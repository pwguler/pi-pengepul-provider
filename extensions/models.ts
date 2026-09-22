/**
 * pengepul model discovery.
 *
 * Fetches the relay's model catalog (`GET /v1/models`) and maps it into the
 * pi-ai `ProviderModelConfig` shape, mirroring the commandcode provider's
 * cached-catalog design: a fresh fetch wins, a valid cache covers a briefly
 * absent relay, and an empty result leaves pengepul models unavailable until
 * the next successful startup refresh.
 *
 * The relay advertises id/owned_by and, since pengepul 0.6.0, optional
 * per-model metadata: `context_window`, `max_output_tokens`,
 * `input_modalities`, `pricing`, and `reasoning`. That is the first-party
 * truth for what this relay actually serves, so it wins. The rollout is
 * partial (some ids
 * still come back with ids only), so two fallbacks remain: pi's builtin
 * catalog - pengepul forwards the same ids upstream, so pi's numbers are the
 * next best source - and then family heuristics. The catalog lookup is
 * injected, so this module imports nothing from pi-ai and tests pin it.
 *
 * The network/cache are injected so the catalog logic stays testable.
 */

import { readFile } from "node:fs/promises"

import { MODELS_TIMEOUT_MS_ENV } from "./config.ts"
import { baseUrlForDialect, dialectForModelId } from "./dialect.ts"
import type { PengepulDialect } from "./dialect.ts"

export const DEFAULT_RELAY_BASE = "http://127.0.0.1:8317"
export const DEFAULT_MODELS_TIMEOUT_MS = 10_000

const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 64_000
const ZERO_COST: ModelCostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
/** v5 cached entries predate the relay-uniform off/minimal overlay (foreign catalog maps offered levels the relay 400s); reject it. */
const MODEL_CACHE_VERSION = 6

export type ModelInput = ("text" | "image")[]

export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** The metadata pi's builtin catalog carries for a model the relay advertises. */
export interface BuiltinModelMeta {
  reasoning: boolean
  contextWindow: number
  maxTokens: number
  input: ModelInput
  cost: ModelCostRates
  /** Level-to-wire mapping for reasoning params; undefined = pi's default. */
  thinkingLevelMap?: Record<string, string | null>
}

/**
 * Resolves a model's metadata from pi's builtin catalogs. The core passes the
 * relay id and its dialect; the edge decides which catalogs to search
 * (commandcode ids carry a routing prefix, so one id may exist verbatim under
 * `openrouter`/`baseten`/... and bare under a vendor catalog like `deepseek`).
 * Undefined when no pi catalog knows the id.
 */
export type BuiltinModelLookup = (id: string, dialect: PengepulDialect) => BuiltinModelMeta | undefined

/** A pengepul model ready to become a pi model entry. */
export interface PengepulModel {
  id: string
  name: string
  dialect: PengepulDialect
  reasoning: boolean
  input: ModelInput
  cost: ModelCostRates
  contextWindow: number
  maxTokens: number
  /** Level-to-wire mapping (inherited, relay-unsafe levels nulled); undefined = pi's default. */
  thinkingLevelMap?: Record<string, string | null>
}


/** `anthropic/claude-opus-5` -> `claude-opus-5` (the id upstream actually serves). */
export function bareId(id: string): string {
  const slash = id.indexOf("/")
  return slash === -1 ? id : id.slice(slash + 1)
}

/** `openrouter/openai/gpt-5.4:batch` -> `gpt-5.4:batch`: the model name without every routing prefix. */
export function modelName(id: string): string {
  const slash = id.lastIndexOf("/")
  return slash === -1 ? id : id.slice(slash + 1)
}

/**
 * Fallback for models pi's catalog does not know. Family-shaped but
 * conservative; the builtin lookup wins whenever it has the id. The relay
 * prefixes ids with routing namespaces (`openrouter/openai/gpt-5.4:batch`),
 * so the family is read from the final segment. The final branch treats
 * unknown ids as non-reasoning, so an unrecognized id never gets reasoning
 * params the upstream may reject.
 */
