import { createHash } from "node:crypto";
import type { Api, Credential, Model, Provider, ProviderAuth, RefreshModelsContext, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { loginDevin } from "./auth.js";
import { readEnvironmentCredentials, type DevinCredentials } from "./credentials.js";
import { DEFAULT_API_SERVER, validateApiServer } from "./endpoints.js";
import { loadCatalog, modelsFromCatalog } from "./models.js";
import { streamDevin } from "./stream.js";

const CACHE_TTL = 5 * 60_000;
const PROVIDER_ID = "devin";

function fromCredential(credential?: Credential): DevinCredentials | null {
  if (!credential) return readEnvironmentCredentials();
  const apiKey = credential.type === "oauth" ? credential.access : credential.key;
  if (!apiKey) return null;
  const host = credential.type === "oauth" ? credential.apiServerUrl : credential.env?.DEVIN_API_SERVER_URL;
  return { apiKey, apiServerUrl: validateApiServer(typeof host === "string" ? host : process.env.DEVIN_API_SERVER_URL || DEFAULT_API_SERVER), source: "pi" };
}

// Cache belongs to the exact credential and tenant. An account switch cannot reuse it.
function fingerprint(creds: DevinCredentials): string {
  return createHash("sha256").update(creds.apiServerUrl).update("\0").update(creds.apiKey).digest("hex");
}

export function createDevinProvider(): Provider {
  let current: { owner: string; models: Model<Api>[]; checkedAt: number } | undefined;

  async function fetchModels(creds: DevinCredentials, signal?: AbortSignal): Promise<Model<Api>[]> {
    const catalog = await loadCatalog(creds, signal);
    return modelsFromCatalog(catalog).map(model => ({ ...model, provider: PROVIDER_ID, api: "devin-local", baseUrl: creds.apiServerUrl }));
  }

  async function prepareLoginCatalog(creds: DevinCredentials, interaction: Parameters<NonNullable<ProviderAuth["oauth"]>["login"]>[0]): Promise<void> {
    interaction.notify({ type: "progress", message: "Loading the live Devin model catalog..." });
    try {
      const models = await fetchModels(creds, interaction.signal);
      interaction.signal.throwIfAborted();
      current = { owner: fingerprint(creds), models, checkedAt: Date.now() };
      interaction.notify({ type: "progress", message: `Loaded ${models.length} Devin model families.` });
    } catch {
      interaction.signal.throwIfAborted();
      interaction.notify({ type: "info", message: "Signed in; model catalog unavailable. Run /devin-refresh to retry." });
    }
  }

  const auth: ProviderAuth = {
    apiKey: {
      name: "Devin API key / DEVIN_API_KEY",
      async login(interaction) {
        const key = (await interaction.prompt({ type: "secret", message: "Enter your Devin/Cognition API key:" })).trim();
        if (!key) throw new Error("No Devin API key supplied.");
        const baseUrl = validateApiServer(process.env.DEVIN_API_SERVER_URL || DEFAULT_API_SERVER);
        await prepareLoginCatalog({ apiKey: key, apiServerUrl: baseUrl, source: "pi" }, interaction);
        return { type: "api_key", key, env: { DEVIN_API_SERVER_URL: baseUrl } };
      },
      async resolve({ credential, ctx }) {
        const apiKey = credential?.key || await ctx.env("DEVIN_API_KEY");
        if (!apiKey) return undefined;
        const baseUrl = validateApiServer(credential?.env?.DEVIN_API_SERVER_URL || await ctx.env("DEVIN_API_SERVER_URL") || DEFAULT_API_SERVER);
        return { auth: { apiKey, baseUrl }, env: { DEVIN_API_SERVER_URL: baseUrl }, source: credential?.key ? "Pi credential" : "DEVIN_API_KEY" };
      },
    },
    oauth: {
      name: "Devin browser / local session",
      loginLabel: "Browser sign-in or import existing Devin credentials",
      isSubscription: true,
      async login(interaction) {
        const credential = { ...await loginDevin({
          signal: interaction.signal,
          onAuth: info => interaction.notify({ type: "auth_url", ...info }),
          onDeviceCode: info => interaction.notify({ type: "device_code", ...info }),
          onPrompt: prompt => interaction.prompt({ type: "secret", ...prompt }),
          onSelect: prompt => interaction.prompt({ type: "select", ...prompt }),
          onProgress: message => interaction.notify({ type: "progress", message }),
        }), type: "oauth" as const };
        const creds = fromCredential(credential)!;
        await prepareLoginCatalog(creds, interaction);
        return credential;
      },
      async refresh() {
        throw new Error("Devin session keys cannot be refreshed. Run /login devin again.");
      },
      async toAuth(credential) {
        const creds = fromCredential(credential)!;
        return { apiKey: creds.apiKey, baseUrl: creds.apiServerUrl };
      },
    },
  };

  return {
    id: PROVIDER_ID,
    name: "Devin Direct",
    baseUrl: DEFAULT_API_SERVER,
    auth,
    getModels: () => current?.models ?? [],
    async refreshModels(context: RefreshModelsContext) {
      const creds = fromCredential(context.credential);
      if (!creds) {
        await context.publish({ update: () => { current = undefined; } });
        return;
      }
      const owner = fingerprint(creds);
      const stored = context.stored;
      if (current?.owner !== owner) {
        await context.publish({ update: () => {
          current = stored?.etag === owner
            ? { owner, models: stored.models.filter(m => m.provider === PROVIDER_ID).map(m => ({ ...m, baseUrl: creds.apiServerUrl })), checkedAt: stored.checkedAt ?? 0 }
            : undefined;
        } });
      }
      if (!context.allowNetwork || context.signal.aborted) {
        if (current?.owner === owner && !context.signal.aborted && (stored?.etag !== owner || stored.checkedAt !== current.checkedAt)) {
          await context.publish({ persist: { models: current.models, checkedAt: current.checkedAt, etag: owner } });
        }
        return;
      }
      if (current?.owner === owner && !context.force && Date.now() - current.checkedAt < CACHE_TTL) return;
      const models = await fetchModels(creds, context.signal);
      const checkedAt = Date.now();
      await context.publish({
        // etag is an opaque local ownership validator, not sent to the server.
        persist: { models, checkedAt, etag: owner },
        update: () => { current = { owner, models, checkedAt }; },
      });
    },
    stream: (model, context, options) => streamDevin(model, context, options as SimpleStreamOptions),
    streamSimple: streamDevin,
  };
}
