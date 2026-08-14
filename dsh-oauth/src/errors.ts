import type { OAuthAccountId, OAuthErrorCode } from './types.ts'

const messages: Readonly<Record<OAuthErrorCode, string>> = {
  configuration: 'dsh-oauth: configuration is invalid',
  'unsupported-flow': 'dsh-oauth: login flow is unsupported',
  'login-cancelled': 'dsh-oauth: login was cancelled',
  'callback-invalid': 'dsh-oauth: login callback is invalid',
  'consent-denied': 'dsh-oauth: authorization consent was denied',
  'token-exchange': 'dsh-oauth: token exchange failed',
  'refresh-temporary': 'dsh-oauth: token refresh temporarily failed',
  'reauth-required': 'dsh-oauth: reauthentication is required',
  'scope-mismatch': 'dsh-oauth: required authorization scope is missing',
  'storage-unavailable': 'dsh-oauth: credential storage is unavailable',
  'route-conflict': 'dsh-oauth: route authorization does not match',
  'rate-limit': 'dsh-oauth: provider rate limit reached',
  internal: 'dsh-oauth: internal lifecycle failure',
}

/** Safe public fields used to construct a stable OAuth error. */
export interface OAuthErrorOptions {
  readonly code: OAuthErrorCode
  readonly provider?: string
  readonly accountId?: OAuthAccountId
  readonly retryable?: boolean
  readonly retryAfterMs?: number
}

/** Safe serialized OAuth error fields. */
export interface OAuthErrorJson {
  readonly name: string
  readonly message: string
  readonly code: OAuthErrorCode
  readonly provider?: string
  readonly accountId?: OAuthAccountId
  readonly retryable: boolean
  readonly retryAfterMs?: number
}

/** Stable OAuth error that never retains an unknown provider message or cause. */
export class OAuthError extends Error {
  readonly code: OAuthErrorCode
  readonly provider: string | undefined
  readonly accountId: OAuthAccountId | undefined
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined

  /** Create an error from safe classified fields only. */
  constructor(options: OAuthErrorOptions) {
    super(messages[options.code])
    this.name = 'OAuthError'
    this.code = options.code
    this.provider = options.provider
    this.accountId = options.accountId
    this.retryable = options.retryable ?? false
    this.retryAfterMs = options.retryAfterMs
  }

  /** Return the safe JSON representation used by commands and diagnostics. */
  toJSON(): OAuthErrorJson {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      ...(this.accountId === undefined ? {} : { accountId: this.accountId }),
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    }
  }
}

/** Replace an unknown failure with a classified error without retaining unsafe text. */
export function normalizeOAuthError(error: unknown, options: OAuthErrorOptions): OAuthError {
  if (error instanceof OAuthError) return error
  return new OAuthError(options)
}
