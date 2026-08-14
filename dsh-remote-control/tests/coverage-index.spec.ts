import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteControlServerOptions } from '../src/server.ts'

const mocks = vi.hoisted(() => ({
  createServer: vi.fn(),
  openState: vi.fn(),
}))

vi.mock('../src/server.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/server.ts')>(),
  createRemoteControlServer: mocks.createServer,
}))

vi.mock('../src/file-state.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/file-state.ts')>(),
  openFileState: mocks.openState,
}))

import { apply } from '../src/index.ts'

const identity = { deviceId: 'host', publicKey: 'host-public', privateKey: 'host-private' }
const trustStore = {
  get: vi.fn(),
  put: vi.fn(),
  revoke: vi.fn(),
  list: vi.fn(() => []),
}

function createContext(apiProxy: object, lifecycles: Array<Promise<unknown>>): Context {
  return {
    apiProxy,
    effect(callback: () => Promise<unknown>) {
      lifecycles.push(callback())
    },
  } as unknown as Context
}

describe('plugin composition coverage', () => {
  const start = vi.fn(async () => {})
  const dispose = vi.fn(async () => {})

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openState.mockReturnValue({ identity, trustStore })
    mocks.createServer.mockReturnValue({ start, dispose })
  })

  it('stays disabled and validates enabled configuration', () => {
    const ctx = createContext({}, [])

    apply(ctx)
    apply(ctx, { enabled: true, lan: false })

    expect(mocks.openState).not.toHaveBeenCalled()
    expect(mocks.createServer).not.toHaveBeenCalled()
    expect(() => apply(ctx, { enabled: true, lan: true })).toThrow(/statePath is required/)
  })

  it('composes default and explicit listener options and lifecycle cleanup', async () => {
    const apiProxy = { sessions: { list: vi.fn(), history: vi.fn() } }
    const defaultsLifecycle: Array<Promise<unknown>> = []
    apply(createContext(apiProxy, defaultsLifecycle), {
      enabled: true,
      lan: true,
      statePath: 'default-state.json',
    })
    const defaults = mocks.createServer.mock.calls.at(-1)?.[0] as RemoteControlServerOptions
    expect(defaults.listen).toEqual({ lan: true, address: '127.0.0.1', port: 0 })
    expect(defaults.management).toEqual({ address: '127.0.0.1', port: 0 })
    const defaultsCleanup = await defaultsLifecycle[0] as () => Promise<void>
    await defaultsCleanup()

    const explicitLifecycle: Array<Promise<unknown>> = []
    apply(createContext(apiProxy, explicitLifecycle), {
      enabled: true,
      lan: true,
      address: '192.168.1.2',
      port: 43721,
      managementPort: 43722,
      statePath: 'explicit-state.json',
    })
    const explicit = mocks.createServer.mock.calls.at(-1)?.[0] as RemoteControlServerOptions
    expect(explicit.listen).toEqual({ lan: true, address: '192.168.1.2', port: 43721 })
    expect(explicit.management).toEqual({ address: '127.0.0.1', port: 43722 })
    const explicitCleanup = await explicitLifecycle[0] as () => Promise<void>
    await explicitCleanup()

    expect(mocks.openState).toHaveBeenNthCalledWith(1, 'default-state.json')
    expect(mocks.openState).toHaveBeenNthCalledWith(2, 'explicit-state.json')
    expect(start).toHaveBeenCalledTimes(2)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('maps successful DSH list and history responses without losing optional fields', async () => {
    const listItems = [
      { sessionId: 'plain', updatedAt: 1, running: false, blank: false },
      {
        sessionId: 'child', updatedAt: 2, running: true, blank: false,
        parentSessionId: 'plain', origin: 'subagent' as const,
      },
    ]
    const eventData = { text: 'copy me' }
    const apiProxy = {
      sessions: {
        list: vi.fn(async (_request: { rpcId: string; payload: Record<string, never> }) => ({ result: { ok: true, value: { items: listItems } } })),
        history: vi.fn(async (_request: { rpcId: string; payload: typeof request }) => ({ result: { ok: true, value: {
          events: [
            { event: { seq: 1, type: 'plain', time: 10, data: null } },
            { event: { seq: 2, type: 'optional', time: 20, data: eventData, ignorable: false } },
          ],
          hasMore: true,
        } } })),
      },
    }
    apply(createContext(apiProxy, []), { enabled: true, lan: true, statePath: 'state.json' })
    const options = mocks.createServer.mock.calls.at(-1)?.[0] as RemoteControlServerOptions
    const signal = new AbortController().signal

    await expect(options.adapter.list({ signal })).resolves.toEqual({ items: listItems })
    const request = { sessionId: 'child', beforeSeq: 3, maxMessages: 4 }
    const history = await options.adapter.history(request, { signal })

    expect(history).toEqual({
      events: [
        { event: { seq: 1, type: 'plain', time: 10, data: null } },
        { event: { seq: 2, type: 'optional', time: 20, data: eventData, ignorable: false } },
      ],
      hasMore: true,
    })
    expect(history.events[1]?.event.data).not.toBe(eventData)
    const [listRequest] = apiProxy.sessions.list.mock.calls[0]!
    expect(typeof listRequest.rpcId).toBe('string')
    expect(listRequest.payload).toEqual({})
    const [historyRequest] = apiProxy.sessions.history.mock.calls[0]!
    expect(typeof historyRequest.rpcId).toBe('string')
    expect(historyRequest.payload).toEqual(request)
  })

  it('surfaces DSH adapter failures and checks aborted signals first', async () => {
    const apiProxy = {
      sessions: {
        list: vi.fn(async () => ({ result: { ok: false } })),
        history: vi.fn(async () => ({ result: { ok: false } })),
      },
    }
    apply(createContext(apiProxy, []), { enabled: true, lan: true, statePath: 'state.json' })
    const options = mocks.createServer.mock.calls.at(-1)?.[0] as RemoteControlServerOptions
    const signal = new AbortController().signal

    await expect(options.adapter.list({ signal })).rejects.toThrow(/session\.list failed/)
    await expect(options.adapter.history({ sessionId: 'x' }, { signal })).rejects.toThrow(/session\.history failed/)

    const aborted = new AbortController()
    aborted.abort(new Error('already aborted'))
    await expect(options.adapter.list({ signal: aborted.signal })).rejects.toThrow(/already aborted/)
  })

  it('drops apiProxy results which resolve after list or history is aborted', async () => {
    let resolveList!: (value: { result: { ok: true; value: { items: [] } } }) => void
    let resolveHistory!: (value: { result: { ok: true; value: { events: []; hasMore: false } } }) => void
    const apiProxy = {
      sessions: {
        list: vi.fn(async () => new Promise(resolve => { resolveList = resolve })),
        history: vi.fn(async () => new Promise(resolve => { resolveHistory = resolve })),
      },
    }
    apply(createContext(apiProxy, []), { enabled: true, lan: true, statePath: 'state.json' })
    const options = mocks.createServer.mock.calls.at(-1)?.[0] as RemoteControlServerOptions

    const listAbort = new AbortController()
    const list = options.adapter.list({ signal: listAbort.signal })
    listAbort.abort(new Error('list revoked'))
    resolveList({ result: { ok: true, value: { items: [] } } })
    await expect(list).rejects.toThrow(/list revoked/)

    const historyAbort = new AbortController()
    const history = options.adapter.history({ sessionId: 'x' }, { signal: historyAbort.signal })
    historyAbort.abort(new Error('history revoked'))
    resolveHistory({ result: { ok: true, value: { events: [], hasMore: false } } })
    await expect(history).rejects.toThrow(/history revoked/)
  })
})
