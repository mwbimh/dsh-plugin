import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryTrustStore,
  createRemoteControlServer,
  generateDeviceIdentity,
  signTranscript,
  transcriptForInvoke,
  type PairedDevice,
  type SessionsReadAdapter,
} from '../src/index.ts'
import { waitUntil } from './helpers.ts'

const httpMocks = vi.hoisted(() => ({
  handlers: [] as Array<(request: unknown, response: unknown) => void>,
  addresses: [] as unknown[],
}))

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  const { EventEmitter: MockEventEmitter } = await import('node:events')
  class FakeServer extends MockEventEmitter {
    headersTimeout = 0
    requestTimeout = 0

    listen(): this {
      queueMicrotask(() => this.emit('listening'))
      return this
    }

    address(): unknown {
      return httpMocks.addresses.length === 0
        ? { address: '127.0.0.1', family: 'IPv4', port: 43721 }
        : httpMocks.addresses.shift()
    }

    close(): this {
      return this
    }

    closeAllConnections(): void {}
  }

  return {
    ...actual,
    createServer: vi.fn((handler: (request: unknown, response: unknown) => void) => {
      httpMocks.handlers.push(handler)
      return new FakeServer()
    }),
  }
})

class FakeRequest extends EventEmitter {
  readonly socket: { remoteAddress?: string }

  constructor(
    readonly method: string,
    readonly url: string,
    private readonly chunks: Array<string | Buffer> = [],
    remoteAddress: string | null = '127.0.0.1',
  ) {
    super()
    this.socket = remoteAddress === null ? {} : { remoteAddress }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string | Buffer> {
    yield* this.chunks
  }

  destroy(): void {}
}

class FakeResponse extends EventEmitter {
  headersSent: boolean
  destroyed = false
  writableEnded = false
  writableFinished = false
  status: number | undefined
  body = ''
  destroyedWith: unknown

  constructor(
    headersSent = false,
    private readonly writeFailure?: unknown,
  ) {
    super()
    this.headersSent = headersSent
  }

  writeHead(status: number): this {
    this.status = status
    this.headersSent = true
    if (this.writeFailure !== undefined) throw this.writeFailure
    return this
  }

  end(body?: string): this {
    this.body = body ?? ''
    this.writableEnded = true
    this.writableFinished = true
    this.emit('finish')
    return this
  }

  destroy(error?: Error): this {
    this.destroyed = true
    this.destroyedWith = error
    this.emit('close')
    return this
  }
}

function createServer(options: {
  management?: boolean
  adapter?: SessionsReadAdapter
  devices?: PairedDevice[]
  listFailure?: unknown
} = {}) {
  const trustStore = createMemoryTrustStore(options.devices)
  if ('listFailure' in options) trustStore.list = () => { throw options.listFailure }
  return createRemoteControlServer({
    enabled: true,
    listen: { lan: true, address: '127.0.0.1', port: 0 },
    ...(options.management ? { management: { address: '127.0.0.1', port: 0 } } : {}),
    adapter: options.adapter ?? {
      list: vi.fn(async () => ({ items: [] })),
      history: vi.fn(async () => ({ events: [], hasMore: false })),
    },
    trustStore,
  })
}

beforeEach(() => {
  httpMocks.handlers.length = 0
  httpMocks.addresses.length = 0
})

describe('mocked Node HTTP defensive branches', () => {
  it('rejects unavailable LAN and management addresses', async () => {
    httpMocks.addresses.push(null)
    await expect(createServer().start()).rejects.toThrow(/TCP address unavailable/)

    httpMocks.addresses.push(
      { address: '127.0.0.1', family: 'IPv4', port: 43721 },
      'named-pipe',
    )
    await expect(createServer({ management: true }).start()).rejects.toThrow(/management address unavailable/)
  })

  it.each([
    ['10.0.0.2'],
    [null],
  ])('denies a non-loopback management request from %s', async (remoteAddress) => {
    const server = createServer({ management: true })
    await server.start()
    const response = new FakeResponse()

    httpMocks.handlers[1]?.(
      new FakeRequest('GET', '/dsh-remote-control/v1/management/devices', [], remoteAddress),
      response,
    )
    await waitUntil(() => response.writableEnded)

    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ error: 'loopback-required' })
  })

  it.each([
    [new Error('management exploded'), true],
    ['management exploded', false],
  ])('destroys a started management response after failure %#', async (failure, isError) => {
    const server = createServer({ management: true, listFailure: failure })
    await server.start()
    const response = new FakeResponse(true)

    httpMocks.handlers[1]?.(
      new FakeRequest('GET', '/dsh-remote-control/v1/management/devices'),
      response,
    )
    await waitUntil(() => response.destroyed)

    expect(response.destroyedWith instanceof Error).toBe(isError)
  })

  it.each([
    [new Error('write exploded'), true],
    ['write exploded', false],
  ])('destroys a started LAN response after failure %#', async (failure, isError) => {
    const server = createServer()
    await server.start()
    const response = new FakeResponse(false, failure)

    httpMocks.handlers[0]?.(new FakeRequest('GET', '/missing'), response)
    await waitUntil(() => response.destroyed)

    expect(response.destroyedWith instanceof Error).toBe(isError)
  })

  it('handles string request chunks and aborts active work from the request event', async () => {
    const identity = generateDeviceIdentity()
    const device: PairedDevice = {
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      friendlyName: 'mock client',
      capabilities: ['sessions.read'],
      pairedAt: '2026-08-14T00:00:00.000Z',
      lastSeenAt: null,
      revokedAt: null,
    }
    let observedSignal: AbortSignal | undefined
    const adapter: SessionsReadAdapter = {
      list: vi.fn(async ({ signal }) => {
        observedSignal = signal
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return { items: [] }
      }),
      history: vi.fn(),
    }
    const server = createServer({ adapter, devices: [device] })
    await server.start()
    const handler = httpMocks.handlers[0]!

    const challengeResponse = new FakeResponse()
    handler(new FakeRequest(
      'POST',
      '/dsh-remote-control/v1/challenge',
      [JSON.stringify({ deviceId: identity.deviceId })],
    ), challengeResponse)
    await waitUntil(() => challengeResponse.writableEnded)
    const challenge = JSON.parse(challengeResponse.body) as { challengeId: string; challenge: string }
    const payload = {}
    const operation = 'session.list'
    const signature = signTranscript(identity.privateKey, transcriptForInvoke(
      challenge.challengeId,
      challenge.challenge,
      identity.deviceId,
      operation,
      payload,
    ))
    const invokeRequest = new FakeRequest('POST', '/dsh-remote-control/v1/invoke', [JSON.stringify({
      deviceId: identity.deviceId,
      challengeId: challenge.challengeId,
      operation,
      payload,
      signature,
    })])
    const invokeResponse = new FakeResponse(true)
    handler(invokeRequest, invokeResponse)
    await waitUntil(() => observedSignal !== undefined)

    invokeRequest.emit('aborted')
    await waitUntil(() => observedSignal?.aborted === true)

    expect(observedSignal?.reason).toEqual(new Error('request aborted'))
  })
})