function heuristicMeta(id: string): BuiltinModelMeta {
  const name = modelName(id).toLowerCase()
  if (name.startsWith("claude-")) {
    return { reasoning: true, contextWindow: 200_000, maxTokens: 64_000, input: ["text"], cost: ZERO_COST }
  }
  if (
    name.startsWith("codex-") ||
    /^gpt-[5-9]/.test(name) ||
    name.startsWith("gpt-oss") ||
    /^o[1-9]/.test(name)
  ) {
    return { reasoning: true, contextWindow: 272_000, maxTokens: 64_000, input: ["text"], cost: ZERO_COST }
  }
  // Families that name their reasoning: DeepSeek's R1 line and ids that spell
  // it out (`sonar-reasoning-pro`). The relay's own numbers win when it sends
  // them; these are placeholders for the ids it describes with nothing else.
  if (name.startsWith("deepseek-r1") || name.includes("reasoning")) {
    return {
      reasoning: true,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      input: ["text"],
      cost: ZERO_COST,
    }
  }
  return {
    reasoning: false,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    input: ["text"],
    cost: ZERO_COST,
  }
}

/**
 * The catalog-id shapes to try for a relay id, in the order they are tried.
 *
 * The order is load-bearing, and it is not "most specific first": the last
 * segment is tried before the namespace-stripped id, which is what the
 * catalogs were measured to give. For 141 of the relay's 527 ids the two
 * shapes resolve to different entries and the last segment wins - 
 * `commandcode/deepseek/deepseek-v4-pro` takes the deepseek catalog's bare
 * `deepseek-v4-pro` (input 0.435) rather than openrouter's
 * `deepseek/deepseek-v4-pro` (input 0.890, and a different level map).
 * Reordering these shapes repoints those ids, so the test pins the order.
 *
 * The namespace-stripped shape is the third fallback: the only one that
 * reaches an id whose catalog entry both the full id and the last segment
 * miss, which is three of the relay's 527 at the time of writing.
 */
export function catalogIdForms(id: string): readonly string[] {
  return [...new Set([id, modelName(id), bareId(id)])]
}

/**
 * Metadata pengepul itself advertises for a model (pengepul >= 0.6.0).
 * Every field is optional: the rollout is partial and older relays send none.
 * `reasoning` is the relay's first-party say on whether the upstream accepts
 * reasoning params; absent or non-boolean falls back to the catalog.
 * Returns undefined when the entry carries no usable metadata at all.
 */
export function metaFromRelayEntry(
  entry: Record<string, unknown>,
): Partial<BuiltinModelMeta> | undefined {
  const contextWindow = optionalPositiveNumber(entry["context_window"])
  const maxTokens = optionalPositiveNumber(entry["max_output_tokens"])
  const input = optionalInputModalities(entry["input_modalities"])
  const cost = optionalPricing(entry["pricing"])
  const reasoning = optionalBoolean(entry["reasoning"])

  if (
    contextWindow === undefined &&
    maxTokens === undefined &&
    input === undefined &&
    cost === undefined &&
    reasoning === undefined
  ) {
    return undefined
  }
  return {
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(cost !== undefined ? { cost } : {}),
  }
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function optionalInputModalities(value: unknown): ModelInput | undefined {
  if (!Array.isArray(value)) return undefined
  const input = value.filter(
    (entry): entry is "text" | "image" => entry === "text" || entry === "image",
  )
  return input.length > 0 ? input : undefined
}

function optionalPricing(value: unknown): ModelCostRates | undefined {
  if (!isRecord(value)) return undefined
  const input = optionalRate(value["input_per_million"])
  const output = optionalRate(value["output_per_million"])
  const cacheRead = optionalRate(value["cache_read_per_million"])
  const cacheWrite = optionalRate(value["cache_write_per_million"])
  if (input === undefined && output === undefined) return undefined
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
  }
}

function optionalRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Extended effort levels for an id no pi catalog carries, on the one relay
 * namespace where that vocabulary has been measured.
 *
 * pi hides `xhigh` and `max` unless a model's map names them, so an id no
 * catalog answers for dropped to low/medium/high and could never send the top
 * of the scale. Two of the 296 reasoning openai-completions ids the provider
 * registers rest on this today; the lookup's namespace-stripped shapes answer
 * for the rest.
 *
 * Only `max` is named. DeepSeek documents low/high/max for the
 * OpenAI-compatible wire and folds `minimal` into low, `medium` and `xhigh`
 * into high - which is what pi's own deepseek catalog encodes, hiding `xhigh`
 * outright and nulling `medium` - but the relay validates one enum for every
 * family it routes, so the namespace rule cannot tell a vendor alias from a
 * level in its own right. Naming the top of the scale is the part that is
 * true whatever the upstream does with it; the rest stays with pi's default.
 *
 * Measured against the running relay: on `commandcode/` ids every requested
 * effort except `minimal` is accepted, and one error text — the relay's own
 * enum — answers all nine families probed (deepseek, Qwen, MiniMax, google,
 * moonshotai, xiaomi, stepfun, nvidia, inclusionai), nine of the eighteen the
 * namespace carries, so the vocabulary belongs to the relay rather than to any
 * one model. `minimal` 400s, and the overlay below nulls it.
 *
 * `openrouter/` ids are left alone, but not because that namespace is
 * unmeasurable: it validates no effort enum at all, so a probe there answers
 * 200 whether the level exists upstream or not. What it serves is also
 * heterogeneous - image generators, R1-class models that take no effort
 * parameter at all - and pi's openrouter entries spell DeepSeek's top level
 * `xhigh` rather than `max`, so a namespace-wide rule there has nothing solid
 * to stand on.
 */
function fallbackLevelMap(id: string): Record<string, string | null> | undefined {
  return id.toLowerCase().startsWith("commandcode/") ? { max: "max" } : undefined
}

/** The levels pi hides unless a map names them. */
const INHERITED_LEVELS = ["xhigh", "max"] as const

/**
 * Extended levels a family's previous minor already carries.
 *
 * pi hides `xhigh` and `max` unless a model's map names them, so an id the
 * catalogs have not caught up with - a Claude point release the relay serves
 * today, before pi's catalog carries it - dropped to low/medium/high and could
 * never send the top of a ladder its own family publishes: in the catalog Opus
 * 4.5 names neither extension, 4.6 names max, and 4.7, 4.8 and 5 name xhigh and
 * max. The previous minor's own entry is that answer, and the only evidence
 * there is: the relay advertises no effort metadata, so `GET /v1/models` has
 * nothing to say about levels and pi's map is the whole vocabulary.
 *
 * Add-only by construction. Only levels the sibling maps to a string come
 * across, so an id that reaches this path can gain the top of the scale but
 * never lose a level that works today, and never takes on a sibling's spelling
 * for off/low/medium/high - the dialect rules downstream own those.
 *
 * Measured against the live catalog at the time of writing: exactly two ids
 * enter this path, `anthropic/claude-opus-5-5` and
 * `openrouter/anthropic/claude-opus-5.5`, each inheriting xhigh and max from
 * `claude-opus-5`. No other family in that catalog was touched.
 */
function inheritedLevelMap(
  id: string,
  dialect: PengepulDialect,
  lookup: BuiltinModelLookup | undefined,
): Record<string, string | null> | undefined {
  const siblingId = previousMinorId(id)
  const siblingMap = siblingId ? lookup?.(siblingId, dialect)?.thinkingLevelMap : undefined
  if (!siblingMap) return undefined

  const inherited: Record<string, string | null> = {}
  for (const level of INHERITED_LEVELS) {
    const mapped = siblingMap[level]
    if (typeof mapped === "string") inherited[level] = mapped
  }
  return Object.keys(inherited).length > 0 ? inherited : undefined
}

/**
 * The same id one minor older, keeping the routing namespace:
 * `anthropic/claude-opus-5-5` -> `anthropic/claude-opus-5`, and the dotted
 * `claude-opus-5.5` -> `claude-opus-5` for the Chat Completions spelling.
 * Undefined when the name carries no trailing version segment to drop, which
 * keeps qualifiers (`-preview`, `-flash`, `-fast`) out of the derivation.
 */
