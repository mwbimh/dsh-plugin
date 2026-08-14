import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-invariants'

export const name = 'dsh-remote-compaction-invariant'
export const inject = ['invariants']

/** Register this package's intentionally empty invariant companion. */
export function apply(ctx: Context): () => Promise<void> {
  return ctx.effect(
    () => ctx.invariants.register(
      'dsh-remote-compaction',
      () => {
        // No runtime invariant: transport state has no authoritative event or mutable-data companion.
      },
    ),
    'dsh-remote-compaction.invariant',
  )
}
