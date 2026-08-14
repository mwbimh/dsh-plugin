import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include, {
  entryListSchema,
  type PatchOptions,
} from '@deepseek-ai/cordis-plugin-include'
import Loader, { type Entry } from '@deepseek-ai/cordis-plugin-loader'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as UsageAnalyticsPlugin from '../src/index.ts'
import * as UsageAnalyticsInvariant from '../src/invariant.ts'

const requireFromInclude = createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-include'))
const yaml = requireFromInclude('js-yaml') as {
  load(source: string, options: { schema: unknown }): unknown
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface Composition {
  context: Context
  includeEntry: Entry
  includeId: string
  includePath: string
  patches: PatchOptions[]
}

function expectInvariantReserved(loaded: Context): void {
  expect(() => loaded.invariants.register('dsh-usage-analytics', () => {}))
    .toThrow('package "dsh-usage-analytics" is already registered')
}

async function loadShippedPatches(): Promise<PatchOptions[]> {
  const source = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const parsed = yaml.load(source, { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('cordis.patch.yml must be a top-level patch list')
  return parsed as PatchOptions[]
}

async function loadComposition(): Promise<Composition> {
  root = await mkdtemp(join(tmpdir(), 'dsh-usage-analytics-loader-'))
  const configPath = join(root, 'cordis.yml')
  const includePath = pathToFileURL(configPath).href
  const fixture = await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8')
  const patches = await loadShippedPatches()
  await writeFile(configPath, fixture)

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-invariants', InvariantRegistry],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['dsh-usage-analytics', UsageAnalyticsPlugin],
    ['dsh-usage-analytics/invariant', UsageAnalyticsInvariant],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  const includeId = await context.loader.create({
    name: 'cordis:include',
    config: { path: includePath, patches: structuredClone(patches) },
  })
  await context.loader.await()
  return {
    context,
    includeEntry: context.loader.resolve(includeId),
    includeId,
    includePath,
    patches,
  }
}

describe('real Loader composition', () => {
  it('applies the shipped patch and owns disable, config HMR, and disposal lifecycles', async () => {
    const composition = await loadComposition()
    const loaded = composition.context
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const analyticsEntry = loaded.loader.resolve(
      `${composition.includeId}:dsh-usage-analytics`,
    )
    const invariantEntry = loaded.loader.resolve(
      `${composition.includeId}:dsh-usage-analytics-invariant`,
    )
    expect(analyticsEntry.options.name).toBe('dsh-usage-analytics')
    expect(invariantEntry.options.name).toBe('dsh-usage-analytics/invariant')
    expectInvariantReserved(loaded)

    const session = loaded.sessions.create(SessionId('loader-composed'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
      reason: 'initial',
    })
    session.append('request/context', {
      provider: 'deepseek', model: 'deepseek-chat', contextWindow: 64_000,
    })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'composed response' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      }),
      usage: { inputTokens: 9, outputTokens: 3, cacheReadTokens: 4 },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(loaded.sessionProjections.snapshot(session).values.dshUsageAnalytics)
      .toMatchObject({ measuredCalls: 1, inputTokens: 9, outputTokens: 3, cacheReadTokens: 4 })

    const firstAnalyticsFiber = analyticsEntry.fiber
    const firstInvariantFiber = invariantEntry.fiber
    expect(firstAnalyticsFiber).toBeDefined()
    expect(firstInvariantFiber).toBeDefined()

    await loaded.loader.update(analyticsEntry.id, { disabled: true })
    await loaded.loader.await()

    expect(firstAnalyticsFiber?.uid).toBeNull()
    expect(analyticsEntry.fiber).toBeUndefined()
    expect(loaded.sessionProjections.snapshot(session).values).not.toHaveProperty('dshUsageAnalytics')
    expectInvariantReserved(loaded)

    await loaded.loader.update(analyticsEntry.id, { disabled: null })
    await loaded.loader.await()

    const directlyReloadedAnalyticsFiber = analyticsEntry.fiber
    expect(directlyReloadedAnalyticsFiber).toBeDefined()
    expect(directlyReloadedAnalyticsFiber).not.toBe(firstAnalyticsFiber)
    expect(loaded.sessionProjections.snapshot(session).values.dshUsageAnalytics)
      .toMatchObject({ measuredCalls: 1, inputTokens: 9, outputTokens: 3, cacheReadTokens: 4 })

    const disabledPatches: PatchOptions[] = [
      ...structuredClone(composition.patches),
      { id: 'dsh-usage-analytics', name: 'dsh-usage-analytics', disabled: true },
      {
        id: 'dsh-usage-analytics-invariant',
        name: 'dsh-usage-analytics/invariant',
        disabled: true,
      },
    ]
    await loaded.loader.update(composition.includeId, {
      config: { path: composition.includePath, patches: disabledPatches },
    })
    await loaded.loader.await()

    const disabledAnalyticsEntry = loaded.loader.resolve(
      `${composition.includeId}:dsh-usage-analytics`,
    )
    const disabledInvariantEntry = loaded.loader.resolve(
      `${composition.includeId}:dsh-usage-analytics-invariant`,
    )
    expect(directlyReloadedAnalyticsFiber?.uid).toBeNull()
    expect(firstInvariantFiber?.uid).toBeNull()
    expect(disabledAnalyticsEntry.fiber).toBeUndefined()
    expect(disabledInvariantEntry.fiber).toBeUndefined()
    expect(loaded.sessionProjections.snapshot(session).values).not.toHaveProperty('dshUsageAnalytics')
    const temporaryInvariant = loaded.invariants.register('dsh-usage-analytics', () => {})
    await Promise.resolve(temporaryInvariant)
    await Promise.resolve(temporaryInvariant())

    await loaded.loader.update(composition.includeId, {
      config: { path: composition.includePath, patches: structuredClone(composition.patches) },
    })
    await loaded.loader.await()

    const reloadedAnalyticsEntry = loaded.loader.resolve(
      `${composition.includeId}:dsh-usage-analytics`,
    )
    const reloadedInvariantEntry = loaded.loader.resolve(
      `${composition.includeId}:dsh-usage-analytics-invariant`,
    )
    expect(reloadedAnalyticsEntry.fiber).toBeDefined()
    expect(reloadedInvariantEntry.fiber).toBeDefined()
    expect(reloadedAnalyticsEntry.fiber).not.toBe(directlyReloadedAnalyticsFiber)
    expect(reloadedInvariantEntry.fiber).not.toBe(firstInvariantFiber)
    expect(loaded.sessionProjections.snapshot(session).values.dshUsageAnalytics)
      .toMatchObject({ measuredCalls: 1, inputTokens: 9, outputTokens: 3, cacheReadTokens: 4 })
    expectInvariantReserved(loaded)

    const activeAnalyticsFiber = reloadedAnalyticsEntry.fiber
    const activeInvariantFiber = reloadedInvariantEntry.fiber
    const includeFiber = composition.includeEntry.fiber
    await loaded.fiber.dispose()
    context = undefined

    expect(activeAnalyticsFiber?.uid).toBeNull()
    expect(activeInvariantFiber?.uid).toBeNull()
    expect(includeFiber?.uid).toBeNull()
    expect(reloadedAnalyticsEntry.fiber).toBeUndefined()
    expect(reloadedInvariantEntry.fiber).toBeUndefined()
  })
})
