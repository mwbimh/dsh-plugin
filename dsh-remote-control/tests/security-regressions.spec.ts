import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryTrustStore,
  createRemoteControlClient,
  createRemoteControlServer,
  derivePairingChallenge,
  generateDeviceIdentity,
  signTranscript,
  transcriptForPairingRequest,
  type AuditEvent,
  type PairingInvitation,
  type SessionsReadAdapter,
} from '../src/index.ts'
import { createAdapter, pairClient, SESSION_A, startAndOpenPairing, waitUntil } from './helpers.ts'

const disposables: Array<{ dispose(): void | Promise<void> }> = []

afterEach(async () => {
  await Promise.allSettled(disposables.splice(0).reverse().map(item => Promise.resolve(item.dispose())))
})

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function pairingProof(invitation: PairingInvitation, friendlyName = 'proved device') {
  const identity = generateDeviceIdentity()
  const pairingChallenge = derivePairingChallenge(invitation, identity.deviceId, identity.publicKey)
  return {
    identity,
    body: {
      pairingId: invitation.pairingId,
      pairingChallenge,
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      friendlyName,
      signature: signTranscript(identity.privateKey, transcriptForPairingRequest(
        invitation,
        pairingChallenge,
        identity.deviceId,
        identity.publicKey,
        friendlyName,
      )),
    },
  }
}

describe('pairing proves device key possession without disclosing the code', () => {
  it('rejects an unsigned pairing request before storing trust or calling the adapter', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const identity = generateDeviceIdentity()

    const response = await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/pair', {
      pairingId: fixture.invitation.pairingId,
      pairingChallenge: derivePairingChallenge(fixture.invitation, identity.deviceId, identity.publicKey),
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      friendlyName: 'unsigned',
    })

    expect(response.status).toBe(401)
    expect(fixture.trustStore.list()).toEqual([])
    expect(fixture.adapter.list).not.toHaveBeenCalled()
    expect(fixture.adapter.history).not.toHaveBeenCalled()
  })

  it('rejects public-key replacement and leaves the invitation usable by its real device', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const victim = pairingProof(fixture.invitation)
    const attacker = generateDeviceIdentity()

    const replaced = await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/pair', {
      ...victim.body,
      deviceId: attacker.deviceId,
      publicKey: attacker.publicKey,
    })

    expect(replaced.status).toBe(401)
    expect(fixture.trustStore.list()).toEqual([])
    const client = createRemoteControlClient({
      baseUrl: fixture.invitation.lanUrl,
      identity: victim.identity,
      hostPublicKey: fixture.invitation.hostPublicKey,
    })
    disposables.push(client)
    await expect(client.pair(fixture.invitation, 'proved device')).resolves.toBeUndefined()
    expect(fixture.trustStore.get(victim.identity.deviceId)?.publicKey).toBe(victim.identity.publicKey)
  })

  it('does not place the pairing code on the LAN request', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    let observedBody = ''
    const identity = generateDeviceIdentity()
    const client = createRemoteControlClient({
      baseUrl: fixture.invitation.lanUrl,
      identity,
      hostPublicKey: fixture.invitation.hostPublicKey,
      fetch: async (input, init) => {
        observedBody = typeof init?.body === 'string' ? init.body : ''
        return fetch(input, init)
      },
    })
    disposables.push(client)

    await client.pair(fixture.invitation, 'code-safe device')

    expect(observedBody).not.toContain(fixture.invitation.code)
    expect(JSON.parse(observedBody)).not.toHaveProperty('code')
  })
})

describe('the client cryptographically authenticates its pinned host', () => {
  it.each([
    ['pair', '/dsh-remote-control/v1/pair'],
    ['challenge', '/dsh-remote-control/v1/challenge'],
    ['invoke', '/dsh-remote-control/v1/invoke'],
  ] as const)('rejects a tampered host-signed %s response', async (phase, suffix) => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const identity = generateDeviceIdentity()
    if (phase !== 'pair') {
      const paired = await pairClient({ invitation: fixture.invitation, identity })
      paired.client.dispose()
    }
    const request = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const response = await fetch(input, init)
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!requestUrl.endsWith(suffix) || !response.ok) return response
      const body = await response.json() as Record<string, unknown>
      const tampered = phase === 'challenge'
        ? { ...body, challenge: `${String(body.challenge)}-tampered` }
        : phase === 'invoke'
          ? { ...body, items: [] }
          : { ...body, capabilities: [] }
      return new Response(JSON.stringify(tampered), { status: response.status, headers: response.headers })
    }
    const client = createRemoteControlClient({
      baseUrl: fixture.invitation.lanUrl,
      identity,
      hostPublicKey: fixture.invitation.hostPublicKey,
      fetch: request,
    })
    disposables.push(client)

    if (phase === 'pair') {
      await expect(client.pair(fixture.invitation, 'tamper test')).rejects.toThrow(/host.*auth|signature/i)
      expect(fixture.adapter.list).not.toHaveBeenCalled()
    } else {
      await expect(client.list()).rejects.toThrow(/host.*auth|signature/i)
      expect(fixture.adapter.list).toHaveBeenCalledTimes(phase === 'invoke' ? 1 : 0)
    }
  })
})

