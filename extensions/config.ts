/**
 * The environment overrides this provider reads.
 *
 * `~/.pi/agent/auth.json` is the configuration surface: the pengepul entry
 * carries the relay API key and the relay base it applies to, and
 * `/login pengepul` writes both. These variables outrank it, so a shell or a CI
 * run can re-point the provider without editing the file.
 */

/** Relay base URL. Outranks the credential's `baseUrl`. */
export const RELAY_BASE_ENV = "PENGEPUL_BASE_URL"

/** Relay API key. Outranks the credential's `key`. */
export const API_KEY_ENV = "PENGEPUL_API_KEY"

/** Milliseconds before model discovery gives up. */
export const MODELS_TIMEOUT_MS_ENV = "PENGEPUL_MODELS_TIMEOUT_MS"
