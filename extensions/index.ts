/**
 * @pwguler/pi-pengepul-provider entry point - the real edge adapter.
 *
 * Registers pengepul as a pi custom provider. pengepul is a local relay
 * (`http://127.0.0.1:8317`) that pools your Claude/Codex subscriptions and
 * speaks both native wires. The pure core lives in `./dialect.ts`, `./models.ts`
 * and `./runtime.ts`; this file adapts them to the pi ExtensionAPI seam.
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all"
import { readFileSync } from "node:fs"

import { resolveApiKey } from "./api-key.ts"
import { resolveSettings } from "./config.ts"
import { modelsUrl } from "./dialect.ts"
import {
  catalogIdForms,
  loadCachedPengepulModels,
  loadPengepulModels,
  toProviderModelConfigs,
  type PengepulModel,
} from "./models.ts"
import { createPengepulRuntime } from "./runtime.ts"

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path
  if (path.startsWith("~/")) return `${process.env.HOME ?? ""}${path.slice(1)}`
  return path
}

function readConfigText(path: string): string | undefined {
  try {
    return readFileSync(expandHome(path), "utf-8")
  } catch {
    return undefined
  }
}

/** The metadata fields the lookup extracts from a pi catalog entry. */
function metaFromModel(model: NonNullable<ReturnType<typeof getBuiltinModel>>) {
  return {
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    cost: model.cost,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
  }
}

/**
 * Multi-catalog lookup over pi's builtin models. A relay id can match several
 * catalogs, so each of the id's shapes is tried in turn - verbatim, bare under
 * a vendor catalog, last segment, and with the routing namespace removed - and
 * the first hit wins. Reasoning metadata and the thinkingLevelMap flow from it.
 */
function createBuiltinLookup(): (id: string, dialect: string) => ReturnType<typeof metaFromModel> | undefined {
  type Entry = { provider: string; id: string };
  const exact = new Map<string, Entry>()
  const lower = new Map<string, Entry>()
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider) ?? []) {
      if (!exact.has(model.id)) exact.set(model.id, { provider, id: model.id })
      if (!lower.has(model.id.toLowerCase())) lower.set(model.id.toLowerCase(), { provider, id: model.id })
    }
  }
  const segments = new Map<string, Entry>()
  for (const [key, entry] of exact) {
    const slash = key.lastIndexOf("/")
    const segment = slash === -1 ? key : key.slice(slash + 1)
    if (!segments.has(segment)) segments.set(segment, entry)
  }

  return (id, dialect) => {
    for (const form of catalogIdForms(id)) {
      const candidates: Array<Entry | undefined> = [
        exact.get(form),
        segments.get(form),
        lower.get(form.toLowerCase()),
      ]
      for (const candidate of candidates) {
        if (candidate === undefined) continue
        const model = getBuiltinModel(candidate.provider as never, candidate.id as never)
        if (model) return metaFromModel(model)
      }
    }
    return undefined
  }
}

function createProviderConfigFactory(relayBase: string, apiKey: string | undefined) {
  return (models: readonly PengepulModel[]): ProviderConfig => ({
    name: "Pengepul",
    baseUrl: relayBase,
    apiKey: apiKey ?? "$PENGEPUL_API_KEY",
    api: "anthropic-messages",
    models: toProviderModelConfigs(models, relayBase),
  })
}

/**
 * Model discovery and provider registration are async: the relay's catalog is
 * fetched live (and cached), so the runtime handles the cache-first, then
 * live-refresh dance. The config factory pins the base URL and key once.
 */
export default async function (pi: ExtensionAPI) {
  const settings = resolveSettings(process.env, getAgentDir())
  const apiKey = resolveApiKey(process.env, readConfigText).key

  // The relay advertises only ids; context/pricing/modality numbers come from
  // pi's builtin catalogs, searched across providers until one knows the id
  // (aggregator, vendor, and last-segment shapes). The lookup is injected so
  // the catalog logic stays free of pi-ai imports.
  const lookupBuiltin = createBuiltinLookup()

  const runtime = createPengepulRuntime(pi, {
    loadModels: (signal) =>
      loadPengepulModels({
        url: modelsUrl(settings.relayBase),
        apiKey,
        cachePath: settings.modelsCachePath,
        relayBase: settings.relayBase,
        timeoutMs: settings.modelsTimeoutMs,
        lookupBuiltin,
        signal,
      }),
    loadCachedModels: () => loadCachedPengepulModels(settings.modelsCachePath),
    createProviderConfig: createProviderConfigFactory(settings.relayBase, apiKey),
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
