/** Function plugin registering durable conversation usage analytics. */

import type { Context } from '@deepseek-ai/cordis'
import { conversationUsageProjectionDefinition } from './projection.ts'

export * from './conversation-usage-projection.ts'
export { conversationUsageProjectionDefinition } from './projection.ts'

/** Cordis plugin name. */
export const name = 'dsh-usage-analytics'

/** The projection registry owns all session cells and delivery. */
export const inject = ['sessionProjections']

/**
 * Register the usage unit on the plugin fiber.
 * @param ctx - Cordis context carrying the session-projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(conversationUsageProjectionDefinition)
}
