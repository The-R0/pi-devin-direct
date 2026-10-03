# pi-devin-direct

Native Pi provider for Devin model inference. Pi owns credentials, tools, permissions,
agent loops and sessions. Devin CLI/Desktop installation is optional.

## Contract

- `/login devin` imports existing credentials read-only, or opens browser sign-in
  and exchanges the pasted token via Cognition `RegisterUser`. `DEVIN_AUTH_MODE`
  selects `auto`, `browser`, or `local`. Never spawn a Devin executable.
- Pi owns persistence. Never write Devin's `credentials.toml` or Desktop database.
  Never prefer local credentials over a stored Pi account during inference.
- Model families and variants come from `GetCliModelConfigs`. No hardcoded model
  allowlist. Keep the last successful catalog on transient failures, bound to its
  exact credential and API server. Never reuse another account's catalog.
- A family id is stable; Pi thinking levels select the actual model uid. Missing
  levels are explicitly `null`. Keep the map even for a single-variant family.
- Catalog Metadata uses `windsurf`; chat Metadata uses `devin-desktop`. Keep
  system prompt in field 2, configuration in 8, trajectory reference in 15,
  planner mode in 20, model uid in 21; omit execution_id in 22.
- Preserve signed/redacted thinking and signature type on replay. The signature
  contains an opaque sealed trace; the visible thinking is only a summary.
- Respect caller cancellation, timeouts, custom fetch, headers and payload/response
  hooks. Send one chat request per turn; never hedge billable calls.
- Validate API destinations and reject credential-bearing redirects. Do not echo
  tokens, keys or raw auth/RPC error bodies in errors or logs.
- Provider id remains `devin`. Install only one Devin provider implementation.

## Layout and checks

`extensions/index.ts` registers the native provider and commands. `src/provider.ts`
owns auth and model lifecycle; `src/auth.ts` implements browser login;
`src/credentials.ts` and `src/desktop-auth.ts` import existing credentials read-only.
`src/models.ts`, `src/stream.ts`, `src/wire.ts`, `src/context-map.ts` and
`src/thinking.ts` implement catalog, transport and message mapping.

Run `npm ci`, then `npm run check` and `npm pack --dry-run` before publishing.
Tests use mocked HTTP and temporary credential stores. `npm run smoke` makes one
real model request and requires an explicitly supplied `DEVIN_API_KEY`.

Upstream protocol basis: The-R0/pi-devin at 252c423; preserve MIT attribution.
