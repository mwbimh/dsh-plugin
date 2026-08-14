import { createHash, randomUUID } from 'node:crypto'
import { OAuthError, normalizeOAuthError } from './errors.ts'
import { assertCredentialAuthorized, providerInfo } from './provider.ts'
import { copyOAuthAccount } from './store.ts'
import type {
  OAuthAccount,
  OAuthAccountCredentialRef,
  OAuthAccountId,
  OAuthCredential,
  OAuthCredentialRef,
  OAuthLoginOptions,
  OAuthProvider,
  OAuthProviderInfo,
  OAuthService,
  OAuthServiceOptions,
  StoredOAuthAccount,
} from './types.ts'

interface RefreshFlight {
  readonly controller: AbortController
  readonly force: boolean
  readonly promise: Promise<void>
  waiters: number
  settled: boolean
}

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** OAuth contract-foundation lifecycle coordinator over provider, store, and bridge seams. */
export class OAuthServiceImpl implements OAuthService {
  private readonly providerMap = new Map<string, OAuthProvider>()
  private readonly routeBindings = new Map<string, OAuthAccountId>()
  private readonly store: OAuthServiceOptions['store']
  private readonly publisher: OAuthServiceOptions['publisher']
  private readonly refreshWindowMs: number
  private readonly now: () => number
  private readonly createAccountId: () => OAuthAccountId
  private readonly flights = new Map<OAuthAccountId, RefreshFlight>()
  private readonly controllers = new Set<AbortController>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly blockedAccounts = new Set<OAuthAccountId>()
  private readonly publishedVersions = new Map<OAuthAccountId, number>()
  private disposePromise: Promise<void> | undefined
  private disposed = false

