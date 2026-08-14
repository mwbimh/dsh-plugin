import { QuotaError, classifyProviderError } from './errors.ts'
import { validateAccount } from './model.ts'
import type { QuotaAccount, QuotaProvider } from './model.ts'

/** Registry enforcing unique, stable provider ownership. */
export class ProviderRegistry {
  private readonly byId = new Map<string, QuotaProvider>()

  constructor(providers: readonly QuotaProvider[] = []) {
    for (const provider of providers) {
      if (provider.id.trim().length === 0 || provider.id.length > 128 || this.byId.has(provider.id)) {
        throw new QuotaError({ code: 'configuration', provider: provider.id })
      }
      if (provider.retryPolicy !== undefined && (
        !Number.isSafeInteger(provider.retryPolicy.maxAttempts)
        || provider.retryPolicy.maxAttempts < 1
        || !Number.isSafeInteger(provider.retryPolicy.baseDelayMs)
        || provider.retryPolicy.baseDelayMs < 0
      )) throw new QuotaError({ code: 'configuration', provider: provider.id })
      this.byId.set(provider.id, provider)
    }
  }

  providers(): readonly QuotaProvider[] {
    return [...this.byId.values()]
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  get(id: string): QuotaProvider {
    const provider = this.byId.get(id)
    if (provider === undefined) throw new QuotaError({ code: 'configuration', provider: id })
    return provider
  }

  async discoverAccounts(): Promise<readonly QuotaAccount[]> {
    const accounts = new Map<string, QuotaAccount>()
    for (const provider of this.byId.values()) {
      let discovered: readonly QuotaAccount[]
      try {
        discovered = await provider.discoverAccounts()
      } catch (error) {
        throw classifyProviderError(error, { provider: provider.id, id: '' })
      }
      if (!Array.isArray(discovered)) throw new QuotaError({ code: 'provider-response', provider: provider.id })
      for (const candidate of discovered) {
        let account: QuotaAccount
        try {
          account = validateAccount(candidate)
        } catch {
          throw new QuotaError({ code: 'provider-response', provider: provider.id })
        }
        if (account.provider !== provider.id) {
          throw new QuotaError({ code: 'provider-response', provider: provider.id, accountId: account.id })
        }
        const key = `${account.provider}\u0000${account.id}`
        if (accounts.has(key)) throw new QuotaError({ code: 'provider-response', provider: provider.id, accountId: account.id })
        accounts.set(key, account)
      }
    }
    return [...accounts.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id))
  }
}
