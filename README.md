# @pwguler/pi-pengepul-provider

A custom provider for [pi](https://github.com/earendil-works/pi) that connects to
[pengepul](https://github.com/pwguler/pengepul), a local relay that pools your
Claude / Codex subscription accounts and serves them over native wire protocols.

pengepul pools several subscription accounts per provider and spreads requests
across them, so pi runs on your subscription instead of a per-token API key.
This extension registers pengepul as a provider so `/model` shows the models
your relay serves.

## Install

```sh
pi install npm:@pwguler/pi-pengepul-provider
```

Start or reload pi, then select a model with `/model`. Pengepul models are
prefixed `pengepul/<id>`.

## What it does

- Registers the `pengepul` provider against your relay's base URL
  (`http://127.0.0.1:8317` by default).
- Discovers models from `GET /v1/models`, maps each to the right wire:
  - `claude-*` / `anthropic/*` and `owned_by: anthropic` → Anthropic Messages
    (`POST /v1/messages`),
  - `gpt-*` / `o<N>` / `codex-*` and `<provider>/<model>` → OpenAI Chat
    Completions (`POST /v1/chat/completions`).
- Takes context window, max output, pricing, and image input from what the
  relay advertises (pengepul >= 0.6.0 sends `context_window`,
  `max_output_tokens`, `input_modalities`, `pricing`). Fields the relay omits
  fall back to pi's builtin catalog for the same id, then to family
  heuristics.
- Caches the last successful catalog at `<agent-dir>/pengepul-models.json`, so
  startup does not wait on the network and a briefly absent relay is covered.
- Reuses pi's built-in stream functions for both wires — no custom transport.
- Registers no commands: the catalog refreshes on every startup.

## Configuration

| Setting | Env var | Default |
|---|---|---|
| Relay base URL | `PENGEPUL_BASE_URL` | `http://127.0.0.1:8317` |
| API key | `PENGEPUL_API_KEY` | read from `~/.pengepul/config.yaml` |
| Config path | `PENGEPUL_CONFIG` | `~/.pengepul/config.yaml` |
| Model cache path | `PENGEPUL_MODELS_CACHE` | `<agent-dir>/pengepul-models.json` |
| Discovery timeout | `PENGEPUL_MODELS_TIMEOUT_MS` | `10000` |

The API key is read from `~/.pengepul/config.yaml` (`api-keys[0]`, the
`sk-local-...` key pengepul generates on first run) unless `PENGEPUL_API_KEY`
is set.

## Notes

- pengepul >= 0.6.0 advertises per-model context windows, output caps,
  modalities, and pricing on `/v1/models`, and that is what the provider
  registers; older relays (or ids the metadata has not reached) fall back to
  pi's builtin catalog. Your subscription, not a per-token meter, is what
  pengepul bills against — displayed costs are upstream list prices.
- The relay must be running and reachable for discovery to succeed. Without a
  cached catalog on a first start, pengepul models stay unavailable until a
  start with the relay up.

## Development

```sh
bun test
npx tsc --noEmit
bun scripts/e2e-live.ts # live e2e against a running relay; sends one tiny completion
```

## License

MIT
