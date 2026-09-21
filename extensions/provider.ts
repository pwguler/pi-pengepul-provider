/**
 * The pengepul provider, as pi-ai sees it.
 *
 * Registered as a native provider, so pi resolves auth through this module and
 * hands the credential back to `refreshModels`. That closes two gaps the
 * config-value form had: model discovery now uses the same resolved key pi uses
 * for requests (it used to read only `PENGEPUL_API_KEY` and pengepul's own
 * config, so a key stored in `auth.json` produced a 401), and the relay base
 * comes from the credential instead of the environment.
 *
 * The relay base lives on the credential as `baseUrl`, a field pi core does not
 * read. Per-model base URLs are derived from it, because pi applies a base URL
 * returned from `resolve()` to every model at once and pengepul's two wires need
 * different paths (`/` for Messages, `/v1` for Chat Completions).
 */

import type {
  Api,
  ApiKeyCredential,
  AuthCheck,
  AuthResult,
  Model,
  Provider,
  ProviderAuthInteraction,
  ProviderStreams,
  RefreshModelsContext,
} from "@earendil-works/pi-ai"
import { anthropicMessagesApi, lazyStream, openAICompletionsApi } from "@earendil-works/pi-ai/compat"

import { API_KEY_ENV, extractApiKeys } from "./api-key.ts"
import { RELAY_BASE_ENV } from "./config.ts"
import {
  credentialApiKey,
  credentialRelayBase,
  relayBaseFromConfigText,
  resolveApiKey,
  resolveRelayBase,
  type PengepulCredential,
} from "./credential.ts"
import { modelsUrl, type PengepulDialect } from "./dialect.ts"
import {
  DEFAULT_RELAY_BASE,
  fetchPengepulModels,
  getModelsTimeoutMs,
  isPengepulModelEntry,
  loadCachedPengepulModels,
  PENGEPUL_PROVIDER_ID,
  restampRelayBase,
  toPengepulModels,
  type BuiltinModelLookup,
  type PengepulModelEntry,
} from "./models.ts"

/** The credential this provider writes: the relay key plus the base it applies to. */
export interface PengepulApiKeyCredential extends ApiKeyCredential {
  type: "api_key"
  key?: string
  baseUrl?: string
}

/** Where the config-file fallback key comes from, for the status label. */
const CONFIG_FILE_LABEL = "~/.pengepul/config.yaml"

