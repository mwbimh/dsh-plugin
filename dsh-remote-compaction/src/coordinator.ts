import { CapabilityCache, type CapabilityStatus } from './capability-cache.js'
import { RemoteCompactionError } from './errors.js'
import { resolveRemoteTarget } from './policy.js'
import type { OpenAICompactRequest, OpenAICompactResult, OpenAIInputItem } from './transport.js'

/** Dependencies for one lifecycle-owned remote coordinator. */
export interface RemoteCompactionCoordinatorOptions {
  readonly supportedTtlMs: number
  readonly unavailableTtlMs: number
  readonly resolveCredential: () => Promise<string | undefined>
  readonly compact: (request: OpenAICompactRequest) => Promise<OpenAICompactResult>
}

/** One operation after Basic has selected its exact summarization range. */
export interface RemoteCompactionOperation {
  readonly provider: string
  readonly model: string
  readonly baseURL: string
  readonly input: readonly OpenAIInputItem[]
  readonly signal?: AbortSignal
}

/** Coordinates credential resolution, target caching, cancellation, and disposal. */
export class RemoteCompactionCoordinator {
  private readonly cache: CapabilityCache
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private disposed = false

  constructor(private readonly options: RemoteCompactionCoordinatorOptions) {
    this.cache = new CapabilityCache(options)
  }

  /** Return one target's current in-memory capability state. */
  status(target: string): CapabilityStatus {
    return this.cache.status(target)
  }

  /** Cancel current work and discard all cached conclusions. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort(new RemoteCompactionError('aborted', 'remote compaction plugin was disposed'))
    this.cache.clear()
    await Promise.allSettled(this.active)
  }

  /** Execute one compact request through the exact-target capability cache. */
  async compact(operation: RemoteCompactionOperation): Promise<OpenAICompactResult> {
    if (this.disposed) {
      throw new RemoteCompactionError('aborted', 'remote compaction plugin was disposed')
    }
    const target = resolveRemoteTarget(operation)
    const signal = operation.signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([operation.signal, this.lifetime.signal])
    const pending = this.cache.run(target.cacheKey, async () => {
      signal.throwIfAborted()
      const apiKey = await this.options.resolveCredential()
      signal.throwIfAborted()
      if (apiKey === undefined || apiKey.length === 0) {
        throw new RemoteCompactionError('authentication', 'remote compaction credential is not configured')
      }
      return this.options.compact({ apiKey, model: target.model, input: operation.input, signal })
    }, signal)
    this.active.add(pending)
    try {
      return await pending
    } finally {
      this.active.delete(pending)
    }
  }
}
