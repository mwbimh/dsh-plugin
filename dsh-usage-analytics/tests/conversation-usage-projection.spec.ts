import { describe, expect, it } from 'vitest'
import {
  applyConversationUsageEvent,
  createConversationUsageState,
  foldConversationUsage,
  type ConversationUsageEvent,
  type ProviderUsage,
} from '../src/conversation-usage-projection.ts'

let seq = 0

function event<T extends ConversationUsageEvent['type']>(
  type: T,
  data: Extract<ConversationUsageEvent, { type: T }>['data'],
  time = 1_700_000_000_000 + seq,
): Extract<ConversationUsageEvent, { type: T }> {
  return { type, seq: seq++, time, data } as Extract<ConversationUsageEvent, { type: T }>
}

function header(provider: string, model: string, reason: 'initial' | 'resume' | 'change' = 'initial') {
  return event('request/header', {
    header: { config: { provider, model } },
    reason,
  })
}

function context(provider: string, model: string, contextWindow?: number) {
  return event('request/context', {
    provider,
    model,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  })
}

function usageChunk(turn: number, step: number, usage: ProviderUsage) {
  return event('assistant/chunk', { turn, step, chunk: { type: 'usage', usage } })
}

function assistant(
  turn: number,
  step: number,
  provider: string,
  model: string,
  usage?: ProviderUsage,
) {
  return event('assistant/message', {
    turn,
    step,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'private response' }],
      source: { kind: 'model', provider, model },
    },
    ...(usage === undefined ? {} : { usage }),
  })
}

