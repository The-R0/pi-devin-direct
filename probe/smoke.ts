import type { Api, Model } from "@earendil-works/pi-ai";
import { readEnvironmentCredentials } from "../src/credentials.js";
import { loadCatalog, modelsFromCatalog } from "../src/models.js";
import { streamDevin } from "../src/stream.js";

const creds = readEnvironmentCredentials();
if (!creds) throw new Error("Set DEVIN_API_KEY explicitly before running the billable live smoke check.");
const families = modelsFromCatalog(await loadCatalog(creds));
const selected = process.env.DEVIN_SMOKE_MODEL ? families.find(m => m.id === process.env.DEVIN_SMOKE_MODEL) : families[0];
if (!selected) throw new Error("Requested smoke model is not in the account catalog.");
const model: Model<Api> = { ...selected, api: "devin-local", provider: "devin", baseUrl: creds.apiServerUrl };
console.log(`Discovered ${families.length} families; making one request with ${model.id}.`);
const output = await streamDevin(model, { messages: [{ role: "user", content: "Reply with the single word pong.", timestamp: Date.now() }] }, {
  apiKey: creds.apiKey, maxTokens: Math.min(model.maxTokens, 1024), timeoutMs: 60_000,
}).result();
if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error(output.errorMessage || output.stopReason);
console.log(output.content.filter(p => p.type === "text").map(p => p.text).join("\n"));
console.log(`Finished: ${output.stopReason}; tokens: ${output.usage.totalTokens}.`);
