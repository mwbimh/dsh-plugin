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

function appendMeasuredTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
    reason: 'initial',
  })
  session.append('request/context', {
    provider: 'deepseek',
    model: 'deepseek-chat',
    contextWindow: 64_000,
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'private response' }],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    }),
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
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

  it('exports the function-plugin namespace without a default export', () => {
    expect('default' in UsageAnalyticsPlugin).toBe(false)
  })
})