describe('durable conversation usage projection', () => {
  it('returns zero measured and missing calls for an empty log', () => {
    expect(foldConversationUsage([])).toEqual({
      measuredCalls: 0,
      missingUsageCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reasoningUsageCalls: 0,
      routes: [],
    })
  })

  it('attributes completed calls across request header changes and records matching context metadata', () => {
    const result = foldConversationUsage([
      header('deepseek', 'deepseek-chat'),
      context('deepseek', 'deepseek-chat', 64_000),
      assistant(1, 1, 'deepseek', 'deepseek-chat', { inputTokens: 10, outputTokens: 4 }),
      header('openai', 'gpt-5', 'change'),
      context('openai', 'gpt-5', 400_000),
      assistant(2, 1, 'openai', 'gpt-5', { inputTokens: 20, outputTokens: 8 }),
    ])

    expect(result.routes).toEqual([
      {
        provider: 'deepseek',
        model: 'deepseek-chat',
        contextWindow: 64_000,
        measuredCalls: 1,
        missingUsageCalls: 0,
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        reasoningUsageCalls: 0,
      },
      {
        provider: 'openai',
        model: 'gpt-5',
        contextWindow: 400_000,
        measuredCalls: 1,
        missingUsageCalls: 0,
        inputTokens: 20,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        reasoningUsageCalls: 0,
      },
    ])
  })

  it('counts cache and reasoning buckets without adding reasoning to output twice', () => {
    const result = foldConversationUsage([
      header('openai', 'gpt-5'),
      assistant(1, 1, 'openai', 'gpt-5', {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 13,
        cacheWriteTokens: 3,
        reasoningTokens: 5,
      }),
    ])

    expect(result).toMatchObject({
      measuredCalls: 1,
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 13,
      cacheWriteTokens: 3,
      reasoningTokens: 5,
      reasoningUsageCalls: 1,
    })
  })

  it('ignores streamed usage chunks and counts the final assistant usage once', () => {
    const result = foldConversationUsage([
      header('deepseek', 'deepseek-reasoner'),
      usageChunk(1, 1, { inputTokens: 9, outputTokens: 1 }),
      usageChunk(1, 1, { inputTokens: 9, outputTokens: 3 }),
      assistant(1, 1, 'deepseek', 'deepseek-reasoner', { inputTokens: 9, outputTokens: 4 }),
    ])

    expect(result).toMatchObject({ measuredCalls: 1, inputTokens: 9, outputTokens: 4 })
  })

  it('replaces a repeated final for the same turn and step instead of double counting it', () => {
    const result = foldConversationUsage([
      header('deepseek', 'deepseek-chat'),
      assistant(1, 1, 'deepseek', 'deepseek-chat', { inputTokens: 8, outputTokens: 2 }),
      assistant(1, 1, 'deepseek', 'deepseek-chat', { inputTokens: 8, outputTokens: 3 }),
    ])

    expect(result).toMatchObject({ measuredCalls: 1, inputTokens: 8, outputTokens: 3 })
  })

  it('tracks a finalized assistant message with missing usage without estimating tokens', () => {
    const result = foldConversationUsage([
      header('custom', 'opaque-model'),
      assistant(1, 1, 'custom', 'opaque-model'),
    ])

    expect(result).toMatchObject({
      measuredCalls: 0,
      missingUsageCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
    })
  })

  it('does not count failed retry chunks and attributes only the durable final response', () => {
    const result = foldConversationUsage([
      header('deepseek', 'deepseek-chat'),
      usageChunk(1, 1, { inputTokens: 100, outputTokens: 20 }),
      usageChunk(1, 1, { inputTokens: 100, outputTokens: 2 }),
      assistant(1, 1, 'deepseek', 'deepseek-chat', { inputTokens: 12, outputTokens: 5 }),
    ])

    expect(result).toMatchObject({ measuredCalls: 1, inputTokens: 12, outputTokens: 5 })
  })

  it('is deterministic on replay and includes inherited prefix usage in a fork projection', () => {
    const parent = [
      header('deepseek', 'deepseek-chat'),
      assistant(1, 1, 'deepseek', 'deepseek-chat', { inputTokens: 10, outputTokens: 2 }),
    ]
    const replayed = parent.map(item => structuredClone(item))
    expect(foldConversationUsage(replayed)).toEqual(foldConversationUsage(parent))

    const child = [
      ...replayed,
      header('openai', 'gpt-5', 'resume'),
      assistant(2, 1, 'openai', 'gpt-5', { inputTokens: 20, outputTokens: 6 }),
    ]
    expect(foldConversationUsage(child)).toMatchObject({
      measuredCalls: 2,
      inputTokens: 30,
      outputTokens: 8,
    })
  })

  it('does not project prompt, response, tool, system, or credential material', () => {
    const sensitive = 'sk-secret-private-material'
    const events: ConversationUsageEvent[] = [
      event('request/header', {
        header: {
          config: { provider: 'deepseek', model: 'deepseek-chat' },
          system: `private prompt ${sensitive}`,
          tools: [{ name: 'private-tool', description: sensitive }],
        },
        reason: 'initial',
      }),
      assistant(1, 1, 'deepseek', 'deepseek-chat', { inputTokens: 1, outputTokens: 1 }),
    ]

    expect(JSON.stringify(foldConversationUsage(events))).not.toContain(sensitive)
    expect(JSON.stringify(foldConversationUsage(events))).not.toContain('private response')
    expect(JSON.stringify(foldConversationUsage(events))).not.toContain('private-tool')
  })

  it('preserves state identity for irrelevant chunks and repeated route metadata', () => {
    const initial = createConversationUsageState()
    const withHeader = applyConversationUsageEvent(initial, header('deepseek', 'deepseek-chat'))
    expect(applyConversationUsageEvent(withHeader, header('deepseek', 'deepseek-chat', 'resume')))
      .toBe(withHeader)

    const withContext = applyConversationUsageEvent(
      withHeader,
      context('deepseek', 'deepseek-chat'),
    )
    expect(applyConversationUsageEvent(
      withContext,
      context('deepseek', 'deepseek-chat'),
    )).toBe(withContext)
    const withKnownContext = applyConversationUsageEvent(
      withContext,
      context('deepseek', 'deepseek-chat', 64_000),
    )
    expect(foldConversationUsage([
      header('deepseek', 'deepseek-chat'),
      context('deepseek', 'deepseek-chat', 64_000),
      context('deepseek', 'deepseek-chat'),
      assistant(1, 1, 'deepseek', 'deepseek-chat', { inputTokens: 1, outputTokens: 1 }),
    ]).routes[0]).not.toHaveProperty('contextWindow')
    expect(withKnownContext).not.toBe(withContext)
    expect(applyConversationUsageEvent(
      withContext,
      usageChunk(1, 1, { inputTokens: 1, outputTokens: 1 }),
    )).toBe(withContext)
  })

  it('uses the current request header only when a non-model assistant source lacks route fields', () => {
    const result = foldConversationUsage([
      header('fallback-provider', 'fallback-model'),
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [], source: { kind: 'import' } },
        usage: { inputTokens: 3, outputTokens: 2 },
      }),
    ])
    expect(result.routes[0]).toMatchObject({
      provider: 'fallback-provider',
      model: 'fallback-model',
    })
  })

  it('ignores a finalized call whose route cannot be identified', () => {
    expect(foldConversationUsage([
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [], source: { kind: 'import' } },
        usage: { inputTokens: 3, outputTokens: 2 },
      }),
    ])).toMatchObject({ measuredCalls: 0, missingUsageCalls: 0, routes: [] })
  })

  it('rejects negative, fractional, and unsafe provider token counts', () => {
    for (const usage of [
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 0, outputTokens: 1.5 },
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: -1 },
      { inputTokens: 0, outputTokens: 0, cacheWriteTokens: -1 },
      { inputTokens: 0, outputTokens: 0, reasoningTokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => foldConversationUsage([
        header('deepseek', 'deepseek-chat'),
        assistant(1, 1, 'deepseek', 'deepseek-chat', usage),
      ])).toThrow('must be a non-negative safe integer')
    }
  })

  it('keeps an identical repeated final as the same fold state and replaces route changes', () => {
    const first = assistant(1, 1, 'deepseek', 'deepseek-chat', { inputTokens: 2, outputTokens: 1 })
    const state = applyConversationUsageEvent(createConversationUsageState(), first)
    expect(applyConversationUsageEvent(state, structuredClone(first))).toBe(state)

    const changed = assistant(1, 1, 'openai', 'gpt-5', { inputTokens: 2, outputTokens: 1 })
    expect(foldConversationUsage([first, changed]).routes).toEqual([
      expect.objectContaining({ provider: 'openai', model: 'gpt-5' }),
    ])
  })

  it('accumulates multiple calls for one route and sorts same-provider models', () => {
    const result = foldConversationUsage([
      header('openai', 'z-model'),
      context('openai', 'z-model'),
      assistant(1, 1, 'openai', 'z-model', { inputTokens: 2, outputTokens: 1 }),
      assistant(2, 1, 'openai', 'z-model', { inputTokens: 3, outputTokens: 2 }),
      header('openai', 'a-model', 'change'),
      assistant(3, 1, 'openai', 'a-model', { inputTokens: 5, outputTokens: 4 }),
    ])
    expect(result.routes.map(route => route.model)).toEqual(['a-model', 'z-model'])
    expect(result.routes[1]).toMatchObject({ measuredCalls: 2, inputTokens: 5, outputTokens: 3 })
  })

  it('preserves state identity for an identical missing-usage final', () => {
    const missing = assistant(1, 1, 'custom', 'model')
    const state = applyConversationUsageEvent(createConversationUsageState(), missing)
    expect(applyConversationUsageEvent(state, structuredClone(missing))).toBe(state)
  })
})
