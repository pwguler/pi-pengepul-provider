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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"

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

/** A pengepul model ready to become a pi `ProviderModelConfig`. */
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

export interface PengepulModelSource {
  models: readonly PengepulModel[]
  /** "live" = fetched from the relay; "cache" = read from disk; "empty" = none. */
  source: "live" | "cache" | "empty"
  warning?: string
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
 * Resolve a model's metadata, most trustworthy source first:
 *   1. what pengepul advertises (first-party for this relay),
 *   2. pi's builtin catalogs for the id (the same id upstream),
 *   3. family heuristics.
 * Sources merge per field, so a relay that sends only `context_window` still
 * picks up pricing and modalities from the catalog.
 */
function metaFor(
  entry: Record<string, unknown>,
  id: string,
  dialect: PengepulDialect,
  lookup: BuiltinModelLookup | undefined,
): BuiltinModelMeta {
  const base = lookup?.(id, dialect) ?? heuristicMeta(id)
  const relay = metaFromRelayEntry(entry)
  return relay ? { ...base, ...relay } : base
}

function toPengepulModel(
  entry: Record<string, unknown>,
  lookup: BuiltinModelLookup | undefined,
): PengepulModel {
  const id = stringField(entry, "id")
  const dialect = dialectForModelId(id)
  const meta = metaFor(entry, id, dialect, lookup)
  const ownedBy = entry["owned_by"]

  // A model the relay tags `anthropic` is Claude-family, hence reasoning-
  // capable, even when pi's catalog does not know its exact id yet.
  const reasoning = meta.reasoning || ownedBy === "anthropic"

  // The relay enforces reasoning_effort low|medium|high|xhigh|max at its
  // request layer, uniformly across families: `minimal` 400s and its thinking
  // toggle never actually disables thinking. That holds no matter where the
  // reasoning knowledge came from, so every openai-completions reasoning model
  // gets the relay's shape: inherited strings case-folded to the enum (pi's
  // catalogs spell Google efforts `HIGH` and Qwen's `default`), values that
  // match under no casing hidden, and off/minimal always null. Overlay, never
  // replace: inherited nulls keep their levels hidden. The Messages dialect
  // needs none of this: it folds `minimal` into `low` and already nulls `off`
  // via forceAdaptiveThinking.
  const thinkingLevelMap = relaySafeLevelMap(
    meta.thinkingLevelMap,
    reasoning && dialect === "openai-completions",
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
 * Shape an inherited level map for the relay's wire. With `enforce` (an
 * openai-completions reasoning model) the relay's enum is the only vocabulary
 * that reaches it: inherited strings are case-folded to the enum or hidden,
 * and off/minimal are always hidden. Without it the map passes through.
 */
function relaySafeLevelMap(
  inherited: Record<string, string | null> | undefined,
  enforce: boolean,
): Record<string, string | null> | undefined {
  if (!enforce) return inherited ? { ...inherited } : undefined

  const map: Record<string, string | null> = {}
  for (const [level, mapped] of Object.entries(inherited ?? {})) {
    map[level] = typeof mapped === "string" ? relayEffort(mapped) : mapped
  }
  map["off"] = null
  map["minimal"] = null
  return map
}

/** The relay's effort enum, case-folded; null keeps the level out of the picker. */
function relayEffort(value: string): string | null {
  if (RELAY_EFFORTS.has(value)) return value
  const lower = value.toLowerCase()
  return RELAY_EFFORTS.has(lower) ? lower : null
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

/** Parse the raw `/v1/models` body into models. Throws on a malformed body. */
export function modelsFromApiResponse(
  value: unknown,
  lookupBuiltin?: BuiltinModelLookup,
): readonly PengepulModel[] {
  if (!isRecord(value)) throw new Error("Expected models response to be an object")
  if (value["object"] !== "list") throw new Error("Expected models response object to be 'list'")

  const data = value["data"]
  if (!Array.isArray(data)) throw new Error("Expected models response data to be an array")
  if (data.length === 0) throw new Error("pengepul returned an empty model catalog")

  return data.map((entry) => {
    if (!isRecord(entry)) throw new Error("Expected model entry to be an object")
    return toPengepulModel(entry, lookupBuiltin)
  })
}

/** Map models to pi `ProviderModelConfig` entries. Pure. */
export function toProviderModelConfigs(
  models: readonly PengepulModel[],
  relayBase: string,
): Array<{
  id: string
  name: string
  api: PengepulDialect
  baseUrl: string
  reasoning: boolean
  input: ("text" | "image")[]
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  contextWindow: number
  maxTokens: number
  thinkingLevelMap?: Record<string, string | null>
  compat?: { forceAdaptiveThinking?: boolean; supportsLongCacheRetention?: boolean }
}> {
  return models.map((model) => {
    const adaptive = model.dialect === "anthropic-messages" && model.reasoning
    // The 1h cache TTL is a Messages-dialect feature: `cache_control.ttl`
    // has nowhere to go on the Chat Completions wire. Reasoning is not part
    // of it — a non-reasoning Claude model caches the same way.
    const longCacheRetention = model.dialect === "anthropic-messages"
    return {
      id: model.id,
      name: model.name,
      api: model.dialect,
      baseUrl: baseUrlForDialect(relayBase, model.dialect),
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      // Inherited level mapping (e.g. deepseek {high:"high"}) flows through;
      // adaptive Claude models additionally mark "off" unsupported so the
      // stream omits thinking:{type:"disabled"} (upstream rejects it).
      ...(model.thinkingLevelMap || adaptive
        ? { thinkingLevelMap: { ...(model.thinkingLevelMap ?? {}), ...(adaptive ? { off: null } : {}) } }
        : {}),
      // Reasoning-capable Claude models run on the adaptive-thinking wire:
      // pi's streamSimple always passes thinkingEnabled:false when no level is
      // selected, and the stream would send thinking:{type:"disabled"}, which
      // the upstream rejects (400: "thinking.type.disabled is not supported
      // for this model"). thinkingLevelMap.off = null marks "off" as
      // unsupported so pi omits the thinking param entirely (server default
      // = adaptive), and forceAdaptiveThinking routes an explicit level to
      // {type:"adaptive"} + effort instead of budget_tokens.
      ...(adaptive || longCacheRetention
        ? {
            compat: {
              ...(adaptive ? { forceAdaptiveThinking: true as const } : {}),
              ...(longCacheRetention ? { supportsLongCacheRetention: true as const } : {}),
            },
          }
        : {}),
    }
  })
}

/** Picker label: the bare model part of a relay id, suffixed. `anthropic/claude-opus-5` -> `claude-opus-5 (pengepul)`. */
function displayName(id: string): string {
  const slash = id.indexOf("/")
  const bare = slash === -1 ? id : id.slice(slash + 1)
  return `${bare} (pengepul)`
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
  const raw = env["PENGEPUL_MODELS_TIMEOUT_MS"]
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
          }). Set PENGEPUL_API_KEY or check ~/.pengepul/config.yaml.`,
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
  if (parsed.length === 0) throw new Error("pengepul cache holds no valid models")
  return parsed
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

async function writeCache(cachePath: string, models: readonly PengepulModel[]): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  // Unique per write: the runtime can issue two overlapping writes in one
  // process (cache-first + background refresh), and a shared pid-keyed name
  // would let the first rename remove the second's source mid-flight.
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`

  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: MODEL_CACHE_VERSION, models }, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    )
    await rename(temporaryPath, cachePath)
  } finally {
    try {
      await rm(temporaryPath, { force: true })
    } catch {
      // Best-effort cleanup must not hide the original cache write error.
    }
  }
}

export async function loadPengepulModels(
  options: LoadModelsOptions,
): Promise<PengepulModelSource> {
  const cachePath = options.cachePath

  try {
    const models = await fetchPengepulModels(options)

    try {
      await writeCache(cachePath, models)
      return { models, source: "live" }
    } catch (error) {
      return {
        models,
        source: "live",
        warning: `Loaded the live pengepul model catalog but could not update ${cachePath}: ${errorMessage(error)}`,
      }
    }
  } catch (liveError) {
    if (options.signal?.aborted) throw abortError(options.signal.reason ?? liveError)

    try {
      const models = await readCache(cachePath)
      return {
        models,
        source: "cache",
        warning: `Could not refresh the pengepul model catalog (${errorMessage(liveError)}). Using the cached catalog from ${cachePath}.`,
      }
    } catch (cacheError) {
      return {
        models: [],
        source: "empty",
        warning: `Could not refresh the pengepul model catalog (${errorMessage(liveError)}), and no valid cached catalog is available at ${cachePath} (${errorMessage(cacheError)}). pengepul models will remain unavailable until the next startup refresh succeeds.`,
      }
    }
  }
}


