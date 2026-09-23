# credential-based-config

## Goal
The pengepul provider is configured from `~/.pi/agent/auth.json` — relay base URL and API key both — by registering a full pi-ai `Provider` that receives the credential from pi instead of re-reading config files, with the `PENGEPUL_*` environment variables as overrides that outrank it. No file of pengepul's own is read.

## Non-goals
- No changes to the pengepul relay itself, its config format, or its routes.
- No read of the relay's own `~/.pengepul/config.yaml`: it is the relay's file, not this client's, and a second config surface is a second thing to keep in sync.
- No change to model metadata mapping: the relay-advertised fields, builtin-catalog lookup, family heuristics, and thinking-level normalization stay as they are.
- No change to the dialect rules in `dialect.ts` (which id maps to which wire, and the `/v1` split).
- No new slash commands, tools, flags, or OAuth providers.
- No support for configuring the relay base through `models.json` or the credential's `env` map.
- No `/login` URL prompt beyond the one the relay base needs.

## Acceptance criteria
- AC-1: Relay base resolution, highest wins: `PENGEPUL_BASE_URL` → `credential.baseUrl` → `http://127.0.0.1:8317`. A trailing `/v1` on any source is accepted.
- AC-2: API key resolution, highest wins: `PENGEPUL_API_KEY` → `credential.key` → unconfigured. Unconfigured means `check()`/`resolve()` report nothing, the provider is unavailable, and no catalog fetch is attempted. `check()`/`resolve()` label the source they actually used, so an environment override is reported as one.
- AC-3: `auth.apiKey.login` prompts for the API key, then for the relay URL (placeholder `http://127.0.0.1:8317`), and returns `{ type: "api_key", key, baseUrl }` with the relay URL defaulted when the answer is blank. Re-running `/login pengepul` therefore cannot drop `baseUrl`.
- AC-4: `auth.apiKey.resolve` returns `auth.apiKey` only — never `auth.baseUrl` — because pi applies a resolved `baseUrl` to every model and would collapse the two wires onto one URL.
- AC-5: Every catalog model carries `provider: "pengepul"` and the dialect-correct `baseUrl`: relay root for `anthropic-messages`, relay root + `/v1` for `openai-completions`, with no doubled `/v1`.
- AC-6: `refreshModels` during the store phase (`allowNetwork: false`) republishes stored pengepul models with `baseUrl` re-derived from the currently resolved relay base, so a moved relay never serves stale URLs; during the network phase it persists `{ models, checkedAt }` and publishes the fetched catalog.
- AC-7: The catalog fetch sends the resolved key as `x-api-key`, is bounded by `PENGEPUL_MODELS_TIMEOUT_MS` (default 10000) and by `context.signal`, and any failure (401, network, timeout, malformed body) is reported as a warning while leaving the previously published models registered.
- AC-8: Both wires still stream through the registered provider: pi-ai's builtin `streamSimple` completes an `anthropic-messages` request and an `openai-completions` request against a mock relay using the provider's models.
- AC-9: README documents auth.json as the configuration surface, the `PENGEPUL_*` environment overrides as outranking it, and warns that `providers.pengepul.baseUrl` in `models.json` collapses the dialect split.

## Verification
```
bun test
bun run typecheck
PENGEPUL_BASE_URL=http://127.0.0.1:8317 bun scripts/e2e-live.ts   # live relay, optional
```
