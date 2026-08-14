import { RemoteCompactionError } from './errors.js'

/** Cached capability conclusion for one provider/model/endpoint target. */
export type CapabilityStatus =
  | 'unknown'
  | 'supported'
  | 'unsupported'
  | 'temporarily-unavailable'

interface CapabilityEntry {
  readonly status: Exclude<CapabilityStatus, 'unknown'>
  readonly expiresAt: number
}

/** Timing dependencies for the in-memory capability cache. */
export interface CapabilityCacheOptions {
  readonly supportedTtlMs: number
  readonly unavailableTtlMs: number
  readonly now?: () => number
}

/**
 * Instance-scoped capability cache. Unknown calls for one exact target wait
 * for the first capability conclusion, then execute their own operation after
 * support is known; response values are never shared across callers.
 */
export class CapabilityCache {
  private readonly entries = new Map<string, CapabilityEntry>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly now: () => number
  private generation = 0

  constructor(private readonly options: CapabilityCacheOptions) {
    this.now = options.now ?? Date.now
  }

  /** Return the unexpired status for one exact target. */
  status(target: string): CapabilityStatus {
    const entry = this.entries.get(target)
    if (entry === undefined) return 'unknown'
    if (entry.expiresAt > this.now()) return entry.status
    this.entries.delete(target)
    return 'unknown'
  }

  /** Clear all conclusions and single-flight references during disposal. */
  clear(): void {
    this.generation += 1
    this.entries.clear()
    this.pending.clear()
  }

  /**
   * Run one target operation while applying capability caching.
   * @param target - provider/model/endpoint cache identity.
   * @param operation - remote operation used to establish unknown capability.
   * @returns the operation result.
   */
  async run<T>(target: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const status = this.status(target)
    if (status === 'unsupported' || status === 'temporarily-unavailable') {
      throw new RemoteCompactionError(status, `remote compaction target is ${status}`)
    }
    if (status === 'supported') return operation()

    const existing = this.pending.get(target)
    if (existing !== undefined) {
      await this.waitForPending(existing, signal)
      return this.run(target, operation, signal)
    }
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.pending.set(target, current)
    try {
      return await this.runUnknown(target, operation, this.generation)
    } finally {
      release()
      if (this.pending.get(target) === current) this.pending.delete(target)
    }
  }

  private async waitForPending(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) return pending
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort)
      const onAbort = () => {
        cleanup()
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void pending.then(() => { cleanup(); resolve() })
    })
  }

  private async runUnknown<T>(
    target: string,
    operation: () => Promise<T>,
    generation: number,
  ): Promise<T> {
    try {
      const result = await operation()
      if (generation === this.generation) {
        this.entries.set(target, {
          status: 'supported',
          expiresAt: this.now() + this.options.supportedTtlMs,
        })
      }
      return result
    } catch (error: unknown) {
      if (error instanceof RemoteCompactionError
        && (error.code === 'unsupported' || error.code === 'temporarily-unavailable')) {
        if (generation === this.generation) {
          this.entries.set(target, {
            status: error.code,
            expiresAt: this.now() + this.options.unavailableTtlMs,
          })
        }
      }
      throw error
    }
  }
}
