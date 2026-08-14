/** Session-projection definition for durable conversation usage. */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  applyConversationUsageEvent,
  createConversationUsageState,
  viewConversationUsage,
  type ConversationUsageEvent,
  type ConversationUsageProjection,
  type ConversationUsageState,
} from './conversation-usage-projection.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Durable final-message conversation usage for one complete session log. */
    dshUsageAnalytics: ConversationUsageProjection
  }
}

const totalsSchema = {
  measuredCalls: z.number().int().nonnegative(),
  missingUsageCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  reasoningUsageCalls: z.number().int().nonnegative(),
} as const

const routeSchema = z.object({
  provider: z.string(),
  model: z.string(),
  contextWindow: z.number().int().positive().optional(),
  ...totalsSchema,
}).strict()

const projectionSchema = z.object({
  ...totalsSchema,
  routes: z.array(routeSchema),
}).strict() as z.ZodType<ConversationUsageProjection>

/** Pure unit registered with `ctx.sessionProjections`. */
export const conversationUsageProjectionDefinition:
ProjectionDefinition<'dshUsageAnalytics', ConversationUsageState> = {
  key: 'dshUsageAnalytics',
  schema: projectionSchema,
  init: createConversationUsageState,
  apply: (state, event: SessionEvent) => {
    switch (event.type) {
      case 'request/header':
      case 'request/context':
      case 'assistant/chunk':
      case 'assistant/message':
        return applyConversationUsageEvent(state, event as ConversationUsageEvent)
      default:
        return state
    }
  },
  view: viewConversationUsage,
  stateVersion: 1,
}
