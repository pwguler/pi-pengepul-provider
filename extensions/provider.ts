/**
 * The pengepul provider, as pi-ai sees it.
 *
 * Registered as a native provider, so pi resolves auth through this module and
 * hands the credential back to `refreshModels`. Discovery and requests
 * therefore resolve the same key and the same relay base: environment first,
 * then the credential. A provider declared as plain config values has no
 * credential at discovery time, so a key stored in `auth.json` left its
 * catalog fetch with nothing to send but an environment variable, and a 401.
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

import { API_KEY_ENV, RELAY_BASE_ENV } from "./config.ts"
import {
  credentialApiKey,
  credentialEnv,
  credentialRelayBase,
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

export interface PengepulProviderOptions {
  /** Environment map holding the optional `PENGEPUL_*` overrides. */
  env?: Record<string, string | undefined>
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
 * The environment overrides are read from the captured environment, not from
 * `AuthContext.env`, because `refreshModels` receives no auth context and both
 * paths must agree on what the key and base are.
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

  let models: PengepulModelEntry[] = []

  /** The relay base in force: the environment override, else the credential, else loopback. */
  function relayBaseFor(credential: unknown): string {
    return resolveRelayBase({
      environment: environmentRelayBase,
      credential: credentialRelayBase(credential as PengepulCredential | undefined),
    })
  }

  /** The key in force, with the label the status UI shows for it. */
  function resolveKey(credential: unknown) {
    return resolveApiKey({
      environment: environmentApiKey,
      credential: credentialApiKey(credential as PengepulCredential | undefined),
    })
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

  /**
   * Re-publish pi's stored catalog with every base URL re-derived from the
   * base in force, so a relay that moved is not reached at its old address.
   * Returns false only when pi refused the publication, the one case that
   * skips the network phase.
   */
  async function restoreStored(context: RefreshModelsContext): Promise<boolean> {
    const stored = (context.stored?.models ?? []).filter(isPengepulModelEntry)
    if (stored.length === 0) return true
    const restored = restampRelayBase(stored, relayBaseFor(context.credential))
    return context.publish({ update: () => { models = restored } })
  }

  async function refreshFromRelay(context: RefreshModelsContext): Promise<void> {
    const relayBase = relayBaseFor(context.credential)

    const resolved = resolveKey(context.credential)
    if (!resolved) {
      logWarning(
        `No pengepul API key is configured (${API_KEY_ENV} or auth.json), so the model catalog cannot be refreshed. Run /login pengepul.`,
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
    baseUrl: resolveRelayBase({ environment: environmentRelayBase }),
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
          return resolved ? { type: "api_key", source: resolved.source } : undefined
        },
        resolve: async (input): Promise<AuthResult | undefined> => {
          const resolved = resolveKey(input.credential)
          if (!resolved) return undefined
          const credential = input.credential as PengepulCredential | undefined
          const relayBase = credentialRelayBase(credential)
          const credentialVars = credentialEnv(credential)
          const env =
            credentialVars || relayBase
              ? { ...credentialVars, ...(relayBase ? { [RELAY_BASE_ENV]: relayBase } : {}) }
              : undefined
          // No `baseUrl` here on purpose: pi would apply it to every model and
          // collapse the two dialect base URLs into one. The relay base rides
          // in `env` instead, because the network phase of a refresh gets a
          // credential pi rebuilds from this result, and `env` is the only
          // field of ours that survives the rebuild.
          //
          // The credential's own `env` is here because pi only reads it off the credential itself
          // when the provider brings no `resolve()` of its own — this one does,
          // so a value like PI_CACHE_RETENTION=long is dropped unless it is
          // handed back. Dropping it is silent and costs money: the cache falls
          // back to the five-minute tier and re-bills the prefix on every
          // return.
          return {
            auth: { apiKey: resolved.key },
            ...(env ? { env } : {}),
            source: resolved.source,
          }
        },
      },
    },
    getModels: () => models,
    refreshModels: async (context) => {
      if (!(await restoreStored(context))) return
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