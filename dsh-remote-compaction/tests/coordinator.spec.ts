import { describe, expect, it, vi } from 'vitest'
import { RemoteCompactionCoordinator } from '../src/coordinator.ts'

describe('RemoteCompactionCoordinator lifecycle', () => {
  it('resolves credentials per operation and isolates cache targets', async () => {
    const resolveCredential = vi.fn()
      .mockResolvedValueOnce('first-key')
      .mockResolvedValueOnce('second-key')
    const compact = vi.fn(async () => ({
      output: [{ type: 'compaction', encrypted_content: 'opaque' }],
    }))
    const coordinator = new RemoteCompactionCoordinator({
      supportedTtlMs: 1_000,
      unavailableTtlMs: 100,
      resolveCredential,
      compact,
    })
    await coordinator.compact({
      provider: 'openai', model: 'one', baseURL: 'https://api.example/v1', input: [],
    })
    await coordinator.compact({
      provider: 'openai', model: 'two', baseURL: 'https://api.example/v1', input: [],
    })
    expect(resolveCredential).toHaveBeenCalledTimes(2)
    expect(compact).toHaveBeenNthCalledWith(1, expect.objectContaining({ apiKey: 'first-key' }))
    expect(compact).toHaveBeenNthCalledWith(2, expect.objectContaining({ apiKey: 'second-key' }))
    expect(coordinator.status('openai\none\nhttps://api.example/v1')).toBe('supported')
  })

  it('fails before transport when credentials are absent', async () => {
    const compact = vi.fn()
    const coordinator = new RemoteCompactionCoordinator({
      supportedTtlMs: 1_000,
      unavailableTtlMs: 100,
      resolveCredential: async () => undefined,
      compact,
    })
    await expect(coordinator.compact({
      provider: 'openai', model: 'one', baseURL: 'https://api.example/v1', input: [],
    })).rejects.toMatchObject({ code: 'authentication' })
    expect(compact).not.toHaveBeenCalled()
  })

  it('aborts in-flight operations and rejects future work after dispose', async () => {
    let observedSignal: AbortSignal | undefined
    const coordinator = new RemoteCompactionCoordinator({
      supportedTtlMs: 1_000,
      unavailableTtlMs: 100,
      resolveCredential: async () => 'key',
      compact: async request => new Promise((_resolve, reject) => {
        observedSignal = request.signal
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      }),
    })
    const pending = coordinator.compact({
      provider: 'openai', model: 'one', baseURL: 'https://api.example/v1', input: [],
    })
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    const disposing = coordinator.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    await disposing
    await coordinator.dispose()
    expect(observedSignal?.aborted).toBe(true)
    expect(coordinator.status('openai\none\nhttps://api.example/v1')).toBe('unknown')
    await expect(coordinator.compact({
      provider: 'openai', model: 'one', baseURL: 'https://api.example/v1', input: [],
    })).rejects.toMatchObject({ code: 'aborted' })
  })

  it('rejects an empty resolved credential', async () => {
    const coordinator = new RemoteCompactionCoordinator({
      supportedTtlMs: 1_000,
      unavailableTtlMs: 100,
      resolveCredential: async () => '',
      compact: vi.fn(),
    })
    await expect(coordinator.compact({
      provider: 'openai', model: 'one', baseURL: 'https://api.example/v1', input: [],
    })).rejects.toMatchObject({ code: 'authentication' })
  })

  it('preserves caller cancellation instead of converting it to disposal', async () => {
    const coordinator = new RemoteCompactionCoordinator({
      supportedTtlMs: 1_000,
      unavailableTtlMs: 100,
      resolveCredential: async () => 'key',
      compact: async request => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      }),
    })
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    const pending = coordinator.compact({
      provider: 'openai', model: 'one', baseURL: 'https://api.example/v1', input: [],
      signal: controller.signal,
    })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })
})
