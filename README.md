# pi-devin-direct

A native Devin provider for [Pi](https://pi.dev), supporting both standalone browser
authentication and existing Devin Desktop/CLI credentials, with no mandatory Devin installation.

Pi runs the agent loop, tools and sessions. This package supplies model inference
through Devin's HTTPS Connect/protobuf endpoints, without a local proxy or CLI subprocess.

## Install

Requires Node.js **22.13+** and Pi **0.87.1+** (`@earendil-works/pi-coding-agent`).

```bash
pi install git:github.com/The-R0/pi-devin-direct
```

For a local checkout:

```bash
npm ci
pi install /absolute/path/to/pi-devin-direct
```

Restart Pi or run `/reload`. Install only one Devin provider: this package and
other `pi-devin` forks all register `devin`.

## Sign in

```text
/login devin
```

Choose the **browser / local session** login method. In the default `auto` mode:

1. Import `DEVIN_API_KEY`, an existing Devin CLI credential file, or a signed-in
   Devin Desktop session, in that order. Imported sessions are validated.
2. If none exists, Pi shows a browser sign-in link. Open it and sign in with your
   Devin/Cognition account, then paste the **auth token displayed on the page**
   into Pi. The plugin exchanges it for a session key through `RegisterUser`.
3. Pi saves the credential in its own auth store and loads the live model catalog.

The browser route currently needs one token paste; it does not require Devin CLI
or Desktop and does not claim an automatic localhost callback. The short-lived
sign-in token is discarded after exchange. Existing Devin credential files and
Desktop databases are never modified.

To sign in independently of an existing Desktop/CLI account, start Pi with:

```bash
DEVIN_AUTH_MODE=browser pi
```

PowerShell:

```powershell
$env:DEVIN_AUTH_MODE = 'browser'
pi
```

Set `DEVIN_AUTH_MODE=local` to require credential import without opening a browser.
Broken or revoked local credentials produce an error; choose `browser` to sign in
independently. Imported keys are copied into Pi; if the Desktop/CLI key later
rotates, run `/login devin` again. Session keys have no synthetic expiry and cannot
be refreshed through an OAuth refresh endpoint.

## Models and commands

Use `/model` to select a discovered Devin model family. Models and available
thinking levels come from your live account catalog; unsupported levels are hidden.
Use `/thinking` or `Shift+Tab` to change the level. Signed thinking summaries,
images, system prompts and tool calls are carried through to the Devin protocol.

- `/devin-status` shows auth configuration, API server and catalog size, without keys.
- `/devin-refresh` forces a direct HTTPS catalog refresh.
- `/logout devin` removes the credential stored by Pi. An ambient `DEVIN_API_KEY`
  remains configured until you remove that environment variable.

The last successful model catalog is cached by Pi and matched to the exact key
and tenant. A failed refresh retains that account's last good catalog. A new
account never borrows the previous account's models. There is no static fallback
allowlist: if initial discovery fails, run `/devin-refresh` when connectivity returns.

## Headless use

Supply a **Devin/Cognition session/API key**, rather than the temporary browser
token or a public Devin Cloud API key:

```bash
export DEVIN_API_KEY='your-session-key'
pi
```

PowerShell:

```powershell
$env:DEVIN_API_KEY = 'your-session-key'
pi
```

| Variable | Purpose |
| --- | --- |
| `DEVIN_API_KEY` | Ambient credential for headless use; no `/login` needed |
| `DEVIN_API_SERVER_URL` | Account API server; defaults to `https://server.codeium.com` |
| `DEVIN_AUTH_MODE` | `auto` (default), `browser`, or `local` |
| `DEVIN_CREDENTIALS_PATH` | Override read-only CLI credential import path |
| `DEVIN_DESKTOP_STATE_DB` | Override read-only Desktop SQLite database path |

Browser login keeps the tenant API server returned by registration. EU/FedStart
route prefixes are preserved for catalog, JWT and chat requests. HTTPS destinations
are restricted to Cognition/Windsurf hosts; redirects carrying secrets are rejected.

## Development and validation

```bash
npm ci
npm run check
npm pack --dry-run
```

Tests cover auth exchange, credential imports, native Pi auth/catalog lifecycle,
account switches, regional routing, Connect streaming, tool calls and signed thinking.
They do not log in to or bill a real account.

The development dependency on Pi 0.87.1 currently brings a shrinkwrap-pinned
`brace-expansion` 5.0.9 advisory (`npm audit`). This package adds no runtime npm
dependencies; that upstream development dependency needs an upstream release to
update its shrinkwrap. CI does not claim a clean audit.

For an opt-in live check, set `DEVIN_API_KEY` and run `npm run smoke`. It discovers
your models and makes **one billable chat request** using the first discovered
family, or `DEVIN_SMOKE_MODEL` if set. Do not run it as part of automated tests.

The protocol is unofficial and may change. Mocked tests establish client behavior;
live browser sign-in and model entitlement still depend on Cognition and your account.

## Credits and license

MIT; see [LICENSE](LICENSE). Based on [The-R0/pi-devin](https://github.com/The-R0/pi-devin)
at commit `252c423`, derived from [webplode/pi-devin](https://github.com/webplode/pi-devin),
[sting8k/pi-devin](https://github.com/sting8k/pi-devin) and
[kashyab12/pi-devin](https://github.com/kashyab12/pi-devin). Browser registration
parameters were cross-checked against [OpenCodex's Devin integration](https://github.com/lidge-jun/opencodex/tree/main/src/oauth/devin).
This package implements its own authentication glue and retains upstream MIT protocol code.
Unofficial; not affiliated with Cognition. The npm package name is
`@the-r0/pi-devin-direct`; use the Git install command above until an npm release exists.
