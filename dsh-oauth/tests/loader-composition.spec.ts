import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { ManagedOAuthService, OAuthRuntimeComposition } from '../src/types.ts'
import * as OAuthPlugin from '../src/index.ts'
import type {
  OAuthAccount,
  OAuthAccountId,
  OAuthCredentialRef,
  OAuthProviderInfo,
} from '../src/types.ts'

let context: Context | undefined
let root: string | undefined
let server: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const accountId = 'account-loader' as OAuthAccountId
const credentialReference = 'DSH_OAUTH_CODEX_ACCOUNT_LOADER' as OAuthCredentialRef
const account: OAuthAccount = {
  id: accountId,
  provider: 'openai-codex',
  displayName: 'Loader Codex account',
  subject: 'subject-loader',
  scopes: ['openid'],
  status: 'ready',
  expiresAt: 60_000,
  createdAt: 1,
  updatedAt: 1,
}
const provider: OAuthProviderInfo = {
  id: 'openai-codex',
  route: 'openai-codex',
  issuer: 'https://issuer.example',
  audience: 'codex-api',
  scopes: ['openid'],
}

const codexAccountId = 'acct-loader'
const jwt = (label: string): string => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ label, 'https://api.openai.com/auth': { chatgpt_account_id: codexAccountId } })}.signature`
}
const oldToken = jwt('old-token')
const newToken = jwt('new-token')

interface MockState {
  refreshes: number
  codexHeaders: IncomingHttpHeaders[]
}

async function startServer(options: { holdRefresh?: boolean } = {}): Promise<{ url: string; state: MockState }> {
  const state: MockState = { refreshes: 0, codexHeaders: [] }
  server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.url === '/oauth/token') {
        state.refreshes += 1
        if (options.holdRefresh) return
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ accessToken: newToken, expiresAt: Date.now() + 60_000 }))
        }, 20)
        return
      }
      state.codexHeaders.push(request.headers)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n')
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind')
  return { url: `http://127.0.0.1:${address.port}`, state }
}

class LoaderOAuthService implements ManagedOAuthService {
  private expiresAt = 0
  private refresh: Promise<void> | undefined
  private readonly controller = new AbortController()
  private disposed = false
  ensureCalls = 0

  constructor(private readonly ctx: Context, private readonly refreshEndpoint: string) {}

  providers(): readonly OAuthProviderInfo[] {
    return [provider]
  }

  async accounts(filter?: string): Promise<readonly OAuthAccount[]> {
    return filter === undefined || filter === provider.id ? [account] : []
  }

  async accountCredential() {
    return { account, credentialRef: credentialReference }
  }

  async login(): Promise<OAuthAccount> {
    return account
  }

  async logout(): Promise<void> {}

  async ensureFresh(): Promise<void> {
    await this.ensureFreshForRoute(provider.route)
  }

  async rotate(): Promise<void> {
    this.expiresAt = 0
    await this.ensureFreshForRoute(provider.route)
  }

  async ensureFreshForRoute(route: string, options: { signal?: AbortSignal } = {}) {
    this.ensureCalls += 1
    if (route !== provider.route) return undefined
    if (this.disposed) throw new Error('dsh-oauth: service disposed')
    if (Date.now() + 30_000 < this.expiresAt) return { account, credentialRef: credentialReference }
    const signals = options.signal === undefined
      ? [this.controller.signal]
      : [this.controller.signal, options.signal]
    this.refresh ??= (async () => {
      const response = await fetch(this.refreshEndpoint, { method: 'POST', signal: AbortSignal.any(signals) })
      if (!response.ok) throw new Error(`refresh failed (${response.status})`)
      const body = await response.json() as { accessToken?: unknown; expiresAt?: unknown }
      if (typeof body.accessToken !== 'string' || typeof body.expiresAt !== 'number') {
        throw new Error('refresh response is invalid')
      }
      await this.ctx.credentials.set(credentialRef(credentialReference), body.accessToken)
      this.expiresAt = body.expiresAt
    })().finally(() => {
      this.refresh = undefined
    })
    await this.refresh
    return { account, credentialRef: credentialReference }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.controller.abort('loader OAuth service disposed')
    await this.refresh?.catch((_disposeOwnedAbort) => undefined)
  }
}

interface BootResult {
  ctx: Context
  oauth: LoaderOAuthService
}

