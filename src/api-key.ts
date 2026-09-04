/**
 * Resolve pengepul's local API key.
 *
 * pengepul authenticates every request with a static key from its config:
 * `~/.pengepul/config.yaml`, under `api-keys:` (the first is generated on first
 * run and is `sk-local-...`). Clients send it as `Authorization: Bearer <key>`
 * or `x-api-key: <key>`.
 *
 * Precedence: an explicit env override wins, then the config file. The config
 * read is injected so this module stays io-free and testable.
 */

const DEFAULT_CONFIG_PATH = "~/.pengepul/config.yaml"

export type ApiKeySource = "env" | "config" | "none"

export interface ApiKeyResolution {
  /** The resolved key, or undefined when none could be found. */
  key?: string
  source: ApiKeySource
}

export const API_KEY_ENV = "PENGEPUL_API_KEY"
export const CONFIG_PATH_ENV = "PENGEPUL_CONFIG"

/**
 * Resolve the key from an env map and a config-file reader.
 *
 * @param env          the environment (or a test substitution for it).
 * @param readConfig   reads a config file's text by path, or undefined when the
 *                     path is unwritable/absent. Injected to keep this pure.
 */
export function resolveApiKey(
  env: Record<string, string | undefined>,
  readConfig: (path: string) => string | undefined,
): ApiKeyResolution {
  const envKey = env[API_KEY_ENV]
  if (envKey && envKey.trim() !== "") return { key: envKey, source: "env" }

  const configPath = env[CONFIG_PATH_ENV] ?? DEFAULT_CONFIG_PATH
  const configText = readConfig(configPath)
  if (configText === undefined) return { source: "none" }

  const keys = extractApiKeys(configText)
  const first = keys[0]
  if (first) return { key: first, source: "config" }

  return { source: "none" }
}

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
