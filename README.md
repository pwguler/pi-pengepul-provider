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

- Registers the `pengepul` provider against the relay base URL on your
  credential (`http://127.0.0.1:8317` by default).
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
- Names the extended thinking levels (`xhigh`, `max`) that a model's own family
  publishes. An id the catalogs have not caught up with — a point release the
  relay already serves — takes them from the same family's previous minor, so
  it does not sit at `high` until the next pi catalog update. Nothing to
  configure: `thinkingLevelMap` is resolved per id here.
- Caches the catalog in pi's model store, so startup does not wait on the
  network and a briefly absent relay is covered. The cached models are
  re-pointed at the relay base configured now, so moving the relay does not
  leave requests aimed at the old address.
- Reuses pi's built-in stream functions for both wires — no custom transport.
- Registers no commands: pi refreshes the catalog on every startup.

## Configuration

Everything lives in `~/.pi/agent/auth.json`: the relay's API key and the relay
base it applies to.

```json
{
  "pengepul": {
    "type": "api_key",
    "key": "sk-local-...",
    "baseUrl": "http://127.0.0.1:8317"
  }
}
```

`/login pengepul` writes both fields for you — it asks for the key, then for the
relay URL, and defaults the URL to `http://127.0.0.1:8317`. Editing the file by
hand works the same way; `baseUrl` may end in `/v1` or not.

To reach a relay on another machine, put that machine's address in `baseUrl`
(and make the relay listen beyond loopback there: `host: 0.0.0.0` in
`~/.pengepul/config.yaml` on the relay, or forward the port over SSH). The key
is the relay's own key — `pengepul config api-key` prints it.

Optional overrides, for CI or a one-off shell. Each is a fallback: the
credential wins when it carries a value.

| Setting | Env var | Default |
|---|---|---|
| Relay base URL | `PENGEPUL_BASE_URL` | `http://127.0.0.1:8317`, or the relay's own `config.yaml` |
| API key | `PENGEPUL_API_KEY` | `api-keys[0]` in `~/.pengepul/config.yaml` |
| Config path | `PENGEPUL_CONFIG` | `~/.pengepul/config.yaml` |
| Legacy cache path | `PENGEPUL_MODELS_CACHE` | `<agent-dir>/pengepul-models.json` |
| Discovery timeout | `PENGEPUL_MODELS_TIMEOUT_MS` | `10000` |

`PENGEPUL_MODELS_CACHE` names the pre-0.3 cache file. It is read once, when pi's
model store has no pengepul catalog yet, and never written again.

Do not set `providers.pengepul.baseUrl` in `models.json`. pi applies that value
to every model of the provider, which collapses the two wires onto one URL —
Anthropic Messages traffic would be sent to `/v1` and Chat Completions traffic
to `/`.

## Notes

- pengepul >= 0.6.0 advertises per-model context windows, output caps,
  modalities, and pricing on `/v1/models`, and that is what the provider
  registers; older relays (or ids the metadata has not reached) fall back to
  pi's builtin catalog. Your subscription, not a per-token meter, is what
  pengepul bills against — displayed costs are upstream list prices.
- The relay must be running and reachable for discovery to succeed. Without a
  cached catalog on a first start, pengepul models stay unavailable until a
  start with the relay up. A relay that answers with 401 leaves the last known
  catalog registered and logs a warning; discovery does not take pi down with
  it.

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
be the ones in play.

Nothing here can enforce that the two match: the peer ranges are `*` and the
host's version is not knowable at install time. The lockfile records whichever
version was current when it was last refreshed, so the comparison is a manual
one, worth making whenever a measurement has to be trusted:

```sh
pi --version                                            # host pi release
cat node_modules/@earendil-works/pi-ai/package.json     # local copy
```

When they drift, anything measured from this directory describes a different
model catalog than the running extension sees — the 0.84.4 copy carried 40
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