describe('abort and revocation stay fail-closed after late adapter resolution', () => {
  it.each(['timeout', 'revoke'] as const)('never returns or audits success after %s', async (cause) => {
    let resolveAdapter!: (value: { items: typeof SESSION_A[] }) => void
    const list = vi.fn<SessionsReadAdapter['list']>(async () => new Promise(resolve => { resolveAdapter = resolve }))
    const adapter: SessionsReadAdapter = {
      list,
      history: vi.fn(),
    }
    const audit: AuditEvent[] = []
    const fixture = await startAndOpenPairing({ adapter, audit: event => audit.push(event), requestTimeoutMs: 40 })
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)
    const pending = paired.client.list()
    const rejected = expect(pending).rejects.toThrow(/cancel|timeout|revok|auth/i)
    await waitUntil(() => list.mock.calls.length === 1)

    if (cause === 'revoke') fixture.server.revokeDevice(paired.identity.deviceId)
    else await new Promise(resolve => setTimeout(resolve, 60))
    resolveAdapter({ items: [SESSION_A] })

    await rejected
    expect(audit).not.toContainEqual(expect.objectContaining({ operation: 'session.list', result: 'allowed' }))
  })
})

describe('listener startup is explicit and transactional', () => {
  it.each(['::0', '0::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0'])('rejects semantic wildcard address %s', async (address) => {
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address, port: 0 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    disposables.push(server)
    await expect(server.start()).rejects.toThrow(/explicit interface/)
    expect(server.addresses).toEqual({ lan: null, management: null })
  })

  it.each(['not-an-ip', 'fe80::1%12'])('rejects unusable explicit address %s', async (address) => {
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address, port: 0 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    disposables.push(server)
    await expect(server.start()).rejects.toThrow(/explicit IP/)
  })

  it('does not leave the LAN listener running when management bind fails', async () => {
    const occupied = createHttpServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolve)
    })
    disposables.push({ dispose: () => new Promise<void>(resolve => occupied.close(() => resolve())) })
    const port = (occupied.address() as AddressInfo).port
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address: '127.0.0.1', port: 0 },
      management: { address: '127.0.0.1', port },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    disposables.push(server)

    await expect(server.start()).rejects.toThrow(/EADDRINUSE/)
    expect(server.addresses).toEqual({ lan: null, management: null })
  })
})

describe('outstanding challenges are bounded and expired slots are reclaimed', () => {
  it.each([
    [{ ttlMs: Number.NaN, maxOutstanding: 2, maxPerDevice: 1 }],
    [{ ttlMs: 1_000, maxOutstanding: Number.POSITIVE_INFINITY, maxPerDevice: 1 }],
    [{ ttlMs: 1_000, maxOutstanding: 2, maxPerDevice: 0 }],
  ])('rejects challenge limits which cannot enforce a finite positive bound %#', (challenges) => {
    expect(() => createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address: '127.0.0.1', port: 0 },
      challenges,
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })).toThrow(/challenge limits/)
  })

  it('enforces per-device and global limits before adapter access', async () => {
    const trustStore = createMemoryTrustStore()
    const adapter = createAdapter()
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address: '127.0.0.1', port: 0 },
      management: { address: '127.0.0.1', port: 0 },
      challenges: { ttlMs: 5_000, maxOutstanding: 2, maxPerDevice: 1 },
      adapter,
      trustStore,
    })
    disposables.push(server)
    await server.start()
    const first = await pairClient({ invitation: server.openPairing() })
    const second = await pairClient({ invitation: server.openPairing() })
    const third = await pairClient({ invitation: server.openPairing() })
    disposables.push(first.client, second.client, third.client)
    const baseUrl = server.addresses.lan!

    expect((await postJson(baseUrl, '/dsh-remote-control/v1/challenge', { deviceId: first.identity.deviceId })).status).toBe(200)
    expect((await postJson(baseUrl, '/dsh-remote-control/v1/challenge', { deviceId: first.identity.deviceId })).status).toBe(429)
    expect((await postJson(baseUrl, '/dsh-remote-control/v1/challenge', { deviceId: second.identity.deviceId })).status).toBe(200)
    expect((await postJson(baseUrl, '/dsh-remote-control/v1/challenge', { deviceId: third.identity.deviceId })).status).toBe(429)
    expect(adapter.list).not.toHaveBeenCalled()
    expect(adapter.history).not.toHaveBeenCalled()
  })

  it('prunes expired challenges before applying the limit', async () => {
    const fixture = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address: '127.0.0.1', port: 0 },
      management: { address: '127.0.0.1', port: 0 },
      challenges: { ttlMs: 10, maxOutstanding: 1, maxPerDevice: 1 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    disposables.push(fixture)
    await fixture.start()
    const paired = await pairClient({ invitation: fixture.openPairing() })
    disposables.push(paired.client)
    const requestChallenge = () => postJson(fixture.addresses.lan!, '/dsh-remote-control/v1/challenge', {
      deviceId: paired.identity.deviceId,
    })

    expect((await requestChallenge()).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect((await requestChallenge()).status).toBe(200)
  })
})
