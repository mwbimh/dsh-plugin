import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { installCredentialBridge } from '../src/bridge.ts'
import type {
  OAuthAccount,
  OAuthAccountId,
  OAuthLoginOptions,
  OAuthService,
} from '../src/types.ts'

const account: OAuthAccount = {
  id: 'account-1' as OAuthAccountId,
  provider: 'openai-codex',
  displayName: 'Codex account',
  subject: 'subject-1',
  scopes: ['openid'],
  status: 'ready',
  expiresAt: 60_000,
  createdAt: 1,
  updatedAt: 1,
}

function fakeService(
  ensureFreshForRoute: OAuthService['ensureFreshForRoute'],
): OAuthService {
  return {
    providers: () => [{
      id: 'openai-codex',
      route: 'openai-codex',
      issuer: 'https://issuer.example',
      audience: 'codex-api',
      scopes: ['openid'],
    }],
    accounts: async () => [],
    accountCredential: async () => ({ account, credentialRef: 'DSH_OAUTH_CODEX' }),
    login: async () => account,
    logout: async () => {},
    ensureFresh: async () => {},
    rotate: async () => {},
    ensureFreshForRoute,
  }
}

async function consume(ctx: Context, provider: string): Promise<void> {
  for await (const _chunk of ctx.llm.stream({ provider, model: 'test-model', messages: [] })) {
    // The downstream listener is the observable boundary.
  }
}

async function harness(service: OAuthService) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  let downstream = 0
  const bridge = await ctx.plugin({
    name: 'test-oauth-bridge',
    inject: ['llm'],
    apply(pluginCtx: Context) {
      installCredentialBridge(pluginCtx, service)
    },
  })
  ctx.on('llm/stream', () => {
    downstream += 1
    return (async function* () {})()
  })
  return { bridge, ctx, downstream: () => downstream }
}

describe('OAuth credential bridge', () => {
  it('waits for the managed route refresh before continuing the same request', async () => {
    let release!: () => void
    const refresh = new Promise<void>(resolve => { release = resolve })
    const ensureFreshForRoute = vi.fn<OAuthService['ensureFreshForRoute']>(async route => {
      expect(route).toBe('openai-codex')
      await refresh
      return { account, credentialRef: 'DSH_OAUTH_CODEX' }
    })
    const service = fakeService(ensureFreshForRoute)
    const { ctx, downstream } = await harness(service)

    const request = consume(ctx, 'openai-codex')
    await vi.waitFor(() => expect(ensureFreshForRoute).toHaveBeenCalledOnce())
    expect(downstream()).toBe(0)
    release()
    await request

    expect(downstream()).toBe(1)
    await ctx.fiber.dispose()
  })

  it('delegates an unmanaged route unchanged', async () => {
    const ensureFreshForRoute = vi.fn<OAuthService['ensureFreshForRoute']>(async () => undefined)
    const service = fakeService(ensureFreshForRoute)
    const { ctx, downstream } = await harness(service)

    await consume(ctx, 'unmanaged')

    expect(ensureFreshForRoute).not.toHaveBeenCalled()
    expect(downstream()).toBe(1)
    await ctx.fiber.dispose()
  })

  it('fails closed when a managed route resolves no account association', async () => {
    const ensureFreshForRoute = vi.fn<OAuthService['ensureFreshForRoute']>(async () => undefined)
    const service = fakeService(ensureFreshForRoute)
    const { ctx, downstream } = await harness(service)

    await expect(consume(ctx, 'openai-codex')).rejects.toMatchObject({ code: 'reauth-required' })
    expect(downstream()).toBe(0)
    await ctx.fiber.dispose()
  })

  it('fails loud on route conflict or credential publication failure without dispatching downstream', async () => {
    for (const error of [
      Object.assign(new Error('dsh-oauth: route ownership is ambiguous'), { code: 'route-conflict' }),
      Object.assign(new Error('dsh-oauth: credential is shadowed by the launching environment'), { code: 'configuration' }),
    ]) {
      const ensureFreshForRoute = vi.fn<OAuthService['ensureFreshForRoute']>(async () => { throw error })
      const service = fakeService(ensureFreshForRoute)
      const { ctx, downstream } = await harness(service)

      await expect(consume(ctx, 'openai-codex')).rejects.toBe(error)
      expect(downstream()).toBe(0)
      await ctx.fiber.dispose()
    }
  })

  it('removes its listener and aborts pending bridge waits when its fiber is disposed', async () => {
    const signals: AbortSignal[] = []
    const ensureFreshForRoute = vi.fn<OAuthService['ensureFreshForRoute']>((
      _route: string,
      options?: OAuthLoginOptions,
    ) => new Promise((_resolve, reject) => {
      const signal = options?.signal
      if (signal === undefined) throw new Error('missing bridge cancellation signal')
      signals.push(signal)
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const service = fakeService(ensureFreshForRoute)
    const { bridge, ctx, downstream } = await harness(service)
    const request = consume(ctx, 'openai-codex')
    await vi.waitFor(() => expect(signals).toHaveLength(1))

    await bridge.dispose()

    expect(signals[0]?.aborted).toBe(true)
    await expect(request).rejects.toThrow(/abort/i)
    await consume(ctx, 'openai-codex')
    expect(downstream()).toBe(1)
    await ctx.fiber.dispose()
  })
})
