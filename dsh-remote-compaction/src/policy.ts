import { RemoteCompactionError } from './errors.ts'

/** Configured target fields required by the direct OpenAI transport. */
export interface RemoteTargetConfig {
  readonly provider: string
  readonly model: string
  readonly baseURL: string
}

/** Exact target and cache identity used for one compact operation. */
export interface ResolvedRemoteTarget extends RemoteTargetConfig {
  readonly cacheKey: string
}

/** Provider/model pair available from configuration or one conversation route. */
export interface ProviderModelTarget {
  readonly provider: string
  readonly model: string
}

function complete(target: Partial<ProviderModelTarget> | undefined): target is ProviderModelTarget {
  return target?.provider !== undefined
    && target.provider.length > 0
    && target.model !== undefined
    && target.model.length > 0
}

/** Resolve the current durable route before process-local agent and config fallbacks. */
export function resolveConversationTarget(
  configured: ProviderModelTarget,
  durable: Partial<ProviderModelTarget> | undefined,
  agent: Partial<ProviderModelTarget> | undefined,
): ProviderModelTarget {
  if (complete(durable)) return durable
  if (complete(agent)) return agent
  return configured
}

/** Resolve and validate the only provider protocol supported by this plugin. */
export function resolveRemoteTarget(config: RemoteTargetConfig): ResolvedRemoteTarget {
  if (config.provider !== 'openai') {
    throw new RemoteCompactionError('unsupported', 'remote compaction requires the OpenAI provider')
  }
  if (config.model.length === 0) {
    throw new RemoteCompactionError('invalid-request', 'remote compaction model must not be empty')
  }
  let parsed: URL
  try {
    parsed = new URL(config.baseURL)
  } catch (cause: unknown) {
    throw new RemoteCompactionError('invalid-request', 'remote compaction baseURL is invalid', { cause })
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new RemoteCompactionError('invalid-request', 'remote compaction baseURL must use HTTPS')
  }
  const baseURL = config.baseURL.replace(/\/+$/, '')
  return {
    provider: config.provider,
    model: config.model,
    baseURL,
    cacheKey: `${config.provider}\n${config.model}\n${baseURL}`,
  }
}

/** Remote engine operating mode. */
export type RemoteCompactionMode = 'auto' | 'remote-only' | 'disabled'

const FALLBACK_CODES = new Set([
  'unsupported',
  'temporarily-unavailable',
  'transport',
  'timeout',
  'incompatible-input',
  'incompatible-response',
])

/** Apply fallback policy without swallowing trust, validation, or caller errors. */
export async function decideRemoteOutcome<T>(
  mode: RemoteCompactionMode,
  error: unknown,
  fallback: () => Promise<T>,
): Promise<T> {
  if (mode === 'auto'
    && error instanceof RemoteCompactionError
    && FALLBACK_CODES.has(error.code)) return fallback()
  throw error
}
