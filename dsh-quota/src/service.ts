import { QuotaError, classifyProviderError } from './errors.ts'
import { validateAccount, validateSnapshot } from './model.ts'
import type { QuotaAccount, QuotaAccountRef, QuotaProvider, QuotaSnapshot } from './model.ts'
import {
  isTokenFreeOAuthAccount,
  isTokenFreeOAuthAccountCredentialRef,
  isTokenFreeOAuthAccountService,
} from './oauth.ts'
import type { TokenFreeOAuthAccountService } from './oauth.ts'
import { ProviderRegistry } from './provider-registry.ts'

/** Public cached snapshot state. */
export interface QuotaSnapshotResult {
  readonly snapshot: QuotaSnapshot
  readonly stale: boolean
  readonly lastError?: ReturnType<QuotaError['toJSON']>
}

/** Namespaced public quota service. */
export interface QuotaService {
  listAccounts(): Promise<readonly QuotaAccount[]>
  getSnapshot(account: QuotaAccountRef, signal?: AbortSignal): Promise<QuotaSnapshotResult>
  refresh(account: QuotaAccountRef, signal?: AbortSignal): Promise<QuotaSnapshotResult>
}

export interface QuotaServiceOptions {
  readonly providers: readonly QuotaProvider[]
  readonly cacheTtlMs: number
  readonly timeoutMs: number
  readonly maxConcurrency: number
  readonly now?: () => number
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** Dynamically resolve the optional structural dsh-oauth service. */
  readonly getOAuthService?: () => unknown
}

interface CacheEntry {
  readonly snapshot: QuotaSnapshot
  readonly cachedAt: number
}

interface ConcurrencyWaiter {
  readonly signal: AbortSignal
  readonly start: () => void
  readonly cancel: () => void
}

function validPolicyInteger(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum
}

/** In-memory quota orchestration with TTL, stale fallback, and per-account single-flight. */
export class QuotaServiceImpl implements QuotaService {
  private readonly registry: ProviderRegistry
  private readonly cache = new Map<string, CacheEntry>()
  private readonly flights = new Map<string, Promise<QuotaSnapshotResult>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly waiters: ConcurrencyWaiter[] = []
  private readonly cacheTtlMs: number
  private readonly timeoutMs: number
  private readonly maxConcurrency: number
  private readonly now: () => number
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly getOAuthService: (() => unknown) | undefined
  private active = 0
  private disposed = false

  constructor(options: QuotaServiceOptions) {
    if (!validPolicyInteger(options.cacheTtlMs, 0)
      || !validPolicyInteger(options.timeoutMs, 1)
      || !validPolicyInteger(options.maxConcurrency, 1)) {
      throw new QuotaError({ code: 'configuration' })
    }
    this.registry = new ProviderRegistry(options.providers)
    this.cacheTtlMs = options.cacheTtlMs
    this.timeoutMs = options.timeoutMs
    this.maxConcurrency = options.maxConcurrency
    this.now = options.now ?? Date.now
    this.delay = options.delay ?? abortableDelay
    this.getOAuthService = options.getOAuthService
  }

