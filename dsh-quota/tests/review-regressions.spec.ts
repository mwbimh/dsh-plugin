import { describe, expect, it, vi } from 'vitest'
import { FakeQuotaProvider, deferred } from '../src/fakes.ts'
import type { QuotaAccount, QuotaSnapshot } from '../src/model.ts'
import type { TokenFreeOAuthAccountCredentialRef, TokenFreeOAuthAccountService } from '../src/oauth.ts'
import { QuotaServiceImpl } from '../src/service.ts'

const account: QuotaAccount = { id: 'account-1', provider: 'fake' }

function snapshot(remaining = 8): QuotaSnapshot {
  return {
    accountId: account.id,
    provider: account.provider,
    observedAt: 1_720_000_000_123,
    windows: [{ id: 'day', remaining, limit: 10, unit: 'requests' }],
  }
}

function createService(provider: FakeQuotaProvider, options: {
  timeoutMs?: number
  oauth?: TokenFreeOAuthAccountService
} = {}): QuotaServiceImpl {
  return new QuotaServiceImpl({
    providers: [provider],
    cacheTtlMs: 60_000,
    timeoutMs: options.timeoutMs ?? 1_000,
    maxConcurrency: 1,
    ...(options.oauth === undefined ? {} : { getOAuthService: () => options.oauth }),
  })
}

describe('Quota review regressions', () => {
  it('does not create an internal flight for a pre-aborted caller', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake' })
    provider.quotaResults.push(snapshot())
    const service = createService(provider)
    const caller = new AbortController()
    caller.abort()

    await expect(service.refresh(account, caller.signal)).rejects.toMatchObject({ code: 'cancelled' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(provider.quotaCalls).toHaveLength(0)

    provider.quotaResults.push(snapshot())
    await expect(service.getSnapshot(account, caller.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(provider.quotaCalls).toHaveLength(0)
  })

  it('aborts the owned provider flight only after its final waiter cancels', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake' })
    const held = deferred<QuotaSnapshot>()
    provider.quotaResults.push(held.promise)
    const service = createService(provider)
    const firstCaller = new AbortController()
    const secondCaller = new AbortController()
    const first = service.refresh(account, firstCaller.signal)
    const second = service.refresh(account, secondCaller.signal)
    await provider.waitForQuotaCalls(1)

    firstCaller.abort()
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    expect(provider.quotaCalls[0]!.signal.aborted).toBe(false)

    secondCaller.abort()
    await expect(second).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(provider.quotaCalls[0]!.signal.aborted).toBe(true))
  })

  it('starts timeout before OAuth freshness lookup and ignores its late settlement', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake', usesOAuth: true })
    provider.quotaResults.push(snapshot())
    const held = deferred<TokenFreeOAuthAccountCredentialRef>()
    const accountCredential = vi.fn((_accountId: string, _options?: { readonly signal?: AbortSignal }) => held.promise)
    const oauth: TokenFreeOAuthAccountService = {
      accounts: async () => [account],
      accountCredential,
    }
    const service = createService(provider, { timeoutMs: 5, oauth })
    const pending = service.refresh(account)

    try {
      await vi.waitFor(() => expect(accountCredential).toHaveBeenCalledOnce())
      const outcome = await Promise.race([
        pending.then(() => 'resolved', (error: unknown) => (error as { code?: string }).code),
        new Promise<string>(resolve => setTimeout(() => resolve('still-pending'), 100)),
      ])
      expect(outcome).toBe('timeout')
      const options = accountCredential.mock.calls[0]?.[1]
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      expect(options?.signal?.aborted).toBe(true)
      held.resolve({ account, credentialRef: 'OPAQUE_REF' })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(provider.quotaCalls).toHaveLength(0)
    } finally {
      held.resolve({ account, credentialRef: 'OPAQUE_REF' })
      await pending.catch(() => undefined)
      await service.dispose()
    }
  })

  it('propagates final-waiter cancellation through OAuth freshness lookup', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake', usesOAuth: true })
    const held = deferred<TokenFreeOAuthAccountCredentialRef>()
    const accountCredential = vi.fn((_accountId: string, _options?: { readonly signal?: AbortSignal }) => held.promise)
    const oauth: TokenFreeOAuthAccountService = {
      accounts: async () => [account],
      accountCredential,
    }
    const service = createService(provider, { oauth })
    const caller = new AbortController()
    const pending = service.refresh(account, caller.signal)
    await vi.waitFor(() => expect(accountCredential).toHaveBeenCalledOnce())

    caller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    const options = accountCredential.mock.calls[0]?.[1]
    expect(options?.signal?.aborted).toBe(true)
    held.resolve({ account, credentialRef: 'OPAQUE_REF' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(provider.quotaCalls).toHaveLength(0)
  })

  it('honors cancellation that races with registration of the first flight waiter', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake', usesOAuth: true })
    const held = deferred<TokenFreeOAuthAccountCredentialRef>()
    const caller = new AbortController()
    const oauth: TokenFreeOAuthAccountService = {
      accounts: async () => [account],
      accountCredential: vi.fn(() => {
        caller.abort()
        return held.promise
      }),
    }
    const service = createService(provider, { oauth })

    await expect(service.refresh(account, caller.signal)).rejects.toMatchObject({ code: 'cancelled' })
    held.resolve({ account, credentialRef: 'OPAQUE_REF' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(provider.quotaCalls).toHaveLength(0)
  })

  it('does not start another request when an abort-ignoring retry delay settles late', async () => {
    const provider = new FakeQuotaProvider({
      id: 'fake',
      retryPolicy: { maxAttempts: 2, baseDelayMs: 10 },
    })
    provider.quotaResults.push(new TypeError('network'), snapshot())
    const delayStarted = deferred<void>()
    const releaseDelay = deferred<void>()
    const service = new QuotaServiceImpl({
      providers: [provider],
      cacheTtlMs: 1,
      timeoutMs: 1_000,
      maxConcurrency: 1,
      delay: async () => {
        delayStarted.resolve()
        await releaseDelay.promise
      },
    })
    const caller = new AbortController()
    const pending = service.refresh(account, caller.signal)
    await delayStarted.promise

    caller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    releaseDelay.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(provider.quotaCalls).toHaveLength(1)
  })

  it('normalizes and freezes a detached provider snapshot before caching or returning it', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake' })
    const providerSnapshot = snapshot()
    ;(providerSnapshot as QuotaSnapshot & { unsafeDetail?: string }).unsafeDetail = 'snapshot-secret'
    ;(providerSnapshot.windows[0] as QuotaSnapshot['windows'][number] & { unsafeDetail?: string }).unsafeDetail = 'window-secret'
    provider.quotaResults.push(providerSnapshot)
    const service = createService(provider)
    const result = await service.refresh(account)

    ;(providerSnapshot.windows[0] as { remaining?: number }).remaining = 999
    expect(result.snapshot.windows[0]?.remaining).toBe(8)
    expect(Object.isFrozen(result.snapshot)).toBe(true)
    expect(Object.isFrozen(result.snapshot.windows)).toBe(true)
    expect(Object.isFrozen(result.snapshot.windows[0])).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result.snapshot).not.toHaveProperty('unsafeDetail')
    expect(result.snapshot.windows[0]).not.toHaveProperty('unsafeDetail')
    expect(() => {
      ;(result.snapshot.windows[0] as { remaining?: number }).remaining = 7
    }).toThrow(TypeError)
    await expect(service.getSnapshot(account)).resolves.toMatchObject({
      snapshot: { windows: [{ remaining: 8 }] },
      stale: false,
    })
  })
})
