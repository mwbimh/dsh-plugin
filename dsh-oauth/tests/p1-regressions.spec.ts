import { describe, expect, it, vi } from 'vitest'
import { OAuthError } from '../src/errors.ts'
import { FakeCredentialPublisher, FakeOAuthProvider, FakeOAuthStore, deferred } from '../src/fakes.ts'
import { OAuthServiceImpl } from '../src/service.ts'
import type {
  OAuthAccountId,
  OAuthCredential,
  OAuthCredentialPublisher,
  OAuthCredentialStore,
  StoredOAuthAccount,
} from '../src/types.ts'

const firstId = 'account-a' as OAuthAccountId
const secondId = 'account-b' as OAuthAccountId

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    accessToken: 'access-old-secret',
    refreshToken: 'refresh-old-secret',
    expiresAt: 100_000,
    provider: 'openai-codex',
    subject: 'subject-a',
    scopes: ['openid'],
    audience: 'codex-api',
    issuer: 'https://issuer.example',
    route: 'openai-codex',
    ...overrides,
  }
}

function provider(): FakeOAuthProvider {
  return new FakeOAuthProvider({
    id: 'openai-codex',
    route: 'openai-codex',
    credentialRef: 'DSH_OAUTH_CODEX',
    issuer: 'https://issuer.example',
    audience: 'codex-api',
    scopes: ['openid'],
  })
}

function service(options: {
  provider?: FakeOAuthProvider
  store?: OAuthCredentialStore
  publisher?: OAuthCredentialPublisher
  ids?: OAuthAccountId[]
  now?: number
  routeBindings?: Readonly<Record<string, OAuthAccountId>>
} = {}) {
  const fakeProvider = options.provider ?? provider()
  const store = options.store ?? new FakeOAuthStore()
  const publisher = options.publisher ?? new FakeCredentialPublisher()
  const ids = options.ids ?? [firstId]
  return {
    provider: fakeProvider,
    store,
    publisher,
    service: new OAuthServiceImpl({
      providers: [fakeProvider],
      store,
      publisher,
      refreshWindowMs: 30_000,
      now: () => options.now ?? 90_000,
      createAccountId: () => ids.shift()!,
      routeBindings: options.routeBindings,
    }),
  }
}

