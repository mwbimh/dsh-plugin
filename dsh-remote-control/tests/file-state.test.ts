import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openFileState } from '../src/index.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('persistent identity and trust state', () => {
  it('retains the host identity, paired devices, and revocation across reopen', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-remote-control-state-'))
    const path = join(root, 'private', 'state.json')
    const first = openFileState(path)
    first.trustStore.put({
      deviceId: 'client-one',
      publicKey: 'fixture-public-key',
      friendlyName: 'phone',
      capabilities: ['sessions.read'],
      pairedAt: '2026-08-14T00:00:00.000Z',
      lastSeenAt: null,
      revokedAt: null,
    })
    expect(first.trustStore.revoke('client-one', '2026-08-14T00:01:00.000Z')).toBe(true)

    const reopened = openFileState(path)
    expect(reopened.identity).toEqual(first.identity)
    expect(reopened.trustStore.get('client-one')?.revokedAt).toBe('2026-08-14T00:01:00.000Z')
    expect(await readFile(path, 'utf8')).toContain('PRIVATE KEY')
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('fails loudly for malformed state instead of replacing trust data', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-remote-control-state-'))
    const path = join(root, 'state.json')
    await import('node:fs/promises').then(fs => fs.writeFile(path, '{"version":999}\n'))
    expect(() => openFileState(path)).toThrow(/invalid state/i)
  })
})
