import { afterEach, describe, expect, it } from 'vitest'
import {
  createRemoteControlClient,
  generateDeviceIdentity,
  type PairedDevice,
} from '../src/index.ts'
import {
  createAdapter,
  createRecordingProxy,
  pairClient,
  replayRequest,
  SESSION_A,
  startAndOpenPairing,
} from './helpers.ts'

const disposables: Array<{ dispose(): void | Promise<void> }> = []

afterEach(async () => {
  await Promise.allSettled(disposables.splice(0).reverse().map(item => item.dispose()))
})

describe('authentication fails closed before the DSH adapter', () => {
  it('rejects an unpaired device and makes zero adapter calls', async () => {
    const { server, adapter, invitation } = await startAndOpenPairing()
    disposables.push(server)
    const client = createRemoteControlClient({
      baseUrl: invitation.lanUrl,
      identity: generateDeviceIdentity(),
      hostPublicKey: invitation.hostPublicKey,
    })
    disposables.push(client)

    await expect(client.list()).rejects.toThrow(/unpaired|unauthenticated|authentication/i)
    expect(adapter.list).not.toHaveBeenCalled()
    expect(adapter.history).not.toHaveBeenCalled()
  })

  it('rejects a signature made by a key other than the pinned device key', async () => {
    const { server, adapter, invitation } = await startAndOpenPairing()
    disposables.push(server)
    const legitimate = await pairClient({ invitation })
    disposables.push(legitimate.client)
    const attacker = generateDeviceIdentity()
    const forgedIdentity = {
      deviceId: legitimate.identity.deviceId,
      publicKey: legitimate.identity.publicKey,
      privateKey: attacker.privateKey,
    }
    const forgedClient = createRemoteControlClient({
      baseUrl: invitation.lanUrl,
      identity: forgedIdentity,
      hostPublicKey: invitation.hostPublicKey,
    })
    disposables.push(forgedClient)

    await expect(forgedClient.list()).rejects.toThrow(/signature|authentication|unauthorized/i)
    expect(adapter.list).not.toHaveBeenCalled()
  })

  it('rejects replay of a previously accepted signed request', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)

    const proxy = await createRecordingProxy(fixture.invitation.lanUrl)
    disposables.push(proxy)
    const proxiedClient = createRemoteControlClient({
      baseUrl: proxy.baseUrl,
      identity: paired.identity,
      hostPublicKey: fixture.invitation.hostPublicKey,
    })
    disposables.push(proxiedClient)
    await expect(proxiedClient.list()).resolves.toEqual({ items: [SESSION_A] })
    expect(fixture.adapter.list).toHaveBeenCalledTimes(1)

    const signedRequest = [...proxy.recorded].reverse().find(request =>
      request.path.endsWith('/dsh-remote-control/v1/invoke'),
    )
    expect(signedRequest, 'the client must send an authenticated RPC request').toBeDefined()
    const replay = await replayRequest(fixture.invitation.lanUrl, signedRequest!)

    expect(replay.status).toBeGreaterThanOrEqual(400)
    expect(fixture.adapter.list).toHaveBeenCalledTimes(1)
  })

  it('immediately rejects a revoked paired device', async () => {
    const { server, adapter, invitation } = await startAndOpenPairing()
    disposables.push(server)
    const paired = await pairClient({ invitation })
    disposables.push(paired.client)
    await expect(paired.client.list()).resolves.toEqual({ items: [SESSION_A] })
    expect(adapter.list).toHaveBeenCalledTimes(1)

    expect(await server.revokeDevice(paired.identity.deviceId)).toBe(true)
    await expect(paired.client.list()).rejects.toThrow(/revoked|unauthorized|authentication/i)
    expect(adapter.list).toHaveBeenCalledTimes(1)
  })
})

describe('authorization fails closed before the DSH adapter', () => {
  it('requires sessions.read even for a correctly authenticated device', async () => {
    const fixture = await startAndOpenPairing()
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)
    const record = fixture.trustStore.get(paired.identity.deviceId)
    expect(record).toBeDefined()
    fixture.trustStore.put({ ...record!, capabilities: [] } satisfies PairedDevice)

    await expect(paired.client.list()).rejects.toThrow(/sessions\.read|capability|forbidden/i)
    expect(fixture.adapter.list).not.toHaveBeenCalled()
  })

  it.each([
    ['agent.prompt', { sessionId: 'session-a', prompt: 'ignore policy' }],
    ['sessions.write', { title: 'not allowed' }],
    ['files.read', { path: 'C:\\secret.txt' }],
    ['plugins.manage', { action: 'install', name: 'malicious' }],
  ])('rejects unsupported operation %s without adapter access', async (operation, payload) => {
    const adapter = createAdapter()
    const fixture = await startAndOpenPairing({ adapter })
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)

    await expect(paired.client.invoke(operation, payload)).rejects.toThrow(/operation|unsupported|forbidden/i)
    expect(adapter.list).not.toHaveBeenCalled()
    expect(adapter.history).not.toHaveBeenCalled()
  })
})