  /** Create a lifecycle service with explicit authorization and refresh policy dependencies. */
  constructor(options: OAuthServiceOptions) {
    if (!Number.isFinite(options.refreshWindowMs) || options.refreshWindowMs < 0) {
      throw new OAuthError({ code: 'configuration' })
    }
    const routeOwners = new Set<string>()
    const credentialOwners = new Set<string>()
    for (const provider of options.providers) {
      if (provider.id.length === 0 || provider.route.length === 0 || !REF_PATTERN.test(provider.credentialRef)
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
    for (const [route, accountId] of Object.entries(options.routeBindings ?? {})) {
      if (!routeOwners.has(route) || accountId.length === 0) throw new OAuthError({ code: 'configuration' })
      this.routeBindings.set(route, accountId)
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
  async accounts(provider?: string, options: OAuthLoginOptions = {}): Promise<readonly OAuthAccount[]> {
    this.assertActive()
    const controller = this.operationController(options.signal)
    const operation = (async () => {
      const records = await this.readRecords(controller.signal)
      return records
        .filter(record => provider === undefined || record.account.provider === provider)
        .map(record => copyOAuthAccount(record.account))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    })()
    return await this.trackOperation(operation, controller)
  }

  /** Ensure freshness and publication before returning a token-free account association. */
  async accountCredential(
    accountId: OAuthAccountId,
    options: OAuthLoginOptions = {},
  ): Promise<OAuthAccountCredentialRef> {
    this.assertAccountActive(accountId)
    const controller = this.operationController(options.signal)
    const operation = (async () => {
      await this.ensureFresh(accountId, { signal: controller.signal })
      const record = await this.readRecord(accountId, controller.signal)
      this.assertAccountActive(accountId)
      if (record.account.status !== 'ready') throw new OAuthError({ code: 'reauth-required', accountId })
      return association(record)
    })()
    return await this.trackOperation(operation, controller)
  }

  /** Run provider login, persist a non-ready credential, then publish and commit readiness. */
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
      if (controller.signal.aborted) throw new OAuthError({ code: 'login-cancelled', provider: provider.id })
      assertCredentialAuthorized(provider, credential, 'login')
      const timestamp = this.now()
      const accountId = this.createAccountId()
      const record: StoredOAuthAccount = {
        account: {
          id: accountId,
          provider: provider.id,
          ...(credential.displayName === undefined ? {} : { displayName: credential.displayName }),
          ...(credential.subject === undefined ? {} : { subject: credential.subject }),
          scopes: [...credential.scopes],
          status: 'error',
          expiresAt: credential.expiresAt,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        credential,
        credentialRef: accountCredentialRef(provider.credentialRef, accountId),
      }
      await this.storeRecord(record, provider.id, accountId)
      if (controller.signal.aborted) throw new OAuthError({ code: 'login-cancelled', provider: provider.id })
      const ready = await this.publishAndCommitReady(record, provider, controller.signal)
      return copyOAuthAccount(ready.account)
    })()
    return await this.trackOperation(operation, controller)
  }

  /** Ensure an account token remains valid beyond the configured refresh window. */
  async ensureFresh(accountId: OAuthAccountId, options: OAuthLoginOptions = {}): Promise<void> {
    this.assertAccountActive(accountId)
    const controller = this.operationController(options.signal)
    const operation = this.runAccountFlight(accountId, false, controller.signal)
    return await this.trackOperation(operation, controller)
  }

  /** Force one account through refresh-token rotation. */
  async rotate(accountId: OAuthAccountId, options: OAuthLoginOptions = {}): Promise<void> {
    this.assertAccountActive(accountId)
    const controller = this.operationController(options.signal)
    const operation = this.runAccountFlight(accountId, true, controller.signal)
    return await this.trackOperation(operation, controller)
  }

  /** Refresh the selected account for a managed route and return only its public association. */
  async ensureFreshForRoute(
    route: string,
    options: OAuthLoginOptions = {},
  ): Promise<OAuthAccountCredentialRef | undefined> {
    this.assertActive()
    const providers = [...this.providerMap.values()].filter(provider => provider.route === route)
    if (providers.length === 0) return undefined
    const provider = providers[0]!
    const controller = this.operationController(options.signal)
    const operation = (async () => {
      const records = (await this.readRecords(controller.signal))
        .filter(record => record.account.provider === provider.id)
      const boundId = this.routeBindings.get(route)
      const selected = boundId === undefined
        ? records.length === 1 ? records[0] : undefined
        : records.find(record => record.account.id === boundId)
      if (selected === undefined) {
        throw new OAuthError({
          code: records.length === 0 || boundId !== undefined ? 'reauth-required' : 'configuration',
          provider: provider.id,
          ...(boundId === undefined ? {} : { accountId: boundId }),
        })
      }
      await this.ensureFresh(selected.account.id, { signal: controller.signal })
      const refreshed = await this.readRecord(selected.account.id, controller.signal)
      if (refreshed.account.provider !== provider.id || refreshed.account.status !== 'ready') {
        throw new OAuthError({ code: 'configuration', provider: provider.id, accountId: refreshed.account.id })
      }
      return association(refreshed)
    })()
    return await this.trackOperation(operation, controller)
  }

  /** Block account work, drain refresh, retain cleanup state until clear and delete both succeed. */
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

    const record = await this.readOptionalRecord(accountId, controller.signal)
    if (record === undefined) return
    const provider = this.requireProvider(record.account.provider, accountId)
    const revoked: StoredOAuthAccount = {
      ...record,
      account: { ...record.account, status: 'revoked', updatedAt: this.now() },
    }
    if (record.account.status !== 'revoked') await this.storeRecord(revoked, provider.id, accountId)
    try {
      await this.publisher.clear(revoked.credentialRef)
    } catch (error) {
      throw normalizeOAuthError(error, { code: 'storage-unavailable', provider: provider.id, accountId })
    }
    this.publishedVersions.delete(accountId)
    try {
      await this.store.delete(accountId)
    } catch (error) {
      throw normalizeOAuthError(error, { code: 'storage-unavailable', provider: provider.id, accountId })
    }
    if (provider.revoke !== undefined) {
      await provider.revoke(revoked.credential, { signal: controller.signal })
        .catch((_bestEffortRemoteRevoke) => undefined)
    }
  }

  /** Abort all work, await quiescence, and remove every traceable published access credential. */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal()
    return this.disposePromise
  }

  private async disposeInternal(): Promise<void> {
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
    await Promise.allSettled(records.map(record => this.publisher.clear(record.credentialRef)))
    this.publishedVersions.clear()
  }