describe('OAuth P1 regressions', () => {
  it('rejects unknown or empty route bindings during construction', () => {
    expect(() => service({ routeBindings: { unknown: firstId } })).toThrowError(
      expect.objectContaining({ code: 'configuration' }),
    )
    expect(() => service({ routeBindings: { 'openai-codex': '' as OAuthAccountId } })).toThrowError(
      expect.objectContaining({ code: 'configuration' }),
    )
  })

  it('keeps a rotated credential unusable until publication succeeds and never leaves the old bridge value', async () => {
    const backing = new FakeCredentialPublisher()
    let publishes = 0
    const publisher: OAuthCredentialPublisher = {
      async publish(ref, value) {
        publishes += 1
        if (publishes === 2) throw new Error('publish failed with unsafe detail')
        await backing.publish(ref, value)
      },
      clear: ref => backing.clear(ref),
    }
    const setup = service({ publisher, now: 1_000 })
    setup.provider.loginResults.push(credential())
    const account = await setup.service.login(setup.provider.id)
    const initial = await setup.service.accountCredential(account.id)
    expect(backing.values.get(initial.credentialRef)).toBe('access-old-secret')

    setup.provider.refreshResults.push(credential({
      accessToken: 'access-new-secret',
      refreshToken: 'refresh-new-secret',
      expiresAt: 200_000,
    }))
    await expect(setup.service.rotate(account.id)).rejects.toMatchObject({ code: 'storage-unavailable' })
    expect((await setup.store.get(account.id))?.account.status).toBe('error')
    expect((await setup.store.get(account.id))?.credential.refreshToken).toBe('refresh-new-secret')
    expect(backing.values.has(initial.credentialRef)).toBe(false)

    await expect(setup.service.accountCredential(account.id)).resolves.toMatchObject({ credentialRef: initial.credentialRef })
    expect(setup.provider.refreshCalls).toHaveLength(1)
    expect(backing.values.get(initial.credentialRef)).toBe('access-new-secret')
    expect((await setup.store.get(account.id))?.account.status).toBe('ready')
  })

  it('rehydrates a fresh stored account into an empty publisher after service restart', async () => {
    const first = service({ now: 1_000 })
    first.provider.loginResults.push(credential({ expiresAt: 200_000 }))
    const account = await first.service.login(first.provider.id)
    const association = await first.service.accountCredential(account.id)
    await first.publisher.clear(association.credentialRef)

    const restarted = service({
      provider: first.provider,
      store: first.store,
      publisher: first.publisher,
      now: 1_000,
    })
    await restarted.service.ensureFresh(account.id)

    expect((first.publisher as FakeCredentialPublisher).values.get(association.credentialRef)).toBe('access-old-secret')
    expect(first.provider.refreshCalls).toHaveLength(0)
  })

  it('clears a published token when the ready-state commit fails and contains clear failure', async () => {
    const backingStore = new FakeOAuthStore()
    let puts = 0
    const store: OAuthCredentialStore = {
      list: signal => backingStore.list(signal),
      get: (accountId, signal) => backingStore.get(accountId, signal),
      async put(record) {
        puts += 1
        if (puts === 4) throw new Error('ready commit failed')
        await backingStore.put(record)
      },
      delete: accountId => backingStore.delete(accountId),
    }
    const publisher = new FakeCredentialPublisher()
    const setup = service({ store, publisher, now: 1_000 })
    setup.provider.loginResults.push(credential())
    const account = await setup.service.login(setup.provider.id)
    const association = await setup.service.accountCredential(account.id)
    setup.provider.refreshResults.push(credential({ expiresAt: 200_000 }))

    await expect(setup.service.rotate(account.id)).rejects.toMatchObject({ code: 'storage-unavailable' })
    expect(publisher.values.has(association.credentialRef)).toBe(false)
    expect((await backingStore.get(account.id))?.account.status).toBe('error')

    const failingPublisher: OAuthCredentialPublisher = {
      async publish() { throw new Error('publish failed') },
      async clear() { throw new Error('clear failed') },
    }
    const contained = service({ publisher: failingPublisher, now: 1_000 })
    contained.provider.loginResults.push(credential())
    await expect(contained.service.login(contained.provider.id)).rejects.toMatchObject({ code: 'storage-unavailable' })
  })

  it('checks disposal after the rotated-store commit and after bridge publication', async () => {
    const backingStore = new FakeOAuthStore()
    const delayedPut = deferred<void>()
    const putStarted = deferred<void>()
    let puts = 0
    const store: OAuthCredentialStore = {
      list: signal => backingStore.list(signal),
      get: (accountId, signal) => backingStore.get(accountId, signal),
      async put(record) {
        puts += 1
        if (puts === 3) {
          putStarted.resolve()
          await delayedPut.promise
        }
        await backingStore.put(record)
      },
      delete: accountId => backingStore.delete(accountId),
    }
    const stored = service({ store, now: 1_000 })
    stored.provider.loginResults.push(credential())
    const storedAccount = await stored.service.login(stored.provider.id)
    stored.provider.refreshResults.push(credential({ expiresAt: 200_000 }))
    const rotating = stored.service.rotate(storedAccount.id)
    await putStarted.promise
    const disposal = stored.service.dispose()
    delayedPut.resolve()
    await expect(rotating).rejects.toMatchObject({ code: 'internal' })
    await disposal

    const backingPublisher = new FakeCredentialPublisher()
    const delayedPublish = deferred<void>()
    const publishStarted = deferred<void>()
    let publishes = 0
    const publisher: OAuthCredentialPublisher = {
      async publish(ref, value) {
        publishes += 1
        if (publishes === 2) {
          publishStarted.resolve()
          await delayedPublish.promise
        }
        await backingPublisher.publish(ref, value)
      },
      clear: ref => backingPublisher.clear(ref),
    }
    const published = service({ publisher, now: 1_000 })
    published.provider.loginResults.push(credential())
    const publishedAccount = await published.service.login(published.provider.id)
    const association = await published.service.accountCredential(publishedAccount.id)
    published.provider.refreshResults.push(credential({ expiresAt: 200_000 }))
    const publishing = published.service.rotate(publishedAccount.id)
    await publishStarted.promise
    const publishedDisposal = published.service.dispose()
    delayedPublish.resolve()
    await expect(publishing).rejects.toMatchObject({ code: 'internal' })
    await publishedDisposal
    expect(backingPublisher.values.has(association.credentialRef)).toBe(false)
  })

  it('uses account-scoped credential refs and an explicit route binding for multiple accounts', async () => {
    const setup = service({
      ids: [firstId, secondId],
      now: 1_000,
      routeBindings: { 'openai-codex': secondId },
    })
    setup.provider.loginResults.push(
      credential({ subject: 'subject-a', accessToken: 'access-a' }),
      credential({ subject: 'subject-b', accessToken: 'access-b' }),
    )
    const first = await setup.service.login(setup.provider.id)
    const second = await setup.service.login(setup.provider.id)
    const firstAssociation = await setup.service.accountCredential(first.id)
    const secondAssociation = await setup.service.accountCredential(second.id)

    expect(firstAssociation.credentialRef).not.toBe(secondAssociation.credentialRef)
    await expect(setup.service.ensureFreshForRoute(setup.provider.route)).resolves.toMatchObject({
      account: { id: secondId },
      credentialRef: secondAssociation.credentialRef,
    })

    await setup.service.logout(first.id)
    expect((setup.publisher as FakeCredentialPublisher).values.get(secondAssociation.credentialRef)).toBe('access-b')
    expect((setup.publisher as FakeCredentialPublisher).values.has(firstAssociation.credentialRef)).toBe(false)
  })

  it('reports the configured account when a route binding has no stored account', async () => {
    const setup = service({ routeBindings: { 'openai-codex': secondId } })

    await expect(setup.service.ensureFreshForRoute(setup.provider.route)).rejects.toMatchObject({
      code: 'reauth-required',
      provider: setup.provider.id,
      accountId: secondId,
    })
  })

  it('rejects an account that stops being ready after the freshness barrier', async () => {
    const initial = service({ now: 1_000 })
    initial.provider.loginResults.push(credential({ expiresAt: 200_000 }))
    const account = await initial.service.login(initial.provider.id)
    let reads = 0
    const store: OAuthCredentialStore = {
      list: signal => initial.store.list(signal),
      async get(accountId, signal) {
        const record = await initial.store.get(accountId, signal)
        reads += 1
        return reads === 2 && record !== undefined
          ? { ...record, account: { ...record.account, status: 'error' } }
          : record
      },
      put: record => initial.store.put(record),
      delete: accountId => initial.store.delete(accountId),
    }
    const guarded = service({ provider: initial.provider, store, publisher: initial.publisher, now: 1_000 })

    await expect(guarded.service.accountCredential(account.id)).rejects.toMatchObject({
      code: 'reauth-required',
      accountId: account.id,
    })
  })

  it('cancels login after provider resolution while the initial store commit is pending', async () => {
    const backing = new FakeOAuthStore()
    const commit = deferred<void>()
    const commitStarted = deferred<void>()
    const store: OAuthCredentialStore = {
      list: signal => backing.list(signal),
      get: (accountId, signal) => backing.get(accountId, signal),
      async put(record) {
        commitStarted.resolve()
        await commit.promise
        await backing.put(record)
      },
      delete: accountId => backing.delete(accountId),
    }
    const setup = service({ store })
    setup.provider.loginResults.push(credential())
    const controller = new AbortController()
    const login = setup.service.login(setup.provider.id, { signal: controller.signal })
    await commitStarted.promise
    controller.abort()
    commit.resolve()

    await expect(login).rejects.toMatchObject({ code: 'login-cancelled' })
    expect((setup.publisher as FakeCredentialPublisher).values.size).toBe(0)
  })

  it('honors cancellation that races with registration of the first account-flight waiter', async () => {
    const backing = new FakeOAuthStore()
    const initial = service({ store: backing, now: 1_000 })
    initial.provider.loginResults.push(credential({ expiresAt: 200_000 }))
    await initial.service.login(initial.provider.id)
    const controller = new AbortController()
    let abortedDuringRead = false
    const store: OAuthCredentialStore = {
      list: signal => backing.list(signal),
      get(accountId, signal) {
        if (!abortedDuringRead) {
          abortedDuringRead = true
          controller.abort()
        }
        return backing.get(accountId, signal)
      },
      put: record => backing.put(record),
      delete: accountId => backing.delete(accountId),
    }
    const guarded = service({ provider: initial.provider, store, publisher: initial.publisher, now: 1_000 })

    await expect(guarded.service.ensureFresh(firstId, { signal: controller.signal })).rejects.toMatchObject({
      code: 'refresh-temporary',
      retryable: true,
    })
  })

  it('rejects a route association that changes after its freshness barrier', async () => {
    const initial = service({ now: 1_000 })
    initial.provider.loginResults.push(credential({ expiresAt: 200_000 }))
    const account = await initial.service.login(initial.provider.id)
    let reads = 0
    const store: OAuthCredentialStore = {
      list: signal => initial.store.list(signal),
      async get(accountId, signal) {
        const record = await initial.store.get(accountId, signal)
        reads += 1
        return reads === 2 && record !== undefined
          ? { ...record, account: { ...record.account, provider: 'changed-provider' } }
          : record
      },
      put: record => initial.store.put(record),
      delete: accountId => initial.store.delete(accountId),
    }
    const guarded = service({ provider: initial.provider, store, publisher: initial.publisher, now: 1_000 })

    await expect(guarded.service.ensureFreshForRoute(initial.provider.route)).rejects.toMatchObject({
      code: 'configuration',
      accountId: account.id,
    })
  })

  it('refreshes public credential lookup once and stops retrying after reauthentication is required', async () => {
    const setup = service()
    setup.provider.loginResults.push(credential())
    await setup.service.login(setup.provider.id)
    const held = deferred<OAuthCredential>()
    setup.provider.refreshResults.push(held.promise)

    const first = setup.service.accountCredential(firstId)
    const second = setup.service.accountCredential(firstId)
    await setup.provider.waitForRefreshCalls(1)
    held.resolve(credential({ accessToken: 'access-fresh', refreshToken: 'refresh-fresh', expiresAt: 200_000 }))
    await Promise.all([first, second])
    expect(setup.provider.refreshCalls).toHaveLength(1)

    const failed = service()
    failed.provider.loginResults.push(credential())
    await failed.service.login(failed.provider.id)
    failed.provider.refreshResults.push(new OAuthError({ code: 'reauth-required' }))
    await expect(failed.service.accountCredential(firstId)).rejects.toMatchObject({ code: 'reauth-required' })
    await expect(failed.service.accountCredential(firstId)).rejects.toMatchObject({ code: 'reauth-required' })
    expect(failed.provider.refreshCalls).toHaveLength(1)
  })

  it('fails closed for a managed route with no account', async () => {
    const setup = service()
    await expect(setup.service.ensureFreshForRoute(setup.provider.route)).rejects.toMatchObject({
      code: 'reauth-required',
      provider: setup.provider.id,
    })
  })

  it('retains a revoked record when bridge clearing fails so logout and disposal can retry it', async () => {
    const backing = new FakeCredentialPublisher()
    let clears = 0
    const publisher: OAuthCredentialPublisher = {
      publish: (ref, value) => backing.publish(ref, value),
      async clear(ref) {
        clears += 1
        if (clears === 1) throw new Error('clear failed with unsafe detail')
        await backing.clear(ref)
      },
    }
    const setup = service({ publisher, now: 1_000 })
    setup.provider.loginResults.push(credential())
    const account = await setup.service.login(setup.provider.id)
    const association = await setup.service.accountCredential(account.id)

    await expect(setup.service.logout(account.id)).rejects.toMatchObject({ code: 'storage-unavailable' })
    expect((await setup.store.get(account.id))?.account.status).toBe('revoked')
    expect(backing.values.has(association.credentialRef)).toBe(true)

    await expect(setup.service.logout(account.id)).resolves.toBeUndefined()
    expect(await setup.store.get(account.id)).toBeUndefined()
    expect(backing.values.has(association.credentialRef)).toBe(false)
  })

  it('creates the account flight before a delayed stale snapshot can start a second refresh decision', async () => {
    const backing = new FakeOAuthStore()
    const delayed = deferred<StoredOAuthAccount | undefined>()
    let reads = 0
    const store: OAuthCredentialStore = {
      list: signal => backing.list(signal),
      get(accountId, signal) {
        reads += 1
        if (reads === 1) return delayed.promise
        return backing.get(accountId, signal)
      },
      put: record => backing.put(record),
      delete: accountId => backing.delete(accountId),
    }
    const setup = service({ store })
    setup.provider.loginResults.push(credential())
    await setup.service.login(setup.provider.id)
    const stale = await backing.get(firstId)
    if (stale === undefined) throw new Error('missing fixture record')
    const refresh = deferred<OAuthCredential>()
    setup.provider.refreshResults.push(refresh.promise)

    const first = setup.service.ensureFresh(firstId)
    const second = setup.service.ensureFresh(firstId)
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBe(1)
    delayed.resolve(stale)
    await setup.provider.waitForRefreshCalls(1)
    refresh.resolve(credential({ expiresAt: 200_000 }))
    await Promise.all([first, second])
    expect(setup.provider.refreshCalls).toHaveLength(1)
  })

  it('runs a forced rotation after an active non-forced fresh check completes', async () => {
    const backing = new FakeOAuthStore()
    const delayed = deferred<StoredOAuthAccount | undefined>()
    let delayNextRead = false
    let reads = 0
    const store: OAuthCredentialStore = {
      list: signal => backing.list(signal),
      get(accountId, signal) {
        reads += 1
        if (delayNextRead) {
          delayNextRead = false
          return delayed.promise
        }
        return backing.get(accountId, signal)
      },
      put: record => backing.put(record),
      delete: accountId => backing.delete(accountId),
    }
    const setup = service({ store, now: 1_000 })
    setup.provider.loginResults.push(credential({ expiresAt: 200_000 }))
    await setup.service.login(setup.provider.id)
    const fresh = await backing.get(firstId)
    if (fresh === undefined) throw new Error('missing fixture record')
    delayNextRead = true
    setup.provider.refreshResults.push(credential({ expiresAt: 300_000 }))

    const checking = setup.service.ensureFresh(firstId)
    const rotating = setup.service.rotate(firstId)
    await Promise.resolve()
    delayed.resolve(fresh)
    await Promise.all([checking, rotating])

    expect(reads).toBeGreaterThanOrEqual(2)
    expect(setup.provider.refreshCalls).toHaveLength(1)
  })

  it.each(['accounts', 'accountCredential', 'ensureFreshForRoute'] as const)(
    'tracks and aborts the initial store read for %s',
    async operation => {
      const read = deferred<readonly StoredOAuthAccount[] | StoredOAuthAccount | undefined>()
      let observedSignal: AbortSignal | undefined
      const store: OAuthCredentialStore = {
        list(signal) {
          observedSignal = signal
          signal?.addEventListener('abort', () => read.reject(new DOMException('aborted', 'AbortError')), { once: true })
          return read.promise as Promise<readonly StoredOAuthAccount[]>
        },
        get(_accountId, signal) {
          observedSignal = signal
          signal?.addEventListener('abort', () => read.reject(new DOMException('aborted', 'AbortError')), { once: true })
          return read.promise as Promise<StoredOAuthAccount | undefined>
        },
        async put() {},
        async delete() {},
      }
      const setup = service({ store })
      const controller = new AbortController()
      const pending = operation === 'accounts'
        ? setup.service.accounts(undefined, { signal: controller.signal })
        : operation === 'accountCredential'
          ? setup.service.accountCredential(firstId, { signal: controller.signal })
          : setup.service.ensureFreshForRoute(setup.provider.route, { signal: controller.signal })
      await vi.waitFor(() => expect(observedSignal).toBeDefined())
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'refresh-temporary' })
      expect(observedSignal?.aborted).toBe(true)
    },
  )

  it.each(['accounts', 'accountCredential', 'ensureFreshForRoute'] as const)(
    'aborts and drains the initial store read for %s during disposal',
    async operation => {
      const read = deferred<readonly StoredOAuthAccount[] | StoredOAuthAccount | undefined>()
      let observedSignal: AbortSignal | undefined
      const store: OAuthCredentialStore = {
        list(signal) {
          observedSignal = signal
          signal?.addEventListener('abort', () => read.reject(new DOMException('aborted', 'AbortError')), { once: true })
          return read.promise as Promise<readonly StoredOAuthAccount[]>
        },
        get(_accountId, signal) {
          observedSignal = signal
          signal?.addEventListener('abort', () => read.reject(new DOMException('aborted', 'AbortError')), { once: true })
          return read.promise as Promise<StoredOAuthAccount | undefined>
        },
        async put() {},
        async delete() {},
      }
      const setup = service({ store })
      const pending = operation === 'accounts'
        ? setup.service.accounts()
        : operation === 'accountCredential'
          ? setup.service.accountCredential(firstId)
          : setup.service.ensureFreshForRoute(setup.provider.route)
      await vi.waitFor(() => expect(observedSignal).toBeDefined())
      const disposal = setup.service.dispose()

      expect(observedSignal?.aborted).toBe(true)
      await expect(pending).rejects.toMatchObject({ code: 'internal' })
      await disposal
    },
  )
})
