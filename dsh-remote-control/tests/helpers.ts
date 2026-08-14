import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { vi } from 'vitest'
import {
  createMemoryTrustStore,
  createRemoteControlClient,
  createRemoteControlServer,
  generateDeviceIdentity,
  type AuditEvent,
  type DeviceIdentity,
  type PairingInvitation,
  type SessionsReadAdapter,
  type TrustStore,
} from '../src/index.ts'

export const SESSION_A = {
  sessionId: 'session-a',
  updatedAt: 1,
  running: false,
  blank: false,
} as const

export const HISTORY_A: Awaited<ReturnType<SessionsReadAdapter['history']>> = {
  events: [{ event: { seq: 0, type: 'fixture/message', time: 1, data: { text: 'hello' } } }],
  hasMore: false,
} as const

export function createAdapter(): SessionsReadAdapter & {
  list: ReturnType<typeof vi.fn<SessionsReadAdapter['list']>>
  history: ReturnType<typeof vi.fn<SessionsReadAdapter['history']>>
} {
  return {
    list: vi.fn(async () => ({ items: [SESSION_A] })),
    history: vi.fn<SessionsReadAdapter['history']>(async () => structuredClone(HISTORY_A)),
  }
}

export function createTestServer(options: {
  adapter?: SessionsReadAdapter
  trustStore?: TrustStore
  audit?: (event: AuditEvent) => void
  maxFrameBytes?: number
  requestTimeoutMs?: number
  headersTimeoutMs?: number
} = {}) {
  const adapter = options.adapter ?? createAdapter()
  const trustStore = options.trustStore ?? createMemoryTrustStore()
  const server = createRemoteControlServer({
    enabled: true,
    listen: { lan: true, address: '127.0.0.1', port: 0 },
    management: { address: '127.0.0.1', port: 0 },
    pairing: { ttlMs: 5_000, maxAttempts: 3 },
    limits: {
      maxFrameBytes: options.maxFrameBytes ?? 1_024,
      requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
      headersTimeoutMs: options.headersTimeoutMs ?? 1_000,
    },
    adapter,
    trustStore,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  })
  return { server, adapter, trustStore }
}

export async function startAndOpenPairing(
  options: Parameters<typeof createTestServer>[0] = {},
) {
  const fixture = createTestServer(options)
  await fixture.server.start()
  const invitation = await fixture.server.openPairing()
  return { ...fixture, invitation }
}

export async function pairClient(options: {
  invitation: PairingInvitation
  identity?: DeviceIdentity
  friendlyName?: string
}) {
  const identity = options.identity ?? generateDeviceIdentity()
  const client = createRemoteControlClient({
    baseUrl: options.invitation.lanUrl,
    identity,
    hostPublicKey: options.invitation.hostPublicKey,
  })
  await client.pair(options.invitation, options.friendlyName ?? 'test client')
  return { client, identity }
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/** A deliberately dumb byte-preserving HTTP forwarder used by the replay test. */
export async function createRecordingProxy(targetBaseUrl: string) {
  const target = new URL(targetBaseUrl)
  const recorded: RecordedRequest[] = []
  const proxy = createHttpServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
    incoming.on('end', () => {
      const body = Buffer.concat(chunks)
      recorded.push({
        method: incoming.method ?? 'GET',
        path: incoming.url ?? '/',
        headers: { ...incoming.headers },
        body,
      })
      const forwarded = httpRequest({
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      }, response => {
        outgoing.writeHead(response.statusCode ?? 500, response.headers)
        response.pipe(outgoing)
      })
      forwarded.on('error', error => outgoing.destroy(error))
      forwarded.end(body)
    })
  })
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', resolve)
  })
  const address = proxy.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    recorded,
    async dispose() {
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
    },
  }
}

export async function replayRequest(targetBaseUrl: string, captured: RecordedRequest) {
  return await fetch(new URL(captured.path, targetBaseUrl), {
    method: captured.method,
    headers: Object.fromEntries(
      Object.entries(captured.headers)
        .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
        .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]),
    ),
    ...(captured.method === 'GET' || captured.method === 'HEAD' ? {} : { body: captured.body }),
  })
}
