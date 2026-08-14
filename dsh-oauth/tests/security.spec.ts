import { describe, expect, it } from 'vitest'
import { OAuthError, normalizeOAuthError } from '../src/errors.ts'
import { FakeCredentialPublisher, FakeOAuthProvider, FakeOAuthStore } from '../src/fakes.ts'
import { OAuthServiceImpl } from '../src/service.ts'
import type { OAuthAccountId } from '../src/types.ts'

const accessSecret = 'access-security-fixture'
const refreshSecret = 'refresh-security-fixture'

describe('OAuth security surfaces', () => {
  it('normalizes unknown provider failures without retaining secret messages or causes', () => {
    const normalized = normalizeOAuthError(
      new Error(`provider said ${accessSecret} ${refreshSecret}`),
      { code: 'refresh-temporary', provider: 'openai-codex', accountId: 'account-1' as OAuthAccountId, retryable: true },
    )

    expect(normalized).toBeInstanceOf(OAuthError)
    expect(normalized).toMatchObject({ code: 'refresh-temporary', provider: 'openai-codex', accountId: 'account-1', retryable: true })
    expect(normalized).not.toHaveProperty('cause')
    expect(`${normalized.stack}\n${JSON.stringify(normalized)}`).not.toContain(accessSecret)
    expect(`${normalized.stack}\n${JSON.stringify(normalized)}`).not.toContain(refreshSecret)
  })

  it('serializes only present safe error fields', () => {
    const minimal = new OAuthError({ code: 'internal' })
    expect(minimal.toJSON()).toEqual({
      name: 'OAuthError',
      message: 'dsh-oauth: internal lifecycle failure',
      code: 'internal',
      retryable: false,
    })

    const limited = new OAuthError({ code: 'rate-limit', retryable: true, retryAfterMs: 2_000 })
    expect(limited.toJSON()).toMatchObject({ code: 'rate-limit', retryable: true, retryAfterMs: 2_000 })
  })

  it('never exposes tokens through providers, accounts, or credential-ref lookup', async () => {
    const provider = new FakeOAuthProvider({
      id: 'openai-codex',
      route: 'openai-codex',
      credentialRef: 'DSH_OAUTH_CODEX',
      issuer: 'https://issuer.example',
      audience: 'codex-api',
      scopes: ['openid'],
    })
    provider.loginResults.push({
      accessToken: accessSecret,
      refreshToken: refreshSecret,
      expiresAt: 100_000,
      provider: provider.id,
      scopes: ['openid'],
      audience: provider.audience,
      issuer: provider.issuer,
      route: provider.route,
    })
    const service = new OAuthServiceImpl({
      providers: [provider],
      store: new FakeOAuthStore(),
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs: 30_000,
      now: () => 1_000,
      createAccountId: () => 'account-1' as OAuthAccountId,
    })

    const account = await service.login('openai-codex')
    const publicResult = {
      providers: service.providers(),
      accounts: await service.accounts(),
      accountCredential: await service.accountCredential(account.id),
    }
    const serialized = JSON.stringify(publicResult)
    expect(serialized).not.toContain(accessSecret)
    expect(serialized).not.toContain(refreshSecret)
  })
})