function previousMinorId(id: string): string | undefined {
  const slash = id.lastIndexOf("/")
  const name = slash === -1 ? id : id.slice(slash + 1)
  const stripped = name.replace(/[.-]\d+$/, "")
  if (stripped === name || stripped === "") return undefined
  return slash === -1 ? stripped : `${id.slice(0, slash + 1)}${stripped}`
}

/**
 * Resolve a model's metadata, most trustworthy source first:
 *   1. what pengepul advertises (first-party for this relay),
 *   2. pi's builtin catalogs for the id (the same id upstream),
 *   3. family heuristics.
 * Sources merge per field, so a relay that sends only `context_window` still
 * picks up pricing and modalities from the catalog.
 *
 * A catalog miss on a reasoning model still gets its extended levels from the
 * family's previous minor where the catalog carries one (`inheritedLevelMap`);
 * the namespace fallback for the Chat Completions wire then takes precedence
 * over both.
 */
function metaFor(
  entry: Record<string, unknown>,
  id: string,
  dialect: PengepulDialect,
  lookup: BuiltinModelLookup | undefined,
): BuiltinModelMeta {
  const known = lookup?.(id, dialect)
  const base = known ?? heuristicMeta(id)
  const relay = metaFromRelayEntry(entry)
  const meta = relay ? { ...base, ...relay } : base

  // A model the relay tags `anthropic` is Claude-family, hence reasoning-
  // capable, even when pi's catalog does not know its exact id yet.
  const reasoning = meta.reasoning || entry["owned_by"] === "anthropic"

  // The lookup searches every provider's catalog, so a hit need not come from
  // the id's own vendor: github-copilot answers for
  // `commandcode/google/gemini-3.8-flash` and carries no map, which is silence
  // about another provider, not an answer about this relay. The fallback still
  // stops there, deliberately. Measuring this relay shows which efforts it
  // accepts and never which ones the upstream honours, so an entry's silence
  // is left as silence and those ids keep pi's default until per-vendor
  // evidence exists - the way DeepSeek's documented scale settled the ids the
  // fallback does serve.
  const fallback =
    known || !reasoning || dialect !== "openai-completions" ? undefined : fallbackLevelMap(id)

  // A catalog miss is not always silence: the family's previous minor answers
  // for the levels the catalog has not named yet. Whatever the base resolved
  // wins over it, so a relay that starts advertising a map still outranks this.
  const inherited = known || !reasoning ? undefined : inheritedLevelMap(id, dialect, lookup)
  const levelMap = inherited
    ? { ...inherited, ...(meta.thinkingLevelMap ?? {}) }
    : meta.thinkingLevelMap

  return {
    ...meta,
    reasoning,
    ...(levelMap ? { thinkingLevelMap: levelMap } : {}),
    ...(fallback ? { thinkingLevelMap: fallback } : {}),
  }
}

function toPengepulModel(
  entry: Record<string, unknown>,
  lookup: BuiltinModelLookup | undefined,
): PengepulModel {
  const id = stringField(entry, "id")
  const dialect = dialectForModelId(id)
  const meta = metaFor(entry, id, dialect, lookup)
  const reasoning = meta.reasoning

  // The relay's request layer validates reasoning_effort on `commandcode/`
  // ids: `minimal` 400s there, and its thinking toggle never actually disables
  // thinking. On `openrouter/` ids it validates nothing, so `minimal` is a real
  // level there and is left in place. `off` is different and stays nulled
  // everywhere: `none` is refused by some upstreams (gemini-3.8-flash 400s on
  // it) and accepted by others (deepseek), which is no basis for sending it.
  // Either way every openai-completions reasoning model gets the relay's shape:
  // inherited strings case-folded to the enum (pi's catalogs spell Google
  // efforts `HIGH` and Qwen's `default`), values that match under no casing
  // hidden. Overlay, never replace: inherited nulls keep their levels hidden.
  // The Messages dialect needs none of this: it folds `minimal` into `low` and
  // already nulls `off` via forceAdaptiveThinking.
  const enforceRelayEnum = reasoning && dialect === "openai-completions"
  const thinkingLevelMap = relaySafeLevelMap(
    meta.thinkingLevelMap,
    enforceRelayEnum,
    relayAcceptsMinimal(id),
  )

  return {
    id,
    name: displayName(id),
    dialect,
    reasoning,
    input: [...meta.input],
    cost: { ...meta.cost },
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  }
}

