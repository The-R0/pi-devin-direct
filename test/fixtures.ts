import { gunzipSync } from "node:zlib";
import type { Api, Model } from "@earendil-works/pi-ai";
import { encodeMessage, encodeString, encodeVarintField, frameConnectStream, iterFields } from "../src/wire.js";

export const API_KEY = "devin-session-token$test-account-key";
export const AUTH_TOKEN = "ott$abcdefghijklmnopqrstuvwxyz0123456789";
export const EU_SERVER = "https://eu.windsurf.com/_route/api_server";
export const JWT = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url")}.test`;

export function protoString(buf: Buffer, num: number): string | undefined {
  const field = [...iterFields(buf)].find(f => f.num === num && f.wire === 2);
  return Buffer.isBuffer(field?.value) ? field.value.toString("utf8") : undefined;
}
export function protoMessage(buf: Buffer, num: number): Buffer {
  const field = [...iterFields(buf)].find(f => f.num === num && f.wire === 2);
  if (!Buffer.isBuffer(field?.value)) throw new Error(`Missing message ${num}`);
  return field.value;
}
export function chatRequest(body: unknown): Buffer {
  const frame = Buffer.from(body as Uint8Array);
  return frame[0] & 1 ? gunzipSync(frame.subarray(5)) : frame.subarray(5);
}

export function catalogResponse(label = "Test Model", uid = "test-model-high"): Buffer {
  const variant = Buffer.concat([
    encodeString(1, `${label} High`), encodeString(22, uid),
    encodeMessage(23, Buffer.concat([encodeVarintField(4, 32000), encodeVarintField(13, 4096), encodeString(23, label)])),
    encodeMessage(30, encodeString(1, label)),
  ]);
  return encodeMessage(1, variant);
}
export function trailer(error?: string): Buffer {
  const payload = Buffer.from(JSON.stringify(error ? { error: { code: "unauthenticated", message: error } } : {}));
  const header = Buffer.alloc(5);
  header[0] = 2;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
export function responseStream(frames: Buffer[], chunkSize = 3): Response {
  const bytes = Buffer.concat(frames);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize));
      controller.close();
    },
  }), { headers: { "Content-Type": "application/connect+proto" } });
}
export const textResponse = () => responseStream([frameConnectStream(encodeString(3, "pong")), trailer()]);
export const model: Model<Api> = {
  id: "test-model", name: "Test", api: "devin-local", provider: "devin", baseUrl: EU_SERVER,
  reasoning: true, thinkingLevelMap: { high: "test-model-high", low: null },
  input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096,
};
