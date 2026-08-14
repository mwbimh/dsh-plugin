import { OAuthError } from './errors.ts'
import type { OAuthCredential, OAuthProvider, OAuthProviderInfo } from './types.ts'

/** Credential-producing operation used to classify malformed provider responses. */
export type OAuthCredentialPhase = 'login' | 'refresh'

/** Enforce a provider's issuer, audience, route, and scope authorization requirements. */
export function assertCredentialAuthorized(
  provider: OAuthProvider,
  credential: OAuthCredential,
  phase: OAuthCredentialPhase,
): void {
  const fallbackCode = phase === 'login' ? 'token-exchange' : 'reauth-required'
  if (credential.accessToken.length === 0 || credential.refreshToken.length === 0
    || !Number.isFinite(credential.expiresAt)) {
    throw new OAuthError({ code: fallbackCode, provider: provider.id })
  }
  if (credential.provider !== provider.id || credential.issuer !== provider.issuer
    || credential.audience !== provider.audience) {
    throw new OAuthError({ code: 'reauth-required', provider: provider.id })
  }
  if (credential.route !== provider.route) {
    throw new OAuthError({ code: 'route-conflict', provider: provider.id })
  }
  const granted = new Set(credential.scopes)
  if (provider.scopes.some(scope => !granted.has(scope))) {
    throw new OAuthError({ code: 'scope-mismatch', provider: provider.id })
  }
}

/** Return token-free provider metadata. */
export function providerInfo(provider: OAuthProvider): OAuthProviderInfo {
  return {
    id: provider.id,
    route: provider.route,
    issuer: provider.issuer,
    audience: provider.audience,
    scopes: [...provider.scopes],
  }
}
