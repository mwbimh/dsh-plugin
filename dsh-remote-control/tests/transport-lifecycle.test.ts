import { createConnection } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditEvent, SessionsReadAdapter } from '../src/index.ts'
import {
  pairClient,
  startAndOpenPairing,
  waitUntil,
} from './helpers.ts'

const disposables: Array<{ dispose(): void | Promise<void> }> = []

afterEach(async () => {
  await Promise.allSettled(disposables.splice(0).reverse().map(item => item.dispose()))
})

describe('transport resource limits', () => {
  it('rejects an oversized frame before authentication or adapter dispatch', async () => {
    const fixture = await startAndOpenPairing({ maxFrameBytes: 128 })
    disposables.push(fixture.server)

    const response = await fetch(new URL('/dsh-remote-control/v1/invoke', fixture.invitation.lanUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(512) }),
    })

    expect(response.status).toBe(413)
    expect(fixture.adapter.list).not.toHaveBeenCalled()
    expect(fixture.adapter.history).not.toHaveBeenCalled()
  })

  it('closes a connection which sends incomplete headers too slowly', async () => {
    const fixture = await startAndOpenPairing({ headersTimeoutMs: 75 })
    disposables.push(fixture.server)
    const url = new URL(fixture.invitation.lanUrl)
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    disposables.push({ dispose: () => { socket.destroy() } })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.once('error', () => resolve())
    })

    socket.write('POST /rpc HTTP/1.1\r\nHost: loopback\r\nContent-Length: 10\r\n')
    await expect(Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('slow connection remained open past headersTimeoutMs')),
        500,
      )),
    ])).resolves.toBeUndefined()
    expect(fixture.adapter.list).not.toHaveBeenCalled()
  })
})

describe('abort and disposal propagation', () => {
  it('aborts the adapter when a request exceeds requestTimeoutMs', async () => {
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
    const fixture = await startAndOpenPairing({ adapter, requestTimeoutMs: 50 })
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)

    await expect(paired.client.list()).rejects.toThrow(/timeout|timed out|abort|cancelled/i)
    expect(observedSignal?.aborted).toBe(true)
  })

  it('client.dispose aborts an in-flight RPC and propagates abort to the adapter', async () => {
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
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })

    const pending = paired.client.list()
    await waitUntil(() => observedSignal !== undefined)
    await paired.client.dispose()

    await expect(pending).rejects.toThrow(/abort|disposed|fetch failed/i)
    await waitUntil(() => observedSignal?.aborted === true)
  })

  it('server.dispose closes an active slow connection', async () => {
    const fixture = await startAndOpenPairing({ headersTimeoutMs: 5_000 })
    const url = new URL(fixture.invitation.lanUrl)
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    disposables.push({ dispose: () => { socket.destroy() } })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.once('error', () => resolve())
    })
    socket.write('POST /rpc HTTP/1.1\r\nHost: loopback\r\n')

    await fixture.server.dispose()
    await expect(closed).resolves.toBeUndefined()
  })
})

describe('secret redaction', () => {
  it('never emits device private keys or pairing codes through audit events', async () => {
    const auditEvents: AuditEvent[] = []
    const fixture = await startAndOpenPairing({ audit: event => auditEvents.push(event) })
    disposables.push(fixture.server)
    const paired = await pairClient({ invitation: fixture.invitation })
    disposables.push(paired.client)
    await paired.client.list()
    await expect(paired.client.invoke('agent.prompt', {
      sessionId: 'session-a',
      prompt: paired.identity.privateKey,
    })).rejects.toThrow()

    expect(auditEvents.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(auditEvents)
    expect(serialized).not.toContain(fixture.invitation.code)
    expect(serialized).not.toContain(paired.identity.privateKey)
    expect(serialized).not.toContain('PRIVATE KEY')
  })
})