export interface PengepulProviderOptions {
  /** Environment map holding the optional `PENGEPUL_*` overrides. */
  env?: Record<string, string | undefined>
  /** Text of pengepul's own config, when this machine happens to run the relay. */
  configText?: string
  /** Where the pre-0.3 catalog cache lives; read once to seed pi's store. */
  legacyCachePath: string
  /** Catalog fetch transport, for tests. */
  fetchImpl?: typeof fetch
  /** Builtin metadata lookup, injected so the catalog logic stays free of pi imports. */
  lookupBuiltin?: BuiltinModelLookup
  /** Warning sink; defaults to `console.warn`. */
  logWarning?: (message: string) => void
  /** Clock, for tests. */
  now?: () => number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The `Api` union is open-ended, so narrow it before indexing by wire. */
function isPengepulDialect(api: Api): api is PengepulDialect {
  return api === "anthropic-messages" || api === "openai-completions"
}

/**
 * A provider whose catalog comes from pengepul and whose auth is the relay key.
 *
 * Ambient sources are read from the captured environment and config text, not
 * from `AuthContext.env`, because `refreshModels` receives no auth context and
 * both paths must agree on what the key and base are.
 */
export function createPengepulProvider(options: PengepulProviderOptions): Provider {
  const env = options.env ?? process.env
  const logWarning =
    options.logWarning ?? ((message: string) => console.warn(`[pengepul] ${message}`))
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = getModelsTimeoutMs(env as NodeJS.ProcessEnv)

  const environmentRelayBase = env[RELAY_BASE_ENV]
  const environmentApiKey = env[API_KEY_ENV]
  const configText = options.configText
  const configRelayBase = relayBaseFromConfigText(configText)
  const configApiKey = configText ? extractApiKeys(configText)[0] : undefined

  let models: PengepulModelEntry[] = []

  /** The key from outside auth.json, with the label the status UI shows. */
  function ambientKey(): { key?: string; source?: string } {
    if (environmentApiKey?.trim()) return { key: environmentApiKey.trim(), source: API_KEY_ENV }
    if (configApiKey) return { key: configApiKey, source: CONFIG_FILE_LABEL }
    return {}
  }

  function resolveKey(credential: unknown): { key?: string; source?: string } {
    const stored = credentialApiKey(credential as PengepulCredential | undefined)
    if (stored) return { key: stored, source: "stored credential" }
    return ambientKey()
  }

  const streams: Record<PengepulDialect, ProviderStreams> = {
    "anthropic-messages": anthropicMessagesApi(),
    "openai-completions": openAICompletionsApi(),
  }

  function streamsFor(model: Model<Api>): ProviderStreams | undefined {
    return isPengepulDialect(model.api) ? streams[model.api] : undefined
  }

  function unsupported(model: Model<Api>) {
    return lazyStream(model, async () => {
      throw new Error(`pengepul serves no "${model.api}" wire, so ${model.id} cannot be streamed`)
    })
  }

  async function restoreOrSeed(context: RefreshModelsContext): Promise<boolean> {
    const relayBase = resolveRelayBase({
      credential: credentialRelayBase(context.credential as PengepulCredential | undefined),
      environment: environmentRelayBase,
      config: configRelayBase,
    })

    const stored = (context.stored?.models ?? []).filter(isPengepulModelEntry)
    if (stored.length > 0) {
      const restored = restampRelayBase(stored, relayBase)
      return context.publish({ update: () => { models = restored } })
    }

    // Pre-0.3 installs kept their own cache file. Read it once so an upgrade
    // does not start blind; pi's store owns the catalog from here on.
    const legacy = await loadCachedPengepulModels(options.legacyCachePath)
    if (legacy.length === 0) return true
    const seeded = toPengepulModels(legacy, relayBase)
    return context.publish({ update: () => { models = seeded } })
  }

  async function refreshFromRelay(context: RefreshModelsContext): Promise<void> {
    const relayBase = resolveRelayBase({
      credential: credentialRelayBase(context.credential as PengepulCredential | undefined),
      environment: environmentRelayBase,
      config: configRelayBase,
    })

    const resolved = resolveKey(context.credential)
    if (!resolved.key) {
      logWarning(
        `No pengepul API key is configured (${API_KEY_ENV}, ${CONFIG_FILE_LABEL}, or auth.json), so the model catalog cannot be refreshed. Run /login pengepul.`,
      )
      return
    }

    try {
      const catalog = await fetchPengepulModels({
        url: modelsUrl(relayBase),
        apiKey: resolved.key,
        fetchImpl,
        timeoutMs,
        signal: context.signal,
        ...(options.lookupBuiltin ? { lookupBuiltin: options.lookupBuiltin } : {}),
      })
      if (context.signal.aborted) return

      const entries = toPengepulModels(catalog, relayBase)
      await context.publish({
        persist: { models: entries, checkedAt: now() },
        update: () => { models = entries },
      })
    } catch (error) {
      if (context.signal.aborted) return
      logWarning(
        `Could not refresh the pengepul model catalog (${errorMessage(error)}). Keeping the last known catalog.`,
      )
    }
  }

  return {
    id: PENGEPUL_PROVIDER_ID,
    name: "Pengepul",
    baseUrl: resolveRelayBase({
      environment: environmentRelayBase,
      config: configRelayBase,
    }),
    auth: {
      apiKey: {
        name: "Pengepul relay",
        login: async (
          interaction: ProviderAuthInteraction,
        ): Promise<PengepulApiKeyCredential> => {
          const key = (await interaction.prompt({
            type: "secret",
            message: "Pengepul API key",
          })).trim()
          const answer = (await interaction.prompt({
            type: "text",
            message: "Pengepul relay URL",
            placeholder: DEFAULT_RELAY_BASE,
          })).trim()
          // Written, not defaulted at read time: pi replaces the whole
          // credential on login, so the URL has to be in the stored entry or a
          // key rotation silently points the relay back at loopback.
          return {
            type: "api_key",
            ...(key === "" ? {} : { key }),
            baseUrl: resolveRelayBase({ credential: answer }),
          }
        },
        check: async (input): Promise<AuthCheck | undefined> => {
          const resolved = resolveKey(input.credential)
          return resolved.key
            ? { type: "api_key", ...(resolved.source ? { source: resolved.source } : {}) }
            : undefined
        },
        resolve: async (input): Promise<AuthResult | undefined> => {
          const resolved = resolveKey(input.credential)
          if (!resolved.key) return undefined
          // No `baseUrl` here on purpose: pi would apply it to every model and
          // collapse the two dialect base URLs into one.
          return {
            auth: { apiKey: resolved.key },
            ...(resolved.source ? { source: resolved.source } : {}),
          }
        },
      },
    },
    getModels: () => models,
    refreshModels: async (context) => {
      if (!(await restoreOrSeed(context))) return
      if (!context.allowNetwork || context.signal.aborted) return
      await refreshFromRelay(context)
    },
    stream: (model, context, streamOptions) => {
      const implementation = streamsFor(model)
      return implementation
        ? implementation.stream(model, context, streamOptions)
        : unsupported(model)
    },
    streamSimple: (model, context, streamOptions) => {
      const implementation = streamsFor(model)
      return implementation
        ? implementation.streamSimple(model, context, streamOptions)
        : unsupported(model)
    },
  }
}