  private async runAccountFlight(
    accountId: OAuthAccountId,
    force: boolean,
    callerSignal: AbortSignal,
  ): Promise<void> {
    if (callerSignal.aborted) throw new OAuthError({ code: 'refresh-temporary', retryable: true })
    const active = this.flights.get(accountId)
    if (active !== undefined) {
      await this.waitForFlight(active, callerSignal)
      if (!force || active.force) return
      return await this.runAccountFlight(accountId, true, callerSignal)
    }
    const controller = this.operationController()
    const promise = this.performAccountOperation(accountId, force, controller)
    const flight: RefreshFlight = { controller, force, promise, waiters: 0, settled: false }
    this.flights.set(accountId, flight)
    void promise.then(
      () => this.finishFlight(accountId, flight),
      () => this.finishFlight(accountId, flight),
    )
    await this.waitForFlight(flight, callerSignal)
  }

  private async waitForFlight(flight: RefreshFlight, signal: AbortSignal): Promise<void> {
    flight.waiters += 1
    try {
      await waitForCaller(flight.promise, signal)
    } catch (error) {
      if (this.disposed) throw new OAuthError({ code: 'internal' })
      throw error
    } finally {
      flight.waiters -= 1
      if (signal.aborted && flight.waiters === 0 && !flight.settled) flight.controller.abort()
    }
  }

  private async performAccountOperation(
    accountId: OAuthAccountId,
    force: boolean,
    controller: AbortController,
  ): Promise<void> {
    const operation = (async () => {
      const { provider, record } = await this.loadAuthorizedAccount(accountId, controller.signal)
      if (record.account.status === 'error') {
        await this.publishAndCommitReady(record, provider, controller.signal)
        return
      }
      if (!force && this.now() + this.refreshWindowMs < record.credential.expiresAt) {
        if (this.publishedVersions.get(accountId) !== record.account.updatedAt) {
          await this.publishAndCommitReady({
            ...record,
            account: { ...record.account, status: 'error' },
          }, provider, controller.signal)
        }
        return
      }
      await this.performRefresh(accountId, record, provider, controller)
    })()
    return await this.trackOperation(operation, controller)
  }

  private async loadAuthorizedAccount(
    accountId: OAuthAccountId,
    lifecycleSignal: AbortSignal,
  ): Promise<{ readonly provider: OAuthProvider; readonly record: StoredOAuthAccount }> {
    const record = await this.readRecord(accountId, lifecycleSignal)
    if (lifecycleSignal.aborted) throw this.cancelledError(accountId)
    this.assertAccountActive(accountId)
    if (record.account.status === 'reauth-required' || record.account.status === 'revoked') {
      throw new OAuthError({ code: 'reauth-required', provider: record.account.provider, accountId })
    }
    const provider = this.requireProvider(record.account.provider, accountId)
    try {
      assertCredentialAuthorized(provider, record.credential, 'refresh')
    } catch (error) {
      await this.markStatus(record, 'reauth-required')
      throw error
    }
    return { provider, record }
  }

  private async performRefresh(
    accountId: OAuthAccountId,
    record: StoredOAuthAccount,
    provider: OAuthProvider,
    controller: AbortController,
  ): Promise<void> {
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
    if (controller.signal.aborted) throw this.cancelledError(accountId, provider.id)
    try {
      assertCredentialAuthorized(provider, credential, 'refresh')
    } catch (error) {
      await this.markStatus(record, 'reauth-required')
      throw error
    }
    const displayName = credential.displayName ?? record.account.displayName
    const subject = credential.subject ?? record.account.subject
    const pending: StoredOAuthAccount = {
      credential,
      credentialRef: record.credentialRef,
      account: {
        ...record.account,
        ...(displayName === undefined ? {} : { displayName }),
        ...(subject === undefined ? {} : { subject }),
        scopes: [...credential.scopes],
        status: 'error',
        expiresAt: credential.expiresAt,
        updatedAt: this.now(),
      },
    }
    await this.storeRecord(pending, provider.id, accountId)
    if (controller.signal.aborted) {
      await this.clearPublished(pending)
      throw this.cancelledError(accountId, provider.id)
    }
    await this.publishAndCommitReady(pending, provider, controller.signal)
  }

