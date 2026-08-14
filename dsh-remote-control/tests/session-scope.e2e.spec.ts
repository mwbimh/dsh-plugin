import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateDeviceIdentity } from '../src/index.ts'
import {
  HISTORY_A,
  pairClient,
  SESSION_A,
  startAndOpenPairing,
} from './helpers.ts'

const disposables: Array<{ dispose(): void | Promise<void> }> = []

afterEach(async () => {
  await Promise.allSettled(disposables.splice(0).reverse().map(item => Promise.resolve(item.dispose())))
})

describe('two-device loopback pairing and read-only RPC', () => {
  it('pairs two distinct devices and serves list/history over loopback', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const first = await pairClient({
      invitation: fixture.invitation,
      identity: generateDeviceIdentity(),
      friendlyName: 'phone',
    })
    disposables.push(first.client)

    const secondInvitation = fixture.server.openPairing()
    const second = await pairClient({
      invitation: secondInvitation,
      identity: generateDeviceIdentity(),
      friendlyName: 'tablet',
    })
    disposables.push(second.client)

    expect(first.identity.deviceId).not.toBe(second.identity.deviceId)
    expect(fixture.trustStore.list()).toHaveLength(2)
    await expect(first.client.list()).resolves.toEqual({ items: [SESSION_A] })
    await expect(first.client.history({ sessionId: 'session-a' })).resolves.toEqual(HISTORY_A)
    await expect(second.client.list()).resolves.toEqual({ items: [SESSION_A] })
    await expect(second.client.history({
      sessionId: 'session-a',
      beforeSeq: 20,
      maxMessages: 10,
    })).resolves.toEqual(HISTORY_A)

    expect(fixture.adapter.list).toHaveBeenCalledTimes(2)
    expect(fixture.adapter.history).toHaveBeenCalledTimes(2)
    const [historyRequest, historyOptions] = vi.mocked(fixture.adapter.history).mock.calls.at(-1)!
    expect(historyRequest).toEqual({ sessionId: 'session-a', beforeSeq: 20, maxMessages: 10 })
    expect(historyOptions.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not allow history until that device obtained the session through list', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)

    await expect(paired.client.history({ sessionId: 'session-a' })).rejects.toThrow(
      /session|scope|not found|forbidden/i,
    )
    expect(fixture.adapter.history).not.toHaveBeenCalled()

    await expect(paired.client.list()).resolves.toEqual({ items: [SESSION_A] })
    await expect(paired.client.history({ sessionId: 'session-a' })).resolves.toEqual(HISTORY_A)
    expect(fixture.adapter.history).toHaveBeenCalledTimes(1)
  })

  it('rejects history for an id absent from the most recent successful list', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)
    await paired.client.list()

    await expect(paired.client.history({ sessionId: 'session-hidden' })).rejects.toThrow(
      /session|scope|not found|forbidden/i,
    )
    expect(fixture.adapter.history).not.toHaveBeenCalled()
  })
})