/** The efforts the relay accepts; anything else is rejected at its request layer. */
const RELAY_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"])

/**
 * Whether the relay's request layer takes `minimal` for this id.
 *
 * Measured: `commandcode/` validates its enum and answers 400 Invalid option:
 * expected one of "low"|"medium"|"high"|"xhigh"|"max", while `openrouter/`
 * validates nothing and answers 200 - so hiding `minimal` there costs 166 of
 * the 227 openrouter models that reason, a level the relay accepts.
 *
 * `none` is not the same story: gemini-3.8-flash answers 400 on it while
 * deepseek accepts it, so `off` stays hidden in every namespace. An unmeasured
 * namespace keeps the conservative default too.
 */
function relayAcceptsMinimal(id: string): boolean {
  return id.toLowerCase().startsWith("openrouter/")
}

/**
 * Shape an inherited level map for the relay's wire. With `enforce` (an
 * openai-completions reasoning model) the relay's enum is the only vocabulary
 * that reaches it: inherited strings are case-folded to the enum or hidden,
 * and `off` is always hidden. `minimal` is hidden unless the namespace is
 * known to take it. Without `enforce` the map passes through.
 */
function relaySafeLevelMap(
  inherited: Record<string, string | null> | undefined,
  enforce: boolean,
  acceptsMinimal = false,
): Record<string, string | null> | undefined {
  if (!enforce) return inherited ? { ...inherited } : undefined

  const map: Record<string, string | null> = {}
  for (const [level, mapped] of Object.entries(inherited ?? {})) {
    map[level] = typeof mapped === "string" ? relayEffort(mapped, acceptsMinimal) : mapped
  }
  map["off"] = null
  if (!acceptsMinimal) map["minimal"] = null
  return map
}

