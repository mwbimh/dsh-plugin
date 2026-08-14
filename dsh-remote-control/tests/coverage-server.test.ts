import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryTrustStore,
  createRemoteControlClient,
  createRemoteControlServer,
  generateDeviceIdentity,
  signTranscript,
  transcriptForInvoke,
  type AuditEvent,
  type PairingInvitation,
  type SessionsReadAdapter,
} from '../src/index.ts'
import { createAdapter, pairClient, SESSION_A, startAndOpenPairing, waitUntil } from './helpers.ts'

const disposables: Array<{ dispose(): void | Promise<void> }> = []

afterEach(async () => {
  await Promise.allSettled(disposables.splice(0).reverse().map(item => item.dispose()))
})

async function postJson(baseUrl: string, path: string, body: unknown | string): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function pairBody(invitation: PairingInvitation, identity = generateDeviceIdentity()) {
  return {
    pairingId: invitation.pairingId,
    code: invitation.code,
    publicKey: identity.publicKey,
    deviceId: identity.deviceId,
    friendlyName: 'coverage device',
  }
}

async function startWithPairing(pairing: { ttlMs: number; maxAttempts: number }) {
  const trustStore = createMemoryTrustStore()
  const audit: AuditEvent[] = []
  const server = createRemoteControlServer({
    enabled: true,
    listen: { lan: true, address: '127.0.0.1', port: 0 },
    management: { address: '127.0.0.1', port: 0 },
    pairing,
    adapter: createAdapter(),
    trustStore,
    audit: event => audit.push(event),
  })
  disposables.push(server)
  await server.start()
  return { server, trustStore, audit, invitation: server.openPairing() }
}

describe('pairing rejection coverage', () => {
  it('rejects expired invitations without storing a device', async () => {
    const fixture = await startWithPairing({ ttlMs: -1, maxAttempts: 3 })
    const response = await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/pair', pairBody(fixture.invitation))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'pairing-denied' })
    expect(fixture.trustStore.list()).toEqual([])
    expect(fixture.audit).toContainEqual(expect.objectContaining({
      operation: 'device.pair', result: 'denied', reason: 'invalid-pairing',
    }))
  })

  it('rejects wrong codes and a correct code after attempts are exhausted', async () => {
    const fixture = await startWithPairing({ ttlMs: 5_000, maxAttempts: 1 })
    const body = pairBody(fixture.invitation)
    const wrong = await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/pair', {
      ...body,
      code: 'x'.repeat(fixture.invitation.code.length),
    })
    const exhausted = await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/pair', body)

    expect(wrong.status).toBe(401)
    expect(exhausted.status).toBe(401)
    expect(fixture.trustStore.list()).toEqual([])
  })

  it('rejects an identity mismatch without consuming the invitation', async () => {
    const fixture = await startWithPairing({ ttlMs: 5_000, maxAttempts: 3 })
    const identity = generateDeviceIdentity()
    const other = generateDeviceIdentity()
    const mismatch = await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/pair', {
      ...pairBody(fixture.invitation, identity),
      deviceId: other.deviceId,
    })

    expect(mismatch.status).toBe(401)
    expect(fixture.audit).toContainEqual(expect.objectContaining({ reason: 'identity-mismatch' }))

    const client = createRemoteControlClient({
      baseUrl: fixture.invitation.lanUrl,
      identity,
      hostPublicKey: fixture.invitation.hostPublicKey,
    })
    disposables.push(client)
    await expect(client.pair(fixture.invitation, 'correct identity')).resolves.toBeUndefined()
  })

  it('rejects malformed, incomplete, and reused pairing requests', async () => {
    const fixture = await startWithPairing({ ttlMs: 5_000, maxAttempts: 3 })
    expect((await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/pair', '[]')).status).toBe(400)
    expect((await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/pair', {})).status).toBe(401)

    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)
    await expect(paired.client.pair(fixture.invitation, 'reuse')).rejects.toThrow(/pairing-denied/)
    expect(fixture.trustStore.list()).toHaveLength(1)
  })
})

describe('management endpoint coverage', () => {
  it('lists redacted devices and validates revoke requests', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation, friendlyName: 'coverage phone' })
    disposables.push(paired.client)
    const management = fixture.server.addresses.management!

    const list = await fetch(new URL('/dsh-remote-control/v1/management/devices', management))
    expect(list.status).toBe(200)
    const listed = await list.json() as { devices: Array<Record<string, unknown>> }
    expect(listed.devices).toEqual([expect.objectContaining({
      deviceId: paired.identity.deviceId,
      friendlyName: 'coverage phone',
      capabilities: ['sessions.read'],
      lastSeenAt: null,
      revokedAt: null,
      publicKeyFingerprint: paired.identity.deviceId,
    })])
    expect(listed.devices[0]).not.toHaveProperty('publicKey')

    const revokePath = '/dsh-remote-control/v1/management/devices/revoke'
    expect((await postJson(management, revokePath, '[]')).status).toBe(400)
    expect((await postJson(management, revokePath, { deviceId: 123 })).status).toBe(400)
    expect((await postJson(management, revokePath, { deviceId: 'missing' })).status).toBe(404)
    expect(fixture.server.revokeDevice('missing')).toBe(false)

    const revoked = await postJson(management, revokePath, { deviceId: paired.identity.deviceId })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ revoked: true })
    expect(fixture.trustStore.get(paired.identity.deviceId)?.revokedAt).not.toBeNull()
    expect((await postJson(management, revokePath, { deviceId: paired.identity.deviceId })).status).toBe(404)
    expect((await fetch(new URL('/missing-management-route', management))).status).toBe(404)
  })

  it('clears only the revoked device challenges', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const first = await pairClient({ invitation: fixture.invitation })
    disposables.push(first.client)
    const secondInvitation = fixture.server.openPairing()
    const second = await pairClient({ invitation: secondInvitation })
    disposables.push(second.client)

    for (const deviceId of [first.identity.deviceId, second.identity.deviceId]) {
      const response = await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/challenge', { deviceId })
      expect(response.status).toBe(200)
    }

    expect(fixture.server.revokeDevice(first.identity.deviceId)).toBe(true)
    await expect(first.client.list()).rejects.toThrow(/authentication-failed/)
    await expect(second.client.list()).resolves.toEqual({ items: [SESSION_A] })
  })

  it('turns management trust-store failures into an internal response', async () => {
    const trustStore = createMemoryTrustStore()
    trustStore.list = () => { throw new Error('list exploded') }
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address: '127.0.0.1', port: 0 },
      management: { address: '127.0.0.1', port: 0 },
      adapter: createAdapter(),
      trustStore,
    })
    disposables.push(server)
    await server.start()

    const response = await fetch(new URL('/dsh-remote-control/v1/management/devices', server.addresses.management!))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'internal' })
  })
})

