import { randomUUID } from 'node:crypto'
import { OAuthError, normalizeOAuthError } from './errors.ts'
import { assertCredentialAuthorized, providerInfo } from './provider.ts'
import { copyOAuthAccount } from './store.ts'
import type {
  OAuthAccount,
  OAuthAccountCredentialRef,
  OAuthAccountId,
  OAuthCredential,
  OAuthLoginOptions,
  OAuthProvider,
  OAuthProviderInfo,
  OAuthService,
  OAuthServiceOptions,
  StoredOAuthAccount,
} from './types.ts'

interface RefreshFlight {
  readonly controller: AbortController
  readonly promise: Promise<void>
}

/** Production OAuth lifecycle coordinator over provider, secure-store, and bridge seams. */
export class OAuthServiceImpl implements OAuthService {
  private readonly providerMap = new Map<string, OAuthProvider>()
  private readonly store: OAuthServiceOptions['store']
  private readonly publisher: OAuthServiceOptions['publisher']
  private readonly refreshWindowMs: number
  private readonly now: () => number
  private readonly createAccountId: () => OAuthAccountId
  private readonly flights = new Map<OAuthAccountId, RefreshFlight>()
  private readonly controllers = new Set<AbortController>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly blockedAccounts = new Set<OAuthAccountId>()
  private disposed = false

  /** Create a lifecycle service with explicit authorization and refresh policy dependencies. */
  constructor(options: OAuthServiceOptions) {
    if (!Number.isFinite(options.refreshWindowMs) || options.refreshWindowMs < 0) {
      throw new OAuthError({ code: 'configuration' })
    }
    const routeOwners = new Set<string>()
    const credentialOwners = new Set<string>()
    for (const provider of options.providers) {
      if (provider.id.length === 0 || provider.route.length === 0 || provider.credentialRef.length === 0
        || provider.issuer.length === 0 || provider.audience.length === 0 || this.providerMap.has(provider.id)) {
        throw new OAuthError({
          code: 'configuration',
          ...(provider.id.length === 0 ? {} : { provider: provider.id }),
        })
      }
      if (routeOwners.has(provider.route)) {
        throw new OAuthError({ code: 'route-conflict', provider: provider.id })
      }
      if (credentialOwners.has(provider.credentialRef)) {
        throw new OAuthError({ code: 'configuration', provider: provider.id })
      }
      this.providerMap.set(provider.id, provider)
      routeOwners.add(provider.route)
      credentialOwners.add(provider.credentialRef)
    }
    this.store = options.store
    this.publisher = options.publisher
    this.refreshWindowMs = options.refreshWindowMs
    this.now = options.now ?? Date.now
    this.createAccountId = options.createAccountId ?? (() => randomUUID() as OAuthAccountId)
  }

  /** Return token-free metadata for configured providers. */
  providers(): readonly OAuthProviderInfo[] {
    return [...this.providerMap.values()].map(providerInfo)
  }

