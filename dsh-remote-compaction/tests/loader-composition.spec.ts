import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import {
  createAssistantMessage,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CredentialProvider, { credentialRef } from '@deepseek-ai/dsh-credentials'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { load as loadYaml } from 'js-yaml'
import * as remotePlugin from '../src/index.ts'
import * as remoteInvariant from '../src/invariant.ts'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cordis.yml')
const autoFixture = join(dirname(fixture), 'auto.cordis.yml')
const disabledFixture = join(dirname(fixture), 'disabled.cordis.yml')
const baseFixture = join(dirname(fixture), 'base.cordis.yml')
let context: Context | undefined

const PROVIDER = 'openai'
const MODEL = 'gpt-test'
const PROMPT = 'older conversation history '.repeat(60)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

class TextAdapter extends LlmAdapter {
  readonly requests: Message[][] = []
  readonly started = deferred()
  gate?: Promise<void>
  failure?: { message: string; code: string }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push([...options.messages])
    this.started.resolve()
    if (this.gate !== undefined) await this.gate
    if (this.failure !== undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: this.failure } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'checkpoint' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let adapter = new TextAdapter()

const fixtureAdapterPlugin = Object.assign(
  (ctx: Context) => ctx.effect(
    () => ctx.llm.registerAdapter([PROVIDER], adapter),
    'fixture-llm-adapter',
  ),
  { inject: ['llm'] },
)

function closedConversation(turns = 2): Session {
  const session = Session.create(SessionId(`remote-transaction-${turns}-${crypto.randomUUID()}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${PROMPT} ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: PROVIDER, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `answer ${turn}` }],
        source: { provider: PROVIDER, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

function idleAgent(session: Session) {
  const maintenanceSignal = new AbortController().signal
  return {
    session,
    options: { provider: PROVIDER, model: MODEL },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(maintenanceSignal)
    },
  }
}

function compactEvents(session: Session) {
  return session.events.filter(event => event.type.startsWith('compaction/'))
}

function openConversation(): Session {
  const session = closedConversation()
  session.append('turn/start', { turn: 3 })
  return session
}

function fullRange(session: Session): [number, number] {
  const nodes = session.surface.nodes
  return [nodes[0]!, nodes.at(-1)!]
}

class FixtureCredentials extends CredentialProvider {
  override async resolve(ref: ReturnType<typeof credentialRef>) {
    return credentialValue === undefined
      ? undefined
      : { value: `${credentialValue}-${ref}`, source: 'fixture' }
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

let credentialValue: string | undefined = 'fixture'

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  adapter = new TextAdapter()
  credentialValue = 'fixture'
})

async function loadComposition(configPath = fixture, patches?: PatchOptions[]): Promise<Context> {
  context = new Context()
  context.baseUrl = pathToFileURL(dirname(configPath)).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', { default: LlmRuntime }],
    ['fixture-llm-adapter', { default: fixtureAdapterPlugin }],
    ['@deepseek-ai/dsh-session', { default: SessionStore }],
    ['@deepseek-ai/dsh-token-meter', { default: TokenMeter }],
    ['fixture-credentials', { default: FixtureCredentials }],
    ['@deepseek-ai/dsh-compaction-basic', { default: BasicCompactionEngine }],
    ['dsh-remote-compaction', remotePlugin],
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
    const previous = loaded.compaction
    const session = openConversation()
    const pending = previous.compactRegion(...fullRange(session), idleAgent(session))
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

  it('installs safely with Basic active, Remote disabled, and the invariant companion registered', async () => {
    credentialValue = undefined
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const patch = await readFile(join(dirname(dirname(dirname(fixture))), 'cordis.patch.yml'), 'utf8')
    const patches = loadYaml(patch, { schema: entryListSchema }) as PatchOptions[]
    const loaded = await loadComposition(baseFixture, patches)
    const basic = [...loaded.loader.entries()]
      .find(candidate => candidate.options.id === 'compaction-basic')
    const remote = [...loaded.loader.entries()]
      .find(candidate => candidate.options.id === 'dsh-remote-compaction')
    const invariant = [...loaded.loader.entries()]
      .find(candidate => candidate.options.id === 'dsh-remote-compaction-invariant')

    expect(basic?.disabled).toBe(false)
    expect(basic?.options.config).toEqual({ auto: false })
    expect(basic?.fiber).toBeDefined()
    expect(remote?.disabled).toBe(true)
    expect(remote?.fiber).toBeUndefined()
    expect(invariant?.fiber).toBeDefined()
    expect(loaded.compaction).toBeInstanceOf(BasicCompactionEngine)
    expect(loaded.compaction).not.toBeInstanceOf(remotePlugin.RemoteCompactionEngine)
    const session = openConversation()
    const before = session.seq
    await expect(loaded.compaction.compactRegion(
      ...fullRange(session),
      idleAgent(session),
    )).resolves.toMatchObject({ summary: [{ type: 'text', text: 'checkpoint' }] })
    expect(session.events.slice(before).map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/summary',
      'user/message',
      'compaction/end',
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('switches only through an explicit overlay that migrates the Basic configuration', async () => {
    const patch = await readFile(join(dirname(dirname(dirname(fixture))), 'cordis.patch.yml'), 'utf8')
    const shipping = loadYaml(patch, { schema: entryListSchema }) as PatchOptions[]
    const explicitEnable: PatchOptions[] = [
      { id: 'compaction-basic', disabled: true },
      {
        id: 'dsh-remote-compaction',
        disabled: false,
        config: {
          auto: false,
          mode: 'auto',
          provider: 'openai',
          model: 'gpt-test',
          baseURL: 'https://api.example/v1',
          credentialRef: 'OPENAI_API_KEY',
        },
      },
    ]
    const loaded = await loadComposition(baseFixture, [...shipping, ...explicitEnable])
    const basic = [...loaded.loader.entries()]
      .find(candidate => candidate.options.id === 'compaction-basic')
    const remote = [...loaded.loader.entries()]
      .find(candidate => candidate.options.id === 'dsh-remote-compaction')

    expect(basic?.options.config).toEqual({ auto: false })
    expect(basic?.disabled).toBe(true)
    expect(remote?.options.config).toMatchObject({ auto: false, mode: 'auto' })
    expect(remote?.fiber).toBeDefined()
    expect(loaded.compaction).toBeInstanceOf(remotePlugin.RemoteCompactionEngine)
  })

  it('commits the inherited Basic transaction after an auto-mode opaque fallback', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'response',
      object: 'response.compaction',
      output: [{ type: 'compaction', encrypted_content: 'opaque' }],
    })))
    vi.stubGlobal('fetch', fetchMock)
    const loaded = await loadComposition(autoFixture)
    const session = openConversation()
    const before = session.seq
    const range = fullRange(session)
    const result = await loaded.compaction.compactRegion(
      ...range,
      idleAgent(session),
    )
    expect(result.summary).toEqual([{ type: 'text', text: 'checkpoint' }])
    expect(session.events.slice(before).map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/summary',
      'user/message',
      'compaction/end',
    ])
    expect(session.events[before + 1]).toMatchObject({
      type: 'compaction/summary',
      data: { provider: PROVIDER, model: MODEL, llmStreamCall: true },
    })
    expect(session.events[before + 2]).toMatchObject({
      type: 'user/message',
      surfaceOp: { op: 'replace', start: range[0], end: range[1] },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(adapter.requests).toHaveLength(1)
  })

  it('fails remote-only opaque output without a partial summary or replacement', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'response',
      object: 'response.compaction',
      output: [{ type: 'compaction', encrypted_content: 'opaque' }],
    }))))
    const loaded = await loadComposition()
    const session = openConversation()
    const nodes = [...session.surface.nodes]
    const generation = session.surface.replaceGeneration
    await expect(loaded.compaction.compactRegion(
      ...fullRange(session),
      idleAgent(session),
    )).rejects.toMatchObject({ code: 'incompatible-response' })
    expect(compactEvents(session).map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/end',
    ])
    expect(session.surface.nodes).toEqual(nodes)
    expect(session.surface.replaceGeneration).toBe(generation)
    expect(adapter.requests).toHaveLength(0)
  })

  it('uses the Basic path by default when a directly loaded config omits mode', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const loaded = await loadComposition(disabledFixture)
    const session = openConversation()
    await expect(loaded.compaction.compactRegion(
      ...fullRange(session),
      idleAgent(session),
    )).resolves.toMatchObject({ summary: [{ type: 'text', text: 'checkpoint' }] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves caller abort without a partial summary or replacement', async () => {
    let observedSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      observedSignal = init?.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true })
      })
    }))
    const loaded = await loadComposition(autoFixture)
    const session = openConversation()
    const nodes = [...session.surface.nodes]
    const controller = new AbortController()
    const reason = new Error('caller cancelled transaction')
    const pending = loaded.compaction.compactRegion(
      ...fullRange(session),
      idleAgent(session),
      controller.signal,
    )
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(compactEvents(session).map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/end',
    ])
    expect(session.surface.nodes).toEqual(nodes)
  })

  it('rejects a changed range after fallback without committing its checkpoint', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'response', object: 'response.compaction',
      output: [{ type: 'compaction', encrypted_content: 'opaque' }],
    }))))
    const gate = deferred()
    adapter.gate = gate.promise
    const loaded = await loadComposition(autoFixture)
    const session = closedConversation()
    const generation = session.surface.replaceGeneration
    const pending = loaded.compaction.compactNow(idleAgent(session), new AbortController().signal)
    await adapter.started.promise
    const head = session.surface.nodes[0]!
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'concurrent replacement' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', start: head, end: head },
      sourceEventSeqs: [head],
    })
    gate.resolve()
    await expect(pending).rejects.toMatchObject({ name: 'ManualCompactionError', code: 'changed' })
    expect(compactEvents(session).map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/end',
    ])
    expect(session.surface.replaceGeneration).toBe(generation + 1)
  })

  it('records fallback failure without committing a checkpoint', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'response', object: 'response.compaction',
      output: [{ type: 'compaction', encrypted_content: 'opaque' }],
    }))))
    adapter.failure = { message: 'fallback unavailable', code: 'FALLBACK_UNAVAILABLE' }
    const loaded = await loadComposition(autoFixture)
    const session = closedConversation()
    const nodes = [...session.surface.nodes]
    await expect(loaded.compaction.compactNow(
      idleAgent(session),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: 'ManualCompactionError', code: 'summary' })
    expect(compactEvents(session).map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/end',
    ])
    expect(session.surface.nodes).toEqual(nodes)
  })
})
