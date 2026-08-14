/**
 * Package-owned invariant companion for `@dsh-plugins/dsh-oauth`.
 * @module @dsh-plugins/dsh-oauth/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-plugins/dsh-oauth'

/** Cordis companion plugin name. */
export const name = 'dsh-oauth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: refresh state is private and credential mutation validity is owned by the
 * DSH credentials seam; this package exposes no authoritative event stream or readable projection.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