  /** List token-free account metadata in stable order. */
  async accounts(provider?: string): Promise<readonly OAuthAccount[]> {
    this.assertActive()
    const records = await this.readRecords()
    return records
      .filter(record => provider === undefined || record.account.provider === provider)
      .map(record => copyOAuthAccount(record.account))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  /** Resolve one account and its non-secret DSH credential reference. */
  async accountCredential(accountId: OAuthAccountId): Promise<OAuthAccountCredentialRef> {
    this.assertAccountActive(accountId)
    const record = await this.readRecord(accountId)
    const provider = this.requireProvider(record.account.provider, accountId)
    return { account: copyOAuthAccount(record.account), credentialRef: provider.credentialRef }
  }

  /** Run provider login, store the private credential, then publish its access token. */
  async login(providerId: string, options: OAuthLoginOptions = {}): Promise<OAuthAccount> {
    this.assertActive()
    const provider = this.requireProvider(providerId)
    const controller = this.operationController(options.signal)
    const operation = (async () => {
      let credential: OAuthCredential
      try {
        credential = await provider.login({ signal: controller.signal })
      } catch (error) {
        throw normalizeOAuthError(error, {
          code: controller.signal.aborted ? 'login-cancelled' : 'token-exchange',
          provider: provider.id,
        })
      }
      if (controller.signal.aborted) {
        throw new OAuthError({ code: 'login-cancelled', provider: provider.id })
      }
      assertCredentialAuthorized(provider, credential, 'login')
      const timestamp = this.now()
      const account: OAuthAccount = {
        id: this.createAccountId(),
        provider: provider.id,
        ...(credential.displayName === undefined ? {} : { displayName: credential.displayName }),
        ...(credential.subject === undefined ? {} : { subject: credential.subject }),
        scopes: [...credential.scopes],
        status: 'ready',
        expiresAt: credential.expiresAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      await this.storeRecord({ account, credential }, provider.id, account.id)
      try {
        await this.publisher.publish(provider.credentialRef, credential.accessToken)
      } catch (error) {
        await this.markStatus({ account, credential }, 'error')
        throw normalizeOAuthError(error, {
          code: 'storage-unavailable',
          provider: provider.id,
          accountId: account.id,
        })
      }
      return copyOAuthAccount(account)
    })()
    return await this.trackOperation(operation, controller)
  }

  /** Ensure an account token remains valid beyond the configured refresh window. */
  async ensureFresh(accountId: OAuthAccountId, options: OAuthLoginOptions = {}): Promise<void> {
    this.assertAccountActive(accountId)
    const controller = this.operationController()
    const operation = this.ensureFreshInternal(accountId, options.signal, controller.signal)
    return await this.trackOperation(operation, controller)
  }

  /** Force one account through refresh-token rotation. */
  async rotate(accountId: OAuthAccountId, options: OAuthLoginOptions = {}): Promise<void> {
    this.assertAccountActive(accountId)
    const controller = this.operationController()
    const operation = this.rotateInternal(accountId, options.signal, controller.signal)
    return await this.trackOperation(operation, controller)
  }

  /** Refresh the sole account for a managed route and return only its public reference. */
  async ensureFreshForRoute(
    route: string,
    options: OAuthLoginOptions = {},
  ): Promise<OAuthAccountCredentialRef | undefined> {
    this.assertActive()
    const providers = [...this.providerMap.values()].filter(provider => provider.route === route)
    if (providers.length === 0) return undefined
    const provider = providers[0]!
    const records = (await this.readRecords()).filter(record => record.account.provider === provider.id)
    if (records.length === 0) return undefined
    if (records.length > 1) throw new OAuthError({ code: 'configuration', provider: provider.id })
    const accountId = records[0]!.account.id
    await this.ensureFresh(accountId, options)
    return await this.accountCredential(accountId)
  }

  /** Block account work, drain refresh, clear local credentials, then attempt remote revoke. */
  async logout(accountId: OAuthAccountId): Promise<void> {
    this.assertActive()
    this.blockedAccounts.add(accountId)
    const controller = this.operationController()
    return await this.trackOperation(this.logoutInternal(accountId, controller), controller)
  }

  private async logoutInternal(accountId: OAuthAccountId, controller: AbortController): Promise<void> {
    const activeFlight = this.flights.get(accountId)
    activeFlight?.controller.abort()
    if (activeFlight !== undefined) await activeFlight.promise.catch((_logoutOwnedAbort) => undefined)

    let record: StoredOAuthAccount | undefined
    try {
      record = await this.store.get(accountId)
    } catch (error) {
      throw normalizeOAuthError(error, { code: 'storage-unavailable', accountId })
    }
    if (record === undefined) return
    const provider = this.requireProvider(record.account.provider, accountId)
    let localFailure = false
    try {
      await this.publisher.clear(provider.credentialRef)
    } catch (bridgeClearFailure) {
      void bridgeClearFailure
      localFailure = true
    }
    try {
      await this.store.delete(accountId)
    } catch (credentialDeleteFailure) {
      void credentialDeleteFailure
      localFailure = true
    }
    if (provider.revoke !== undefined) {
      await provider.revoke(record.credential, { signal: controller.signal })
        .catch((_bestEffortRemoteRevoke) => undefined)
    }
    if (localFailure) {
      throw new OAuthError({ code: 'storage-unavailable', provider: provider.id, accountId })
    }
  }

  /** Abort all work, await quiescence, and remove published access credentials. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled(this.operations)
    let records: readonly StoredOAuthAccount[] = []
    try {
      records = await this.store.list()
    } catch (credentialStoreUnavailableDuringDisposal) {
      void credentialStoreUnavailableDuringDisposal
      return
    }
    await Promise.allSettled(records.map(record => {
      const provider = this.providerMap.get(record.account.provider)
      return provider === undefined ? Promise.resolve() : this.publisher.clear(provider.credentialRef)
    }))
  }

  private async ensureFreshInternal(
    accountId: OAuthAccountId,
    callerSignal: AbortSignal | undefined,
    lifecycleSignal: AbortSignal,
  ): Promise<void> {
    const { provider, record } = await this.loadAuthorizedAccount(accountId, lifecycleSignal)
    if (this.now() + this.refreshWindowMs < record.credential.expiresAt) return
    await this.refresh(accountId, record, provider, callerSignal)
  }

  private async rotateInternal(
    accountId: OAuthAccountId,
    callerSignal: AbortSignal | undefined,
    lifecycleSignal: AbortSignal,
  ): Promise<void> {
    const { provider, record } = await this.loadAuthorizedAccount(accountId, lifecycleSignal)
    await this.refresh(accountId, record, provider, callerSignal)
  }

  private async loadAuthorizedAccount(
    accountId: OAuthAccountId,
    lifecycleSignal: AbortSignal,
  ): Promise<{ readonly provider: OAuthProvider; readonly record: StoredOAuthAccount }> {
    const record = await this.readRecord(accountId)
    if (lifecycleSignal.aborted) throw new OAuthError({ code: 'internal', accountId })
    this.assertAccountActive(accountId)
    const provider = this.requireProvider(record.account.provider, accountId)
    try {
      assertCredentialAuthorized(provider, record.credential, 'refresh')
    } catch (error) {
      await this.markStatus(record, 'reauth-required')
      throw error
    }
    return { provider, record }
  }

  private async refresh(
    accountId: OAuthAccountId,
    record: StoredOAuthAccount,
    provider: OAuthProvider,
    callerSignal?: AbortSignal,
  ): Promise<void> {
    let flight = this.flights.get(accountId)
    if (flight === undefined) {
      const controller = this.operationController()
      const promise = this.performRefresh(accountId, record, provider, controller)
      flight = { controller, promise }
      this.flights.set(accountId, flight)
      void promise.then(
        () => this.finishFlight(accountId),
        () => this.finishFlight(accountId),
      )
    }
    await waitForCaller(flight.promise, callerSignal)
  }

  private async performRefresh(
    accountId: OAuthAccountId,
    record: StoredOAuthAccount,
    provider: OAuthProvider,
    controller: AbortController,
  ): Promise<void> {
    const operation = (async () => {
      let credential: OAuthCredential
      try {
        credential = await provider.refresh(record.credential, { signal: controller.signal })
      } catch (error) {
        const code = this.blockedAccounts.has(accountId)
          ? 'reauth-required'
          : this.disposed ? 'internal' : 'refresh-temporary'
        const normalized = normalizeOAuthError(error, {
          code,
          provider: provider.id,
          accountId,
          retryable: code === 'refresh-temporary',
        })
        if (isTerminalAuthorizationError(normalized)) await this.markStatus(record, 'reauth-required')
        throw normalized
      }
      if (controller.signal.aborted) {
        throw new OAuthError({
          code: this.disposed ? 'internal' : 'reauth-required',
          provider: provider.id,
          accountId,
        })
      }
      try {
        assertCredentialAuthorized(provider, credential, 'refresh')
      } catch (error) {
        await this.markStatus(record, 'reauth-required')
        throw error
      }
      const displayName = credential.displayName ?? record.account.displayName
      const subject = credential.subject ?? record.account.subject
      const account: OAuthAccount = {
        ...record.account,
        ...(displayName === undefined ? {} : { displayName }),
        ...(subject === undefined ? {} : { subject }),
        scopes: [...credential.scopes],
        status: 'ready',
        expiresAt: credential.expiresAt,
        updatedAt: this.now(),
      }
      await this.storeRecord({ account, credential }, provider.id, accountId)
      try {
        await this.publisher.publish(provider.credentialRef, credential.accessToken)
      } catch (error) {
        await this.markStatus({ account, credential }, 'error')
        throw normalizeOAuthError(error, {
          code: 'storage-unavailable',
          provider: provider.id,
          accountId,
        })
      }
    })()
    return await this.trackOperation(operation, controller)
  }

  private finishFlight(accountId: OAuthAccountId): void {
    this.flights.delete(accountId)
  }

  private async markStatus(record: StoredOAuthAccount, status: OAuthAccount['status']): Promise<void> {
    try {
      await this.store.put({
        credential: record.credential,
        account: { ...record.account, status, updatedAt: this.now() },
      })
    } catch (statusStorageFailure) {
      void statusStorageFailure
      // The original classified failure remains the only public error.
    }
  }

  private async storeRecord(record: StoredOAuthAccount, provider: string, accountId: OAuthAccountId): Promise<void> {
    try {
      await this.store.put(record)
    } catch (error) {
      throw normalizeOAuthError(error, { code: 'storage-unavailable', provider, accountId })
    }
  }

  private async readRecords(): Promise<readonly StoredOAuthAccount[]> {
    try {
      return await this.store.list()
    } catch (error) {
      throw normalizeOAuthError(error, { code: 'storage-unavailable' })
    }
  }

  private async readRecord(accountId: OAuthAccountId): Promise<StoredOAuthAccount> {
    let record: StoredOAuthAccount | undefined
    try {
      record = await this.store.get(accountId)
    } catch (error) {
      throw normalizeOAuthError(error, { code: 'storage-unavailable', accountId })
    }
    if (record === undefined) throw new OAuthError({ code: 'reauth-required', accountId })
    return record
  }

  private requireProvider(providerId: string, accountId?: OAuthAccountId): OAuthProvider {
    const provider = this.providerMap.get(providerId)
    if (provider === undefined) {
      throw new OAuthError({
        code: 'configuration',
        ...(accountId === undefined ? {} : { accountId }),
      })
    }
    return provider
  }

  private operationController(externalSignal?: AbortSignal): AbortController {
    const controller = new AbortController()
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true, signal: controller.signal })
    }
    this.controllers.add(controller)
    return controller
  }

  private async trackOperation<T>(operation: Promise<T>, controller: AbortController): Promise<T> {
    this.operations.add(operation)
    try {
      return await operation
    } finally {
      this.operations.delete(operation)
      this.controllers.delete(controller)
      controller.abort()
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new OAuthError({ code: 'internal' })
  }

  private assertAccountActive(accountId: OAuthAccountId): void {
    this.assertActive()
    if (this.blockedAccounts.has(accountId)) throw new OAuthError({ code: 'reauth-required', accountId })
  }
}

function isTerminalAuthorizationError(error: OAuthError): boolean {
  return error.code === 'reauth-required' || error.code === 'scope-mismatch' || error.code === 'route-conflict'
}

async function waitForCaller<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await operation
  if (signal.aborted) throw new OAuthError({ code: 'refresh-temporary', retryable: true })
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new OAuthError({ code: 'refresh-temporary', retryable: true }))
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}
