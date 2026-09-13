# @pwguler/pi-pengepul-provider

A custom provider for [pi](https://github.com/earendil-works/pi) that connects to
[pengepul](https://github.com/pwguler/pengepul), a local relay that pools your
Claude / Codex subscription accounts and serves them over native wire protocols.

pengepul pools several subscription accounts per provider and spreads requests
across them, so pi runs on your subscription instead of a per-token API key.
This extension registers pengepul as a provider so `/model` shows the models
your relay serves.

## Install

From npm:

```sh
pi install npm:@pwguler/pi-pengepul-provider
```

Or straight from GitHub (no npm account needed):

```sh
pi install git:github.com/pwguler/pi-pengepul-provider
```

Pin a release so updates don't move under you:

```sh
pi install git:github.com/pwguler/pi-pengepul-provider@v0.1.0
```

To update a git-installed package later:

```sh
pi install git:github.com/pwguler/pi-pengepul-provider@v0.2.0
```

Start or reload pi, then select a model with `/model`. Pengepul models are
prefixed `pengepul/<id>`. To try it without installing, use
`pi -e git:github.com/pwguler/pi-pengepul-provider`.

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
npm install
bun test
npx tsc --noEmit
bun scripts/e2e-live.ts # live e2e against a running relay; sends one tiny completion
```

The `@earendil-works/*` copies `npm install` writes into `node_modules` are for
`tsc` and the tests only. At runtime pi serves the extension those modules from
its own bundle (`loader.js` maps `@earendil-works/pi-ai/providers/all` to a
virtual module), so the local copies exist to be *type-checked against*, not to
be the ones in play. Keep them on the host's version:

```sh
pi --version                                            # host pi release
cat node_modules/@earendil-works/pi-ai/package.json     # local copy
```

When they drift, anything measured from this directory describes a different
model catalog than the running extension sees — the 0.84.4 copy carries 40
`:batch` entries where 0.85.1 carries 68 — and local verification quietly
disagrees with production.

## Releasing

Releases publish from CI on a version tag. Bump, tag, push:

```sh
VERSION=0.2.3
npm version "$VERSION" --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore(release): v$VERSION"
git tag "v$VERSION"
git push origin main --tags
```

`.github/workflows/publish.yml` then runs the full test suite and refuses the
release unless the tag matches `package.json`, the tagged commit is on `main`,
and the version is not already on the registry. It publishes with a provenance
attestation linking the tarball to this repository and commit.

Publishing needs a repository secret named `NPM_TOKEN`, holding a granular
access token:

- **Permissions**: *Read and write*. *Read-only*, and the *stage only* variant
  of read and write, cannot run `npm publish`.
- **Packages and scopes**: *All packages*.
- **Bypass two-factor authentication**: ticked. A token that prompts for an OTP
  cannot publish unattended.
- **Expiration**: whatever you will actually remember to rotate. When it lapses,
  the release fails at the publish step.

npm removed classic tokens in November 2025, so granular is the only kind that
exists. On the token form, leave **Organizations** at *No access*: this package
lives in a user scope (`@pwguler`), not an organization, so a personal account
has nothing to select there. Choosing *Only select packages and scopes* instead
of *All packages* asks for a scope selection that such an account cannot
satisfy.

Trusted publishing (OIDC) is the alternative: no secret to store or rotate, and
provenance is generated automatically. It needs a one-time configuration on the
package's npm settings page instead of a token.

`.github/workflows/ci.yml` runs typecheck and tests on pull requests and pushes
to `main`, and is the same gate the publish job depends on.

## License

MIT