  private async publishAndCommitReady(
    record: StoredOAuthAccount,
    provider: OAuthProvider,
    signal: AbortSignal,
  ): Promise<StoredOAuthAccount> {
    try {
      await this.publisher.publish(record.credentialRef, record.credential.accessToken)
    } catch (error) {
      this.publishedVersions.delete(record.account.id)
      await this.clearPublished(record)
      throw normalizeOAuthError(error, {
        code: 'storage-unavailable',
        provider: provider.id,
        accountId: record.account.id,
      })
    }
    if (signal.aborted) {
      this.publishedVersions.delete(record.account.id)
      await this.clearPublished(record)
      throw this.cancelledError(record.account.id, provider.id)
    }
    const ready: StoredOAuthAccount = {
      ...record,
      account: { ...record.account, status: 'ready' },
    }
    try {
      await this.storeRecord(ready, provider.id, record.account.id)
    } catch (error) {
      this.publishedVersions.delete(record.account.id)
      await this.clearPublished(record)
      throw error
    }
    this.publishedVersions.set(record.account.id, ready.account.updatedAt)
    return ready
  }

  private async clearPublished(record: StoredOAuthAccount): Promise<void> {
    try {
      await this.publisher.clear(record.credentialRef)
    } catch (bridgeClearFailure) {
      void bridgeClearFailure
    }
  }

  private finishFlight(accountId: OAuthAccountId, flight: RefreshFlight): void {
    flight.settled = true
    this.flights.delete(accountId)
  }

  private async markStatus(record: StoredOAuthAccount, status: OAuthAccount['status']): Promise<void> {
    try {
      await this.store.put({
        ...record,
        account: { ...record.account, status, updatedAt: this.now() },
      })
    } catch (statusStorageFailure) {
      void statusStorageFailure
    }
  }

  private async storeRecord(record: StoredOAuthAccount, provider: string, accountId: OAuthAccountId): Promise<void> {
    try {
      await this.store.put(record)
    } catch (error) {
      throw normalizeOAuthError(error, { code: 'storage-unavailable', provider, accountId })
    }
  }

  private async readRecords(signal?: AbortSignal): Promise<readonly StoredOAuthAccount[]> {
    try {
      return await this.store.list(signal)
    } catch (error) {
      if (signal?.aborted) throw this.cancelledError()
      throw normalizeOAuthError(error, { code: 'storage-unavailable' })
    }
  }

  private async readOptionalRecord(accountId: OAuthAccountId, signal?: AbortSignal): Promise<StoredOAuthAccount | undefined> {
    try {
      return await this.store.get(accountId, signal)
    } catch (error) {
      if (signal?.aborted) throw this.cancelledError(accountId)
      throw normalizeOAuthError(error, { code: 'storage-unavailable', accountId })
    }
  }

  private async readRecord(accountId: OAuthAccountId, signal?: AbortSignal): Promise<StoredOAuthAccount> {
    const record = await this.readOptionalRecord(accountId, signal)
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

  private cancelledError(accountId?: OAuthAccountId, provider?: string): OAuthError {
    return new OAuthError({
      code: this.disposed ? 'internal' : this.blockedAccounts.has(accountId as OAuthAccountId)
        ? 'reauth-required' : 'refresh-temporary',
      ...(provider === undefined ? {} : { provider }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(this.disposed || this.blockedAccounts.has(accountId as OAuthAccountId) ? {} : { retryable: true }),
    })
  }

  private assertActive(): void {
    if (this.disposed) throw new OAuthError({ code: 'internal' })
  }

  private assertAccountActive(accountId: OAuthAccountId): void {
    this.assertActive()
    if (this.blockedAccounts.has(accountId)) throw new OAuthError({ code: 'reauth-required', accountId })
  }
}

function accountCredentialRef(prefix: OAuthCredentialRef, accountId: OAuthAccountId): OAuthCredentialRef {
  const digest = createHash('sha256').update(accountId).digest('hex').toUpperCase()
  return `${prefix}_${digest}` as OAuthCredentialRef
}

function association(record: StoredOAuthAccount): OAuthAccountCredentialRef {
  return { account: copyOAuthAccount(record.account), credentialRef: record.credentialRef }
}

function isTerminalAuthorizationError(error: OAuthError): boolean {
  return error.code === 'reauth-required' || error.code === 'scope-mismatch' || error.code === 'route-conflict'
}

async function waitForCaller<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
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
