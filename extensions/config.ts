/**
 * Where the pengepul provider's fallback sources live.
 *
 * `auth.json` is the configuration surface. These are the escape hatches kept
 * for tests, CI, and a machine that happens to run the relay itself: env vars
 * for the relay base and key, and pengepul's own config on disk.
 */

import { join } from "node:path"

import { CONFIG_PATH_ENV, DEFAULT_CONFIG_PATH } from "./api-key.ts"

export { CONFIG_PATH_ENV, DEFAULT_CONFIG_PATH }

export const RELAY_BASE_ENV = "PENGEPUL_BASE_URL"
export const MODELS_CACHE_ENV = "PENGEPUL_MODELS_CACHE"
export const MODELS_TIMEOUT_MS_ENV = "PENGEPUL_MODELS_TIMEOUT_MS"

export interface PengepulSettings {
  /** Where pengepul's own config lives, when this machine runs the relay. */
  configPath: string
  /** Where the pre-0.3 catalog cache lives; read once to seed pi's store. */
  legacyCachePath: string
}

export function resolveSettings(
  env: Record<string, string | undefined>,
  agentDir: string,
): PengepulSettings {
  return {
    configPath: env[CONFIG_PATH_ENV] ?? DEFAULT_CONFIG_PATH,
    legacyCachePath: env[MODELS_CACHE_ENV] ?? join(agentDir, "pengepul-models.json"),
  }
}
