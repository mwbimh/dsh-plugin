/** Units that providers may safely normalize without guessing. */
export type QuotaUnit = 'tokens' | 'requests' | 'credits' | 'currency' | 'percent' | 'unknown'

export interface QuotaAccountRef {
  readonly id: string
  readonly provider: string
}

export interface QuotaAccount extends QuotaAccountRef {
  readonly displayName?: string
  readonly plan?: string
}

export interface QuotaWindow {
  readonly id: string
  readonly used?: number
  readonly remaining?: number
  readonly limit?: number
  readonly unit: QuotaUnit
  readonly resetAt?: number
}

export interface QuotaSnapshot {
  readonly accountId: string
  readonly provider: string
  readonly observedAt: number
  readonly windows: readonly QuotaWindow[]
}

export interface QuotaRetryPolicy {
  readonly maxAttempts: number
  readonly baseDelayMs: number
}

export interface QuotaProvider {
  readonly id: string
  readonly usesOAuth?: boolean
  readonly retryPolicy?: QuotaRetryPolicy
  discoverAccounts(): Promise<readonly QuotaAccount[]>
  getQuota(account: QuotaAccountRef, signal?: AbortSignal, credentialRef?: string): Promise<QuotaSnapshot>
}

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

export interface QuotaErrorJson {
  readonly name: 'QuotaError'
  readonly message: string
  readonly code: QuotaErrorCode
  readonly provider?: string
  readonly accountId?: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
}

export interface QuotaSnapshotResult {
  readonly snapshot: QuotaSnapshot
  readonly stale: boolean
  readonly lastError?: QuotaErrorJson
}

export interface QuotaService {
  listAccounts(): Promise<readonly QuotaAccount[]>
  getSnapshot(account: QuotaAccountRef, signal?: AbortSignal): Promise<QuotaSnapshotResult>
  refresh(account: QuotaAccountRef, signal?: AbortSignal): Promise<QuotaSnapshotResult>
}
