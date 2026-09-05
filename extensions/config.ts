/**
 * Resolve pengepul connection and cache settings from the environment.
 *
 * Kept small and pure: takes an env map and the host's agent dir, returns the
 * connection defaults a test can pin down.
 */

import { join } from "node:path"

import { DEFAULT_RELAY_BASE } from "./models.ts"

export const RELAY_BASE_ENV = "PENGEPUL_BASE_URL"
export const MODELS_CACHE_ENV = "PENGEPUL_MODELS_CACHE"
export const MODELS_TIMEOUT_MS_ENV = "PENGEPUL_MODELS_TIMEOUT_MS"

export interface PengepulSettings {
  /** The relay base URL (may or may not end in /v1). */
  relayBase: string
  /** Where the model catalog is cached; defaults to `<agent-dir>/pengepul-models.json`. */
  modelsCachePath: string
  /** Discovery timeout in milliseconds. */
  modelsTimeoutMs: number
}

export function resolveSettings(
  env: Record<string, string | undefined>,
  agentDir: string,
): PengepulSettings {
  const relayBase = env[RELAY_BASE_ENV] ?? DEFAULT_RELAY_BASE
  const modelsCachePath =
    env[MODELS_CACHE_ENV] ?? join(agentDir, "pengepul-models.json")
  const rawTimeout = env[MODELS_TIMEOUT_MS_ENV]
  const parsedTimeout = rawTimeout ? Number(rawTimeout) : NaN
  const modelsTimeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : 10_000

  return { relayBase, modelsCachePath, modelsTimeoutMs }
}
