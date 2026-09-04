/**
 * Live end-to-end test for @pwguler/pwgu-pengepul-provider.
 *
 * Run against a REAL pengepul relay (default http://127.0.0.1:8317):
 *
 *   1. loads the actual extension seam with a fake pi host,
 *   2. discovers the relay's real model catalog with the real key
 *      (PENGEPUL_API_KEY or ~/.pengepul/config.yaml),
 *   3. prints what pi would see in /model,
 *   4. sends ONE minimal completion ("reply exactly: pong") through
 *      pi-ai's builtin stream for the first claude-* model, proving the
 *      whole chain: pi-ai -> provider config -> relay -> upstream
 *      subscription -> parsed response.
 *
 * Not part of `bun test` (it makes a real request); run explicitly:
 *
 *   bun packages/pwgu-pengepul-provider/scripts/e2e-live.ts
 */

import { streamSimple } from "@earendil-works/pi-ai/compat"
import type { Context, Model } from "@earendil-works/pi-ai"

import loadExtension from "../src/index.ts"
import type { ProviderConfig } from "@earendil-works/pi-coding-agent"

const redactKey = (key: string | undefined) =>
  key ? `${key.slice(0, 8)}…${key.slice(-4)}` : "(none)"

// --- 1. load the real extension seam with a fake pi host --------------------
const registered: Array<{ name: string; config: ProviderConfig }> = [];

const fakePi = {
  registerProvider: (name: string, config: ProviderConfig) => registered.push({ name, config }),
  on: () => {},
} as never

console.log("── 1. loading the real extension seam ──")
await loadExtension(fakePi)

// The runtime registers cache-first, then re-registers after the live
// refresh; the last registration is the current one.
const registration = [...registered].reverse().find((r) => r.name === "pengepul")
if (!registration) {
  console.error("FAIL: pengepul provider was never registered")
  process.exit(1)
}
const config = registration.config
console.log(`provider: pengepul (display "${config.name}")`)
console.log(`api key:  ${redactKey(config.apiKey)}`)

const models = config.models ?? []
if (models.length === 0) {
  console.error("FAIL: no models registered (is the relay running? pengepul serve)")
  process.exit(1)
}

// --- 2. what /model would show ----------------------------------------------
console.log(`\n── 2. catalog: ${models.length} models ──`)
for (const m of models) {
  console.log(
    `  ${m.id.padEnd(24)} ${String(m.api).padEnd(20)} ${m.baseUrl}  ctx=${m.contextWindow} max=${m.maxTokens}`,
  )
}

// --- 3. one live completion through the chain -------------------------------
const target = models.find((m) => m.id.startsWith("claude-")) ?? models[0]
if (!target) {
  console.error("FAIL: no target model")
  process.exit(1)
}
console.log(`\n── 3. live completion via ${target.id} (${target.api}) ──`)

const api = target.api ?? "openai-completions"
const model = {
  id: target.id,
  name: target.name,
  api,
  provider: "pengepul",
  baseUrl: target.baseUrl,
  reasoning: target.reasoning,
  input: target.input,
  cost: target.cost,
  contextWindow: target.contextWindow,
  maxTokens: target.maxTokens,
  // pi copies `compat` and `thinkingLevelMap` from the model config onto the
  // model; without them the builtin stream sends thinking:{type:"disabled"}
  // and the upstream 400s.
  compat: target.compat,
  thinkingLevelMap: target.thinkingLevelMap,
} as unknown as Model<typeof api>

const context: Context = {
  messages: [{ role: "user", content: "reply exactly: pong", timestamp: Date.now() }],
}

const stream = streamSimple(model, context, { apiKey: config.apiKey })

let text = ""
let final
for await (const event of stream) {
  if (event.type === "text_delta") {
    text += event.delta
    process.stdout.write(event.delta)
  }
  if (event.type === "done") final = event.message
  if (event.type === "error") {
    console.error(`\nFAIL: stream error: ${event.error?.errorMessage}`)
    process.exit(1)
  }
}

console.log("")
if (!final || text.trim() === "") {
  console.error(`FAIL: empty response (stopReason=${final?.stopReason})`)
  process.exit(1)
}
if (!/pong/i.test(text)) {
  console.error(`FAIL: expected "pong" in response, got: ${JSON.stringify(text)}`)
  process.exit(1)
}

const usage = final.usage
console.log(`\n── result ──`)
console.log(`stopReason: ${final.stopReason}`)
console.log(
  `usage: in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} total=${usage.totalTokens} cost=$${usage.cost.total.toFixed(6)}`,
)
console.log("\nPASS: full chain works — pi-ai → provider config → relay → upstream → parsed response")
