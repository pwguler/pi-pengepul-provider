/**
 * Pengepul credential and relay-base resolution.
 *
 * The credential is the pengepul entry in pi's `auth.json`: an API key for the
 * relay plus the relay base it applies to. pi core resolves the key itself but
 * knows nothing about `baseUrl`, so the extension reads it here. Everything in
 * this module is pure: an env map and config text in, a value out.
 *
 * Precedence, highest first: credential, then environment, then the relay's own
 * config file (which only exists on the machine running the relay), then the
 * loopback default pengepul binds to.
 */

import { normalizeRootBaseUrl } from "./dialect.ts"
import { DEFAULT_RELAY_BASE } from "./models.ts"

/** The fields this provider reads off a stored credential. */
export interface PengepulCredential {
  /** Always `"api_key"` in pi's store; read as unknown so a hand-edited file cannot lie its way past a cast. */
  type?: unknown
  key?: unknown
  baseUrl?: unknown
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** The relay base stored on the credential, when the user set one. */
export function credentialRelayBase(credential: PengepulCredential | undefined): string | undefined {
  return nonEmptyString(credential?.baseUrl)
}

/** The API key stored on the credential, when the user set one. */
export function credentialApiKey(credential: PengepulCredential | undefined): string | undefined {
  return nonEmptyString(credential?.key)
}

/**
 * Build a relay base from pengepul's own `config.yaml`. Only the machine running
 * the relay has this file; clients reach a relay elsewhere and skip this source.
 *
 * pengepul writes `host: ''` when it binds loopback ("empty binds 127.0.0.1, not
 * every interface"), so an empty host means loopback rather than "unset". A
 * bind-all address is not a connect address either: `0.0.0.0`, `::`, and `*` mean
 * "every interface", and a client reaches that listener on loopback.
 */
export function relayBaseFromConfigText(configText: string | undefined): string | undefined {
  if (configText === undefined) return undefined

  let host = "127.0.0.1"
  let port: number | undefined

  for (const line of configText.split(/\r?\n/)) {
    const hostMatch = /^\s*host:\s*(.*)$/.exec(line)
    if (hostMatch) {
      const value = (hostMatch[1] ?? "").trim().replace(/^["']|["']$/g, "")
      if (value !== "" && !isBindAll(value)) host = value
      continue
    }

    const portMatch = /^\s*port:\s*(.*)$/.exec(line)
    if (portMatch) {
      const value = (portMatch[1] ?? "").trim().replace(/^["']|["']$/g, "")
      const parsed = Number(value)
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) port = parsed
    }
  }

  return port === undefined ? undefined : `http://${host}:${port}`
}

/** Whether a configured host is a bind-all address rather than a destination. */
function isBindAll(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]" || host === "*"
}

export interface RelayBaseSources {
  /** The relay base stored on the pengepul credential. */
  credential?: string | undefined
  /** The `PENGEPUL_BASE_URL` environment value. */
  environment?: string | undefined
  /** The relay base derived from pengepul's own config file. */
  config?: string | undefined
}

/**
 * The relay root every wire appends to: highest-precedence non-blank source, or
 * loopback. A trailing `/v1` is accepted and stripped, so a base copied from a
 * client config cannot produce `/v1/v1` downstream.
 */
export function resolveRelayBase(sources: RelayBaseSources): string {
  const chosen =
    nonEmptyString(sources.credential) ??
    nonEmptyString(sources.environment) ??
    nonEmptyString(sources.config) ??
    DEFAULT_RELAY_BASE
  return normalizeRootBaseUrl(chosen)
}

export interface ApiKeySources {
  /** The key stored on the pengepul credential. */
  credential?: string | undefined
  /** The key resolved from `PENGEPUL_API_KEY` or pengepul's own config file. */
  ambient?: string | undefined
}

/** The key requests and catalog fetches use, or undefined when none is configured. */
export function resolveApiKey(sources: ApiKeySources): string | undefined {
  return nonEmptyString(sources.credential) ?? nonEmptyString(sources.ambient)
}
