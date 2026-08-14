import { Context } from '@deepseek-ai/cordis'

export interface FakeApiProxy {
  sessions: {
    list(request: { rpcId: string; payload: Record<string, never> }): Promise<{
      result: { ok: true; value: { items: never[] } }
    }>
    history(request: { rpcId: string; payload: Record<string, unknown> }): Promise<{
      result: { ok: true; value: { events: never[]; hasMore: false } }
    }>
  }
}

/** Minimal fake DSH public service for real Cordis composition tests. */
export function createFakeApiProxy(): FakeApiProxy {
  return {
    sessions: {
      async list() {
        return { result: { ok: true, value: { items: [] } } }
      },
      async history() {
        return { result: { ok: true, value: { events: [], hasMore: false } } }
      },
    },
  }
}

/** Compose through Cordis with the required service surface present. */
export function composePlugin(
  plugin: Parameters<Context['plugin']>[0],
  config?: Parameters<Context['plugin']>[1],
): { context: Context; dispose: () => Promise<void> } {
  const context = new Context()
  Object.assign(context, { apiProxy: createFakeApiProxy() })
  const state = context.plugin(plugin, config)
  return {
    context,
    async dispose() {
      await state.dispose()
    },
  }
}
