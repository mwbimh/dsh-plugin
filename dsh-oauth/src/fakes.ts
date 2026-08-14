import { copyStoredOAuthAccount } from './store.ts'
import type {
  OAuthAccountId,
  OAuthCredential,
  OAuthCredentialPublisher,
  OAuthCredentialRef,
  OAuthCredentialStore,
  OAuthProvider,
  OAuthProviderOperationOptions,
  StoredOAuthAccount,
} from './types.ts'

let eventSequence = 0

/** Controllable promise used by lifecycle and concurrency tests. */
export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

/** Create a controllable promise. */
export function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type FakeResult<T> = T | Promise<T> | Error

/** Configuration for the deterministic fake OAuth provider. */
export interface FakeOAuthProviderOptions {
  readonly id: string
  readonly route: string
  readonly credentialRef: string
  readonly issuer: string
  readonly audience: string
  readonly scopes: readonly string[]
}

/** Deterministic provider fake with queued operation results and call recording. */
export class FakeOAuthProvider implements OAuthProvider {
  readonly id: string
  readonly route: string
  readonly credentialRef: OAuthCredentialRef
  readonly issuer: string
  readonly audience: string
  readonly scopes: readonly string[]
  readonly loginResults: FakeResult<OAuthCredential>[] = []
  readonly refreshResults: FakeResult<OAuthCredential>[] = []
  readonly loginCalls: OAuthProviderOperationOptions[] = []
  readonly refreshCalls: Array<OAuthProviderOperationOptions & { readonly credential: OAuthCredential }> = []
  readonly revokeCalls: Array<OAuthProviderOperationOptions & { readonly credential: OAuthCredential }> = []
  revokeError: unknown
  private readonly refreshWaiters = new Set<() => void>()

  /** Create a fake with fixed authorization requirements. */
  constructor(options: FakeOAuthProviderOptions) {
    this.id = options.id
    this.route = options.route
    this.credentialRef = options.credentialRef as OAuthCredentialRef
    this.issuer = options.issuer
    this.audience = options.audience
    this.scopes = [...options.scopes]
  }

  /** Consume the next queued login result. */
  async login(options: OAuthProviderOperationOptions): Promise<OAuthCredential> {
    this.loginCalls.push(options)
    return await consumeFakeResult(this.loginResults, options.signal)
  }

  /** Consume the next queued refresh result. */
  async refresh(credential: OAuthCredential, options: OAuthProviderOperationOptions): Promise<OAuthCredential> {
    this.refreshCalls.push({ ...options, credential })
    for (const waiter of this.refreshWaiters) waiter()
    this.refreshWaiters.clear()
    return await consumeFakeResult(this.refreshResults, options.signal)
  }

  /** Record a revoke call and optionally reject it. */
  async revoke(credential: OAuthCredential, options: OAuthProviderOperationOptions): Promise<void> {
    this.revokeCalls.push({ ...options, credential })
    if (this.revokeError !== undefined) throw this.revokeError
  }

  /** Wait until at least the requested number of refresh calls has started. */
  async waitForRefreshCalls(count: number): Promise<void> {
    if (this.refreshCalls.length >= count) return
    await new Promise<void>(resolve => this.refreshWaiters.add(resolve))
  }
}

async function consumeFakeResult<T>(results: FakeResult<T>[], signal: AbortSignal): Promise<T> {
  const result = results.shift()
  if (result === undefined) throw new Error('fake OAuth provider result queue is empty')
  if (result instanceof Error) throw result
  return await awaitWithAbort(Promise.resolve(result), signal)
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
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

/** In-memory atomic store fake with operation ordering evidence. */
export class FakeOAuthStore implements OAuthCredentialStore {
  readonly events: Array<{ readonly kind: 'put' | 'delete'; readonly accountId: OAuthAccountId; readonly sequence: number }> = []
  private readonly records = new Map<OAuthAccountId, StoredOAuthAccount>()

  /** List copied records. */
  async list(): Promise<readonly StoredOAuthAccount[]> {
    return [...this.records.values()].map(copyStoredOAuthAccount)
  }

  /** Get one copied record. */
  async get(accountId: OAuthAccountId): Promise<StoredOAuthAccount | undefined> {
    const record = this.records.get(accountId)
    return record === undefined ? undefined : copyStoredOAuthAccount(record)
  }

  /** Atomically replace one record. */
  async put(record: StoredOAuthAccount): Promise<void> {
    this.records.set(record.account.id, copyStoredOAuthAccount(record))
    this.events.push({ kind: 'put', accountId: record.account.id, sequence: ++eventSequence })
  }

  /** Delete one record. */
  async delete(accountId: OAuthAccountId): Promise<void> {
    this.records.delete(accountId)
    this.events.push({ kind: 'delete', accountId, sequence: ++eventSequence })
  }
}

/** In-memory access-token publisher fake with operation ordering evidence. */
export class FakeCredentialPublisher implements OAuthCredentialPublisher {
  readonly values = new Map<OAuthCredentialRef, string>()
  readonly events: Array<{
    readonly kind: 'publish' | 'clear'
    readonly credentialRef: OAuthCredentialRef
    readonly sequence: number
  }> = []

  /** Publish one short-lived access token. */
  async publish(credentialRef: OAuthCredentialRef, accessToken: string): Promise<void> {
    this.values.set(credentialRef, accessToken)
    this.events.push({ kind: 'publish', credentialRef, sequence: ++eventSequence })
  }

  /** Clear one published access token. */
  async clear(credentialRef: OAuthCredentialRef): Promise<void> {
    this.values.delete(credentialRef)
    this.events.push({ kind: 'clear', credentialRef, sequence: ++eventSequence })
  }
}