describe('history validation and adapter failure coverage', () => {
  it.each([
    { beforeSeq: '1' },
    { beforeSeq: 1.5 },
    { beforeSeq: -1 },
    { maxMessages: '1' },
    { maxMessages: 1.5 },
    { maxMessages: -1 },
  ])('rejects non-natural history parameters %#', async (invalid) => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)
    await paired.client.list()

    await expect(paired.client.invoke('session.history', {
      sessionId: SESSION_A.sessionId,
      ...invalid,
    })).rejects.toThrow(/bad-request/)
    expect(fixture.adapter.history).not.toHaveBeenCalled()
  })

  it('rejects malformed challenge and invoke documents', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)

    expect((await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/challenge', '[]')).status).toBe(400)
    expect((await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/challenge', {})).status).toBe(401)
    expect((await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/invoke', '[]')).status).toBe(400)
    expect((await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/invoke', '{')).status).toBe(400)
    expect((await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/invoke', {})).status).toBe(401)
  })

  it('handles authenticated missing operations and non-object history payloads', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)

    const challengeResponse = await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/challenge', {
      deviceId: paired.identity.deviceId,
    })
    const challenge = await challengeResponse.json() as { challengeId: string; challenge: string }
    const operation = 'unknown'
    const payload = {}
    const signature = signTranscript(paired.identity.privateKey, transcriptForInvoke(
      challenge.challengeId,
      challenge.challenge,
      paired.identity.deviceId,
      operation,
      payload,
    ))
    const missingOperation = await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/invoke', {
      deviceId: paired.identity.deviceId,
      challengeId: challenge.challengeId,
      signature,
      payload,
    })
    expect(missingOperation.status).toBe(403)

    const missingDeviceChallenge = await postJson(
      fixture.invitation.lanUrl,
      '/dsh-remote-control/v1/challenge',
      { deviceId: paired.identity.deviceId },
    )
    const secondChallenge = await missingDeviceChallenge.json() as { challengeId: string }
    expect((await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/invoke', {
      challengeId: secondChallenge.challengeId,
      operation: 'session.list',
      payload: {},
      signature: 'invalid',
    })).status).toBe(401)

    await paired.client.list()
    await expect(paired.client.invoke('session.history', null)).rejects.toThrow(/session-denied/)
  })

  it('turns list adapter errors into internal responses', async () => {
    const adapter: SessionsReadAdapter = {
      list: vi.fn(async () => { throw new Error('list exploded') }),
      history: vi.fn(),
    }
    const fixture = await startAndOpenPairing({ adapter })
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)

    await expect(paired.client.list()).rejects.toThrow(/internal/)
    expect(adapter.list).toHaveBeenCalledOnce()
  })

  it('turns history adapter errors into internal responses', async () => {
    const adapter: SessionsReadAdapter = {
      list: vi.fn(async () => ({ items: [SESSION_A] })),
      history: vi.fn(async () => { throw new Error('history exploded') }),
    }
    const fixture = await startAndOpenPairing({ adapter })
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)
    await paired.client.list()

    await expect(paired.client.history({ sessionId: SESSION_A.sessionId })).rejects.toThrow(/internal/)
    expect(adapter.history).toHaveBeenCalledOnce()
  })

  it('aborts an active adapter request when its device is revoked', async () => {
    const observedSignals: AbortSignal[] = []
    const adapter: SessionsReadAdapter = {
      list: vi.fn(async ({ signal }) => {
        observedSignals.push(signal)
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return { items: [] }
      }),
      history: vi.fn(),
    }
    const fixture = await startAndOpenPairing({ adapter, requestTimeoutMs: 5_000 })
    disposables.push(fixture.server)
    const first = await pairClient({ invitation: fixture.invitation })
    disposables.push(first.client)
    const second = await pairClient({ invitation: fixture.server.openPairing() })
    disposables.push(second.client)

    const firstPending = first.client.list()
    const secondPending = second.client.list()
    await waitUntil(() => observedSignals.length === 2)
    expect(fixture.server.revokeDevice(first.identity.deviceId)).toBe(true)

    await expect(firstPending).rejects.toThrow(/cancelled/)
    expect(observedSignals.filter(signal => signal.aborted)).toHaveLength(1)
    expect(fixture.server.revokeDevice(second.identity.deviceId)).toBe(true)
    await expect(secondPending).rejects.toThrow(/cancelled/)
    expect(observedSignals.every(signal => signal.aborted)).toBe(true)
  })

  it('aborts active adapter work during server disposal', async () => {
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
    const fixture = await startAndOpenPairing({ adapter, requestTimeoutMs: 5_000 })
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)

    const pending = paired.client.list()
    await waitUntil(() => observedSignal !== undefined)
    const disposal = fixture.server.dispose()

    await expect(pending).rejects.toThrow(/cancelled|fetch failed/)
    await disposal
    expect(observedSignal?.aborted).toBe(true)
  })

  it('returns early when an oversized object body is rejected', async () => {
    const fixture = await startAndOpenPairing({ maxFrameBytes: 64 })
    disposables.push(fixture.server)

    const response = await postJson(fixture.invitation.lanUrl, '/dsh-remote-control/v1/pair', {
      padding: 'x'.repeat(512),
    })
    expect(response.status).toBe(413)
  })
})

describe('listener start branch coverage', () => {
  it.each(['0.0.0.0', '::'])('rejects wildcard LAN address %s', async (address) => {
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address, port: 0 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    disposables.push(server)
    await expect(server.start()).rejects.toThrow(/explicit interface/)
  })

  it('starts once without a management listener', async () => {
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address: '127.0.0.1', port: 0 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    disposables.push(server)
    await server.start()
    const firstAddress = server.addresses.lan
    await server.start()

    expect(firstAddress).not.toBeNull()
    expect(server.addresses.management).toBeNull()
  })

  it('formats an IPv6 loopback listener address', async () => {
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address: '::1', port: 0 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    disposables.push(server)
    await server.start()

    expect(server.addresses.lan).toMatch(/^http:\/\/\[::1\]:\d+$/)
  })
})
