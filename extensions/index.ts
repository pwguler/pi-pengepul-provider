/**
 * @pwguler/pi-pengepul-provider entry point - the real edge adapter.
 *
 * Registers pengepul as a pi provider. pengepul is a relay that pools your
 * Claude/Codex subscriptions and speaks both native wires. The provider itself
 * lives in `./provider.ts`: pi resolves auth through it and hands the credential
 * back on every refresh, so `auth.json` carries the key and the relay base, and
 * the `PENGEPUL_*` environment variables override both. The pure core is
 * `./credential.ts`, `./dialect.ts`, and `./models.ts`; this file adapts them to
 * the pi ExtensionAPI seam and reads nothing of its own.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all"

import { catalogIdForms, type PengepulModel } from "./models.ts"
import { createPengepulProvider } from "./provider.ts"

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

/**
 * Model discovery belongs to pi: it calls `refreshModels` with the resolved
 * credential, first against pi's model store and then, when the network is
 * allowed, against the relay. Registration is synchronous; nothing here waits
 * on the relay, and the catalog survives a restart through pi's model store.
 */
export default function (pi: ExtensionAPI) {
  const provider = createPengepulProvider({
    env: process.env,
    lookupBuiltin: createBuiltinLookup(),
  })

  pi.registerProvider(provider)
}

/** The pengepul catalog shape, re-exported for callers that build on the core. */
export type { PengepulModel }
