import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { QuotaError } from './errors.ts'
import type { QuotaProvider } from './model.ts'
import type { TokenFreeOAuthAccountService } from './oauth.ts'
import { QuotaServiceImpl } from './service.ts'

export type { TokenFreeOAuthAccountService } from './oauth.ts'

export interface QuotaPluginConfig {
  readonly cacheTtlMs?: number
  readonly timeoutMs?: number
  readonly maxConcurrency?: number
}

export const QuotaPluginConfig: z<QuotaPluginConfig> = z.object({
  cacheTtlMs: z.number().min(0).default(60_000),
  timeoutMs: z.number().min(1).default(10_000),
  maxConcurrency: z.number().min(1).default(4),
})

export interface ResolvedQuotaPluginConfig {
  readonly cacheTtlMs: number
  readonly timeoutMs: number
  readonly maxConcurrency: number
}

export interface QuotaPluginDependencies {
  providers(ctx: Context, config: ResolvedQuotaPluginConfig): readonly QuotaProvider[]
}

export interface QuotaPluginModule {
  readonly name: 'dsh-quota'
  readonly inject: readonly []
  readonly Config: z<QuotaPluginConfig>
  apply(ctx: Context, config: QuotaPluginConfig): void
}

function resolveConfig(config: QuotaPluginConfig): ResolvedQuotaPluginConfig {
  const resolved = {
    cacheTtlMs: config.cacheTtlMs ?? 60_000,
    timeoutMs: config.timeoutMs ?? 10_000,
    maxConcurrency: config.maxConcurrency ?? 4,
  }
  if (!Number.isSafeInteger(resolved.cacheTtlMs) || resolved.cacheTtlMs < 0
    || !Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs < 1
    || !Number.isSafeInteger(resolved.maxConcurrency) || resolved.maxConcurrency < 1) {
    throw new QuotaError({ code: 'configuration' })
  }
  return resolved
}

/** Create a Loader-compatible plugin with a provider composition seam. */
export function createQuotaPlugin(dependencies?: QuotaPluginDependencies): QuotaPluginModule {
  return {
    name: 'dsh-quota',
    inject: [],
    Config: QuotaPluginConfig,
    apply(ctx, config): void {
      const resolved = resolveConfig(config)
      const providers = dependencies?.providers(ctx, resolved) ?? []
      const service = new QuotaServiceImpl({
        providers,
        ...resolved,
        getOAuthService: () => ctx.get('dsh-oauth') as TokenFreeOAuthAccountService | undefined,
      })
      ctx.effect(() => async () => service.dispose())
      ctx.provide('dsh-quota', service)
    },
  }
}
