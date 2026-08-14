import { describe, expect, it, vi } from 'vitest'
import {
  createMemoryTrustStore,
  createRemoteControlClient,
  generateDeviceIdentity,
  HOST_SIGNATURE_HEADER,
  PROTOCOL_VERSION,
  signTranscript,
  transcriptForChallengeResponse,
  transcriptForInvitation,
  type PairedDevice,
  type PairingInvitation,
} from '../src/index.ts'
import { apply } from '../src/invariant.ts'

const hostIdentity = generateDeviceIdentity()
const invitation: PairingInvitation = {
  version: PROTOCOL_VERSION,
  pairingId: 'pairing-id',
  code: 'pairing-code',
  expiresAt: Date.now() + 1_000,
  hostPublicKey: hostIdentity.publicKey,
  lanUrl: 'http://127.0.0.1:43721',
  hostSignature: '',
}
invitation.hostSignature = signTranscript(hostIdentity.privateKey, transcriptForInvitation(invitation))

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

  it.each([
    [{ ...invitation, version: PROTOCOL_VERSION - 1 }],
    [{ ...invitation, hostSignature: 'invalid' }],
  ])('rejects an unauthenticated invitation before fetching %#', async (untrustedInvitation) => {
    const request = vi.fn()
    const client = createRemoteControlClient({
      baseUrl: invitation.lanUrl,
      identity: generateDeviceIdentity(),
      hostPublicKey: invitation.hostPublicKey,
      fetch: request as unknown as typeof fetch,
    })

    await expect(client.pair(untrustedInvitation, 'phone')).rejects.toThrow(/host authentication/)
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    [{ version: PROTOCOL_VERSION - 1, hostPublicKey: hostIdentity.publicKey }],
    [{ version: PROTOCOL_VERSION, hostPublicKey: generateDeviceIdentity().publicKey }],
  ])('rejects signed challenge fields which do not match the pinned protocol %#', async (fields) => {
    const identity = generateDeviceIdentity()
    const body = {
      ...fields,
      challengeId: 'challenge-id',
      challenge: 'challenge',
      expiresAt: Date.now() + 1_000,
    }
    const request = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        [HOST_SIGNATURE_HEADER]: signTranscript(hostIdentity.privateKey, transcriptForChallengeResponse(
          hostIdentity.publicKey,
          identity.deviceId,
          200,
          body,
        )),
      },
    }))
    const client = createRemoteControlClient({
      baseUrl: invitation.lanUrl,
      identity,
      hostPublicKey: hostIdentity.publicKey,
      fetch: request as unknown as typeof fetch,
    })

    await expect(client.list()).rejects.toThrow(/host authentication/)
    expect(request).toHaveBeenCalledOnce()
  })

  it('uses the HTTP status fallback and combines caller abort signals', async () => {
    const identity = generateDeviceIdentity()
    const body = {}
    const request = vi.fn(async () => {
      const status = 418
      return new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': 'application/json',
          [HOST_SIGNATURE_HEADER]: signTranscript(hostIdentity.privateKey, transcriptForChallengeResponse(
            hostIdentity.publicKey,
            identity.deviceId,
            status,
            body,
          )),
        },
      })
    })
    const client = createRemoteControlClient({
      baseUrl: invitation.lanUrl,
      identity,
      hostPublicKey: invitation.hostPublicKey,
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
      hostPublicKey: invitation.hostPublicKey,
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
