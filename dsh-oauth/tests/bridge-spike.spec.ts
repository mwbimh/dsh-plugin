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
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import * as OAuthBridge from '../src/index.ts'

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

const accountId = 'acct-spike'
const jwt = (label: string): string => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ label, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.signature`
}
const oldToken = jwt('old-token')
const newToken = jwt('new-token')

interface MockState {
  refreshes: number
  codexHeaders: IncomingHttpHeaders[]
  codexBodies: Buffer[]
}

async function startServer(options: { holdRefresh?: boolean } = {}): Promise<{ url: string; state: MockState }> {
  const state: MockState = { refreshes: 0, codexHeaders: [], codexBodies: [] }
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      if (request.url === '/oauth/token') {
        state.refreshes += 1
        if (options.holdRefresh) return
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ accessToken: newToken, expiresAt: Date.now() + 60_000 }))
        }, 30)
        return
      }
      state.codexHeaders.push(request.headers)
      state.codexBodies.push(Buffer.concat(chunks))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n')
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind')
  return { url: `http://127.0.0.1:${address.port}`, state }
}

async function boot(baseURL: string, environment: Record<string, string> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-oauth-spike-'))
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(credentialsPath, `DSH_OAUTH_CODEX: ${JSON.stringify(oldToken)}\n`, { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    watch: false',
    '- id: oauth-bridge',
    "  name: '@dsh-plugins/dsh-oauth'",
    '  config:',
    '    route: openai-codex',
    '    credentialRef: DSH_OAUTH_CODEX',
    `    refreshEndpoint: ${JSON.stringify(`${baseURL}/oauth/token`)}`,
    '    expiresAt: 0',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      openai-codex:',
    '        apiKeyEnv: DSH_OAUTH_CODEX',
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
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@dsh-plugins/dsh-oauth', OAuthBridge],
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
  return ctx
}

async function consume(ctx: Context, provider = 'openai-codex'): Promise<void> {
  for await (const _chunk of ctx.llm.stream({ provider, model: 'gpt-5.4-mini', messages: [] })) {
    // The request reaching the mock server is the assertion boundary.
  }
}

describe('OAuth credential bridge P0 spike', () => {
  it('refreshes once before concurrent Codex requests and emits only the new token with complete auth headers', async () => {
    const mock = await startServer()
    const ctx = await boot(mock.url)

    await Promise.all([consume(ctx), consume(ctx)])

    expect(mock.state.refreshes).toBe(1)
    expect(mock.state.codexHeaders).toHaveLength(2)
    for (const headers of mock.state.codexHeaders) {
      expect(headers.authorization).toBe(`Bearer ${newToken}`)
      expect(headers.authorization).not.toContain(oldToken)
      expect(headers['chatgpt-account-id']).toBe(accountId)
      expect(headers.originator).toBe('pi')
      expect(headers['user-agent']).toMatch(/^pi \(/)
      expect(headers['openai-beta']).toBe('responses=experimental')
      expect(headers.accept).toBe('text/event-stream')
      expect(headers['content-type']).toBe('application/json')
    }
  })

  it('delegates non-managed routes and removes the refresh listener on Loader entry disposal', async () => {
    const mock = await startServer()
    const ctx = await boot(mock.url)
    let delegated = 0
    ctx.on('llm/stream', (_options, _next) => {
      delegated += 1
      return (async function* () {})()
    })

    await consume(ctx, 'unmanaged')
    expect(delegated).toBe(1)
    expect(mock.state.refreshes).toBe(0)

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'oauth-bridge')
    await entry?.fiber?.dispose()
    await consume(ctx)
    expect(delegated).toBe(2)
    expect(mock.state.refreshes).toBe(0)
  })

  it('fails loud when the launching environment shadows credential rotation', async () => {
    const mock = await startServer()
    const ctx = await boot(mock.url, { DSH_OAUTH_CODEX: oldToken })

    await expect(consume(ctx)).rejects.toThrow(/launching environment|shadow/)
    expect(mock.state.refreshes).toBe(1)
    expect(mock.state.codexHeaders).toHaveLength(0)
  })

  it('aborts and drains an in-flight refresh during Loader entry disposal without dispatching downstream', async () => {
    const mock = await startServer({ holdRefresh: true })
    const ctx = await boot(mock.url)
    const request = consume(ctx)
    await expect.poll(() => mock.state.refreshes).toBe(1)

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'oauth-bridge')
    await entry?.fiber?.dispose()

    await expect(request).rejects.toThrow(/abort|disposed|invalid_argument/i)
    expect(mock.state.codexHeaders).toHaveLength(0)
  })
})
