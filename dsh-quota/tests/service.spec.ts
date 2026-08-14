import { describe, expect, it, vi } from 'vitest'
import { QuotaError } from '../src/errors.ts'
import { FakeQuotaProvider, deferred } from '../src/fakes.ts'
import type { QuotaAccount, QuotaSnapshot } from '../src/model.ts'
import { QuotaServiceImpl, abortableDelay } from '../src/service.ts'
import type { TokenFreeOAuthAccountService } from '../src/plugin.ts'

const account: QuotaAccount = { id: 'account-1', provider: 'fake', displayName: 'Example' }
const second: QuotaAccount = { id: 'account-2', provider: 'fake' }

function snapshot(value: number, target = account): QuotaSnapshot {
  return {
    accountId: target.id,
    provider: target.provider,
    observedAt: value,
    windows: [{ id: 'day', remaining: value, unit: 'requests' }],
  }
}

function setup(options: { now?: () => number; retry?: boolean } = {}) {
  const provider = new FakeQuotaProvider({
    id: 'fake',
    ...(options.retry ? { retryPolicy: { maxAttempts: 2, baseDelayMs: 10 } } : {}),
  })
  provider.accounts.push(account, second)
  const delay = vi.fn(async () => {})
  const service = new QuotaServiceImpl({
    providers: [provider],
    cacheTtlMs: 100,
    timeoutMs: 1_000,
    maxConcurrency: 2,
    now: options.now ?? (() => 1_000),
    delay,
  })
  return { delay, provider, service }
}