/** The relay's effort enum, case-folded; null keeps the level out of the picker. */
function relayEffort(value: string, acceptsMinimal: boolean): string | null {
  if (RELAY_EFFORTS.has(value)) return value
  const lower = value.toLowerCase()
  if (RELAY_EFFORTS.has(lower)) return lower
  return acceptsMinimal && lower === "minimal" ? lower : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string`)
  }
  return value
}

/**
 * The relay lists OpenRouter's batch routes as models, and OpenRouter refuses
 * them on the chat wire with 404 "This model is only available through the
 * Batch API". Confirmed on 10 of the relay's 77 batch ids across anthropic,
 * openai, qwen, deepseek and z-ai; the rest are inferred from the same route
 * rule, because probing them in bulk does not work - the refusals put the
 * relay's pooled openrouter account on cooldown, which turns every following
 * probe into 503 "no available openrouter account" and measures the cooldown
 * rather than the model. Nothing pi sends can reach them, so they are left
 * out of the catalog rather than offered as an entry that always fails.
 */
function isBatchRoute(id: string): boolean {
  return id.endsWith(":batch")
}

/**
 * Drop the ids this relay cannot serve on either wire. Applied on the way in
 * from the relay and on the way in from the cache: the cache is what covers a
 * briefly absent relay, so it must not be the path that resurrects a route
 * the live catalog would have dropped.
 */
function servableModels(models: readonly PengepulModel[]): PengepulModel[] {
  return models.filter((model) => !isBatchRoute(model.id))
}

/** Parse the raw `/v1/models` body into models. Throws on a malformed body. */
export function modelsFromApiResponse(
  value: unknown,
  lookupBuiltin?: BuiltinModelLookup,
): readonly PengepulModel[] {
  if (!isRecord(value)) throw new Error("Expected models response to be an object")
  if (value["object"] !== "list") throw new Error("Expected models response object to be 'list'")

  const data = value["data"]
  if (!Array.isArray(data)) throw new Error("Expected models response data to be an array")

  const models = servableModels(
    data.map((entry) => {
      if (!isRecord(entry)) throw new Error("Expected model entry to be an object")
      return toPengepulModel(entry, lookupBuiltin)
    }),
  )

  if (models.length === 0) throw new Error("pengepul returned an empty model catalog")
  return models
}

import type { Api, Model } from "@earendil-works/pi-ai"

/** The pi-ai model shapes this provider serves: one per dialect the relay speaks. */
export type PengepulModelEntry = Model<"anthropic-messages"> | Model<"openai-completions">

/** The provider id every pengepul model is stamped with. */
export const PENGEPUL_PROVIDER_ID = "pengepul"

/** What every model carries regardless of wire: identity, pricing, and the limits. */
function sharedModelFields(model: PengepulModel, relayBase: string) {
  return {
    id: model.id,
    name: model.name,
    provider: PENGEPUL_PROVIDER_ID,
    baseUrl: baseUrlForDialect(relayBase, model.dialect),
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }
}

/**
 * The relay's prompt-cache affinity pin, on both wires.
 *
 * The relay's conversation_key resolves `x-claude-code-session-id`, then
 * `x-session-id`, then the body's `prompt_cache_key`, then a hash of the
 * cacheable prefix. pi emits one of those headers only for the `openrouter`
 * affinity format, and only when the send flag is set. Both auto-detected
 * defaults are wrong here: openai-completions picks `openai` (session_id +
 * x-client-request-id + x-session-affinity) and anthropic-messages picks
 * nothing at all. The header is the cheaper and more explicit of the two
 * signals and it outranks the body field, so the pin keeps a session's account
 * stable by the relay's first rule rather than its third. Losing it costs a
 * session that migrates between pooled accounts its whole prefix: the upstream
 * cache is per account.
 *
 * Measured, not assumed — `test/affinity-wire.test.ts` dumps both bodies:
 * openai-completions carries `prompt_cache_key: <sessionId>` (and
 * `prompt_cache_retention: "24h"`) under PI_CACHE_RETENTION=long, so the body
 * field alone would name the conversation; anthropic-messages carries no
 * `prompt_cache_key` at all, and pi-ai hardcodes `x-session-affinity` there,
 * which this relay does not read. Messages traffic therefore rests entirely on
 * the relay's prefix fallback until a pi release honours
 * `sessionAffinityFormat` on that dialect.
 *
 * The two dialects do not land at the same time. openai-completions honors
 * `sessionAffinityFormat` in every released pi. anthropic-messages only reads it
 * from the unreleased change on pi main (commit bbb61e34a), which is why the
 * field is re-declared below rather than taken from `AnthropicMessagesCompat`:
 * against pi-ai 0.85.1 the pin is inert, and the cost of an ignored header is
 * zero. Pin now rather than later — the cost of forgetting is silently
 * re-billed Claude prefixes.
 */
function affinityPin() {
  return {
    sendSessionAffinityHeaders: true as const,
    sessionAffinityFormat: "openrouter" as const,
  }
}

/**
 * Anthropic compat as pi-ai 0.85.1 types it, plus the affinity format a later
 * pi reads. Declared here so the pin does not depend on the host's pi-ai
 * version; the field is optional, so a host that predates it ignores the value.
 */
type AnthropicCompat = NonNullable<Model<"anthropic-messages">["compat"]> & {
  sessionAffinityFormat?: "openrouter"
}

/**
 * Map the relay catalog to pi models, one base URL per dialect. Pure.
 *
 * The per-model `baseUrl` is the only place the dialect split can live: pi
 * applies a base URL returned from `auth.resolve()` to every model at once
 * (`models.js` `applyAuth`), so a provider-wide value would send Anthropic
 * Messages traffic to `/v1` and Chat Completions traffic to the root.
 */
export function toPengepulModels(
  models: readonly PengepulModel[],
  relayBase: string,
): PengepulModelEntry[] {
  return models.map((model) => {
    const shared = sharedModelFields(model, relayBase)
    if (model.dialect === "anthropic-messages") {
      const adaptive = model.reasoning
      return {
        ...shared,
        api: "anthropic-messages" as const,
        // Inherited level mapping (e.g. deepseek {high:"high"}) flows through;
        // adaptive Claude models additionally mark "off" unsupported so the
        // stream omits thinking:{type:"disabled"} (upstream rejects it).
        ...(model.thinkingLevelMap || adaptive
          ? {
              thinkingLevelMap: {
                ...(model.thinkingLevelMap ?? {}),
                ...(adaptive ? { off: null } : {}),
              },
            }
          : {}),
        // Reasoning-capable Claude models run on the adaptive-thinking wire:
        // pi's streamSimple always passes thinkingEnabled:false when no level is
        // selected, and the stream would send thinking:{type:"disabled"}, which
        // the upstream rejects (400: "thinking.type.disabled is not supported
        // for this model"). thinkingLevelMap.off = null marks "off" as
        // unsupported so pi omits the thinking param entirely (server default
        // = adaptive), and forceAdaptiveThinking routes an explicit level to
        // {type:"adaptive"} + effort instead of budget_tokens.
        //
        // The 1h cache TTL is a Messages-dialect feature too: `cache_control.ttl`
        // has nowhere to go on the Chat Completions wire. Reasoning is not part
        // of it — a non-reasoning Claude model caches the same way.
        compat: {
          ...affinityPin(),
          ...(adaptive ? { forceAdaptiveThinking: true as const } : {}),
          supportsLongCacheRetention: true as const,
        } satisfies AnthropicCompat,
      }
    }

    return {
      ...shared,
      api: "openai-completions" as const,
      ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      compat: { ...affinityPin() },
    }
  })
}

/** Whether a stored pi model is one this provider published. */
export function isPengepulModelEntry(model: Model<Api>): model is PengepulModelEntry {
  return (
    model.provider === PENGEPUL_PROVIDER_ID &&
    (model.api === "anthropic-messages" || model.api === "openai-completions")
  )
}

/**
 * Re-derive every model's base URL from the base currently configured.
 *
 * pi's model store keeps whole models, baseUrl included, and replays them
 * before the network phase. A relay that moved would otherwise be reached at
 * its old address until a fetch succeeds — which never happens when the old
 * address is gone.
 */
export function restampRelayBase(
  models: readonly PengepulModelEntry[],
  relayBase: string,
): PengepulModelEntry[] {
  return models.map((model) => ({
    ...model,
    baseUrl: baseUrlForDialect(relayBase, model.api),
  }))
}

/** Picker label: the bare model part of a relay id, suffixed. `anthropic/claude-opus-5` -> `claude-opus-5 (pengepul)`. */
function displayName(id: string): string {
  return `${bareId(id)} (pengepul)`
}

interface FetchModelsOptions {
  url?: string
  apiKey?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
  lookupBuiltin?: BuiltinModelLookup
}

interface LoadModelsOptions extends FetchModelsOptions {
  cachePath: string
  relayBase: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException("The operation was aborted", "AbortError")
}

function configuredTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_MODELS_TIMEOUT_MS
}

export function getModelsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MODELS_TIMEOUT_MS_ENV]
  if (!raw) return DEFAULT_MODELS_TIMEOUT_MS
  const parsed = Number(raw)
  return configuredTimeoutMs(parsed)
}

class ModelDiscoveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`pengepul model discovery timed out after ${timeoutMs}ms`)
    this.name = "ModelDiscoveryTimeoutError"
  }
}

function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let onExternalAbort: (() => void) | undefined

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (onExternalAbort && externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort)
      }
    }

    const resolveOnce = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const abort = (reason: unknown) => {
      const error = abortError(reason)
      controller.abort(error)
      rejectOnce(error)
    }

    if (externalSignal?.aborted) {
      abort(externalSignal.reason)
      return
    }

    onExternalAbort = () => abort(externalSignal?.reason)
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
    timer = setTimeout(() => abort(new ModelDiscoveryTimeoutError(timeoutMs)), timeoutMs)

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(resolveOnce, rejectOnce)
  })
}

export async function fetchPengepulModels(
  options: FetchModelsOptions = {},
): Promise<readonly PengepulModel[]> {
  const url = options.url ?? `${DEFAULT_RELAY_BASE}/v1/models`
  const fetchImpl = options.fetchImpl ?? fetch
  const apiKey = options.apiKey

  const headers: Record<string, string> = {
    accept: "application/json",
  }
  if (apiKey) headers["x-api-key"] = apiKey

  const body: unknown = await runWithTimeout(
    async (signal) => {
      const response = await fetchImpl(url, { headers, signal })

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `pengepul rejected the API key (${
            response.status
          }). Run /login pengepul, or set the key in ~/.pi/agent/auth.json or PENGEPUL_API_KEY.`,
        )
      }
      if (!response.ok) {
        throw new Error(
          `Failed to fetch pengepul models: ${response.status} ${response.statusText}`,
        )
      }

      return await response.json()
    },
    configuredTimeoutMs(options.timeoutMs),
    options.signal,
  )

  return modelsFromApiResponse(body, options.lookupBuiltin)
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${key} to be a finite number`)
  }
  return value
}

