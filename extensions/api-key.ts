/**
 * Read pengepul's own API key.
 *
 * pengepul authenticates every request with a static key from its config:
 * `~/.pengepul/config.yaml`, under `api-keys:` (the first is generated on first
 * run and is `sk-local-...`). Clients send it as `Authorization: Bearer <key>`
 * or `x-api-key: <key>`.
 *
 * This is the fallback for the machine that runs the relay itself: a client box
 * configures the key in `auth.json`, which pi resolves and hands to the
 * provider. Only extraction lives here, so the file read stays with the caller
 * and this module stays io-free.
 */

export const DEFAULT_CONFIG_PATH = "~/.pengepul/config.yaml"

export const API_KEY_ENV = "PENGEPUL_API_KEY"
export const CONFIG_PATH_ENV = "PENGEPUL_CONFIG"

/**
 * Extract `api-keys:` entries from pengepul's YAML config, without a YAML
 * dependency. Handles both the inline-flow form and the block-sequence form:
 *
 *   api-keys: [sk-local-a, sk-local-b]
 *   api-keys:
 *     - sk-local-a
 *     - sk-local-b
 */
export function extractApiKeys(configText: string): string[] {
  const lines = configText.split(/\r?\n/)
  const keys: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    const match = /^\s*api-keys:\s*(.*)$/.exec(line)
    if (!match) continue

    const rest = (match[1] ?? "").trim()
    if (rest.startsWith("[")) {
      // Inline flow sequence: [a, b, c]
      for (const token of rest.slice(1, -1).split(",")) {
        const key = token.trim().replace(/^["']|["']$/g, "")
        if (key) keys.push(key)
      }
    } else if (rest === "" || rest === "|" || rest === ">") {
      // Block sequence follows. Sequence entries may sit at any indent —
      // pengepul itself writes them flush with the key (`- sk-local-…`) —
      // so scan forward through blanks, comments, and `- ` entries and
      // stop at the first line that starts another key.
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j]
        if (item === undefined) continue
        const token = item.trim()
        if (token === "" || token.startsWith("#")) continue
        if (!token.startsWith("-")) break
        const value = token.slice(1).trim().replace(/^["']|["']$/g, "")
        if (value) keys.push(value)
      }
    } else {
      // Single inline scalar: api-keys: sk-local-a
      const value = rest.replace(/^["']|["']$/g, "")
      if (value) keys.push(value)
    }
    break
  }

  return keys
}
