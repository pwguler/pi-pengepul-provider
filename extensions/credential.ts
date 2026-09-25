/**
 * Pengepul credential and relay-base resolution.
 *
 * The credential is the pengepul entry in pi's `auth.json`: an API key for the
 * relay plus the relay base it applies to. pi core resolves the key itself but
 * knows nothing about `baseUrl`, so the extension reads it here. Everything in
 * this module is pure: an env map and credential fields in, a value out.
 *
 * Precedence is the same for both, highest first: the `PENGEPUL_*` environment
 * override, then the credential, then the loopback default pengepul binds to.
 */

import { API_KEY_ENV, RELAY_BASE_ENV } from "./config.ts"
import { normalizeRootBaseUrl } from "./dialect.ts"
import { DEFAULT_RELAY_BASE } from "./models.ts"

/** The fields this provider reads off a stored credential. */
export interface PengepulCredential {
  /** Always `"api_key"` in pi's store; read as unknown so a hand-edited file cannot lie its way past a cast. */
  type?: unknown
  key?: unknown
  baseUrl?: unknown
  /** Provider-scoped environment values pi stores alongside the key. */
  env?: unknown
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/**
 * The relay base stored on the credential, when the user set one.
 *
 * `baseUrl` is where the stored credential keeps it. The credential pi hands
 * the network phase of a refresh is not the stored one: pi rebuilds it from
 * `resolve()` as `{ type, key, env }`, so the base only survives as the
 * `PENGEPUL_BASE_URL` entry `resolve()` writes into `env`. Missing that
 * fallback sends the catalog fetch to loopback - which on any machine but the
 * relay's is some other listener, or nothing.
 */
export function credentialRelayBase(credential: PengepulCredential | undefined): string | undefined {
  return nonEmptyString(credential?.baseUrl) ?? credentialEnv(credential)?.[RELAY_BASE_ENV]
}

/** The API key stored on the credential, when the user set one. */
export function credentialApiKey(credential: PengepulCredential | undefined): string | undefined {
  return nonEmptyString(credential?.key)
}

/**
 * The provider-scoped environment the credential carries, when it holds any.
 *
 * pi core fills an `AuthResult.env` from here only for providers that bring no
 * `resolve()` of their own; this provider brings one, so the values have to be
 * passed through or they never reach a request. They are how a user sets
 * `PI_CACHE_RETENTION=long` for the relay without exporting it in every shell
 * that starts pi, and losing them is silent: the cache quietly falls back to
 * the five-minute tier and re-bills whole prefixes.
 *
 * Non-string values are dropped rather than stringified — an env var is a
 * string, and a nested object here is a typo, not a value.
 */
export function credentialEnv(
  credential: PengepulCredential | undefined,
): Record<string, string> | undefined {
  const raw = credential?.env
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined

  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string") env[name] = value
  }
  return Object.keys(env).length > 0 ? env : undefined
}

export interface RelayBaseSources {
  /** The `PENGEPUL_BASE_URL` environment value. */
  environment?: string | undefined
  /** The relay base stored on the pengepul credential. */
  credential?: string | undefined
}

/**
 * The relay root every wire appends to: the environment override, else the
 * credential, else loopback. A trailing `/v1` is accepted and stripped, so a
 * base copied from a client config cannot produce `/v1/v1` downstream.
 */
export function resolveRelayBase(sources: RelayBaseSources): string {
  const chosen =
    nonEmptyString(sources.environment) ??
    nonEmptyString(sources.credential) ??
    DEFAULT_RELAY_BASE
  return normalizeRootBaseUrl(chosen)
}

export interface ApiKeySources {
  /** The `PENGEPUL_API_KEY` environment value. */
  environment?: string | undefined
  /** The key stored on the pengepul credential. */
  credential?: string | undefined
}

/** Which source answered, as the auth status labels it. */
export type ApiKeySource = "PENGEPUL_API_KEY" | "stored credential"

export interface ResolvedApiKey {
  key: string
  source: ApiKeySource
}

/**
 * The key requests and catalog fetches use, or undefined when none is
 * configured. The value and the label it reports come from one walk, so the
 * status UI cannot name a source the request did not use.
 */
export function resolveApiKey(sources: ApiKeySources): ResolvedApiKey | undefined {
  const environment = nonEmptyString(sources.environment)
  if (environment) return { key: environment, source: API_KEY_ENV }

  const credential = nonEmptyString(sources.credential)
  if (credential) return { key: credential, source: "stored credential" }

  return undefined
}
