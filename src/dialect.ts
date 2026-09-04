/**
 * Pure pengepul dialect mapping.
 *
 * pengepul is a local relay that speaks *both* native wires and routes each
 * request by model id. This module maps a model id (and the owned_by value
 * pengepul advertises on `/v1/models`) to the pi-ai API dialect pi should use,
 * and to the base URL pi's built-in stream functions should point at.
 *
 * No pi imports, no io: this is unit-testable with a table of inputs.
 *
 * pengepul routing (from its `resolve_id` / heuristic):
 *   - `anthropic/...` and bare `claude-*` / `anthropic`  -> Anthropic Messages
 *     (`POST /v1/messages`). pi's Anthropic SDK appends `/v1/messages`, so the
 *     base URL is the relay root (no trailing `/v1`).
 *   - `codex/...`, bare `gpt-*` / `o<N>` / `codex-*`, and any other
 *     `<provider>/<model>` prefix      -> OpenAI Chat Completions
 *     (`POST /v1/chat/completions`). pi's OpenAI SDK appends `/chat/completions`,
 *     so the base URL must end in `/v1`.
 */

export type PengepulDialect = "anthropic-messages" | "openai-completions"

/** Which wire pengepul serves a given model id on. */
export function dialectForModelId(id: string): PengepulDialect {
  const slash = id.indexOf("/")
  if (slash !== -1) {
    const prefix = id.slice(0, slash).toLowerCase()
    return prefix === "anthropic" ? "anthropic-messages" : "openai-completions"
  }

  const lower = id.toLowerCase()
  if (lower.startsWith("claude-") || lower.startsWith("anthropic")) {
    return "anthropic-messages"
  }
  if (lower.startsWith("gpt-") || lower.startsWith("codex-") || isOpenAIModelPattern(lower)) {
    return "openai-completions"
  }

  // Unknown bare id: prefer Messages only when the upstream explicitly says so;
  // otherwise assume Chat Completions (the relay's generic-namespace default).
  return "openai-completions"
}

function isOpenAIModelPattern(lower: string): boolean {
  // o1, o3-mini, o4, ... — the OpenAI reasoning-family names pengepul routes to codex.
  const first = lower[0]
  const second = lower[1]
  if (first === undefined || second === undefined) return false
  if (lower.length >= 2 && first === "o" && /^[1-9]/.test(second)) return true
  return false
}

/**
 * The base URL pi's built-in stream should use for a dialect.
 *
 * Accepts a relay base that may or may not end in `/v1` (pengepul's own config
 * notes "the base url may end in /v1"); we normalize so the Anthropic Messages
 * SDK gets the root and the OpenAI Chat Completions SDK gets `/v1`, and neither
 * produces a doubled `/v1/v1`.
 */
export function baseUrlForDialect(baseUrl: string, dialect: PengepulDialect): string {
  const root = normalizeRootBaseUrl(baseUrl)
  return dialect === "anthropic-messages" ? root : `${root}/v1`
}

/** Strip a trailing `/v1` (and any trailing slashes) so we can re-add it per dialect. */
export function normalizeRootBaseUrl(baseUrl: string): string {
  let out = baseUrl.replace(/\/+$/g, "")
  if (out.endsWith("/v1")) out = out.slice(0, -3)
  return out.replace(/\/+$/g, "")
}

/** The discovery endpoint for a relay base. */
export function modelsUrl(baseUrl: string): string {
  return `${normalizeRootBaseUrl(baseUrl)}/v1/models`
}
