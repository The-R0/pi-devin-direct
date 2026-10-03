import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { buildSignInUrl, loginDevin, parseAuthToken, registerUser } from "../src/auth.js";
import { readCredentials, readLocalCredentials } from "../src/credentials.js";
import { validateApiServer } from "../src/endpoints.js";
import { clearCachedUserJwt } from "../src/jwt.js";
import { encodeString } from "../src/wire.js";
import { API_KEY, AUTH_TOKEN, EU_SERVER, JWT } from "./fixtures.js";

const fetchOriginal = globalThis.fetch;
let directory: string;
let savedEnv: Record<string, string | undefined>;
const envKeys = ["DEVIN_AUTH_MODE", "DEVIN_API_KEY", "DEVIN_API_SERVER_URL", "DEVIN_CREDENTIALS_PATH", "DEVIN_DESKTOP_STATE_DB"];
beforeEach(() => {
  clearCachedUserJwt();
  directory = mkdtempSync(join(tmpdir(), "pi-devin-test-"));
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.DEVIN_CREDENTIALS_PATH = join(directory, "credentials.toml");
  process.env.DEVIN_DESKTOP_STATE_DB = join(directory, "state.vscdb");
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  clearCachedUserJwt();
  for (const key of envKeys) savedEnv[key] === undefined ? delete process.env[key] : process.env[key] = savedEnv[key];
  rmSync(directory, { recursive: true, force: true });
});

function callbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
  return { onAuth() {}, onDeviceCode() {}, onPrompt: async () => AUTH_TOKEN, onSelect: async () => undefined, ...overrides };
}

test("accepts opaque one-time tokens and callback query/fragment values", () => {
  assert.equal(parseAuthToken(`  ${AUTH_TOKEN} \n`), AUTH_TOKEN);
  for (const name of ["firebase_id_token", "access_token", "id_token", "token"]) {
    assert.equal(parseAuthToken(`https://windsurf.com/callback#${name}=${encodeURIComponent(AUTH_TOKEN)}`), AUTH_TOKEN);
    assert.equal(parseAuthToken(`https://windsurf.com/callback?${name}=${encodeURIComponent(AUTH_TOKEN)}`), AUTH_TOKEN);
  }
  for (const value of ["", "not a token", "https://windsurf.com/callback", "https://invalid.invalid/?token=short"]) assert.throws(() => parseAuthToken(value));
  assert.notEqual(new URL(buildSignInUrl()).searchParams.get("state"), new URL(buildSignInUrl()).searchParams.get("state"));
});

test("browser sign-in works without Devin installed and returns Pi-owned credentials", async () => {
  let authUrl = "";
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(init?.body)), { firebase_id_token: AUTH_TOKEN });
    return Response.json({ api_key: API_KEY, api_server_url: EU_SERVER });
  };
  const cred = await loginDevin(callbacks({ onAuth: info => { authUrl = info.url; } }));
  assert.equal(cred.access, API_KEY);
  assert.equal(cred.apiServerUrl, EU_SERVER);
  assert.equal(cred.source, "browser");
  assert.equal(cred.expires, Number.MAX_SAFE_INTEGER);
  assert.equal(calls, 1);
  assert.equal(new URL(authUrl).searchParams.get("redirect_uri"), "show-auth-token");
  assert.equal(readCredentials(), null);
});

test("imports a CLI session read-only and validates its own regional host", async () => {
  const body = `windsurf_api_key = '${API_KEY}' # imported\napi_server_url = "${EU_SERVER}"\n`;
  writeFileSync(process.env.DEVIN_CREDENTIALS_PATH!, body);
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `${EU_SERVER}/exa.auth_pb.AuthService/GetUserJwt`);
    assert.equal(init?.redirect, "error");
    return new Response(new Uint8Array(encodeString(1, JWT)));
  };
  const cred = await loginDevin(callbacks({ onAuth: () => assert.fail("must not open browser") }));
  assert.equal(cred.source, "local-cli");
  assert.equal(cred.access, API_KEY);
  assert.equal(readFileSync(process.env.DEVIN_CREDENTIALS_PATH!, "utf8"), body);
});

test("imports the current Desktop SQLite row without creating CLI credentials", async () => {
  const db = new DatabaseSync(process.env.DEVIN_DESKTOP_STATE_DB!);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("windsurfAuthStatus", JSON.stringify({ apiKey: API_KEY }));
  db.close();
  const creds = await readLocalCredentials();
  assert.equal(creds?.apiKey, API_KEY);
  assert.equal(creds?.source, "local-desktop");
  assert.equal(readCredentials(), null);
});

test("browser mode ignores existing and malformed local credentials", async () => {
  process.env.DEVIN_AUTH_MODE = "browser";
  process.env.DEVIN_API_KEY = "old-key";
  writeFileSync(process.env.DEVIN_CREDENTIALS_PATH!, "broken");
  globalThis.fetch = async () => Response.json({ api_key: API_KEY });
  const cred = await loginDevin(callbacks());
  assert.equal(cred.source, "browser");
  assert.equal(cred.access, API_KEY);
  assert.equal(readFileSync(process.env.DEVIN_CREDENTIALS_PATH!, "utf8"), "broken");
});

test("registration refuses foreign destinations and never echoes secret error bodies", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ message: AUTH_TOKEN }), { status: 401 });
  await assert.rejects(registerUser(AUTH_TOKEN), error => error instanceof Error && !error.message.includes(AUTH_TOKEN) && /HTTP 401/.test(error.message));
  globalThis.fetch = async () => Response.json({ api_key: API_KEY, api_server_url: "https://attacker.invalid" });
  await assert.rejects(registerUser(AUTH_TOKEN), /HTTPS Cognition/);
  for (const host of ["http://server.codeium.com", "https://server.codeium.com@attacker.invalid", "https://127.0.0.1", "https://server.codeium.com:444", "https://server.codeium.com?token=secret"]) assert.throws(() => validateApiServer(host));
  assert.equal(validateApiServer(`${EU_SERVER}/`), EU_SERVER);
});

test("cancellation, local-only and invalid modes never start browser HTTP", async () => {
  globalThis.fetch = async () => assert.fail("must not fetch");
  process.env.DEVIN_AUTH_MODE = "local";
  await assert.rejects(loginDevin(callbacks()), /No local/);
  process.env.DEVIN_AUTH_MODE = "invalid";
  await assert.rejects(loginDevin(callbacks()), /must be/);
  await assert.rejects(loginDevin(callbacks({ signal: AbortSignal.abort() })), /abort/i);
});