function inputField(record: Record<string, unknown>, key: string): ModelInput {
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`Expected ${key} to be an array`)
  return value.map((entry) => {
    if (entry !== "text" && entry !== "image") {
      throw new Error(`Expected ${key} entries to be "text" or "image"`)
    }
    return entry
  })
}

function costField(record: Record<string, unknown>, key: string): ModelCostRates {
  const value = record[key]
  if (!isRecord(value)) throw new Error(`Expected ${key} to be an object`)
  return {
    input: numberField(value, "input"),
    output: numberField(value, "output"),
    cacheRead: numberField(value, "cacheRead"),
    cacheWrite: numberField(value, "cacheWrite"),
  }
}

function levelMapField(
  record: Record<string, unknown>,
  key: string,
): Record<string, string | null> {
  const value = record[key]
  if (!isRecord(value)) throw new Error(`Expected ${key} to be an object`)
  const map: Record<string, string | null> = {}
  for (const [level, mapped] of Object.entries(value)) {
    if (mapped !== null && typeof mapped !== "string") {
      throw new Error(`Expected ${key} values to be strings or null`)
    }
    map[level] = mapped
  }
  return map
}

export function modelsFromCache(value: unknown): readonly PengepulModel[] {
  if (!isRecord(value)) throw new Error("Expected model cache to be an object")
  if (value["version"] !== MODEL_CACHE_VERSION) {
    throw new Error(`Expected model cache version ${MODEL_CACHE_VERSION}`)
  }
  if (!Array.isArray(value["models"])) throw new Error("Expected cached models to be an array")

  const parsed: PengepulModel[] = value["models"].map((entry) => {
    if (!isRecord(entry)) throw new Error("Expected cached model entry to be an object")
    return {
      id: stringField(entry, "id"),
      name: stringField(entry, "name"),
      dialect: stringField(entry, "dialect") as PengepulDialect,
      reasoning: entry["reasoning"] === true,
      input: inputField(entry, "input"),
      cost: costField(entry, "cost"),
      contextWindow: numberField(entry, "contextWindow"),
      maxTokens: numberField(entry, "maxTokens"),
      ...(entry["thinkingLevelMap"] !== undefined
        ? { thinkingLevelMap: levelMapField(entry, "thinkingLevelMap") }
        : {}),
    }
  })
  const servable = servableModels(parsed)
  if (servable.length === 0) throw new Error("pengepul cache holds no valid models")
  return servable
}

async function readCache(cachePath: string): Promise<readonly PengepulModel[]> {
  const contents = await readFile(cachePath, "utf-8")
  return modelsFromCache(JSON.parse(contents))
}

/** Reads the cached catalog without touching the network; empty when missing/invalid. */
export async function loadCachedPengepulModels(
  cachePath: string,
): Promise<readonly PengepulModel[]> {
  try {
    return await readCache(cachePath)
  } catch {
    return []
  }
}


