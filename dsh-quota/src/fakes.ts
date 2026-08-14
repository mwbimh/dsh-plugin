import type { QuotaAccount, QuotaAccountRef, QuotaProvider, QuotaRetryPolicy, QuotaSnapshot } from './model.ts'

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type FakeResult = QuotaSnapshot | Promise<QuotaSnapshot> | Error | { readonly status: 429; readonly retryAfterMs?: number }

export interface FakeQuotaProviderOptions {
  readonly id: string
  readonly usesOAuth?: boolean
  readonly retryPolicy?: QuotaRetryPolicy
}

/** Deterministic provider with no network or real-account access. */
export class FakeQuotaProvider implements QuotaProvider {
  readonly id: string
  readonly usesOAuth: boolean
  readonly retryPolicy?: QuotaRetryPolicy
  readonly accounts: QuotaAccount[] = []
  readonly quotaResults: FakeResult[] = []
  readonly quotaCalls: Array<{
    readonly account: QuotaAccountRef
    readonly signal: AbortSignal
    readonly credentialRef?: string
  }> = []
  discoverCalls = 0
  private readonly quotaWaiters = new Set<() => void>()

  constructor(options: FakeQuotaProviderOptions) {
    this.id = options.id
    this.usesOAuth = options.usesOAuth ?? false
    if (options.retryPolicy !== undefined) this.retryPolicy = options.retryPolicy
  }

  async discoverAccounts(): Promise<readonly QuotaAccount[]> {
    this.discoverCalls += 1
    return [...this.accounts]
  }

  async getQuota(account: QuotaAccountRef, signal = new AbortController().signal, credentialRef?: string): Promise<QuotaSnapshot> {
    this.quotaCalls.push({ account, signal, ...(credentialRef === undefined ? {} : { credentialRef }) })
    for (const waiter of this.quotaWaiters) waiter()
    this.quotaWaiters.clear()
    const result = this.quotaResults.shift()
    if (result === undefined) throw new Error('fake quota result queue is empty')
    if (result instanceof Error || isFakeRateLimit(result)) throw result
    return await withAbort(Promise.resolve(result), signal)
  }

  async waitForQuotaCalls(count: number): Promise<void> {
    if (this.quotaCalls.length >= count) return
    await new Promise<void>(resolve => this.quotaWaiters.add(resolve))
  }
}

function isFakeRateLimit(value: FakeResult): value is { readonly status: 429; readonly retryAfterMs?: number } {
  return typeof value === 'object' && 'status' in value && value.status === 429
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}
