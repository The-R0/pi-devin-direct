import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Type, type AssistantMessageEvent, type Context } from "@earendil-works/pi-ai";
import { clearCachedUserJwt } from "../src/jwt.js";
import { clearStreamSessions, streamDevin } from "../src/stream.js";
import { mapContextToChat } from "../src/context-map.js";
import { encodeMessage, encodeString, encodeVarintField, frameConnectStream, iterFields } from "../src/wire.js";
import { API_KEY, EU_SERVER, JWT, chatRequest, model, protoMessage, protoString, responseStream, trailer } from "./fixtures.js";

beforeEach(() => { clearCachedUserJwt(); clearStreamSessions(); });
afterEach(() => { clearCachedUserJwt(); clearStreamSessions(); });
const context: Context = { systemPrompt: "System instructions", messages: [{ role: "user", content: "Read example.txt", timestamp: 1 }], tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }] };

test("fragmented gzip frames preserve thinking signatures, tool args and their next-turn replay", async () => {
  let chatCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.ok(String(input).startsWith(EU_SERVER));
    assert.equal(init?.redirect, "error");
    if (String(input).endsWith("GetUserJwt")) return new Response(new Uint8Array(encodeString(1, JWT)));
    chatCalls++;
    assert.equal(new Headers(init?.headers).get("X-Test"), "works");
    const request = chatRequest(init?.body);
    assert.equal(protoString(request, 2), "System instructions");
    assert.equal(protoString(request, 21), "test-model-high");
    assert.equal(protoString(protoMessage(request, 1), 1), "devin-desktop");
    assert.ok([...iterFields(request)].some(f => f.num === 10));
    assert.ok(![...iterFields(request)].some(f => f.num === 22));
    const configuration = [...iterFields(protoMessage(request, 8))];
    assert.equal(configuration.find(f => f.num === 2)?.value, 4096n);
    return responseStream([
      frameConnectStream(encodeString(9, "Need to inspect the file")),
      frameConnectStream(Buffer.concat([encodeString(10, "sealed.v1.test-signature"), encodeString(21, "sealed")])),
      frameConnectStream(encodeMessage(6, Buffer.concat([encodeString(1, "call-1"), encodeString(2, "read"), encodeString(3, '{"path":')]))),
      frameConnectStream(encodeMessage(6, encodeString(3, '"example.txt"}'))),
      frameConnectStream(encodeVarintField(5, 10)), trailer(),
    ]);
  };
  let payloadCalls = 0;
  let responseCalls = 0;
  const events: AssistantMessageEvent[] = [];
  const stream = streamDevin(model, context, {
    apiKey: API_KEY, fetch: fetchImpl, sessionId: "pi-session", headers: { "X-Test": "works" },
    onPayload: bytes => { payloadCalls++; assert.ok(bytes instanceof Uint8Array); return bytes; },
    onResponse: response => { responseCalls++; assert.equal(response.status, 200); },
  });
  for await (const event of stream) events.push(event);
  const output = await stream.result();
  assert.equal(output.stopReason, "toolUse");
  assert.equal(chatCalls, 1);
  assert.equal(payloadCalls, 1);
  assert.equal(responseCalls, 1);
  assert.ok(events.some(e => e.type === "toolcall_delta"));
  const thinking = output.content.find(p => p.type === "thinking");
  assert.equal(thinking?.thinkingSignature, "sealed.v1.test-signature");
  const tool = output.content.find(p => p.type === "toolCall");
  assert.deepEqual(tool?.arguments, { path: "example.txt" });
  const replay = mapContextToChat({ ...context, messages: [...context.messages, output, { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file data" }], isError: false, timestamp: 2 }] });
  assert.equal(replay.messages[1].thinking?.signatureType, "sealed");
  assert.equal(replay.messages[2].tool_call_id, "call-1");
});

test("same Pi session reuses its trajectory; separate sessions do not", async () => {
  const trajectories: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("GetUserJwt")) return new Response(new Uint8Array(encodeString(1, JWT)));
    trajectories.push(protoString(protoMessage(chatRequest(init?.body), 15), 1)!);
    return responseStream([frameConnectStream(encodeString(3, "pong")), trailer()]);
  };
  for (const sessionId of ["one", "one", "two"]) {
    assert.equal((await streamDevin(model, context, { apiKey: API_KEY, fetch: fetchImpl, sessionId }).result()).stopReason, "stop");
  }
  assert.equal(trajectories[0], trajectories[1]);
  assert.notEqual(trajectories[0], trajectories[2]);
});

test("HTTP and Connect trailer failures produce sanitized stream errors without retries", async () => {
  for (const response of [new Response(API_KEY, { status: 429 }), responseStream([trailer(API_KEY)])]) {
    clearCachedUserJwt();
    let chatCalls = 0;
    const fetchImpl: typeof fetch = async input => {
      if (String(input).endsWith("GetUserJwt")) return new Response(new Uint8Array(encodeString(1, JWT)));
      chatCalls++;
      return response;
    };
    const output = await streamDevin(model, context, { apiKey: API_KEY, fetch: fetchImpl }).result();
    assert.equal(output.stopReason, "error");
    assert.ok(!output.errorMessage?.includes(API_KEY));
    assert.equal(chatCalls, 1);
  }
});

test("missing EOS and incomplete tool arguments cannot finish successfully", async () => {
  const responses = [responseStream([frameConnectStream(encodeString(3, "partial"))]),
    responseStream([frameConnectStream(encodeMessage(6, Buffer.concat([encodeString(1, "call-1"), encodeString(2, "read"), encodeString(3, '{"path":')]))), trailer()])];
  for (const response of responses) {
    clearCachedUserJwt();
    const fetchImpl: typeof fetch = async input => String(input).endsWith("GetUserJwt") ? new Response(new Uint8Array(encodeString(1, JWT))) : response;
    const output = await streamDevin(model, context, { apiKey: API_KEY, fetch: fetchImpl }).result();
    assert.equal(output.stopReason, "error");
    assert.match(output.errorMessage!, /EOS|tool arguments/);
  }
});

test("pre-aborted requests never start HTTP and report aborted", async () => {
  const output = await streamDevin(model, context, { apiKey: API_KEY, signal: AbortSignal.abort(), fetch: async () => assert.fail("must not fetch") }).result();
  assert.equal(output.stopReason, "aborted");
});

test("redacted reasoning with no visible summary still preserves and replays its signature", async () => {
  const fetchImpl: typeof fetch = async input => String(input).endsWith("GetUserJwt")
    ? new Response(new Uint8Array(encodeString(1, JWT)))
    : responseStream([frameConnectStream(Buffer.concat([encodeVarintField(11, 1), encodeString(10, "sealed.v1.redacted"), encodeString(21, "sealed")])), trailer()]);
  const output = await streamDevin(model, context, { apiKey: API_KEY, fetch: fetchImpl }).result();
  const thinking = output.content.find(p => p.type === "thinking");
  assert.equal(thinking?.redacted, true);
  assert.equal(thinking?.thinkingSignature, "sealed.v1.redacted");
  const replay = mapContextToChat({ messages: [output] });
  assert.equal(replay.messages[0].thinking?.signature, "sealed.v1.redacted");
  assert.equal(replay.messages[0].thinking?.redacted, true);
});

test("malformed protobuf cannot be silently accepted as a completed response", () => {
  for (const payload of [Buffer.from([0]), Buffer.from([10, 8, 1]), Buffer.from([9, 1]), Buffer.alloc(11, 128)]) {
    assert.throws(() => [...iterFields(payload)]);
  }
});
