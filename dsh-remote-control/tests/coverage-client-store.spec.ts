import { describe, expect, it, vi } from 'vitest'
import {
  createMemoryTrustStore,
  createRemoteControlClient,
  generateDeviceIdentity,
  type PairedDevice,
  type PairingInvitation,
} from '../src/index.ts'
import { apply } from '../src/invariant.ts'

const invitation: PairingInvitation = {
  pairingId: 'pairing-id',
  code: 'pairing-code',
  expiresAt: Date.now() + 1_000,
  hostPublicKey: 'host-public-key',
  lanUrl: 'http://127.0.0.1:43721',
}

describe('client branch coverage', () => {
  it('rejects a host identity mismatch before fetching', async () => {
    const request = vi.fn()
    const client = createRemoteControlClient({
      baseUrl: invitation.lanUrl,
      identity: generateDeviceIdentity(),
      hostPublicKey: 'different-host-key',
      fetch: request as unknown as typeof fetch,
    })

    await expect(client.pair(invitation, 'phone')).rejects.toThrow(/host identity mismatch/)
    expect(request).not.toHaveBeenCalled()
  })

  it('allows an unpinned host and sends the pairing request', async () => {
    const request = vi.fn(async () => new Response('{}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createRemoteControlClient({
      baseUrl: invitation.lanUrl,
      identity: generateDeviceIdentity(),
      fetch: request as unknown as typeof fetch,
    })

    await expect(client.pair(invitation, 'phone')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('uses the HTTP status fallback and combines caller abort signals', async () => {
    const request = vi.fn(async () => new Response('{}', {
      status: 418,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createRemoteControlClient({
      baseUrl: invitation.lanUrl,
      identity: generateDeviceIdentity(),
      fetch: request as unknown as typeof fetch,
    })
    const caller = new AbortController()

    await expect(client.list({ signal: caller.signal })).rejects.toThrow(/HTTP 418/)
    expect(request).toHaveBeenCalledOnce()
  })

  it('makes disposal idempotent and rejects later operations', async () => {
    const client = createRemoteControlClient({
      baseUrl: invitation.lanUrl,
      identity: generateDeviceIdentity(),
      fetch: vi.fn() as unknown as typeof fetch,
    })

    client.dispose()
    client.dispose()

    await expect(client.list()).rejects.toThrow(/client is disposed/)
    await expect(client.pair(invitation, 'phone')).rejects.toThrow(/client is disposed/)
  })
})

describe('memory trust store and invariant coverage', () => {
  it('clones initial records and handles missing or repeated revocation', () => {
    const initial: PairedDevice = {
      deviceId: 'device-one',
      publicKey: 'public-key',
      friendlyName: 'phone',
      capabilities: ['sessions.read'],
      pairedAt: '2026-08-14T00:00:00.000Z',
      lastSeenAt: null,
      revokedAt: null,
    }
    const store = createMemoryTrustStore([initial])
    initial.friendlyName = 'mutated input'

    expect(store.get('device-one')?.friendlyName).toBe('phone')
    expect(store.revoke('missing', '2026-08-14T00:01:00.000Z')).toBe(false)
    expect(store.revoke('device-one', '2026-08-14T00:01:00.000Z')).toBe(true)
    expect(store.revoke('device-one', '2026-08-14T00:02:00.000Z')).toBe(false)
    expect(store.list()[0]?.revokedAt).toBe('2026-08-14T00:01:00.000Z')
  })

  it('invokes the invariant plugin entry point', () => {
    expect(apply()).toBeUndefined()
  })
})
