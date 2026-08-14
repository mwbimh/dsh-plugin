/** Request-time bridge from managed OAuth routes to the DSH LLM waterfall. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { installOAuthCommands, type OAuthCommandRegistry } from './commands.ts'
import { OAuthError } from './errors.ts'
import type { OAuthService } from './types.ts'

/** Non-secret OAuth refresh policy configuration. */
export interface OAuthPluginConfig {
  /** Refresh tokens this many milliseconds before access expiry. */
  refreshWindowMs?: number
}

/** Runtime schema for the non-secret OAuth policy. */
export const OAuthPluginConfig: z<OAuthPluginConfig> = z.object({
  refreshWindowMs: z.number().min(0).default(30_000),
})

/** Runtime-only composition seam for provider, secure store, and publisher dependencies. */
export interface OAuthPluginDependencies {
  /** Construct the OAuth service for one plugin fiber. */
  createService(ctx: Context, config: Required<OAuthPluginConfig>): ManagedOAuthService
}

/** Plugin-owned service lifecycle in addition to the token-free public API. */
export interface ManagedOAuthService extends OAuthService {
  /** Abort and drain all owned OAuth work. */
  dispose(): Promise<void>
}

/** Loader-compatible function-plugin namespace returned by the runtime factory. */
export interface OAuthPluginModule {
  readonly name: 'dsh-oauth'
  readonly inject: readonly ['llm', 'credentials', 'commands']
  readonly Config: z<OAuthPluginConfig>
  apply(ctx: Context, config: OAuthPluginConfig): void
}

/** Resolve programmatic calls through the same default as Schemastery. */
function resolveConfig(config: OAuthPluginConfig): Required<OAuthPluginConfig> {
  return { refreshWindowMs: config.refreshWindowMs ?? 30_000 }
}

/**
 * Install one request-time credential bridge.
 *
 * The OAuth service owns account selection, refresh single-flight, rotation,
 * and credential publication. The listener only waits for that work before
 * delegating the same request to the existing adapter.
 *
 * @param ctx - Plugin context that owns the listener and cancellation signal.
 * @param service - OAuth lifecycle service used to classify and refresh routes.
 */
export function installCredentialBridge(ctx: Context, service: OAuthService): void {
  const controller = new AbortController()
  const managedRoutes = new Set(service.providers().map(provider => provider.route))

  ctx.effect(() => () => {
    controller.abort('dsh-oauth bridge disposed')
  })

  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (!managedRoutes.has(options.provider)) return next()
    return (async function* () {
      await service.ensureFreshForRoute(options.provider, { signal: controller.signal })
      yield* next()
    })()
  })
}

/**
 * Create a function-plugin namespace around explicit runtime dependencies.
 *
 * This source-level factory is intentionally not exported from the package
 * root. Provider endpoints, secure storage, and credential publication stay
 * host-owned runtime code rather than Loader configuration.
 *
 * @param dependencies - Host-owned service factory; omission creates a plugin that fails loud at load.
 * @returns Loader-compatible named function-plugin exports.
 */
export function createOAuthPlugin(dependencies?: OAuthPluginDependencies): OAuthPluginModule {
  return {
    name: 'dsh-oauth',
    inject: ['llm', 'credentials', 'commands'],
    Config: OAuthPluginConfig,
    apply(ctx, config): void {
      if (dependencies === undefined) throw new OAuthError({ code: 'configuration' })
      const service = dependencies.createService(ctx, resolveConfig(config))

      ctx.effect(() => async () => {
        await service.dispose()
      })
      ctx.provide('dsh-oauth', service)
      installCredentialBridge(ctx, service)

      const commands = ctx.get('commands') as OAuthCommandRegistry | undefined
      if (commands === undefined) throw new OAuthError({ code: 'configuration' })
      const disposeCommand = installOAuthCommands(commands, service)
      ctx.effect(() => disposeCommand)
    },
  }
}
