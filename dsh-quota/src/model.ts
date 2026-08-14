import { QuotaError } from './errors.ts'

/** Units that providers may safely normalize without guessing. */
export type QuotaUnit = 'tokens' | 'requests' | 'credits' | 'currency' | 'percent' | 'unknown'

/** Stable account identity within one provider. */
export interface QuotaAccountRef {
  readonly id: string
  readonly provider: string
}

/** Public token-free account metadata. */
export interface QuotaAccount extends QuotaAccountRef {
  readonly displayName?: string
  readonly plan?: string
}

/** One provider-native quota window. */
export interface QuotaWindow {
  readonly id: string
  readonly used?: number
  readonly remaining?: number
  readonly limit?: number
  readonly unit: QuotaUnit
  /** Unix epoch timestamp in milliseconds. */
  readonly resetAt?: number
}

/** Successful provider observation. */
export interface QuotaSnapshot {
  readonly accountId: string
  readonly provider: string
  /** Unix epoch timestamp in milliseconds, captured by the provider. */
  readonly observedAt: number
  readonly windows: readonly QuotaWindow[]
}

/** Provider-controlled bounded retry policy. */
export interface QuotaRetryPolicy {
  /** Total provider attempts, including the first request. */
  readonly maxAttempts: number
  /** Delay used when a retryable failure has no Retry-After value. */
  readonly baseDelayMs: number
}

/** Provider seam. Credential references are opaque names, never tokens. */
export interface QuotaProvider {
  readonly id: string
  readonly usesOAuth?: boolean
  readonly retryPolicy?: QuotaRetryPolicy
  discoverAccounts(): Promise<readonly QuotaAccount[]>
  getQuota(account: QuotaAccountRef, signal?: AbortSignal, credentialRef?: string): Promise<QuotaSnapshot>
}

const units = new Set<QuotaUnit>(['tokens', 'requests', 'credits', 'currency', 'percent', 'unknown'])

function invalid(provider?: string, accountId?: string): never {
  throw new QuotaError({
    code: 'provider-response',
    ...(provider === undefined ? {} : { provider }),
    ...(accountId === undefined ? {} : { accountId }),
  })
}

function validText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 256
    && !hasControlCharacter(value)
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validQuotaValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Validate public account metadata without coercing unknown values. */
export function validateAccount(value: QuotaAccount): QuotaAccount {
  if (!validText(value.id) || !validText(value.provider)) invalid(value.provider, value.id)
  if (value.displayName !== undefined && !validText(value.displayName)) invalid(value.provider, value.id)
  if (value.plan !== undefined && !validText(value.plan)) invalid(value.provider, value.id)
  return value
}

/** Validate snapshot identity, millisecond timestamps, units, and numeric invariants. */
export function validateSnapshot(value: QuotaSnapshot, account: QuotaAccountRef): QuotaSnapshot {
  if (value.accountId !== account.id || value.provider !== account.provider || !validTimestamp(value.observedAt)) {
    invalid(account.provider, account.id)
  }
  if (!Array.isArray(value.windows)) invalid(account.provider, account.id)
  const windows = value.windows as readonly QuotaWindow[]
  const ids = new Set<string>()
  for (const window of windows) {
    if (!validText(window.id) || ids.has(window.id) || !units.has(window.unit)) invalid(account.provider, account.id)
    ids.add(window.id)
    for (const numeric of [window.used, window.remaining, window.limit]) {
      if (numeric !== undefined && !validQuotaValue(numeric)) invalid(account.provider, account.id)
    }
    if (window.limit !== undefined && (
      (window.used !== undefined && window.used > window.limit)
      || (window.remaining !== undefined && window.remaining > window.limit)
      || (window.used !== undefined && window.remaining !== undefined && window.used + window.remaining > window.limit)
    )) invalid(account.provider, account.id)
    if (window.resetAt !== undefined && !validTimestamp(window.resetAt)) invalid(account.provider, account.id)
  }
  return value
}
