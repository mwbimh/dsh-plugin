import type {
  OAuthAccount,
  OAuthAccountId,
  OAuthCredentialRef,
} from './public.ts'

export type {
  ManagedOAuthService,
  OAuthAccount,
  OAuthAccountCredentialRef,
  OAuthAccountId,
  OAuthAccountService,
  OAuthAccountStatus,
  OAuthCredentialRef,
  OAuthLoginOptions,
  OAuthProviderInfo,
  OAuthRuntimeComposition,
  OAuthService,
} from './public.ts'

/** Stable public OAuth failure categories. */
export type OAuthErrorCode =
  | 'configuration'
  | 'unsupported-flow'
  | 'login-cancelled'
  | 'callback-invalid'
  | 'consent-denied'
  | 'token-exchange'
  | 'refresh-temporary'
  | 'reauth-required'
  | 'scope-mismatch'
  | 'storage-unavailable'
  | 'route-conflict'
  | 'rate-limit'
  | 'internal'

/** Sensitive provider and storage value that must never cross the public service. */
export interface OAuthCredential {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly provider: string
  readonly subject?: string
  readonly displayName?: string
  readonly scopes: readonly string[]
  readonly audience: string
  readonly issuer: string
  readonly route: string
}

/** Stored account and its sensitive structured credential. */
export interface StoredOAuthAccount {
  readonly account: OAuthAccount
  readonly credential: OAuthCredential
  readonly credentialRef: OAuthCredentialRef
}

/** Provider operation options. */
export interface OAuthProviderOperationOptions {
  readonly signal: AbortSignal
}

/** OAuth provider implementation with fixed authorization requirements. */
export interface OAuthProvider {
  readonly id: string
  readonly route: string
  readonly credentialRef: OAuthCredentialRef
  readonly issuer: string
  readonly audience: string
  readonly scopes: readonly string[]
  /** Begin provider authorization and return a private structured credential. */
  login(options: OAuthProviderOperationOptions): Promise<OAuthCredential>
  /** Rotate a private structured credential. */
  refresh(credential: OAuthCredential, options: OAuthProviderOperationOptions): Promise<OAuthCredential>
  /** Revoke a provider credential when supported. */
  revoke?(credential: OAuthCredential, options: OAuthProviderOperationOptions): Promise<void>
}

/** Atomic storage seam for sensitive OAuth records. */
export interface OAuthCredentialStore {
  /** List all stored records. */
  list(signal?: AbortSignal): Promise<readonly StoredOAuthAccount[]>
  /** Read one stored record. */
  get(accountId: OAuthAccountId, signal?: AbortSignal): Promise<StoredOAuthAccount | undefined>
  /** Atomically replace one stored record. */
  put(record: StoredOAuthAccount): Promise<void>
  /** Delete one stored record. */
  delete(accountId: OAuthAccountId): Promise<void>
}

/** DSH credential bridge publisher for short-lived access tokens. */
export interface OAuthCredentialPublisher {
  /** Publish a short-lived access token under a DSH credential reference. */
  publish(credentialRef: OAuthCredentialRef, accessToken: string): Promise<void>
  /** Remove a published access token. */
  clear(credentialRef: OAuthCredentialRef): Promise<void>
}

/** OAuth service construction dependencies and policies. */
export interface OAuthServiceOptions {
  readonly providers: readonly OAuthProvider[]
  readonly store: OAuthCredentialStore
  readonly publisher: OAuthCredentialPublisher
  readonly refreshWindowMs: number
  readonly now?: () => number
  readonly createAccountId?: () => OAuthAccountId
  /** Optional explicit managed-route selection for providers with multiple accounts. */
  readonly routeBindings?: Readonly<Record<string, OAuthAccountId>>
}