  async listAccounts(): Promise<readonly QuotaAccount[]> {
    this.assertActive()
    const merged = new Map<string, QuotaAccount>()
    for (const account of await this.registry.discoverAccounts()) merged.set(cacheKey(account), account)

    for (const provider of this.registry.providers()) {
      if (provider.usesOAuth !== true) continue
      const oauth = this.requireOAuthService(provider.id)
      let accounts: readonly { readonly id: string; readonly provider: string; readonly displayName?: string }[]
      try {
        accounts = await oauth.accounts(provider.id)
      } catch {
        throw new QuotaError({ code: 'oauth-account-unavailable', provider: provider.id })
      }
      if (!Array.isArray(accounts)) throw new QuotaError({ code: 'oauth-service-incompatible', provider: provider.id })
      for (const oauthAccount of accounts) {
        if (!isTokenFreeOAuthAccount(oauthAccount)) {
          throw new QuotaError({ code: 'oauth-service-incompatible', provider: provider.id })
        }
        let account: QuotaAccount
        try {
          const candidate: QuotaAccount = {
            id: oauthAccount.id,
            provider: oauthAccount.provider,
          }
          account = validateAccount(oauthAccount.displayName === undefined
            ? candidate
            : { ...candidate, displayName: oauthAccount.displayName })
        } catch {
          throw new QuotaError({ code: 'oauth-service-incompatible', provider: provider.id })
        }
        if (account.provider !== provider.id) {
          throw new QuotaError({ code: 'oauth-account-not-found', provider: provider.id, accountId: account.id })
        }
        merged.set(cacheKey(account), { ...merged.get(cacheKey(account)), ...account })
      }
    }
    return [...merged.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id))
  }

  async getSnapshot(account: QuotaAccountRef, signal?: AbortSignal): Promise<QuotaSnapshotResult> {
    this.assertActive()
    validateAccount({ id: account.id, provider: account.provider })
    const cached = this.cache.get(cacheKey(account))
    if (cached !== undefined && this.now() - cached.cachedAt < this.cacheTtlMs) {
      return { snapshot: cached.snapshot, stale: false }
    }
    return await this.refresh(account, signal)
  }

  async refresh(account: QuotaAccountRef, signal?: AbortSignal): Promise<QuotaSnapshotResult> {
    this.assertActive()
    validateAccount({ id: account.id, provider: account.provider })
    const key = cacheKey(account)
    let flight = this.flights.get(key)
    if (flight === undefined) {
      const controller = new AbortController()
      this.controllers.set(key, controller)
      flight = this.runRefresh(account, controller.signal).finally(() => {
        this.flights.delete(key)
        this.controllers.delete(key)
      })
      this.flights.set(key, flight)
    }
    return await awaitCaller(flight, signal, account)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.controllers.values()) controller.abort('dsh-quota disposed')
    await Promise.allSettled(this.flights.values())
    this.cache.clear()
  }

  private assertActive(): void {
    if (this.disposed) throw new QuotaError({ code: 'internal' })
  }

  private requireOAuthService(provider: string): TokenFreeOAuthAccountService {
    const candidate = this.getOAuthService?.()
    if (candidate === undefined || candidate === null) {
      throw new QuotaError({ code: 'oauth-service-unavailable', provider })
    }
    if (!isTokenFreeOAuthAccountService(candidate)) {
      throw new QuotaError({ code: 'oauth-service-incompatible', provider })
    }
    return candidate
  }

  private async resolveCredentialRef(provider: QuotaProvider, account: QuotaAccountRef): Promise<string | undefined> {
    if (provider.usesOAuth !== true) return undefined
    const oauth = this.requireOAuthService(provider.id)
    let result: unknown
    try {
      result = await oauth.accountCredential(account.id)
    } catch {
      throw new QuotaError({ code: 'oauth-account-unavailable', provider: provider.id, accountId: account.id })
    }
    if (!isTokenFreeOAuthAccountCredentialRef(result)) {
      throw new QuotaError({ code: 'oauth-service-incompatible', provider: provider.id, accountId: account.id })
    }
    if (result.account.id !== account.id || result.account.provider !== account.provider) {
      throw new QuotaError({ code: 'oauth-account-not-found', provider: provider.id, accountId: account.id })
    }
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(result.credentialRef)) {
      throw new QuotaError({ code: 'oauth-service-incompatible', provider: provider.id, accountId: account.id })
    }
    return result.credentialRef
  }

  private async runRefresh(account: QuotaAccountRef, signal: AbortSignal): Promise<QuotaSnapshotResult> {
    const key = cacheKey(account)
    try {
      const provider = this.registry.get(account.provider)
      const credentialRef = await this.resolveCredentialRef(provider, account)
      const snapshot = await this.withConcurrency(signal, account, () =>
        this.requestWithRetry(provider, account, credentialRef, signal))
      validateSnapshot(snapshot, account)
      this.cache.set(key, { snapshot, cachedAt: this.now() })
      return { snapshot, stale: false }
    } catch (error) {
      /* v8 ignore next -- all owned operation seams classify before reaching this boundary */
      const classified = error instanceof QuotaError ? error : classifyProviderError(error, account)
      const cached = this.cache.get(key)
      if (cached !== undefined) {
        return { snapshot: cached.snapshot, stale: true, lastError: classified.toJSON() }
      }
      throw classified
    }
  }

  private async requestWithRetry(
    provider: QuotaProvider,
    account: QuotaAccountRef,
    credentialRef: string | undefined,
    signal: AbortSignal,
  ): Promise<QuotaSnapshot> {
    const attempts = provider.retryPolicy?.maxAttempts ?? 1
    let attempt = 0
    while (true) {
      attempt += 1
      try {
        return await this.requestOnce(provider, account, credentialRef, signal)
      } catch (error) {
        const classified = error as QuotaError
        if (attempt === attempts || provider.retryPolicy === undefined || !classified.retryable) throw classified
        await this.delay(classified.retryAfterMs ?? provider.retryPolicy.baseDelayMs, signal)
      }
    }
  }

  private async requestOnce(
    provider: QuotaProvider,
    account: QuotaAccountRef,
    credentialRef: string | undefined,
    flightSignal: AbortSignal,
  ): Promise<QuotaSnapshot> {
    const request = new AbortController()
    let timedOut = false
    const abort = () => request.abort(flightSignal.reason)
    flightSignal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      request.abort('dsh-quota timeout')
    }, this.timeoutMs)
    try {
      return await provider.getQuota(account, request.signal, credentialRef)
    } catch (error) {
      if (timedOut) throw new QuotaError({ code: 'timeout', provider: account.provider, accountId: account.id })
      if (flightSignal.aborted) throw new QuotaError({ code: 'cancelled', provider: account.provider, accountId: account.id })
      throw classifyProviderError(error, account)
    } finally {
      clearTimeout(timeout)
      flightSignal.removeEventListener('abort', abort)
    }
  }

  private async withConcurrency<T>(signal: AbortSignal, account: QuotaAccountRef, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal, account)
    try {
      return await operation()
    } finally {
      this.release()
    }
  }

  private async acquire(signal: AbortSignal, account: QuotaAccountRef): Promise<void> {
    if (signal.aborted) throw new QuotaError({ code: 'cancelled', provider: account.provider, accountId: account.id })
    if (this.active < this.maxConcurrency) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: ConcurrencyWaiter = {
        signal,
        start: () => {
          signal.removeEventListener('abort', waiter.cancel)
          resolve()
        },
        cancel: () => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          reject(new QuotaError({ code: 'cancelled', provider: account.provider, accountId: account.id }))
        },
      }
      signal.addEventListener('abort', waiter.cancel, { once: true })
      this.waiters.push(waiter)
    })
  }

  private release(): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.active -= 1
    else waiter.start()
  }
}

function cacheKey(account: QuotaAccountRef): string {
  return `${account.provider}\u0000${account.id}`
}

async function awaitCaller<T>(promise: Promise<T>, signal: AbortSignal | undefined, account: QuotaAccountRef): Promise<T> {
  if (signal === undefined) return await promise
  if (signal.aborted) throw new QuotaError({ code: 'cancelled', provider: account.provider, accountId: account.id })
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new QuotaError({ code: 'cancelled', provider: account.provider, accountId: account.id }))
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

export async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
