import type { QuotaAccountRef } from './model.ts'

/** Stable public failure categories. */
export type QuotaErrorCode =
  | 'configuration'
  | 'authentication'
  | 'authorization'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'provider-response'
  | 'cancelled'
  | 'oauth-service-unavailable'
  | 'oauth-service-incompatible'
  | 'oauth-account-not-found'
  | 'oauth-account-unavailable'
  | 'internal'

const messages: Readonly<Record<QuotaErrorCode, string>> = {
  configuration: 'dsh-quota: configuration is invalid',
  authentication: 'dsh-quota: provider authentication failed',
  authorization: 'dsh-quota: provider authorization failed',
  'rate-limit': 'dsh-quota: provider rate limit reached',
  timeout: 'dsh-quota: provider request timed out',
  network: 'dsh-quota: provider network request failed',
  'provider-response': 'dsh-quota: provider response is invalid',
  cancelled: 'dsh-quota: quota request was cancelled',
  'oauth-service-unavailable': 'dsh-quota: OAuth account service is unavailable',
  'oauth-service-incompatible': 'dsh-quota: OAuth account service is incompatible',
  'oauth-account-not-found': 'dsh-quota: OAuth account identity does not match',
  'oauth-account-unavailable': 'dsh-quota: OAuth account reference is unavailable',
  internal: 'dsh-quota: internal lifecycle failure',
}

export interface QuotaErrorOptions {
  readonly code: QuotaErrorCode
  readonly provider?: string
  readonly accountId?: string
  readonly retryable?: boolean
  readonly retryAfterMs?: number
}

export interface QuotaErrorJson {
  readonly name: 'QuotaError'
  readonly message: string
  readonly code: QuotaErrorCode
  readonly provider?: string
  readonly accountId?: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Stable error that never stores a provider cause or unknown error message. */
export class QuotaError extends Error {
  readonly code: QuotaErrorCode
  readonly provider: string | undefined
  readonly accountId: string | undefined
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined

  constructor(options: QuotaErrorOptions) {
    super(messages[options.code])
    this.name = 'QuotaError'
    this.code = options.code
    this.provider = safeIdentifier(options.provider)
    this.accountId = safeIdentifier(options.accountId)
    this.retryable = options.retryable ?? false
    this.retryAfterMs = normalizeRetryAfter(options.retryAfterMs)
  }

  toJSON(): QuotaErrorJson {
    return {
      name: 'QuotaError',
      message: this.message,
      code: this.code,
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      ...(this.accountId === undefined ? {} : { accountId: this.accountId }),
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    }
  }
}

function safeIdentifier(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= 256 && !hasControlCharacter(value)
    ? value
    : undefined
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}

function normalizeRetryAfter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.trunc(value), MAX_TIMER_DELAY_MS)
    : undefined
}

function retryAfter(error: object): number | undefined {
  if (!('retryAfterMs' in error)) return undefined
  return normalizeRetryAfter(error.retryAfterMs)
}

/** Classify provider-facing failures while discarding all unsafe source details. */
export function classifyProviderError(error: unknown, account: QuotaAccountRef): QuotaError {
  if (error instanceof QuotaError) return error
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new QuotaError({ code: 'cancelled', provider: account.provider, accountId: account.id })
  }
  if (typeof error === 'object' && error !== null && 'status' in error && error.status === 429) {
    const retryAfterMs = retryAfter(error)
    return new QuotaError({
      code: 'rate-limit',
      provider: account.provider,
      accountId: account.id,
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  }
  if (error instanceof TypeError) {
    return new QuotaError({ code: 'network', provider: account.provider, accountId: account.id, retryable: true })
  }
  return new QuotaError({ code: 'provider-response', provider: account.provider, accountId: account.id })
}
