import type { OAuthAccount, OAuthCredential, StoredOAuthAccount } from './types.ts'

/** Copy public account metadata so callers cannot mutate stored scope arrays. */
export function copyOAuthAccount(account: OAuthAccount): OAuthAccount {
  return { ...account, scopes: [...account.scopes] }
}

/** Copy a sensitive credential so providers cannot mutate stored scope arrays. */
export function copyOAuthCredential(credential: OAuthCredential): OAuthCredential {
  return { ...credential, scopes: [...credential.scopes] }
}

/** Copy one complete store record. */
export function copyStoredOAuthAccount(record: StoredOAuthAccount): StoredOAuthAccount {
  return {
    account: copyOAuthAccount(record.account),
    credential: copyOAuthCredential(record.credential),
  }
}
