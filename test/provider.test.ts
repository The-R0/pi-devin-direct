import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createDevinProvider } from "../src/provider.js";
import { modelsFromCatalog, resolveModelUid } from "../src/models.js";
import { clearCachedUserJwt } from "../src/jwt.js";
import { encodeString } from "../src/wire.js";
import { API_KEY, AUTH_TOKEN, EU_SERVER, JWT, catalogResponse, chatRequest, protoString, textResponse } from "./fixtures.js";

const fetchOriginal = globalThis.fetch;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  clearCachedUserJwt();
  saved = Object.fromEntries(["DEVIN_AUTH_MODE", "DEVIN_API_KEY", "DEVIN_API_SERVER_URL"].map(k => [k, process.env[k]]));
  for (const key of Object.keys(saved)) delete process.env[key];
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  clearCachedUserJwt();
  for (const key of Object.keys(saved)) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
});

test("native Pi login saves the key, restores catalog offline and routes inference to the owning tenant", async () => {
  process.env.DEVIN_AUTH_MODE = "browser";
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const models = createModels({ credentials, modelsStore });
  const provider = createDevinProvider();
  models.setProvider(provider);
  let chats = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("RegisterUser")) return Response.json({ api_key: API_KEY, api_server_url: EU_SERVER });
    assert.ok(url.startsWith(EU_SERVER));
    if (url.endsWith("GetCliModelConfigs")) return new Response(new Uint8Array(catalogResponse()));
    if (url.endsWith("GetUserJwt")) return new Response(new Uint8Array(encodeString(1, JWT)));
    if (url.endsWith("GetChatMessage")) {
      chats++;
      assert.equal(protoString(chatRequest(init?.body), 21), "test-model-high");
      return textResponse();
    }
    throw new Error("Unexpected endpoint");
  };
  await models.login("devin", "oauth", { prompt: async () => AUTH_TOKEN, notify() {} });
  assert.equal((await credentials.read("devin"))?.type, "oauth");
  await models.refresh({ allowNetwork: false });
  assert.equal(models.getModels("devin")[0].id, "test-model");
  assert.equal((await models.getAuth("devin"))?.auth.baseUrl, EU_SERVER);
  const answer = await models.completeSimple(models.getModels("devin")[0], {
    messages: [{ role: "user", content: "ping", timestamp: 1 }],
  });
  assert.equal(answer.stopReason, "stop");
  assert.equal(answer.content[0].type === "text" && answer.content[0].text, "pong");
  assert.equal(chats, 1);
  const restarted = createModels({ credentials, modelsStore });
  restarted.setProvider(createDevinProvider());
  globalThis.fetch = async () => assert.fail("offline restore must not fetch");
  await restarted.refresh({ allowNetwork: false });
  assert.equal(restarted.getModels("devin")[0].id, "test-model");
  await restarted.logout("devin");
  await restarted.refresh({ allowNetwork: false });
  assert.equal(restarted.getModels("devin").length, 0);
  assert.equal(await restarted.getAuth("devin"), undefined);
});

test("headless env credentials load models; failed refresh keeps only the owning account's catalog", async () => {
  process.env.DEVIN_API_KEY = API_KEY;
  process.env.DEVIN_API_SERVER_URL = EU_SERVER;
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials, modelsStore: new InMemoryModelsStore() });
  models.setProvider(createDevinProvider());
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(new Uint8Array(catalogResponse())); };
  assert.equal((await models.refresh()).errors.size, 0);
  assert.equal(models.getModels("devin").length, 1);
  await models.refresh();
  assert.equal(calls, 1, "successful catalog TTL avoids redundant fetches");
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  assert.equal((await models.refresh({ force: true })).errors.size, 1);
  assert.equal(models.getModels("devin").length, 1);
  await credentials.modify("devin", async () => ({ type: "oauth", access: "other-account", refresh: "", expires: Number.MAX_SAFE_INTEGER, apiServerUrl: EU_SERVER }));
  const result = await models.refresh({ force: true });
  assert.equal(result.errors.size, 1);
  assert.equal(models.getModels("devin").length, 0, "a failed new account cannot borrow the old catalog");
});

test("an empty catalog is an error and leaves the last known models intact", async () => {
  process.env.DEVIN_API_KEY = API_KEY;
  const models = createModels();
  models.setProvider(createDevinProvider());
  globalThis.fetch = async () => new Response(new Uint8Array(catalogResponse()));
  await models.refresh();
  globalThis.fetch = async () => new Response(new Uint8Array());
  assert.match((await models.refresh({ force: true })).errors.get("devin")!.message, /empty model catalog/);
  assert.equal(models.getModels("devin").length, 1);
});

test("single-variant model keeps a stable family id and maps it to the actual wire uid", () => {
  const mapped = modelsFromCatalog({ families: [{ family_label: "Sample", family_uid: "sample", slug: "sample", variants: [{ model_uid: "sample-none", label: "Sample" }] }] })[0];
  assert.equal(mapped.id, "sample");
  assert.equal(mapped.thinkingLevelMap?.low, null);
  assert.equal(resolveModelUid(mapped.id, mapped.thinkingLevelMap), "sample-none");
  assert.deepEqual(modelsFromCatalog(null), []);
});

test("manual API-key login makes its catalog available immediately without a separate network refresh", async () => {
  process.env.DEVIN_API_SERVER_URL = EU_SERVER;
  const models = createModels();
  models.setProvider(createDevinProvider());
  globalThis.fetch = async input => {
    assert.ok(String(input).startsWith(EU_SERVER));
    return new Response(new Uint8Array(catalogResponse()));
  };
  await models.login("devin", "api_key", { prompt: async () => API_KEY, notify() {} });
  globalThis.fetch = async () => assert.fail("must restore just-loaded catalog without HTTP");
  await models.refresh({ allowNetwork: false });
  assert.equal(models.getModels("devin")[0].id, "test-model");
});

test("a superseded catalog request cannot publish over a newer account refresh", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("devin", async () => ({ type: "api_key", key: "account-one" }));
  const models = createModels({ credentials });
  models.setProvider(createDevinProvider());
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const firstRelease = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) { started(); await firstRelease; return new Response(new Uint8Array(catalogResponse("First", "first-high"))); }
    return new Response(new Uint8Array(catalogResponse("Second", "second-high")));
  };
  const first = models.refresh({ force: true });
  await firstStarted;
  await credentials.modify("devin", async () => ({ type: "api_key", key: "account-two" }));
  await models.refresh({ force: true });
  release();
  await first;
  assert.equal(models.getModels("devin")[0].id, "second");
});
