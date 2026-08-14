import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CredentialProvider, { credentialRef } from '@deepseek-ai/dsh-credentials'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import { load as loadYaml } from 'js-yaml'
import * as remotePlugin from '../src/index.ts'
import * as remoteInvariant from '../src/invariant.ts'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cordis.yml')
const autoFixture = join(dirname(fixture), 'auto.cordis.yml')
const disabledFixture = join(dirname(fixture), 'disabled.cordis.yml')
const baseFixture = join(dirname(fixture), 'base.cordis.yml')
let context: Context | undefined

class ExposedRemoteCompactionEngine extends remotePlugin.RemoteCompactionEngine {
  runSummarize(
    input: { readonly system?: string; readonly messages: readonly Message[] },
    agent: Agent,
    signal?: AbortSignal,
  ) {
    return this.summarize(input, agent, signal)
  }
}

class FixtureCredentials extends CredentialProvider {
  override async resolve(ref: ReturnType<typeof credentialRef>) {
    return { value: `fixture-${ref}`, source: 'fixture' }
  }

  override async describe() {
    return { configured: true, source: 'fixture', writable: false }
  }

  override async set(): Promise<void> {
    throw new Error('fixture is read-only')
  }

  override async unset(): Promise<void> {
    throw new Error('fixture is read-only')
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function loadComposition(configPath = fixture, patches?: PatchOptions[]): Promise<Context> {
  context = new Context()
  context.baseUrl = pathToFileURL(dirname(configPath)).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', { default: LlmRuntime }],
    ['@deepseek-ai/dsh-session', { default: SessionStore }],
    ['@deepseek-ai/dsh-token-meter', { default: TokenMeter }],
    ['fixture-credentials', { default: FixtureCredentials }],
    ['dsh-remote-compaction', { ...remotePlugin, default: ExposedRemoteCompactionEngine }],
    ['@deepseek-ai/dsh-invariants', { default: InvariantRegistry }],
    ['dsh-remote-compaction/invariant', remoteInvariant],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href, patches },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('loads the shipping namespace through YAML and removes services on disposal', async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.compaction).toBeInstanceOf(remotePlugin.RemoteCompactionEngine)
    expect(loaded.credentials).toBeInstanceOf(FixtureCredentials)
    expect(loaded.invariants).toBeInstanceOf(InvariantRegistry)

    await loaded.fiber.dispose()
    context = undefined
    expect(loaded.get('compaction')).toBeUndefined()
    expect(loaded.get('credentials')).toBeUndefined()
  })

  it('unloads and reloads the invariant companion without duplicate registration', async () => {
    const loaded = await loadComposition()
    const entry = [...loaded.loader.entries()]
      .find(candidate => candidate.options.name === 'dsh-remote-compaction/invariant')
    expect(entry?.fiber).toBeDefined()

    await entry?.update({ disabled: true })
    expect(entry?.fiber).toBeUndefined()
    await entry?.update({ disabled: false })
    expect(entry?.fiber).toBeDefined()
  })

  it('aborts old Remote work and replaces the service across entry reload', async () => {
    let observedSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      observedSignal = init?.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true })
      })
    }))
    const loaded = await loadComposition()
    const previous = loaded.compaction as ExposedRemoteCompactionEngine
    const pending = previous.runSummarize(
      { messages: [] },
      { options: {}, session: { requestHeader: () => undefined } } as unknown as Agent,
    )
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    const entry = [...loaded.loader.entries()]
      .find(candidate => candidate.options.name === 'dsh-remote-compaction')

    await entry?.update({ disabled: true })
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect(observedSignal?.aborted).toBe(true)
    expect(loaded.get('compaction')).toBeUndefined()

    await entry?.update({ disabled: false })
    expect(loaded.compaction).toBeInstanceOf(remotePlugin.RemoteCompactionEngine)
    expect(loaded.compaction).not.toBe(previous)
  })

  it('applies the shipping bundle patch before Loader activates the provider', async () => {
    const patch = await readFile(join(dirname(dirname(dirname(fixture))), 'cordis.patch.yml'), 'utf8')
    const patches = loadYaml(patch, { schema: entryListSchema }) as PatchOptions[]
    const loaded = await loadComposition(baseFixture, patches)
    const basic = [...loaded.loader.entries()]
      .find(candidate => candidate.options.id === 'compaction-basic')
    const remote = [...loaded.loader.entries()]
      .find(candidate => candidate.options.id === 'dsh-remote-compaction')

    expect(basic?.disabled).toBe(true)
    expect(basic?.fiber).toBeUndefined()
    expect(remote?.fiber).toBeDefined()
    expect(loaded.compaction).toBeInstanceOf(remotePlugin.RemoteCompactionEngine)
  })

  it('fails closed on official opaque output in remote-only mode', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'response',
      object: 'response.compaction',
      output: [{ type: 'compaction', encrypted_content: 'opaque' }],
    }))))
    const loaded = await loadComposition()
    const engine = loaded.compaction as ExposedRemoteCompactionEngine
    const controller = new AbortController()
    await expect(engine.runSummarize(
      { messages: [] },
      { options: {}, session: { requestHeader: () => undefined } } as unknown as Agent,
      controller.signal,
    )).rejects.toMatchObject({ code: 'incompatible-response' })
  })

  it('invokes the inherited Basic summarizer for an auto-mode fallback', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'response',
      object: 'response.compaction',
      output: [{ type: 'compaction', encrypted_content: 'opaque' }],
    }))))
    const summary = {
      summary: [{ type: 'text', text: 'basic' }],
      rawOutput: [{ type: 'text', text: 'basic' }],
      llmStreamCall: true as const,
      provider: 'fallback',
      model: 'fallback',
    }
    const prototype = BasicCompactionEngine.prototype as unknown as Record<
      'summarize', (...args: unknown[]) => Promise<unknown>
    >
    const fallback = vi.spyOn(prototype, 'summarize').mockResolvedValue(summary)
    const loaded = await loadComposition(autoFixture)
    const engine = loaded.compaction as ExposedRemoteCompactionEngine
    await expect(engine.runSummarize(
      { messages: [] },
      { options: {}, session: { requestHeader: () => undefined } } as unknown as Agent,
    )).resolves.toEqual(summary)
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('bypasses transport entirely in disabled mode', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const summary = {
      summary: [{ type: 'text', text: 'basic' }],
      rawOutput: [{ type: 'text', text: 'basic' }],
      llmStreamCall: true as const,
      provider: 'fallback',
      model: 'fallback',
    }
    const prototype = BasicCompactionEngine.prototype as unknown as Record<
      'summarize', (...args: unknown[]) => Promise<unknown>
    >
    const fallback = vi.spyOn(prototype, 'summarize').mockResolvedValue(summary)
    const loaded = await loadComposition(disabledFixture)
    const engine = loaded.compaction as ExposedRemoteCompactionEngine
    await expect(engine.runSummarize(
      { messages: [] },
      { options: {}, session: { requestHeader: () => undefined } } as unknown as Agent,
    )).resolves.toEqual(summary)
    expect(fallback).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
