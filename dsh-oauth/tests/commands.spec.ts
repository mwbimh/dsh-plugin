import { describe, expect, it, vi } from 'vitest'
import { installOAuthCommands, type OAuthCommandDefinition, type OAuthCommandRegistry } from '../src/commands.ts'
import { OAuthError } from '../src/errors.ts'
import type { OAuthAccount, OAuthAccountId, OAuthCredentialRef, OAuthService } from '../src/types.ts'

const account: OAuthAccount = {
  id: 'account-1' as OAuthAccountId,
  provider: 'openai-codex',
  displayName: 'Codex account',
  subject: 'subject-1',
  scopes: ['openid', 'model.read'],
  status: 'ready',
  expiresAt: 60_000,
  createdAt: 1,
  updatedAt: 1,
}

function harness(listedAccounts: readonly OAuthAccount[] = [account]) {
  let definition: OAuthCommandDefinition | undefined
  let disposed = false
  const registry: OAuthCommandRegistry = {
    register(next) {
      definition = next
      return () => { disposed = true }
    },
  }
  const accounts = vi.fn<OAuthService['accounts']>(async () => listedAccounts)
  const login = vi.fn<OAuthService['login']>(async () => account)
  const logout = vi.fn<OAuthService['logout']>(async () => {})
  const rotate = vi.fn<OAuthService['rotate']>(async () => {})
  const service: OAuthService = {
    providers: () => [{
      id: 'openai-codex',
      route: 'openai-codex',
      credentialRef: 'DSH_OAUTH_CODEX' as OAuthCredentialRef,
      issuer: 'https://issuer.example',
      audience: 'codex-api',
      scopes: ['openid'],
    }],
    accounts,
    accountCredential: async () => ({ account, credentialRef: 'DSH_OAUTH_CODEX' }),
    login,
    logout,
    ensureFresh: async () => {},
    rotate,
    ensureFreshForRoute: async () => undefined,
  }
  const dispose = installOAuthCommands(registry, service)
  if (definition === undefined) throw new Error('command was not registered')
  return { definition, dispose, disposed: () => disposed, spies: { accounts, login, logout, rotate } }
}

async function invoke(definition: OAuthCommandDefinition, rawInput: string) {
  return definition.handler({ rawInput, signal: new AbortController().signal })
}

describe('/dsh-oauth command', () => {
  it('registers one namespaced command with input recording disabled', () => {
    const { definition } = harness()

    expect(definition).toMatchObject({
      name: 'dsh-oauth',
      recordInput: false,
      input: { hint: 'accounts [provider] | login <provider> | logout <account-id> | rotate <account-id>' },
    })
  })

  it('lists token-free accounts and supports an optional provider filter', async () => {
    const { definition, spies } = harness()

    const result = await invoke(definition, ' accounts openai-codex')

    expect(spies.accounts).toHaveBeenCalledWith('openai-codex')
    expect(result).toEqual({
      kind: 'success',
      text: 'account-1\topenai-codex\tCodex account\tready\texpires 1970-01-01T00:01:00.000Z\tscopes openid,model.read',
    })
    expect(JSON.stringify(result)).not.toMatch(/access|refresh.*token/i)
  })

  it('renders absent optional metadata and empty scopes without resolving credentials', async () => {
    const minimalAccount: OAuthAccount = {
      id: 'account-minimal' as OAuthAccountId,
      provider: 'openai-codex',
      scopes: [],
      status: 'reauth-required',
      createdAt: 1,
      updatedAt: 1,
    }
    const { definition, spies } = harness([minimalAccount])

    const result = await invoke(definition, 'accounts')

    expect(spies.accounts).toHaveBeenCalledWith(undefined)
    expect(result).toEqual({
      kind: 'success',
      text: 'account-minimal\topenai-codex\t-\treauth-required\texpiry unknown\tscopes -',
    })
  })

  it('reports an empty account set and usage for blank input', async () => {
    const { definition } = harness([])

    await expect(invoke(definition, ' accounts ')).resolves.toEqual({ kind: 'success', text: 'No OAuth accounts.' })
    await expect(invoke(definition, ' \t ')).resolves.toEqual({
      kind: 'error',
      text: 'Usage: /dsh-oauth accounts [provider] | login <provider> | logout <account-id> | rotate <account-id>',
    })
  })

  it.each([
    ['login openai-codex', 'login'],
    ['logout account-1', 'logout'],
    ['rotate account-1', 'rotate'],
  ] as const)('dispatches %s without accepting a code or token', async (rawInput, operation) => {
    const { definition, spies } = harness()

    const result = await invoke(definition, ` ${rawInput}`)

    expect(spies[operation]).toHaveBeenCalledOnce()
    expect(result.kind).toBe('success')
  })

  it.each([
    'login openai-codex authorization-code-secret',
    'logout account-1 access-token-secret',
    'rotate account-1 refresh-token-secret',
    'accounts openai-codex unexpected-secret',
  ])('rejects extra sensitive-position input without echoing it: %s', async (rawInput) => {
    const { definition, spies } = harness()

    const result = await invoke(definition, ` ${rawInput}`)

    expect(result).toEqual({ kind: 'error', text: 'Usage: /dsh-oauth accounts [provider] | login <provider> | logout <account-id> | rotate <account-id>' })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(spies.login).not.toHaveBeenCalled()
    expect(spies.logout).not.toHaveBeenCalled()
    expect(spies.rotate).not.toHaveBeenCalled()
  })

  it('does not expose provider error details and unregisters on disposal', async () => {
    const { definition, dispose, disposed, spies } = harness()
    spies.login.mockRejectedValueOnce(new Error('provider returned access-token-secret'))

    const result = await invoke(definition, ' login openai-codex')

    expect(result).toEqual({ kind: 'error', text: 'dsh-oauth: login failed' })
    expect(JSON.stringify(result)).not.toContain('secret')
    dispose()
    expect(disposed()).toBe(true)
  })

  it('returns the stable safe message for a classified OAuth failure', async () => {
    const { definition, spies } = harness()
    spies.login.mockRejectedValueOnce(new OAuthError({ code: 'consent-denied', provider: 'openai-codex' }))

    const result = await invoke(definition, 'login openai-codex')

    expect(result).toEqual({ kind: 'error', text: 'dsh-oauth: authorization consent was denied' })
  })
})