async function boot(baseURL: string, environment: Record<string, string> = {}): Promise<BootResult> {
  root = await mkdtemp(join(tmpdir(), 'dsh-oauth-composition-'))
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(credentialsPath, `${credentialReference}: ${JSON.stringify(oldToken)}\n`, { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    watch: false',
    '- id: commands',
    "  name: 'test-command-service'",
    '- id: oauth-runtime',
    "  name: 'test-oauth-runtime'",
    '- id: oauth',
    "  name: '@dsh-plugins/dsh-oauth'",
    '  config:',
    '    refreshWindowMs: 30000',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      openai-codex:',
    `        apiKeyEnv: ${credentialReference}`,
    `        baseURL: ${JSON.stringify(baseURL)}`,
    '        transport: sse',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  let oauth: LoaderOAuthService | undefined
  const runtimeModule = {
    name: 'test-oauth-runtime',
    apply(pluginCtx: Context) {
      const runtime: OAuthRuntimeComposition = {
        createService(serviceCtx) {
          oauth = new LoaderOAuthService(serviceCtx, `${baseURL}/oauth/token`)
          return oauth
        },
      }
      pluginCtx.provide('dsh-oauth-runtime', runtime)
    },
  }
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['test-command-service', CommandRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['test-oauth-runtime', runtimeModule],
    ['@dsh-plugins/dsh-oauth', OAuthPlugin],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  if (oauth === undefined) throw new Error('OAuth Loader entry did not construct its service')
  return { ctx, oauth }
}

async function consume(ctx: Context, route = 'openai-codex'): Promise<void> {
  for await (const _chunk of ctx.llm.stream({ provider: route, model: 'gpt-5.4-mini', messages: [] })) {}
}

describe('dsh-oauth real Loader composition', () => {
  it('refreshes once before concurrent requests and sends only the new token with complete Codex headers', async () => {
    const mock = await startServer()
    const { ctx } = await boot(mock.url)

    await Promise.all([consume(ctx), consume(ctx)])

    expect(mock.state.refreshes).toBe(1)
    expect(mock.state.codexHeaders).toHaveLength(2)
    for (const headers of mock.state.codexHeaders) {
      expect(headers.authorization).toBe(`Bearer ${newToken}`)
      expect(headers.authorization).not.toContain(oldToken)
      expect(headers['chatgpt-account-id']).toBe(codexAccountId)
      expect(headers.originator).toBe('pi')
      expect(headers['user-agent']).toMatch(/^pi \(/u)
      expect(headers['openai-beta']).toBe('responses=experimental')
      expect(headers.accept).toBe('text/event-stream')
      expect(headers['content-type']).toBe('application/json')
    }
  })

  it('delegates unmanaged routes and removes the listener and public service on Loader entry disposal', async () => {
    const mock = await startServer()
    const { ctx, oauth } = await boot(mock.url)
    let delegated = 0
    ctx.on('llm/stream', () => {
      delegated += 1
      return (async function* () {})()
    })

    await consume(ctx, 'unmanaged')
    expect(delegated).toBe(1)
    expect(oauth.ensureCalls).toBe(0)

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'oauth')
    await entry?.fiber?.dispose()
    expect(ctx.get('dsh-oauth')).toBeUndefined()
    await consume(ctx)
    expect(delegated).toBe(2)
    expect(oauth.ensureCalls).toBe(0)
  })

  it('fails loud when the launching environment shadows credential publication', async () => {
    const mock = await startServer()
    const { ctx } = await boot(mock.url, { [credentialReference]: oldToken })

    await expect(consume(ctx)).rejects.toThrow(/launching environment|shadow/iu)
    expect(mock.state.refreshes).toBe(1)
    expect(mock.state.codexHeaders).toHaveLength(0)
  })

  it('aborts and drains in-flight refresh on Loader entry disposal without dispatching downstream', async () => {
    const mock = await startServer({ holdRefresh: true })
    const { ctx } = await boot(mock.url)
    const request = consume(ctx)
    await expect.poll(() => mock.state.refreshes).toBe(1)

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'oauth')
    await entry?.fiber?.dispose()

    await expect(request).rejects.toThrow(/abort|disposed|invalid_argument/iu)
    expect(mock.state.codexHeaders).toHaveLength(0)
  })
})
