/** Package-owned invariant companion for `@dsh-plugins/dsh-quota`. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-plugins/dsh-quota'

export const name = 'dsh-quota-invariant'
export const inject = ['invariants']

/** Cache state is private and no authoritative public event projection exists yet. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
