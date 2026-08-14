import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateDeviceIdentity,
  openFileState,
  signTranscript,
  verifyTranscript,
} from '../src/index.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('file state branch coverage', () => {
  it('lists cloned records and rejects missing or already revoked devices', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-remote-control-coverage-state-'))
    const state = openFileState(join(root, 'state.json'))
    const device = {
      deviceId: 'client-one',
      publicKey: 'fixture-public-key',
      friendlyName: 'phone',
      capabilities: ['sessions.read' as const],
      pairedAt: '2026-08-14T00:00:00.000Z',
      lastSeenAt: null,
      revokedAt: null,
    }
    state.trustStore.put(device)

    expect(state.trustStore.get('missing')).toBeUndefined()
    expect(state.trustStore.list()).toEqual([device])
    expect(state.trustStore.revoke('missing', '2026-08-14T00:00:30.000Z')).toBe(false)
    expect(state.trustStore.revoke('client-one', '2026-08-14T00:01:00.000Z')).toBe(true)
    expect(state.trustStore.revoke('client-one', '2026-08-14T00:02:00.000Z')).toBe(false)
  })

  it('rethrows file-system errors other than a missing state file', () => {
    expect(() => openFileState('\0')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
  })

  it.each([
    null,
    'not-an-object',
    { version: 1 },
    { version: 1, identity: { deviceId: 1, publicKey: 'public', privateKey: 'private' }, devices: [] },
    { version: 1, identity: { deviceId: 'id', publicKey: 1, privateKey: 'private' }, devices: [] },
    { version: 1, identity: { deviceId: 'id', publicKey: 'public', privateKey: 1 }, devices: [] },
    { version: 1, identity: { deviceId: 'id', publicKey: 'public', privateKey: 'private' }, devices: {} },
  ])('rejects malformed state shape %#', async (value) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-remote-control-coverage-invalid-'))
    const path = join(root, 'state.json')
    await writeFile(path, `${JSON.stringify(value)}\n`)

    expect(() => openFileState(path)).toThrow(/invalid state file/)
  })
})

describe('identity primitive coverage', () => {
  it('signs, verifies, and rejects malformed keys', () => {
    const identity = generateDeviceIdentity()
    const signature = signTranscript(identity.privateKey, 'transcript')

    expect(verifyTranscript(identity.publicKey, 'transcript', signature)).toBe(true)
    expect(verifyTranscript(identity.publicKey, 'modified', signature)).toBe(false)
    expect(verifyTranscript('not-a-public-key', 'transcript', 'AA')).toBe(false)
  })
})
