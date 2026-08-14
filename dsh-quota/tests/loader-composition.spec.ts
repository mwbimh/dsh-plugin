import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeQuotaProvider } from '../src/fakes.ts'
import * as Quota from '../src/index.ts'
import type { TokenFreeOAuthAccountService } from '../src/plugin.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const oauthAccount = { id: 'oauth-loader', provider: 'fake', displayName: 'Loader account' }
const oauthService: TokenFreeOAuthAccountService = {
  async accounts(provider) {
    return provider === undefined || provider === oauthAccount.provider ? [oauthAccount] : []
  },
  async accountCredential(accountId) {
    if (accountId !== oauthAccount.id) throw new Error('not found')
    return { account: oauthAccount, credentialRef: 'OPAQUE_LOADER_REF' }
  },
}

const OAuthFixture = {
  name: 'token-free-oauth-fixture',
  inject: [],
  apply(ctx: Context): void {
    ctx.provide('dsh-oauth', oauthService)
  },
}

async function boot(entries: readonly string[], quotaModule: unknown): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-quota-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, `${entries.join('\n')}\n`)

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@dsh-plugins/dsh-quota', quotaModule],
    ['test-token-free-oauth', OAuthFixture],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('dsh-quota real Loader composition', () => {
  it('starts standalone and removes the service when its Loader entry is disposed', async () => {
    const ctx = await boot([
      '- id: quota',
      "  name: '@dsh-plugins/dsh-quota'",
    ], Quota)

    await expect(ctx.get('dsh-quota')!.listAccounts()).resolves.toEqual([])
    const quotaEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'quota')
    await quotaEntry?.fiber?.dispose()
    expect(ctx.get('dsh-quota')).toBeUndefined()
  })

  it('reads the optional OAuth service dynamically and fails clearly after OAuth unload', async () => {
    const provider = new FakeQuotaProvider({ id: 'fake', usesOAuth: true })
    const quotaModule = Quota.createQuotaPlugin({ providers: () => [provider] })
    const ctx = await boot([
      '- id: oauth-fixture',
      "  name: 'test-token-free-oauth'",
      '- id: quota',
      "  name: '@dsh-plugins/dsh-quota'",
    ], quotaModule)

    await expect(ctx.get('dsh-quota')!.listAccounts()).resolves.toEqual([oauthAccount])
    const oauthEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'oauth-fixture')
    await oauthEntry?.fiber?.dispose()
    await expect(ctx.get('dsh-quota')!.listAccounts())
      .rejects.toMatchObject({ code: 'oauth-service-unavailable' })
  })
})
