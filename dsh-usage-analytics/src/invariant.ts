/** Package-owned invariant companion for `dsh-usage-analytics`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-usage-analytics'

/** Cordis companion plugin name. */
export const name = 'dsh-usage-analytics-invariant'

/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns a pure projection whose public value
 * is schema-validated by the projection registry. Session lifecycle and event
 * ordering invariants belong to the DSH session and agent-loop packages.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the registration disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
