import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as plugin from '../src/index.ts'

let context: Context | undefined
let root: string | undefined

class FakeApiProxy extends Service {
  static inject = []
  readonly sessions = {
    list: vi.fn(async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } })),
    history: vi.fn(async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true, value: { events: [], hasMore: false } } })),
  }

  constructor(ctx: Context) {
    super(ctx, 'apiProxy')
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('loads disabled by default without binding a listener and disposes cleanly', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-remote-control-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@fixture/api-proxy'",
      "- name: '@deepseek-ai/dsh-remote-control'",
      '  config:',
      '    enabled: false',
      '    lan: false',
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@fixture/api-proxy', FakeApiProxy],
      ['@deepseek-ai/dsh-remote-control', plugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    const entry = [...context.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-remote-control')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()
  })
})
