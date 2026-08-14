import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply as applyWithoutDependencies } from '../src/index.ts'
import { createOAuthPlugin, type ManagedOAuthService } from '../src/bridge.ts'
import type { OAuthCommandDefinition, OAuthCommandRegistry } from '../src/commands.ts'

function fakeService() {
  const ensureFreshForRoute = vi.fn<ManagedOAuthService['ensureFreshForRoute']>(async () => undefined)
  const dispose = vi.fn<ManagedOAuthService['dispose']>(async () => {})
  const service: ManagedOAuthService = {
    providers: () => [],
    accounts: async () => [],
    accountCredential: async () => { throw new Error('no account') },
    login: async () => { throw new Error('no provider') },
    logout: async () => {},
    ensureFresh: async () => {},
    rotate: async () => {},
    ensureFreshForRoute,
    dispose,
  }
  return { service, ensureFreshForRoute, dispose }
}

describe('dsh-oauth plugin lifecycle', () => {
  it('fails loud when no provider/store composition was injected', () => {
    expect(() => applyWithoutDependencies(new Context(), {})).toThrowError(expect.objectContaining({ code: 'configuration' }))
  })

  it('defaults programmatic config and fails loud when the required command service is absent', async () => {
    const ctx = new Context()
    const { service, dispose } = fakeService()
    let receivedRefreshWindow: number | undefined
    const plugin = createOAuthPlugin({
      createService(_pluginCtx, config) {
        receivedRefreshWindow = config.refreshWindowMs
        return service
      },
    })

    expect(() => plugin.apply(ctx, {})).toThrowError(expect.objectContaining({ code: 'configuration' }))
    expect(receivedRefreshWindow).toBe(30_000)
    await ctx.fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('publishes the namespaced service and removes service, command, and bridge contributions on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('credentials', {})
    let command: OAuthCommandDefinition | undefined
    let commandDisposed = false
    const commands: OAuthCommandRegistry = {
      register(definition) {
        command = definition
        return () => { commandDisposed = true }
      },
    }
    ctx.provide('commands', commands)
    const { service, ensureFreshForRoute, dispose } = fakeService()
    let receivedRefreshWindow: number | undefined
    const plugin = createOAuthPlugin({
      createService(_pluginCtx, config) {
        receivedRefreshWindow = config.refreshWindowMs
        return service
      },
    })
    const runtime = await ctx.plugin(plugin, { refreshWindowMs: 5_000 })
    let downstream = 0
    ctx.on('llm/stream', () => {
      downstream += 1
      return (async function* () {})()
    })

    expect(ctx.get('dsh-oauth')).toBe(service)
    expect(receivedRefreshWindow).toBe(5_000)
    expect(command?.name).toBe('dsh-oauth')
    for await (const _chunk of ctx.llm.stream({ provider: 'unmanaged', model: 'model', messages: [] })) {}
    expect(ensureFreshForRoute).not.toHaveBeenCalled()

    await runtime.dispose()

    expect(dispose).toHaveBeenCalledOnce()
    expect(commandDisposed).toBe(true)
    expect(ctx.get('dsh-oauth')).toBeUndefined()
    for await (const _chunk of ctx.llm.stream({ provider: 'unmanaged', model: 'model', messages: [] })) {}
    expect(ensureFreshForRoute).not.toHaveBeenCalled()
    expect(downstream).toBe(2)
    await ctx.fiber.dispose()
  })
})
