/**
 * Live end-to-end test for @pwguler/pi-pengepul-provider.
 *
 * Run against a REAL pengepul relay (default http://127.0.0.1:8317):
 *
 *   1. loads the actual extension seam with a fake pi host,
 *   2. refreshes the provider the way pi does, discovering the relay's real
 *      model catalog with the real key (auth.json, or the PENGEPUL_API_KEY /
 *      PENGEPUL_BASE_URL overrides),
 *   3. prints what pi would see in /model,
 *   4. sends ONE minimal completion ("reply exactly: pong") through the
 *      provider's own stream for the first claude-* model, proving the whole
 *      chain: pi-ai -> provider auth -> relay -> upstream subscription ->
 *      parsed response.
 *
 * Not part of `bun test` (it makes a real request); run explicitly:
 *
 *   bun scripts/e2e-live.ts
 */

import { streamSimple } from "@earendil-works/pi-ai/compat"
import type { Api, Context, Model, Provider } from "@earendil-works/pi-ai"

import loadExtension from "../extensions/index.ts"
import { baseUrlForDialect } from "../extensions/dialect.ts"

const redactKey = (key: string | undefined) =>
  key ? `${key.slice(0, 8)}…${key.slice(-4)}` : "(none)"

// --- 1. load the real extension seam with a fake pi host --------------------
const registered: Provider[] = []

const fakePi = {
  registerProvider: (provider: Provider) => registered.push(provider),
  on: () => {},
} as never

console.log("── 1. loading the real extension seam ──")
loadExtension(fakePi)

const provider = registered.find((candidate) => candidate.id === "pengepul")
if (!provider) {
  console.error("FAIL: pengepul provider was never registered")
  process.exit(1)
}
console.log(`provider: ${provider.id} (display "${provider.name}")`)
console.log(`base url: ${provider.baseUrl}`)

// --- 2. the refresh pi performs, minus pi --------------------------------
// The relay base and key come from the environment here because this script is
// its own client; in pi they come from the credential in auth.json.

const credential = {
  type: "api_key" as const,
  ...(process.env["PENGEPUL_API_KEY"] ? { key: process.env["PENGEPUL_API_KEY"] } : {}),
  ...(process.env["PENGEPUL_BASE_URL"] ? { baseUrl: process.env["PENGEPUL_BASE_URL"] } : {}),
}

const auth = await provider.auth.apiKey?.resolve({
  ctx: { env: async (name) => process.env[name], fileExists: async () => false },
  credential,
  signal: new AbortController().signal,
})
if (!auth) {
  console.error("FAIL: no pengepul API key configured (auth.json or PENGEPUL_API_KEY)")
  process.exit(1)
}
console.log(`api key:  ${redactKey(auth.auth.apiKey)} (${auth.source ?? "unknown source"})`)

console.log("\n── 2. refreshing the catalog the way pi does ──")
let persisted = 0
await provider.refreshModels?.({
  credential,
  allowNetwork: true,
  signal: new AbortController().signal,
  publish: async (publication) => {
    publication.update?.()
    if (publication.persist) persisted++
    return true
  },
})

const models = provider.getModels()
if (models.length === 0) {
  console.error("FAIL: no models discovered (is the relay running? pengepul serve)")
  process.exit(1)
}
console.log(`models:   ${models.length} (persisted: ${persisted})`)
for (const m of models) {
  console.log(
    `  ${m.id.padEnd(24)} ${String(m.api).padEnd(20)} ${m.baseUrl}  ctx=${m.contextWindow} max=${m.maxTokens}`,
  )
}

// --- 3. one live completion through the chain -------------------------------
// A relay that pools subscription accounts can carry models its upstream
// refuses (a pool-side routing bug shows up as an identical error on both
// wires). Walk candidate models round-robin across pools, report each refusal,
// and complete on the first that works so the run proves the chain rather than
// one pool's health.
const byPool = new Map<string, Model<Api>[]>()
for (const model of models) {
  const pool = model.id.split("/")[0] ?? model.id
  byPool.set(pool, [...(byPool.get(pool) ?? []), model])
}
const candidates: Model<Api>[] = []
for (let index = 0; candidates.length < 6; index++) {
  let added = false
  for (const pool of byPool.values()) {
    const candidate = pool[index]
    if (!candidate) continue
    candidates.push(candidate)
    added = true
    if (candidates.length >= 6) break
  }
  if (!added) break
}

const context: Context = {
  messages: [{ role: "user", content: "reply exactly: pong", timestamp: Date.now() }],
}

let text = ""
let final
let served: string | undefined
for (const candidate of candidates) {
  if (!candidate) continue
  const api = candidate.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions"
  // The per-model base URL is the dialect split; re-derive it here so the
  // script proves the split rather than trusting the catalog entry.
  const model = {
    ...candidate,
    api,
    baseUrl: baseUrlForDialect(provider.baseUrl ?? "http://127.0.0.1:8317", api),
  } as unknown as Model<typeof api>

  console.log(`\n── 3. live completion via ${candidate.id} (${api}) ──`)
  text = ""
  final = undefined
  let failed: string | undefined

  for await (const event of streamSimple(model, context, { apiKey: auth.auth.apiKey })) {
    if (event.type === "text_delta") {
      text += event.delta
      process.stdout.write(event.delta)
    }
    if (event.type === "done") final = event.message
    if (event.type === "error") {
      failed = event.error?.errorMessage ?? "stream error"
      break
    }
  }

  if (failed) {
    console.log(`\n   relay refused ${candidate.id}: ${failed}`)
    continue
  }
  if (!final || text.trim() === "") {
    console.log(`\n   empty response (stopReason=${final?.stopReason})`)
    continue
  }
  served = candidate.id
  break
}

console.log("")

if (!served || !final) {
  console.error("FAIL: no candidate model completed; every one was refused (relay-side)")
  process.exit(1)
}
if (!/pong/i.test(text)) {
  console.error(`FAIL: expected "pong" in response from ${served}, got: ${JSON.stringify(text)}`)
  process.exit(1)
}

const usage = final.usage
console.log(`\n── result (${served}) ──`)
console.log(`stopReason: ${final.stopReason}`)
console.log(
  `usage: in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} total=${usage.totalTokens} cost=$${usage.cost.total.toFixed(6)}`,
)
console.log("\nPASS: full chain works — pi-ai → provider auth → relay → upstream → parsed response")
