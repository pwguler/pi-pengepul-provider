/**
 * Cached-model runtime for the pengepul provider.
 *
 * Registers the provider immediately from the cache (so startup never waits on
 * the network), refreshes it in the background, and disposes cleanly. There
 * are no user-facing commands: the startup refresh is the only refresh.
 *
 * The pi seam is an interface, so the whole thing is testable with a fake host.
 */

import type { PengepulModel, PengepulModelSource } from "./models.ts"

export interface PengepulRuntimeApi {
  registerProvider(name: string, config: unknown): void
}

export interface PengepulRuntimeOptions {
  /** A provider config built from a model list. */
  createProviderConfig: (models: readonly PengepulModel[]) => unknown
  /** Live fetch; resolves to the catalog plus a source marker. */
  loadModels: (signal: AbortSignal) => Promise<PengepulModelSource>
  /** Cached catalog only; empty when no valid cache exists. */
  loadCachedModels: () => Promise<readonly PengepulModel[]>
  now?: () => number
  logWarning?: (message: string) => void
}

export interface PengepulRefreshResult {
  refreshed: boolean
  source: PengepulModelSource["source"]
  modelCount: number
  warning?: string
}

interface RuntimeStatus {
  source: PengepulModelSource["source"]
  modelCount: number
  providerRegistered: boolean
  lastSuccess?: number
  lastAttempt?: number
  warning?: string
  refreshing: boolean
}

const REDACTED = "[redacted]"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk-local|sk-|api[-_ ]?key|token|secret|password)[_-]?[\w.~+/=-]{8,}\b/gi, REDACTED)
    .replace(/\b(?:api[-_ ]?key|token|secret|password)\s*[=:]\s*[^\s,;)]+/gi, (match) => {
      const separator = match.match(/\s*[=:]\s*/)?.[0] ?? "="
      return `${match.slice(0, match.indexOf(separator))}${separator}${REDACTED}`
    })
}

export class PengepulRuntime {
  private readonly now: () => number
  private readonly logWarning: (message: string) => void
  private status: RuntimeStatus
  private providerRegistered = false
  private refreshPromise: Promise<PengepulRefreshResult> | undefined
  private readonly shutdown = new AbortController()

  constructor(
    private readonly pi: PengepulRuntimeApi,
    private readonly options: PengepulRuntimeOptions,
  ) {
    this.now = options.now ?? Date.now
    this.logWarning = options.logWarning ?? ((message) => console.warn(`[pengepul] ${message}`))
    this.status = {
      source: "empty",
      modelCount: 0,
      providerRegistered: false,
      refreshing: false,
    }
  }

  /**
   * Registers the cached catalog immediately (so host startup does not wait on
   * the network) and refreshes it in the background. Without a valid cache the
   * live refresh is awaited so models are available right away.
   */
  async initialize(): Promise<void> {
    const cached = await this.options.loadCachedModels()
    if (cached.length === 0) {
      await this.refresh()
      return
    }

    this.pi.registerProvider("pengepul", this.options.createProviderConfig(cached))
    this.providerRegistered = true
    this.status = {
      ...this.status,
      source: "cache",
      modelCount: cached.length,
      providerRegistered: true,
      lastSuccess: this.now(),
    }
    void this.refresh()
  }

  /** Aborts any background refresh so a stopping host does not wait on the network. */
  dispose(): void {
    this.shutdown.abort(new Error("pengepul provider shut down"))
  }

  refresh(): Promise<PengepulRefreshResult> {
    if (this.refreshPromise) return this.refreshPromise

    const refreshPromise = this.refreshCatalog().finally(() => {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = undefined
    })
    this.refreshPromise = refreshPromise
    return refreshPromise
  }

  private async refreshCatalog(): Promise<PengepulRefreshResult> {
    this.status = { ...this.status, lastAttempt: this.now(), refreshing: true }

    try {
      const loaded = await this.options.loadModels(this.shutdown.signal)
      const warning = loaded.warning ? redactDiagnosticText(loaded.warning) : undefined

      const shouldRegister =
        !this.providerRegistered ||
        loaded.source === "live" ||
        (this.status.modelCount === 0 && loaded.models.length > 0)

      if (shouldRegister) {
        this.pi.registerProvider("pengepul", this.options.createProviderConfig(loaded.models))
        this.providerRegistered = true

        if (loaded.models.length === 0) {
          const preservedWarning = warning ?? "pengepul model discovery returned no models"
          this.status = {
            ...this.status,
            source: loaded.source,
            modelCount: 0,
            providerRegistered: true,
            warning: preservedWarning,
            refreshing: false,
          }
          this.warn(preservedWarning)
          return { refreshed: false, source: loaded.source, modelCount: 0, warning: preservedWarning }
        }

        this.status = {
          ...this.status,
          source: loaded.source,
          modelCount: loaded.models.length,
          providerRegistered: true,
          lastSuccess: this.now(),
          warning,
          refreshing: false,
        }
        if (warning) this.warn(warning)
        return { refreshed: true, source: loaded.source, modelCount: loaded.models.length, warning }
      }

      const preservedWarning = warning ?? "pengepul model discovery returned no models"
      this.status = { ...this.status, warning: preservedWarning, refreshing: false }
      this.warn(preservedWarning)
      return {
        refreshed: false,
        source: this.status.source,
        modelCount: this.status.modelCount,
        warning: preservedWarning,
      }
    } catch (error) {
      if (this.shutdown.signal.aborted) {
        this.status = { ...this.status, refreshing: false }
        return {
          refreshed: false,
          source: this.status.source,
          modelCount: this.status.modelCount,
        }
      }
      const warning = redactDiagnosticText(
        `Could not refresh the pengepul model catalog: ${errorMessage(error)}`,
      )
      this.status = { ...this.status, warning, refreshing: false }
      this.warn(warning)
      return {
        refreshed: false,
        source: this.status.source,
        modelCount: this.status.modelCount,
        warning,
      }
    }
  }

  private warn(message: string): void {
    try {
      this.logWarning(redactDiagnosticText(message))
    } catch {
      // Diagnostics must never make a catalog refresh fail.
    }
  }
}

export function createPengepulRuntime(
  pi: PengepulRuntimeApi,
  options: PengepulRuntimeOptions,
): PengepulRuntime {
  return new PengepulRuntime(pi, options)
}
