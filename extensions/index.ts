import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearCachedUserJwt, getCachedUserJwt } from "../src/jwt.js";
import { CLIENT_IDE, CLIENT_VERSION } from "../src/metadata.js";
import { createDevinProvider } from "../src/provider.js";
import { clearStreamSessions } from "../src/stream.js";

export default function (pi: ExtensionAPI): void {
  const provider = createDevinProvider();
  pi.registerProvider(provider);

  pi.on("session_start", async (_event, ctx) => {
    // Pi supplies its own credential store and generation-checked catalog cache.
    // Loading the catalog in the background keeps extension startup responsive.
    void ctx.modelRegistry.refresh({ providers: [provider.id], allowNetwork: true }).then(async result => {
      const error = result.errors.get(provider.id);
      if (error) {
        ctx.ui.notify(`Devin catalog unavailable: ${error.message}. Run /devin-refresh to retry.`, "warning");
        return;
      }
      const resolved = await ctx.modelRegistry.getProviderAuth(provider.id);
      if (resolved?.auth.apiKey && resolved.auth.baseUrl) {
        await getCachedUserJwt(resolved.auth.apiKey, resolved.auth.baseUrl);
      }
    }).catch(() => { /* Connection prewarming is best effort. */ });
  });

  pi.registerCommand("devin-status", {
    description: "Show Devin auth configuration and live catalog status",
    handler: async (_args, ctx) => {
      try {
        const resolved = await ctx.modelRegistry.getProviderAuth(provider.id);
        ctx.ui.notify([
          `Auth: ${resolved ? resolved.source : "not configured; run /login devin"}`,
          `API server: ${resolved?.auth.baseUrl ?? provider.baseUrl}`,
          `Model families: ${provider.getModels().length}`,
          `Protocol identity: ${CLIENT_IDE} ${CLIENT_VERSION}`,
          `Login mode: ${process.env.DEVIN_AUTH_MODE || "auto"}`,
        ].join("\n"), resolved ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Cannot read Devin auth status.", "error");
      }
    },
  });

  pi.registerCommand("devin-refresh", {
    description: "Refresh Devin model families directly over HTTPS",
    handler: async (_args, ctx) => {
      const result = await ctx.modelRegistry.refresh({ providers: [provider.id], allowNetwork: true, force: true });
      const error = result.errors.get(provider.id);
      ctx.ui.notify(error ? `Devin refresh failed: ${error.message}`
        : provider.getModels().length ? `Devin: loaded ${provider.getModels().length} model families.`
        : "No Devin model catalog. Run /login devin or set DEVIN_API_KEY.", error ? "error" : provider.getModels().length ? "info" : "warning");
    },
  });

  pi.on("session_shutdown", () => {
    clearCachedUserJwt();
    clearStreamSessions();
  });
}
