import type { Context } from '@deepseek-ai/cordis'
import { createRemoteControlServer, type RemoteControlServerOptions } from './server.ts'

export * from './client.ts'
export * from './identity.ts'
export * from './file-state.ts'
export * from './server.ts'
export * from './trust-store.ts'
export type * from './types.ts'

export const name = 'dsh-remote-control'
export const inject = ['apiProxy']

export interface Config {
  enabled?: boolean
  lan?: boolean
  address?: string
  port?: number
  managementPort?: number
  statePath?: string
}

/** Mount the disabled-by-default authenticated read listener. */
export function apply(ctx: Context, config: Config = {}): void {
  if (!config.enabled || !config.lan) return
  if (config.statePath === undefined) throw new Error('dsh-remote-control: statePath is required when enabled')
  const apiProxy = (ctx as unknown as { apiProxy: {
    sessions: {
      list(request: { rpcId: string; payload: Record<string, never> }): Promise<{ result: { ok: boolean; value?: unknown; error?: unknown } }>
      history(request: { rpcId: string; payload: Record<string, unknown> }): Promise<{ result: { ok: boolean; value?: unknown; error?: unknown } }>
    }
  } }).apiProxy
  const state = openFileState(config.statePath)
  const options: RemoteControlServerOptions = {
    enabled: true,
    listen: { lan: true, address: config.address ?? '127.0.0.1', port: config.port ?? 0 },
    management: { address: '127.0.0.1', port: config.managementPort ?? 0 },
    trustStore: state.trustStore,
    identity: state.identity,
    adapter: {
      async list({ signal }) {
        signal.throwIfAborted()
        const response = await apiProxy.sessions.list({ rpcId: crypto.randomUUID(), payload: {} })
        if (!response.result.ok) throw new Error('DSH session.list failed')
        const value = response.result.value as { items: Array<{
          sessionId: string
          updatedAt: number
          running: boolean
          blank: boolean
          parentSessionId?: string
          origin?: 'subagent'
        }> }
        return {
          items: value.items.map(item => ({
            sessionId: item.sessionId,
            updatedAt: item.updatedAt,
            running: item.running,
            blank: item.blank,
            ...(item.parentSessionId === undefined ? {} : { parentSessionId: item.parentSessionId }),
            ...(item.origin === undefined ? {} : { origin: item.origin }),
          })),
        }
      },
      async history(request, { signal }) {
        signal.throwIfAborted()
        const response = await apiProxy.sessions.history({ rpcId: crypto.randomUUID(), payload: request })
        if (!response.result.ok) throw new Error('DSH session.history failed')
        const value = response.result.value as { events: Array<{ event: {
          seq: number
          type: string
          time: number
          data: unknown
          ignorable?: boolean
        } }>; hasMore: boolean }
        return {
          events: value.events.map(({ event }) => ({ event: {
            seq: event.seq,
            type: event.type,
            time: event.time,
            data: structuredClone(event.data),
            ...(event.ignorable === undefined ? {} : { ignorable: event.ignorable }),
          } })),
          hasMore: value.hasMore,
        }
      },
    },
  }
  const server = createRemoteControlServer(options)
  ctx.effect(async () => {
    await server.start()
    return () => server.dispose()
  }, 'dsh-remote-control.listener')
}

import { openFileState } from './file-state.ts'
