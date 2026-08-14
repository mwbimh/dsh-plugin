import { describe, expect, it, vi } from 'vitest'
import { CapabilityCache } from '../src/capability-cache.ts'
import { RemoteCompactionError } from '../src/errors.ts'

describe('CapabilityCache', () => {
  it('isolates targets, expires entries, and clears state', async () => {
    let now = 0
    const cache = new CapabilityCache({ supportedTtlMs: 10, unavailableTtlMs: 5, now: () => now })
    const operation = vi.fn(async () => 'ok')
    await expect(cache.run('a/model/endpoint', operation)).resolves.toBe('ok')
    await expect(cache.run('a/model/endpoint', operation)).resolves.toBe('ok')
    await cache.run('b/model/endpoint', operation)
    expect(operation).toHaveBeenCalledTimes(3)
    expect(cache.status('a/model/endpoint')).toBe('supported')
    now = 11
    expect(cache.status('a/model/endpoint')).toBe('unknown')
    cache.clear()
    expect(cache.status('b/model/endpoint')).toBe('unknown')
  })

  it('merges concurrent unknown-state probes', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const cache = new CapabilityCache({ supportedTtlMs: 10, unavailableTtlMs: 5 })
    let result = 0
    const operation = vi.fn(async () => { await pending; result += 1; return result })
    const first = cache.run('target', operation)
    const second = cache.run('target', operation)
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1))
    release()
    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(2)
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('rejects an aborted waiter before the target probe settles', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const cache = new CapabilityCache({ supportedTtlMs: 10, unavailableTtlMs: 5 })
    const operation = vi.fn(async () => { await pending; return 'ok' })
    const first = cache.run('target', operation)
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce())

    const controller = new AbortController()
    const reason = new Error('waiter cancelled')
    const second = cache.run('target', operation, controller.signal)
    controller.abort(reason)

    await expect(second).rejects.toBe(reason)
    expect(operation).toHaveBeenCalledOnce()
    release()
    await expect(first).resolves.toBe('ok')
  })

  it('caches unsupported and temporary outcomes but not authentication', async () => {
    const cache = new CapabilityCache({ supportedTtlMs: 10, unavailableTtlMs: 5 })
    const unsupported = vi.fn(async () => {
      throw new RemoteCompactionError('unsupported', 'not supported')
    })
    await expect(cache.run('unsupported', unsupported)).rejects.toMatchObject({ code: 'unsupported' })
    await expect(cache.run('unsupported', unsupported)).rejects.toMatchObject({ code: 'unsupported' })
    expect(unsupported).toHaveBeenCalledTimes(1)

    const auth = vi.fn(async () => {
      throw new RemoteCompactionError('authentication', 'bad credentials')
    })
    await expect(cache.run('auth', auth)).rejects.toMatchObject({ code: 'authentication' })
    await expect(cache.run('auth', auth)).rejects.toMatchObject({ code: 'authentication' })
    expect(auth).toHaveBeenCalledTimes(2)
  })

  it('transitions through all four states with distinct TTLs', async () => {
    let now = 0
    const cache = new CapabilityCache({ supportedTtlMs: 10, unavailableTtlMs: 5, now: () => now })
    expect(cache.status('target')).toBe('unknown')

    await expect(cache.run('target', async () => {
      throw new RemoteCompactionError('temporarily-unavailable', 'retry later')
    })).rejects.toMatchObject({ code: 'temporarily-unavailable' })
    expect(cache.status('target')).toBe('temporarily-unavailable')
    now = 5
    expect(cache.status('target')).toBe('unknown')

    await expect(cache.run('target', async () => 'ok')).resolves.toBe('ok')
    expect(cache.status('target')).toBe('supported')
    now = 15
    expect(cache.status('target')).toBe('unknown')

    await expect(cache.run('target', async () => {
      throw new RemoteCompactionError('unsupported', 'not supported')
    })).rejects.toMatchObject({ code: 'unsupported' })
    expect(cache.status('target')).toBe('unsupported')
  })

  it('shares a concurrent unavailable conclusion without sharing response values', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const cache = new CapabilityCache({ supportedTtlMs: 10, unavailableTtlMs: 5 })
    const operation = vi.fn(async () => {
      await pending
      throw new RemoteCompactionError('temporarily-unavailable', 'retry later')
    })
    const first = cache.run('target', operation)
    const second = cache.run('target', operation)
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce())
    release()
    await expect(first).rejects.toMatchObject({ code: 'temporarily-unavailable' })
    await expect(second).rejects.toMatchObject({ code: 'temporarily-unavailable' })
    expect(operation).toHaveBeenCalledOnce()
  })

  it('does not repopulate cleared state from a late operation', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const cache = new CapabilityCache({ supportedTtlMs: 10, unavailableTtlMs: 5 })
    const running = cache.run('target', async () => { await pending; return 'ok' })
    await vi.waitFor(() => expect(cache.status('target')).toBe('unknown'))
    cache.clear()
    release()
    await expect(running).resolves.toBe('ok')
    expect(cache.status('target')).toBe('unknown')

    let rejectLate!: () => void
    const lateFailure = new Promise<void>(resolve => { rejectLate = resolve })
    const failing = cache.run('failure', async () => {
      await lateFailure
      throw new RemoteCompactionError('temporarily-unavailable', 'late failure')
    })
    cache.clear()
    rejectLate()
    await expect(failing).rejects.toMatchObject({ code: 'temporarily-unavailable' })
    expect(cache.status('failure')).toBe('unknown')
  })
})
