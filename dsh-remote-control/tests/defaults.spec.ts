import { describe, expect, it } from 'vitest'
import { createMemoryTrustStore, createRemoteControlServer } from '../src/index.ts'
import { createAdapter } from './helpers.ts'

describe('safe listener defaults', () => {
  it('does not bind when the plugin is disabled', async () => {
    const server = createRemoteControlServer({
      enabled: false,
      listen: { lan: true, address: '0.0.0.0', port: 0 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    await server.start()
    expect(server.addresses.lan).toBeNull()
    await server.dispose()
  })

  it('does not bind when LAN access is disabled', async () => {
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: false, address: '0.0.0.0', port: 0 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    await server.start()
    expect(server.addresses.lan).toBeNull()
    expect(() => server.openPairing()).toThrow(/not running/i)
    await server.dispose()
  })

  it('refuses a non-loopback management listener', async () => {
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address: '127.0.0.1', port: 0 },
      management: { address: '0.0.0.0', port: 0 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    await expect(server.start()).rejects.toThrow(/management.*loopback/i)
    await server.dispose()
  })

  it('refuses wildcard LAN binding even when explicitly enabled', async () => {
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address: '0.0.0.0', port: 0 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    await expect(server.start()).rejects.toThrow(/explicit interface/i)
  })

  it('opens pairing only through the separate loopback management listener', async () => {
    const server = createRemoteControlServer({
      enabled: true,
      listen: { lan: true, address: '127.0.0.1', port: 0 },
      management: { address: '127.0.0.1', port: 0 },
      adapter: createAdapter(),
      trustStore: createMemoryTrustStore(),
    })
    await server.start()
    const management = server.addresses.management
    expect(management).not.toBeNull()
    const response = await fetch(new URL('/dsh-remote-control/v1/management/pairing/open', management!), { method: 'POST' })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ lanUrl: server.addresses.lan })
    expect(await fetch(new URL('/dsh-remote-control/v1/management/pairing/open', server.addresses.lan!), { method: 'POST' }))
      .toMatchObject({ status: 404 })
    await server.dispose()
  })
})
