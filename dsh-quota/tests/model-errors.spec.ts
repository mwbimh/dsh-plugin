import { describe, expect, it } from 'vitest'
import { QuotaError, classifyProviderError } from '../src/errors.ts'
import { validateAccount, validateSnapshot } from '../src/model.ts'
import type { QuotaAccount, QuotaSnapshot } from '../src/model.ts'

const account: QuotaAccount = { id: 'account-1', provider: 'fake', displayName: 'Example' }

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    accountId: account.id,
    provider: account.provider,
    observedAt: 1_720_000_000_123,
    windows: [{ id: 'day', remaining: 8, limit: 10, unit: 'requests', resetAt: 1_720_086_400_000 }],
    ...overrides,
  }
}

describe('quota public model invariants', () => {
  it('accepts millisecond timestamps, empty windows, and windows without percentage data', () => {
    expect(validateAccount(account)).toEqual(account)
    expect(validateSnapshot(snapshot({ windows: [] }), account)).toEqual(snapshot({ windows: [] }))
    expect(validateSnapshot(snapshot(), account).windows[0]).not.toHaveProperty('remainingPercent')
  })

  it('rejects invalid identities, timestamps, values, units, and duplicate window ids', () => {
    for (const invalid of [
      { ...account, id: '' },
      { ...account, provider: '' },
      { ...account, displayName: '' },
      { ...account, plan: ' '.repeat(2) },
      { ...account, displayName: `unsafe${String.fromCharCode(127)}` },
      { ...account, id: 'x'.repeat(257) },
      { id: undefined, provider: undefined } as unknown as QuotaAccount,
    ]) expect(() => validateAccount(invalid)).toThrowError(expect.objectContaining({ code: 'provider-response' }))

    for (const invalid of [
      snapshot({ accountId: 'other' }),
      snapshot({ provider: 'other' }),
      snapshot({ observedAt: -1 }),
      snapshot({ observedAt: 1.5 }),
      snapshot({ observedAt: Number.POSITIVE_INFINITY }),
      snapshot({ windows: [{ id: '', unit: 'requests' }] }),
      snapshot({ windows: [{ id: 'day', unit: 'invalid' as 'requests' }] }),
      snapshot({ windows: [{ id: 'day', used: -1, unit: 'requests' }] }),
      snapshot({ windows: [{ id: 'day', remaining: Number.NaN, unit: 'requests' }] }),
      snapshot({ windows: [{ id: 'day', limit: Number.POSITIVE_INFINITY, unit: 'requests' }] }),
      snapshot({ windows: [{ id: 'day', unit: 'requests', resetAt: 2.5 }] }),
      snapshot({ windows: [{ id: 'day', remaining: 11, limit: 10, unit: 'requests' }] }),
      snapshot({ windows: [{ id: 'day', used: 11, limit: 10, unit: 'requests' }] }),
      snapshot({ windows: [{ id: 'day', used: 6, remaining: 5, limit: 10, unit: 'requests' }] }),
      snapshot({ windows: [{ id: 'day', unit: 'requests' }, { id: 'day', unit: 'requests' }] }),
      snapshot({ windows: undefined as unknown as [] }),
    ]) expect(() => validateSnapshot(invalid, account)).toThrowError(expect.objectContaining({ code: 'provider-response' }))
  })
})

describe('stable redacted quota errors', () => {
  it('serializes only safe classified fields', () => {
    const error = new QuotaError({
      code: 'rate-limit',
      provider: 'fake',
      accountId: 'account-1',
      retryable: true,
      retryAfterMs: 2_000,
    })
    expect(error.toJSON()).toEqual({
      name: 'QuotaError',
      message: 'dsh-quota: provider rate limit reached',
      code: 'rate-limit',
      provider: 'fake',
      accountId: 'account-1',
      retryable: true,
      retryAfterMs: 2_000,
    })
  })

  it('classifies 429/retry-after explicitly and redacts unknown failures', () => {
    const rateLimit = classifyProviderError(
      { status: 429, retryAfterMs: 1_500, message: 'Authorization: Bearer secret' },
      account,
    )
    expect(rateLimit).toMatchObject({ code: 'rate-limit', retryable: true, retryAfterMs: 1_500 })
    expect(JSON.stringify(rateLimit)).not.toContain('secret')

    const network = classifyProviderError(new TypeError('token=secret'), account)
    expect(network).toMatchObject({ code: 'network', retryable: true })
    expect(network.message).not.toContain('secret')

    const existing = new QuotaError({ code: 'authentication', provider: 'fake' })
    expect(classifyProviderError(existing, account)).toBe(existing)
    expect(classifyProviderError(new Error('unsafe'), account)).toMatchObject({ code: 'provider-response', retryable: false })
    expect(classifyProviderError(new DOMException('unsafe', 'AbortError'), account)).toMatchObject({ code: 'cancelled' })
    expect(classifyProviderError({ status: 429 }, account).toJSON()).not.toHaveProperty('retryAfterMs')
    expect(classifyProviderError({ status: 429, retryAfterMs: -1 }, account).toJSON()).not.toHaveProperty('retryAfterMs')
    expect(new QuotaError({ code: 'internal' }).toJSON()).toEqual({
      name: 'QuotaError', message: 'dsh-quota: internal lifecycle failure', code: 'internal', retryable: false,
    })
  })
})
