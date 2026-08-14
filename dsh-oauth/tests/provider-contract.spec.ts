import { describe, expect, it } from 'vitest'
import { assertCredentialAuthorized } from '../src/provider.ts'
import { FakeOAuthProvider } from '../src/fakes.ts'
import type { OAuthCredential } from '../src/types.ts'

const provider = new FakeOAuthProvider({
  id: 'openai-codex',
  route: 'openai-codex',
  credentialRef: 'DSH_OAUTH_CODEX',
  issuer: 'https://issuer.example',
  audience: 'codex-api',
  scopes: ['openid', 'model.read'],
})

function valid(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 100_000,
    provider: provider.id,
    scopes: ['model.read', 'openid', 'extra'],
    audience: provider.audience,
    issuer: provider.issuer,
    route: provider.route,
    ...overrides,
  }
}

describe('OAuth provider credential contract', () => {
  it('accepts the configured provider, issuer, audience, route, and required scope set', () => {
    expect(() => assertCredentialAuthorized(provider, valid(), 'login')).not.toThrow()
  })

  it.each([
    ['provider', { provider: 'other' }, 'reauth-required'],
    ['issuer', { issuer: 'https://forged.example' }, 'reauth-required'],
    ['audience', { audience: 'other-api' }, 'reauth-required'],
    ['route', { route: 'other-route' }, 'route-conflict'],
    ['scope', { scopes: ['openid'] }, 'scope-mismatch'],
  ] as const)('rejects a %s mismatch with a stable safe code', (_field, overrides, code) => {
    expect(() => assertCredentialAuthorized(provider, valid(overrides), 'refresh')).toThrowError(expect.objectContaining({ code }))
  })

  it('rejects malformed token responses without echoing credential fields', () => {
    let error: unknown
    try {
      assertCredentialAuthorized(provider, valid({ accessToken: '', refreshToken: 'do-not-echo' }), 'login')
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'token-exchange', retryable: false })
    expect(String(error)).not.toContain('do-not-echo')
  })

  it('provides deterministic fake success, exhaustion, and pre-abort paths', async () => {
    const controller = new AbortController()
    provider.refreshResults.push(valid())
    await provider.refresh(valid(), { signal: controller.signal })
    await provider.waitForRefreshCalls(1)
    await expect(provider.revoke(valid(), { signal: controller.signal })).resolves.toBeUndefined()
    await expect(provider.login({ signal: controller.signal })).rejects.toThrow(/queue is empty/)

    const aborted = new AbortController()
    aborted.abort()
    provider.loginResults.push(valid())
    await expect(provider.login({ signal: aborted.signal })).rejects.toThrow(/abort/i)
  })
})
