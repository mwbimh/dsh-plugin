/** Minimal token-free account shape consumed structurally from dsh-oauth. */
export interface TokenFreeOAuthAccount {
  readonly id: string
  readonly provider: string
  readonly displayName?: string
}

/** Token-free OAuth lookup result. credentialRef is an opaque name only. */
export interface TokenFreeOAuthAccountCredentialRef {
  readonly account: TokenFreeOAuthAccount
  readonly credentialRef: string
}

/** Cancellation boundary shared structurally with the optional OAuth service. */
export interface TokenFreeOAuthOperationOptions {
  readonly signal?: AbortSignal
}

/** Optional structural service; no runtime or type dependency on dsh-oauth. */
export interface TokenFreeOAuthAccountService {
  accounts(provider?: string, options?: TokenFreeOAuthOperationOptions): Promise<readonly TokenFreeOAuthAccount[]>
  accountCredential(accountId: string, options?: TokenFreeOAuthOperationOptions): Promise<TokenFreeOAuthAccountCredentialRef>
}

export function isTokenFreeOAuthAccountService(value: unknown): value is TokenFreeOAuthAccountService {
  return typeof value === 'object' && value !== null
    && 'accounts' in value && typeof value.accounts === 'function'
    && 'accountCredential' in value && typeof value.accountCredential === 'function'
}

export function isTokenFreeOAuthAccount(value: unknown): value is TokenFreeOAuthAccount {
  return typeof value === 'object' && value !== null
    && 'id' in value && typeof value.id === 'string'
    && 'provider' in value && typeof value.provider === 'string'
    && (!('displayName' in value) || value.displayName === undefined || typeof value.displayName === 'string')
}

export function isTokenFreeOAuthAccountCredentialRef(value: unknown): value is TokenFreeOAuthAccountCredentialRef {
  return typeof value === 'object' && value !== null
    && 'account' in value && isTokenFreeOAuthAccount(value.account)
    && 'credentialRef' in value && typeof value.credentialRef === 'string'
}
