import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as UsageAnalyticsPlugin from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

function appendMeasuredTurn(
  session: Session,
  turn = 1,
  provider = 'deepseek',
  model = 'deepseek-chat',
): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('request/header', {
    header: { config: { provider, model } },
    reason: 'initial',
  })
  session.append('request/context', {
    provider,
    model,
    contextWindow: 64_000,
  })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'private response' }],
      source: { kind: 'model', provider, model },
    }),
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('session projection service registration', () => {
  it('registers the durable usage projection and serves a complete logged turn', async () => {
    context = new Context()
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(UsageAnalyticsPlugin)

    const session = context.sessions.create(SessionId('usage-service'))
    appendMeasuredTurn(session)

    expect(context.sessionProjections.snapshot(session).values.dshUsageAnalytics).toEqual({
      measuredCalls: 1,
      missingUsageCalls: 0,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
      reasoningUsageCalls: 1,
      routes: [{
        provider: 'deepseek',
        model: 'deepseek-chat',
        contextWindow: 64_000,
        measuredCalls: 1,
        missingUsageCalls: 0,
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 7,
        cacheWriteTokens: 2,
        reasoningTokens: 3,
        reasoningUsageCalls: 1,
      }],
    })
  })

  it('removes the projection when the contributing fiber is disposed', async () => {
    context = new Context()
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    const fiber = await context.plugin(UsageAnalyticsPlugin)
    const session = context.sessions.create(SessionId('usage-disposal'))

    expect(context.sessionProjections.snapshot(session).values).toHaveProperty('dshUsageAnalytics')
    await fiber.dispose()
    expect(context.sessionProjections.snapshot(session).values).not.toHaveProperty('dshUsageAnalytics')
  })

  it('restores the bounded stateVersion 2 checkpoint and replays a real fork seed', async () => {
    context = new Context()
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(UsageAnalyticsPlugin)

    const parent = context.sessions.create(SessionId('usage-parent'))
    appendMeasuredTurn(parent)
    const checkpoint = context.sessionProjections.checkpoint(parent)
    const persistedCheckpoint = JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint
    expect(checkpoint.dshUsageAnalytics?.ver).toBe(2)
    expect(checkpoint.dshUsageAnalytics?.val).not.toHaveProperty('calls')
    expect(JSON.stringify(checkpoint.dshUsageAnalytics?.val).length).toBeLessThan(2_000)
    expect(context.sessionProjections.viewCheckpoint(checkpoint).dshUsageAnalytics)
      .toMatchObject({ measuredCalls: 1, inputTokens: 10, outputTokens: 4 })
    expect(context.sessionProjections.viewCheckpoint({
      dshUsageAnalytics: { ...checkpoint.dshUsageAnalytics!, ver: 1 },
    })).not.toHaveProperty('dshUsageAnalytics')

    const previousFinal = parent.events.find(event => event.type === 'assistant/message')
    if (previousFinal?.type !== 'assistant/message') throw new Error('missing assistant final')
    const replacement = {
      ...structuredClone(previousFinal),
      seq: parent.events.length,
      time: previousFinal.time + 1,
      data: {
        ...structuredClone(previousFinal.data),
        usage: { inputTokens: 20, outputTokens: 8 },
      },
    }
    expect(context.sessionProjections.restore(
      persistedCheckpoint,
      [replacement],
      replacement.seq,
    ).snapshot.values.dshUsageAnalytics).toMatchObject({
      measuredCalls: 1,
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reasoningUsageCalls: 0,
    })

    const child = context.sessions.fork(parent, undefined, SessionId('usage-child'))
    expect(context.sessionProjections.snapshot(child).values.dshUsageAnalytics)
      .toEqual(context.sessionProjections.snapshot(parent).values.dshUsageAnalytics)

    appendMeasuredTurn(child, 2, 'openai', 'gpt-5')
    expect(context.sessionProjections.snapshot(child).values.dshUsageAnalytics)
      .toMatchObject({ measuredCalls: 2, inputTokens: 20, outputTokens: 8 })
    expect(context.sessionProjections.snapshot(parent).values.dshUsageAnalytics)
      .toMatchObject({ measuredCalls: 1, inputTokens: 10, outputTokens: 4 })
  })

  it('exports the function-plugin namespace without a default export', () => {
    expect('default' in UsageAnalyticsPlugin).toBe(false)
  })
})
