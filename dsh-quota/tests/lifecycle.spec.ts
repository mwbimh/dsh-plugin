import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'
import { createQuotaPlugin } from '../src/plugin.ts'
import * as Quota from '../src/index.ts'
import type { TokenFreeOAuthAccountService } from '../src/plugin.ts'
import { FakeQuotaProvider } from '../src/fakes.ts'

describe('dsh-quota function-plugin lifecycle', () => {
  it('keeps the Loader namespace and schema defaults intact', () => {
    expect('default' in Quota).toBe(false)
    expect(Object.keys(Quota).sort()).toEqual(['Config', 'apply', 'createQuotaPlugin', 'inject', 'name'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(Quota)).toBe(Quota)
    expect(Quota.name).toBe('dsh-quota')
    expect(Quota.inject).toEqual([])
  })

  it('registers an empty-provider service and disposes it with its fiber', async () => {
    const ctx = new Context()
    const runtime = await ctx.plugin(Quota, {})
    const service = ctx.get('dsh-quota')
    expect(service).toBeDefined()
    await expect(service!.listAccounts()).resolves.toEqual([])

    await runtime.dispose()
    expect(ctx.get('dsh-quota')).toBeUndefined()
    await expect(service!.listAccounts()).rejects.toMatchObject({ code: 'internal' })
    await ctx.fiber.dispose()
  })

  it('uses validated config and dynamically consumes only token-free OAuth structure', async () => {
    const ctx = new Context()
    const accounts = vi.fn(async () => [])
    const oauth: TokenFreeOAuthAccountService = {
      accounts,
      accountCredential: vi.fn(async () => ({
        account: { id: 'oauth-1', provider: 'fake' },
        credentialRef: 'DUMMY_REF',
      })),
    }
    ctx.provide('dsh-oauth', oauth)
    let receivedConfig: unknown
    const provider = new FakeQuotaProvider({ id: 'fake', usesOAuth: true })
    const plugin = createQuotaPlugin({
      providers(_pluginCtx, config) {
        receivedConfig = config
        return [provider]
      },
    })
    const runtime = await ctx.plugin(plugin, { cacheTtlMs: 5, timeoutMs: 6, maxConcurrency: 7 })
    expect(receivedConfig).toEqual({ cacheTtlMs: 5, timeoutMs: 6, maxConcurrency: 7 })
    await expect(ctx.get('dsh-quota')!.listAccounts()).resolves.toEqual([])
    expect(accounts).toHaveBeenCalledOnce()
    expect(Object.keys(oauth)).toEqual(['accounts', 'accountCredential'])
    await runtime.dispose()
    await ctx.fiber.dispose()
  })

  it('applies programmatic defaults and rejects invalid config', async () => {
    const ctx = new Context()
    let receivedConfig: unknown
    const plugin = createQuotaPlugin({
      providers(_pluginCtx, config) {
        receivedConfig = config
        return []
      },
    })
    const runtime = await ctx.plugin(plugin, {})
    expect(receivedConfig).toEqual({ cacheTtlMs: 60_000, timeoutMs: 10_000, maxConcurrency: 4 })
    await runtime.dispose()
    for (const config of [
      { cacheTtlMs: -1 },
      { cacheTtlMs: 1.5 },
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
      { maxConcurrency: 0 },
      { maxConcurrency: 1.5 },
    ]) expect(() => plugin.apply(new Context(), config)).toThrowError(expect.objectContaining({ code: 'configuration' }))
    await ctx.fiber.dispose()
  })
})
