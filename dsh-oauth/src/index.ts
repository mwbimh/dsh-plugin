/** OAuth account lifecycle service, DSH credential bridge, and commands. */
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { createOAuthPlugin } from './bridge.ts'
import type { OAuthService } from './public.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Token-free OAuth account and credential lifecycle service. */
    'dsh-oauth': OAuthService
  }
}

/** Non-secret OAuth refresh policy configuration. */
export interface Config {
  /** Refresh tokens this many milliseconds before access expiry. */
  refreshWindowMs?: number
}

const plugin = createOAuthPlugin()

/** Canonical plugin name and public service namespace. */
export const name = plugin.name

/** Required DSH services. */
export const inject = plugin.inject

/** Loader configuration schema. */
export const Config: z<Config> = plugin.Config

/**
 * Load the package without a host-owned provider composition.
 *
 * The published root deliberately fails loud until an allowed provider,
 * secure store, and credential publisher are composed by the host. It never
 * guesses endpoints or storage from Loader input.
 *
 * @param ctx - Owning plugin context.
 * @param config - Non-secret refresh policy.
 */
export function apply(ctx: Context, config: Config): void {
  plugin.apply(ctx, config)
}
