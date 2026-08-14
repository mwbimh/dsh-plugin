/** Provider-neutral quota snapshot service. */
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { createQuotaPlugin as createInternalQuotaPlugin } from './plugin.ts'
import type { QuotaProvider, QuotaService } from './public.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Namespaced provider-neutral quota service. */
    'dsh-quota': QuotaService
  }
}

export interface Config {
  readonly cacheTtlMs?: number
  readonly timeoutMs?: number
  readonly maxConcurrency?: number
}

/** Fully validated non-secret policy passed to programmatic provider composition. */
export interface ResolvedQuotaPluginConfig {
  readonly cacheTtlMs: number
  readonly timeoutMs: number
  readonly maxConcurrency: number
}

/** Public host-owned provider composition seam; provider secrets never enter Loader config. */
export interface QuotaPluginDependencies {
  providers(ctx: Context, config: ResolvedQuotaPluginConfig): readonly QuotaProvider[]
}

/** Loader-compatible module returned by the public composition factory. */
export interface QuotaPluginModule {
  readonly name: 'dsh-quota'
  readonly inject: readonly []
  readonly Config: z<Config>
  apply(ctx: Context, config: Config): void
}

const plugin = createInternalQuotaPlugin()

export const name = plugin.name
export const inject = plugin.inject
export const Config: z<Config> = plugin.Config

/** Compose providers programmatically while keeping credentials and endpoints out of YAML. */
export function createQuotaPlugin(dependencies?: QuotaPluginDependencies): QuotaPluginModule {
  return createInternalQuotaPlugin(dependencies)
}

export function apply(ctx: Context, config: Config): void {
  plugin.apply(ctx, config)
}
