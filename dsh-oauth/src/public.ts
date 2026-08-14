/** Stable local OAuth account identifier. */
export type OAuthAccountId = string & { readonly __oauthAccountId: unique symbol }

/** DSH credential reference that contains a short-lived access token. */
export type OAuthCredentialRef = string & { readonly __oauthCredentialRef: unique symbol }

/** Public account lifecycle state. */
export type OAuthAccountStatus = 'ready' | 'refreshing' | 'reauth-required' | 'revoked' | 'error'

/** Token-free account metadata exposed to commands and optional consumers. */
export interface OAuthAccount {
  readonly id: OAuthAccountId
  readonly provider: string
  readonly displayName?: string
  readonly subject?: string
  readonly scopes: readonly string[]
  readonly status: OAuthAccountStatus
  readonly expiresAt?: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Token-free provider metadata exposed by the public service. */
export interface OAuthProviderInfo {
  readonly id: string
  readonly route: string
  readonly credentialRef: OAuthCredentialRef
  readonly issuer: string
  readonly audience: string
  readonly scopes: readonly string[]
}

/** Public operation options for cancellation. */
export interface OAuthLoginOptions {
  readonly signal?: AbortSignal
}

/** Token-free account and credential-reference lookup result. */
export interface OAuthAccountCredentialRef {
  readonly account: OAuthAccount
  readonly credentialRef: OAuthCredentialRef
}

/** Optional account lookup service consumed without a hard plugin dependency. */
export interface OAuthAccountService {
  /** Return token-free account metadata, optionally filtered by provider. */
  accounts(provider?: string): Promise<readonly OAuthAccount[]>
  /** Resolve token-free account metadata and its DSH credential reference. */
  accountCredential(accountId: OAuthAccountId): Promise<OAuthAccountCredentialRef>
}

/** Public OAuth account and token lifecycle service. */
export interface OAuthService extends OAuthAccountService {
  /** Return token-free provider metadata. */
  providers(): readonly OAuthProviderInfo[]
  /** Authorize and persist a provider account. */
  login(provider: string, options?: OAuthLoginOptions): Promise<OAuthAccount>
  /** Remove local credentials after blocking new account work. */
  logout(accountId: OAuthAccountId): Promise<void>
  /** Refresh an account when it is inside the configured window. */
  ensureFresh(accountId: OAuthAccountId, options?: OAuthLoginOptions): Promise<void>
  /** Force one account through refresh-token rotation. */
  rotate(accountId: OAuthAccountId, options?: OAuthLoginOptions): Promise<void>
  /** Refresh the sole account for a route and return its public reference. */
  ensureFreshForRoute(route: string, options?: OAuthLoginOptions): Promise<OAuthAccountCredentialRef | undefined>
}
