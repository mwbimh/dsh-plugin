/** Provider-neutral quota snapshot service. */
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { createQuotaPlugin } from './plugin.ts'
import type { QuotaService } from './public.ts'

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

const plugin = createQuotaPlugin()

export const name = plugin.name
export const inject = plugin.inject
export const Config: z<Config> = plugin.Config

export function apply(ctx: Context, config: Config): void {
  plugin.apply(ctx, config)
}