describe('QuotaServiceImpl cache and concurrency', () => {
  it('lists accounts stably and validates config', async () => {
    const { service } = setup()
    await expect(service.listAccounts()).resolves.toEqual([account, second])
    for (const options of [
      { cacheTtlMs: -1, timeoutMs: 1, maxConcurrency: 1 },
      { cacheTtlMs: 1, timeoutMs: 0, maxConcurrency: 1 },
      { cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 0 },
      { cacheTtlMs: 1.5, timeoutMs: 1, maxConcurrency: 1 },
    ]) expect(() => new QuotaServiceImpl({ providers: [], ...options }))
      .toThrowError(expect.objectContaining({ code: 'configuration' }))
  })

  it('uses a fresh cache and refreshes after TTL', async () => {
    let now = 1_000
    const { provider, service } = setup({ now: () => now })
    provider.quotaResults.push(snapshot(900), snapshot(1_100))

    await expect(service.getSnapshot(account)).resolves.toEqual({ snapshot: snapshot(900), stale: false })
    now = 1_099
    await expect(service.getSnapshot(account)).resolves.toEqual({ snapshot: snapshot(900), stale: false })
    expect(provider.quotaCalls).toHaveLength(1)
    now = 1_100
    await expect(service.getSnapshot(account)).resolves.toEqual({ snapshot: snapshot(1_100), stale: false })
    expect(provider.quotaCalls).toHaveLength(2)
  })

  it('returns stale last success with a redacted latest error and preserves observedAt', async () => {
    let now = 1_000
    const { provider, service } = setup({ now: () => now })
    provider.quotaResults.push(snapshot(777), new Error('Bearer unsafe-secret'))
    await service.refresh(account)
    now = 1_100

    const result = await service.getSnapshot(account)
    expect(result).toMatchObject({ snapshot: { observedAt: 777 }, stale: true, lastError: { code: 'provider-response' } })
    expect(JSON.stringify(result)).not.toContain('unsafe-secret')
  })

  it('rejects failed first loads and does not cache identity-mismatched snapshots', async () => {
    const { provider, service } = setup()
    provider.quotaResults.push(new Error('unsafe'), snapshot(1, { ...account, id: 'wrong' }))
    await expect(service.getSnapshot(account)).rejects.toMatchObject({ code: 'provider-response' })
    await expect(service.getSnapshot(account)).rejects.toMatchObject({ code: 'provider-response' })
    expect(provider.quotaCalls).toHaveLength(2)
  })

  it('rejects unsafe caller account refs before cache or provider work', async () => {
    const { provider, service } = setup()
    for (const invalid of [
      { id: 'line\nbearer-secret', provider: 'fake' },
      { id: 'x'.repeat(257), provider: 'fake' },
      { id: 'account-1', provider: 'bad\rprovider' },
    ]) {
      const error = await service.refresh(invalid).catch((failure: unknown) => failure)
      expect(error).toMatchObject({ code: 'provider-response' })
      if (!(error instanceof QuotaError)) throw new Error('expected QuotaError')
      if (invalid.id !== account.id) expect(error.toJSON()).not.toHaveProperty('accountId')
      expect(JSON.stringify(error)).not.toContain('bearer-secret')
      await expect(service.getSnapshot(invalid)).rejects.toMatchObject({ code: 'provider-response' })
    }
    expect(provider.quotaCalls).toHaveLength(0)
  })

  it('single-flights one account while different accounts run independently', async () => {
    const { provider, service } = setup()
    const first = deferred<QuotaSnapshot>()
    const other = deferred<QuotaSnapshot>()
    provider.quotaResults.push(first.promise, other.promise)

    const a = service.refresh(account)
    const b = service.refresh(account)
    const c = service.refresh(second)
    await provider.waitForQuotaCalls(2)
    expect(provider.quotaCalls).toHaveLength(2)
    expect(provider.quotaCalls[0]!.signal).not.toBe(provider.quotaCalls[1]!.signal)
    first.resolve(snapshot(1))
    other.resolve(snapshot(2, second))
    await expect(Promise.all([a, b, c])).resolves.toEqual([
      { snapshot: snapshot(1), stale: false },
      { snapshot: snapshot(1), stale: false },
      { snapshot: snapshot(2, second), stale: false },
    ])
  })

  it('cancels one waiter without aborting a shared refresh', async () => {
    const { provider, service } = setup()
    const held = deferred<QuotaSnapshot>()
    provider.quotaResults.push(held.promise)
    const caller = new AbortController()
    const cancelled = service.refresh(account, caller.signal)
    const survivor = service.refresh(account)
    await provider.waitForQuotaCalls(1)
    caller.abort()

    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    expect(provider.quotaCalls[0]!.signal.aborted).toBe(false)
    held.resolve(snapshot(3))
    await expect(survivor).resolves.toMatchObject({ snapshot: { observedAt: 3 } })
  })

  it('aborts and drains in-flight work on idempotent disposal', async () => {
    const { provider, service } = setup()
    const held = deferred<QuotaSnapshot>()
    provider.quotaResults.push(held.promise)
    const pending = service.refresh(account)
    await provider.waitForQuotaCalls(1)
    const disposal = service.dispose()
    expect(provider.quotaCalls[0]!.signal.aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await disposal
    await expect(service.dispose()).resolves.toBeUndefined()
    await expect(service.refresh(account)).rejects.toMatchObject({ code: 'internal' })
    await expect(service.listAccounts()).rejects.toMatchObject({ code: 'internal' })
  })

  it('dynamically consumes OAuth account metadata and opaque refs without resolving tokens', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake', usesOAuth: true })
    provider.quotaResults.push(snapshot(8))
    const firstOAuth: TokenFreeOAuthAccountService = {
      accounts: vi.fn(async () => [{ ...account, displayName: 'From OAuth' }]),
      accountCredential: vi.fn(async () => ({ account, credentialRef: 'OPAQUE_REF' })),
    }
    const secondOAuth: TokenFreeOAuthAccountService = {
      accounts: vi.fn(async () => [{ ...account, displayName: 'Replaced OAuth' }]),
      accountCredential: vi.fn(async () => ({ account, credentialRef: 'REPLACED_REF' })),
    }
    let currentOAuth: TokenFreeOAuthAccountService | undefined = firstOAuth
    const service = new QuotaServiceImpl({
      providers: [provider],
      cacheTtlMs: 100,
      timeoutMs: 1_000,
      maxConcurrency: 1,
      getOAuthService: () => currentOAuth,
    })

    await expect(service.listAccounts()).resolves.toEqual([{ ...account, displayName: 'From OAuth' }])
    currentOAuth = secondOAuth
    await expect(service.listAccounts()).resolves.toEqual([{ ...account, displayName: 'Replaced OAuth' }])
    await service.refresh(account)
    expect(provider.quotaCalls[0]).toMatchObject({ credentialRef: 'REPLACED_REF' })
    expect(provider.quotaCalls[0]).not.toHaveProperty('accessToken')
  })

  it('normalizes OAuth account-list failures and malformed ownership', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake', usesOAuth: true })
    const create = (accounts: TokenFreeOAuthAccountService['accounts']) => new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 1,
      getOAuthService: () => ({
        accounts,
        accountCredential: async () => ({ account, credentialRef: 'OPAQUE' }),
      }),
    })
    await expect(create(async () => { throw new Error('secret') }).listAccounts())
      .rejects.toMatchObject({ code: 'oauth-account-unavailable' })
    await expect(create(async () => 'bad' as unknown as []).listAccounts())
      .rejects.toMatchObject({ code: 'oauth-service-incompatible' })
    await expect(create(async () => [{ ...account, provider: 'other' }]).listAccounts())
      .rejects.toMatchObject({ code: 'oauth-account-not-found' })
    await expect(create(async () => [null as never]).listAccounts())
      .rejects.toMatchObject({ code: 'oauth-service-incompatible' })
    await expect(create(async () => [{ ...account, displayName: '' }]).listAccounts())
      .rejects.toMatchObject({ code: 'oauth-service-incompatible' })
    const unnamed = { id: account.id, provider: account.provider }
    await expect(create(async () => [unnamed]).listAccounts()).resolves.toEqual([unnamed])
  })

  it('fails safely when an OAuth-aware provider lacks service or returns mismatched identity', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake', usesOAuth: true })
    const unavailable = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 1,
    })
    await expect(unavailable.refresh(account)).rejects.toMatchObject({ code: 'oauth-service-unavailable' })

    const mismatched = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 1,
      getOAuthService: () => ({
        accounts: async () => [],
        accountCredential: async () => ({ account: { ...account, id: 'other' }, credentialRef: 'OPAQUE' }),
      }),
    })
    await expect(mismatched.refresh(account)).rejects.toMatchObject({ code: 'oauth-account-not-found' })

    const incompatible = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 1,
      getOAuthService: () => ({ accounts: 'wrong shape' } as unknown as TokenFreeOAuthAccountService),
    })
    await expect(incompatible.refresh(account)).rejects.toMatchObject({ code: 'oauth-service-incompatible' })

    const rejecting = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 1,
      getOAuthService: () => ({
        accounts: async () => [],
        accountCredential: async () => { throw new Error('Bearer secret') },
      }),
    })
    const rejection = await rejecting.refresh(account).catch((error: unknown) => error)
    expect(rejection).toMatchObject({ code: 'oauth-account-unavailable' })
    expect(JSON.stringify(rejection)).not.toContain('secret')

    const invalidRef = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 1,
      getOAuthService: () => ({
        accounts: async () => [],
        accountCredential: async () => ({ account, credentialRef: '' }),
      }),
    })
    await expect(invalidRef.refresh(account)).rejects.toMatchObject({ code: 'oauth-service-incompatible' })

    for (const credentialRef of ['BAD\nREF', 'x'.repeat(129), 'lowercase_ref']) {
      const unsafeRef = new QuotaServiceImpl({
        providers: [provider], cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 1,
        getOAuthService: () => ({
          accounts: async () => [],
          accountCredential: async () => ({ account, credentialRef }),
        }),
      })
      await expect(unsafeRef.refresh(account)).rejects.toMatchObject({ code: 'oauth-service-incompatible' })
    }

    const malformedResult = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 1,
      getOAuthService: () => ({
        accounts: async () => [],
        accountCredential: async () => null as never,
      }),
    })
    await expect(malformedResult.refresh(account)).rejects.toMatchObject({ code: 'oauth-service-incompatible' })
  })

  it('classifies timeouts and bounds concurrency across accounts', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake' })
    const first = deferred<QuotaSnapshot>()
    const secondResult = deferred<QuotaSnapshot>()
    provider.quotaResults.push(first.promise, secondResult.promise)
    const service = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1_000, maxConcurrency: 1,
    })
    const firstCall = service.refresh(account)
    const secondCall = service.refresh(second)
    await provider.waitForQuotaCalls(1)
    expect(provider.quotaCalls).toHaveLength(1)
    first.resolve(snapshot(10))
    await firstCall
    await provider.waitForQuotaCalls(2)
    secondResult.resolve(snapshot(11, second))
    await secondCall
    expect(provider.quotaCalls).toHaveLength(2)

    const timeoutProvider = new FakeQuotaProvider({ id: 'fake' })
    timeoutProvider.quotaResults.push(deferred<QuotaSnapshot>().promise)
    const timeoutService = new QuotaServiceImpl({
      providers: [timeoutProvider], cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 1,
    })
    await expect(timeoutService.refresh(account)).rejects.toMatchObject({ code: 'timeout', retryable: false })
  })

  it('does not retry timeouts even when the provider opts into network and 429 retry', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake', retryPolicy: { maxAttempts: 2, baseDelayMs: 0 } })
    provider.quotaResults.push(deferred<QuotaSnapshot>().promise, snapshot(99))
    const service = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1, maxConcurrency: 1,
    })
    await expect(service.refresh(account)).rejects.toMatchObject({ code: 'timeout', retryable: false })
    expect(provider.quotaCalls).toHaveLength(1)
  })

  it('cancels queued work during disposal', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake' })
    const held = deferred<QuotaSnapshot>()
    provider.quotaResults.push(held.promise)
    const service = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1_000, maxConcurrency: 1,
    })
    const firstCall = service.refresh(account)
    const queued = service.refresh(second)
    await provider.waitForQuotaCalls(1)
    const disposal = service.dispose()
    await expect(firstCall).rejects.toMatchObject({ code: 'cancelled' })
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' })
    await disposal
  })

  it('handles pre-aborted callers and signalled rejection waiters', async () => {
    const { provider, service } = setup()
    const preAborted = new AbortController()
    preAborted.abort()
    provider.quotaResults.push(snapshot(12))
    await expect(service.refresh(account, preAborted.signal)).rejects.toMatchObject({ code: 'cancelled' })

    const active = new AbortController()
    provider.quotaResults.push(new Error('unsafe'))
    await expect(service.refresh(second, active.signal)).rejects.toMatchObject({ code: 'provider-response' })
  })

  it('uses the default retry delay and cancels it during disposal', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake', retryPolicy: { maxAttempts: 2, baseDelayMs: 1 } })
    provider.quotaResults.push(new TypeError('network'), snapshot(13))
    const service = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1_000, maxConcurrency: 1,
    })
    await expect(service.refresh(account)).resolves.toMatchObject({ snapshot: { observedAt: 13 } })

    const slowProvider = new FakeQuotaProvider({ id: 'fake', retryPolicy: { maxAttempts: 2, baseDelayMs: 10_000 } })
    slowProvider.quotaResults.push(new TypeError('network'))
    const slowService = new QuotaServiceImpl({
      providers: [slowProvider], cacheTtlMs: 1, timeoutMs: 1_000, maxConcurrency: 1,
    })
    const pending = slowService.refresh(account)
    await slowProvider.waitForQuotaCalls(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    const disposal = slowService.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await disposal
  })

  it('rejects a pre-aborted default delay without leaving a timer running', async () => {
    const signal = new AbortController()
    signal.abort()
    await expect(abortableDelay(10_000, signal.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels an internal flight before it enters the provider', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake' })
    const service = new QuotaServiceImpl({
      providers: [provider], cacheTtlMs: 1, timeoutMs: 1_000, maxConcurrency: 1,
    })
    const pending = service.refresh(account)
    const disposal = service.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await disposal
    expect(provider.quotaCalls).toHaveLength(0)
  })
})

