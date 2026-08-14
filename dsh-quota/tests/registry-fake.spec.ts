import { describe, expect, it } from 'vitest'
import { FakeQuotaProvider, deferred } from '../src/fakes.ts'
import { ProviderRegistry } from '../src/provider-registry.ts'
import type { QuotaAccount } from '../src/model.ts'

const account: QuotaAccount = { id: 'account-1', provider: 'fake' }

describe('ProviderRegistry and FakeQuotaProvider', () => {
  it('registers stable unique provider ids and discovers validated accounts', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake' })
    provider.accounts.push(account)
    const registry = new ProviderRegistry([provider])

    expect(registry.get('fake')).toBe(provider)
    expect(registry.has('fake')).toBe(true)
    expect(registry.providers()).toEqual([provider])
    await expect(registry.discoverAccounts()).resolves.toEqual([account])
    expect(provider.discoverCalls).toBe(1)
  })

  it('rejects missing, duplicate, and mismatched provider ownership', async () => {
    expect(() => new ProviderRegistry([new FakeQuotaProvider({ id: '' })]))
      .toThrowError(expect.objectContaining({ code: 'configuration' }))
    expect(() => new ProviderRegistry([
      new FakeQuotaProvider({ id: 'same' }),
      new FakeQuotaProvider({ id: 'same' }),
    ])).toThrowError(expect.objectContaining({ code: 'configuration' }))

    const mismatched = new FakeQuotaProvider({ id: 'fake' })
    mismatched.accounts.push({ ...account, provider: 'other' })
    await expect(new ProviderRegistry([mismatched]).discoverAccounts())
      .rejects.toMatchObject({ code: 'provider-response' })
    expect(() => new ProviderRegistry().get('missing'))
      .toThrowError(expect.objectContaining({ code: 'configuration' }))

    const duplicateAccounts = new FakeQuotaProvider({ id: 'fake' })
    duplicateAccounts.accounts.push(account, account)
    await expect(new ProviderRegistry([duplicateAccounts]).discoverAccounts())
      .rejects.toMatchObject({ code: 'provider-response' })

    const discoveryFailure = new FakeQuotaProvider({ id: 'fake' })
    discoveryFailure.discoverAccounts = async () => { throw new TypeError('secret') }
    await expect(new ProviderRegistry([discoveryFailure]).discoverAccounts())
      .rejects.toMatchObject({ code: 'network' })

    for (const malformed of [null, { account: 'not-an-array' }, [null]]) {
      const malformedProvider = new FakeQuotaProvider({ id: 'fake' })
      malformedProvider.discoverAccounts = async () => malformed as never
      await expect(new ProviderRegistry([malformedProvider]).discoverAccounts())
        .rejects.toMatchObject({ code: 'provider-response', provider: 'fake' })
    }
  })

  it('fails account discovery atomically with a stable provider classification', async () => {
    const healthy = new FakeQuotaProvider({ id: 'healthy' })
    healthy.accounts.push({ id: 'healthy-account', provider: 'healthy' })
    const failed = new FakeQuotaProvider({ id: 'failed' })
    failed.discoverAccounts = async () => { throw new TypeError('secret endpoint detail') }

    await expect(new ProviderRegistry([healthy, failed]).discoverAccounts()).rejects.toMatchObject({
      code: 'network',
      provider: 'failed',
      retryable: true,
    })
    expect(healthy.discoverCalls).toBe(1)
  })

  it('rejects invalid retry policies and overlong ids', () => {
    for (const provider of [
      new FakeQuotaProvider({ id: 'x'.repeat(129) }),
      new FakeQuotaProvider({ id: 'fake', retryPolicy: { maxAttempts: 0, baseDelayMs: 1 } }),
      new FakeQuotaProvider({ id: 'fake', retryPolicy: { maxAttempts: 1.5, baseDelayMs: 1 } }),
      new FakeQuotaProvider({ id: 'fake', retryPolicy: { maxAttempts: 1, baseDelayMs: -1 } }),
      new FakeQuotaProvider({ id: 'fake', retryPolicy: { maxAttempts: 1, baseDelayMs: 1.5 } }),
    ]) expect(() => new ProviderRegistry([provider])).toThrowError(expect.objectContaining({ code: 'configuration' }))
  })

  it('queues deterministic quota results and forwards cancellation', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake' })
    provider.quotaResults.push({ accountId: account.id, provider: account.provider, observedAt: 1, windows: [] })
    await expect(provider.getQuota(account)).resolves.toMatchObject({ observedAt: 1 })

    const held = deferred<never>()
    provider.quotaResults.push(held.promise)
    const controller = new AbortController()
    const pending = provider.getQuota(account, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(provider.quotaCalls).toHaveLength(2)
  })

  it('records only an opaque credential reference for OAuth-aware calls', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake', usesOAuth: true })
    provider.quotaResults.push({ accountId: account.id, provider: account.provider, observedAt: 1, windows: [] })
    await provider.getQuota(account, undefined, 'OPAQUE_REF')
    expect(provider.quotaCalls[0]).toMatchObject({ account, credentialRef: 'OPAQUE_REF' })
    expect(provider.quotaCalls[0]).not.toHaveProperty('token')
  })

  it('surfaces empty queues, pre-cancellation, and queued promise rejection', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake' })
    await expect(provider.getQuota(account)).rejects.toThrow('queue is empty')

    const cancelled = new AbortController()
    cancelled.abort()
    provider.quotaResults.push(Promise.resolve({ accountId: account.id, provider: account.provider, observedAt: 1, windows: [] }))
    await expect(provider.getQuota(account, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })

    provider.quotaResults.push(Promise.reject(new Error('fake rejection')))
    await expect(provider.getQuota(account)).rejects.toThrow('fake rejection')
    await provider.waitForQuotaCalls(3)
  })
})