describe('QuotaServiceImpl retry policy', () => {
  it('does not retry 429 without provider opt-in', async () => {
    const { provider, service } = setup()
    provider.quotaResults.push({ status: 429, retryAfterMs: 25 } as unknown as Error)
    await expect(service.refresh(account)).rejects.toMatchObject({ code: 'rate-limit', retryAfterMs: 25 })
    expect(provider.quotaCalls).toHaveLength(1)
  })

  it('retries opted-in 429 with retry-after and opted-in retryable network failures', async () => {
    const { delay, provider, service } = setup({ retry: true })
    provider.quotaResults.push(
      { status: 429, retryAfterMs: 25 } as unknown as Error,
      snapshot(4),
      new TypeError('network secret'),
      snapshot(5, second),
    )
    await expect(service.refresh(account)).resolves.toMatchObject({ snapshot: { observedAt: 4 } })
    await expect(service.refresh(second)).resolves.toMatchObject({ snapshot: { observedAt: 5 } })
    expect(delay).toHaveBeenNthCalledWith(1, 25, expect.any(AbortSignal))
    expect(delay).toHaveBeenNthCalledWith(2, 10, expect.any(AbortSignal))
  })

  it('stops at max attempts and never retries authentication failures', async () => {
    const { delay, provider, service } = setup({ retry: true })
    provider.quotaResults.push(
      new TypeError('one'),
      new TypeError('two'),
      new QuotaError({ code: 'authentication', provider: 'fake' }),
    )
    await expect(service.refresh(account)).rejects.toMatchObject({ code: 'network' })
    await expect(service.refresh(second)).rejects.toMatchObject({ code: 'authentication' })
    expect(delay).toHaveBeenCalledOnce()
    expect(provider.quotaCalls).toHaveLength(3)
  })
})
