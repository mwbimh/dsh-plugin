import { describe, expect, it } from 'vitest'
import { OAuthError } from '../src/errors.ts'
import { FakeCredentialPublisher, FakeOAuthProvider, FakeOAuthStore, deferred } from '../src/fakes.ts'
import { OAuthServiceImpl } from '../src/service.ts'
import type {
  OAuthAccountId,
  OAuthCredential,
  OAuthCredentialPublisher,
  OAuthCredentialStore,
  OAuthProvider,
  StoredOAuthAccount,
} from '../src/types.ts'

const accountId = 'account-1' as OAuthAccountId
const refreshWindowMs = 30_000

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    accessToken: 'access-initial-secret',
    refreshToken: 'refresh-initial-secret',
    expiresAt: 100_000,
    provider: 'openai-codex',
    subject: 'subject-1',
    displayName: 'Codex account',
    scopes: ['openid', 'model.read'],
    audience: 'codex-api',
    issuer: 'https://issuer.example',
    route: 'openai-codex',
    ...overrides,
  }
}

function credentialWithoutIdentity(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    accessToken: 'access-no-identity',
    refreshToken: 'refresh-no-identity',
    expiresAt: 100_000,
    provider: 'openai-codex',
    scopes: ['openid', 'model.read'],
    audience: 'codex-api',
    issuer: 'https://issuer.example',
    route: 'openai-codex',
    ...overrides,
  }
}

function providerWith(overrides: Partial<{
  id: string
  route: string
  credentialRef: string
  issuer: string
  audience: string
  scopes: readonly string[]
}> = {}): FakeOAuthProvider {
  return new FakeOAuthProvider({
    id: 'openai-codex',
    route: 'openai-codex',
    credentialRef: 'DSH_OAUTH_CODEX',
    issuer: 'https://issuer.example',
    audience: 'codex-api',
    scopes: ['openid', 'model.read'],
    ...overrides,
  })
}

function stored(
  accountProvider = 'openai-codex',
  storedCredential: OAuthCredential = credential(),
): StoredOAuthAccount {
  return {
    account: {
      id: accountId,
      provider: accountProvider,
      scopes: [...storedCredential.scopes],
      status: 'ready',
      expiresAt: storedCredential.expiresAt,
      createdAt: 1,
      updatedAt: 1,
    },
    credential: storedCredential,
  }
}

function setup(now = 1_000) {
  const store = new FakeOAuthStore()
  const publisher = new FakeCredentialPublisher()
  const provider = new FakeOAuthProvider({
    id: 'openai-codex',
    route: 'openai-codex',
    credentialRef: 'DSH_OAUTH_CODEX',
    issuer: 'https://issuer.example',
    audience: 'codex-api',
    scopes: ['openid', 'model.read'],
  })
  const service = new OAuthServiceImpl({
    providers: [provider],
    store,
    publisher,
    refreshWindowMs,
    now: () => now,
    createAccountId: () => accountId,
  })
  return { provider, publisher, service, store }
}

describe('OAuthServiceImpl', () => {
  it('rejects invalid refresh policies and provider ownership at load time', () => {
    const store = new FakeOAuthStore()
    const publisher = new FakeCredentialPublisher()
    const construct = (providers: readonly OAuthProvider[], window = refreshWindowMs) => new OAuthServiceImpl({
      providers,
      store,
      publisher,
      refreshWindowMs: window,
    })

    expect(() => construct([], Number.NaN)).toThrowError(expect.objectContaining({ code: 'configuration' }))
    expect(() => construct([], -1)).toThrowError(expect.objectContaining({ code: 'configuration' }))
    for (const invalid of [
      providerWith({ id: '' }),
      providerWith({ route: '' }),
      providerWith({ credentialRef: '' }),
      providerWith({ issuer: '' }),
      providerWith({ audience: '' }),
    ]) {
      expect(() => construct([invalid])).toThrowError(expect.objectContaining({ code: 'configuration' }))
    }
    expect(() => construct([providerWith(), providerWith({ route: 'second', credentialRef: 'SECOND' })]))
      .toThrowError(expect.objectContaining({ code: 'configuration' }))
    expect(() => construct([providerWith(), providerWith({ id: 'second', route: 'second' })]))
      .toThrowError(expect.objectContaining({ code: 'configuration' }))
  })

  it('uses default clock and UUID generation and sorts filtered account metadata stably', async () => {
    const provider = providerWith()
    const store = new FakeOAuthStore()
    const service = new OAuthServiceImpl({
      providers: [provider],
      store,
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
    })
    provider.loginResults.push(credential())
    const generated = await service.login(provider.id)
    expect(generated.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(generated.createdAt).toBeGreaterThan(0)

    const ids = ['b', 'a', 'c'] as OAuthAccountId[]
    const times = [2, 1, 1]
    const sortedProvider = providerWith()
    const sortedService = new OAuthServiceImpl({
      providers: [sortedProvider],
      store: new FakeOAuthStore(),
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
      now: () => times.shift()!,
      createAccountId: () => ids.shift()!,
    })
    sortedProvider.loginResults.push(credential(), credential(), credential())
    await sortedService.login(sortedProvider.id)
    await sortedService.login(sortedProvider.id)
    await sortedService.login(sortedProvider.id)
    expect((await sortedService.accounts(sortedProvider.id)).map(account => account.id)).toEqual(['a', 'c', 'b'])
    expect(await sortedService.accounts('missing')).toEqual([])
  })

  it('persists a structured login credential before publishing access and returns token-free metadata', async () => {
    const { provider, publisher, service, store } = setup()
    provider.loginResults.push(credential())

    const account = await service.login('openai-codex')

    expect(account).toMatchObject({ id: accountId, provider: 'openai-codex', scopes: ['openid', 'model.read'], status: 'ready' })
    expect(account).not.toHaveProperty('accessToken')
    expect(account).not.toHaveProperty('refreshToken')
    expect(store.events[0]).toMatchObject({ kind: 'put', accountId })
    expect(publisher.events[0]).toMatchObject({ kind: 'publish', credentialRef: 'DSH_OAUTH_CODEX' })
    expect(store.events[0]!.sequence).toBeLessThan(publisher.events[0]!.sequence)

    const resolved = await service.accountCredential(accountId)
    expect(resolved).toEqual({ account, credentialRef: 'DSH_OAUTH_CODEX' })
    expect(JSON.stringify(resolved)).not.toContain('access-initial-secret')
    expect(JSON.stringify(resolved)).not.toContain('refresh-initial-secret')
  })

  it('classifies login failure, cancellation, and bridge publication failure', async () => {
    await expect(setup().service.login('missing-provider')).rejects.toEqual(expect.objectContaining({
      code: 'configuration',
      accountId: undefined,
    }))

    const failed = setup()
    failed.provider.loginResults.push(new Error('unsafe provider detail'))
    await expect(failed.service.login(failed.provider.id)).rejects.toMatchObject({ code: 'token-exchange' })

    const preAborted = setup()
    preAborted.provider.loginResults.push(credential())
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort()
    await expect(preAborted.service.login(preAborted.provider.id, { signal: alreadyCancelled.signal }))
      .rejects.toMatchObject({ code: 'login-cancelled' })

    const held = deferred<OAuthCredential>()
    const activeAbort = setup()
    activeAbort.provider.loginResults.push(held.promise)
    const caller = new AbortController()
    const login = activeAbort.service.login(activeAbort.provider.id, { signal: caller.signal })
    caller.abort()
    await expect(login).rejects.toMatchObject({ code: 'login-cancelled' })

    const provider = providerWith()
    provider.loginResults.push(credential())
    const store = new FakeOAuthStore()
    const publisher: OAuthCredentialPublisher = {
      async publish() { throw new Error('unsafe publish detail') },
      async clear() {},
    }
    const service = new OAuthServiceImpl({
      providers: [provider],
      store,
      publisher,
      refreshWindowMs,
      now: () => 1,
      createAccountId: () => accountId,
    })
    await expect(service.login(provider.id)).rejects.toMatchObject({ code: 'storage-unavailable' })
    expect((await store.get(accountId))?.account.status).toBe('error')
  })

  it('stops a login after an ignoring provider observes caller cancellation', async () => {
    const result = deferred<OAuthCredential>()
    const fake = providerWith()
    const provider: OAuthProvider = {
      id: fake.id,
      route: fake.route,
      credentialRef: fake.credentialRef,
      issuer: fake.issuer,
      audience: fake.audience,
      scopes: fake.scopes,
      async login() { return await result.promise },
      async refresh(value) { return value },
    }
    const service = new OAuthServiceImpl({
      providers: [provider],
      store: new FakeOAuthStore(),
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
    })
    const controller = new AbortController()
    const login = service.login(provider.id, { signal: controller.signal })
    controller.abort()
    result.resolve(credential())
    await expect(login).rejects.toMatchObject({ code: 'login-cancelled' })
  })

  it('rotates once per account and stores the new refresh credential before publishing access', async () => {
    const { provider, publisher, service, store } = setup(90_000)
    provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await service.login('openai-codex')
    provider.refreshResults.push(credential({ accessToken: 'access-rotated-secret', refreshToken: 'refresh-rotated-secret', expiresAt: 200_000 }))

    await Promise.all([service.ensureFresh(accountId), service.ensureFresh(accountId)])

    expect(provider.refreshCalls).toHaveLength(1)
    const rotationPut = store.events.at(-1)
    const rotationPublish = publisher.events.at(-1)
    expect(rotationPut!.sequence).toBeLessThan(rotationPublish!.sequence)
    expect((await store.get(accountId))?.credential.refreshToken).toBe('refresh-rotated-secret')
    expect(publisher.values.get('DSH_OAUTH_CODEX')).toBe('access-rotated-secret')
  })

  it('skips fresh credentials, supports forced rotation, and resolves managed routes', async () => {
    const { provider, service } = setup(1_000)
    provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await service.login(provider.id)
    await service.ensureFresh(accountId)
    expect(provider.refreshCalls).toHaveLength(0)

    provider.refreshResults.push(credential({ expiresAt: 200_000 }))
    await service.rotate(accountId)
    expect(provider.refreshCalls).toHaveLength(1)
    await expect(service.ensureFreshForRoute(provider.route)).resolves.toMatchObject({ credentialRef: provider.credentialRef })

    await expect(new OAuthServiceImpl({
      providers: [],
      store: new FakeOAuthStore(),
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
    }).ensureFreshForRoute('unmanaged')).resolves.toBeUndefined()

    const noAccount = new OAuthServiceImpl({
      providers: [providerWith()],
      store: new FakeOAuthStore(),
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
    })
    await expect(noAccount.ensureFreshForRoute('openai-codex')).resolves.toBeUndefined()
  })

  it('marks existing and refreshed authorization mismatches for reauthentication', async () => {
    const existing = setup(90_000)
    existing.provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await existing.service.login(existing.provider.id)
    await existing.store.put(stored(existing.provider.id, credential({ issuer: 'https://forged.example' })))
    await expect(existing.service.ensureFresh(accountId)).rejects.toMatchObject({ code: 'reauth-required' })
    expect((await existing.store.get(accountId))?.account.status).toBe('reauth-required')

    const refreshed = setup(90_000)
    refreshed.provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await refreshed.service.login(refreshed.provider.id)
    refreshed.provider.refreshResults.push(credential({ issuer: 'https://forged.example', expiresAt: 200_000 }))
    await expect(refreshed.service.ensureFresh(accountId)).rejects.toMatchObject({ code: 'reauth-required' })
    expect((await refreshed.store.get(accountId))?.account.status).toBe('reauth-required')
  })

  it('preserves or omits optional identity metadata across rotation', async () => {
    const preserving = setup(90_000)
    preserving.provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await preserving.service.login(preserving.provider.id)
    preserving.provider.refreshResults.push(credentialWithoutIdentity({ expiresAt: 200_000 }))
    await preserving.service.rotate(accountId)
    expect((await preserving.service.accounts())[0]).toMatchObject({ displayName: 'Codex account', subject: 'subject-1' })

    const omitting = setup(90_000)
    omitting.provider.loginResults.push(credentialWithoutIdentity({ expiresAt: 100_000 }))
    await omitting.service.login(omitting.provider.id)
    omitting.provider.refreshResults.push(credentialWithoutIdentity({ expiresAt: 200_000 }))
    await omitting.service.rotate(accountId)
    const account = (await omitting.service.accounts())[0]!
    expect(account).not.toHaveProperty('displayName')
    expect(account).not.toHaveProperty('subject')
  })

  it('uses independent refresh flights for different accounts', async () => {
    const store = new FakeOAuthStore()
    const publisher = new FakeCredentialPublisher()
    const provider = new FakeOAuthProvider({
      id: 'openai-codex',
      route: 'openai-codex',
      credentialRef: 'DSH_OAUTH_CODEX',
      issuer: 'https://issuer.example',
      audience: 'codex-api',
      scopes: ['openid', 'model.read'],
    })
    const accountIds = ['account-1', 'account-2'] as OAuthAccountId[]
    const service = new OAuthServiceImpl({
      providers: [provider],
      store,
      publisher,
      refreshWindowMs,
      now: () => 90_000,
      createAccountId: () => accountIds.shift()!,
    })
    provider.loginResults.push(credential({ subject: 'subject-1' }), credential({ subject: 'subject-2' }))
    const first = await service.login('openai-codex')
    const second = await service.login('openai-codex')
    await expect(service.ensureFreshForRoute('openai-codex')).rejects.toMatchObject({ code: 'configuration' })
    const firstRefresh = deferred<OAuthCredential>()
    const secondRefresh = deferred<OAuthCredential>()
    provider.refreshResults.push(firstRefresh.promise, secondRefresh.promise)

    const firstFlight = service.ensureFresh(first.id)
    const secondFlight = service.ensureFresh(second.id)
    await provider.waitForRefreshCalls(2)
    expect(provider.refreshCalls).toHaveLength(2)
    expect(provider.refreshCalls[0]!.signal).not.toBe(provider.refreshCalls[1]!.signal)
    firstRefresh.resolve(credential({ accessToken: 'first-new', refreshToken: 'first-refresh', expiresAt: 200_000 }))
    secondRefresh.resolve(credential({ accessToken: 'second-new', refreshToken: 'second-refresh', expiresAt: 200_000 }))
    await Promise.all([firstFlight, secondFlight])
  })

  it('cancels one waiter without aborting the shared account refresh', async () => {
    const { provider, service } = setup(90_000)
    provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await service.login('openai-codex')
    const heldRefresh = deferred<OAuthCredential>()
    provider.refreshResults.push(heldRefresh.promise)
    const caller = new AbortController()

    const cancelledWaiter = service.ensureFresh(accountId, { signal: caller.signal })
    const survivingWaiter = service.ensureFresh(accountId)
    await provider.waitForRefreshCalls(1)
    caller.abort()

    await expect(cancelledWaiter).rejects.toMatchObject({ code: 'refresh-temporary', retryable: true })
    expect(provider.refreshCalls[0]!.signal.aborted).toBe(false)
    heldRefresh.resolve(credential({ expiresAt: 200_000 }))
    await expect(survivingWaiter).resolves.toBeUndefined()
    expect(provider.refreshCalls).toHaveLength(1)
  })

  it('persists reauth-required status after a terminal refresh failure', async () => {
    const { provider, service } = setup(90_000)
    provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await service.login('openai-codex')
    provider.refreshResults.push(new OAuthError({ code: 'reauth-required', provider: provider.id }))

    await expect(service.ensureFresh(accountId)).rejects.toMatchObject({ code: 'reauth-required' })
    expect((await service.accounts())[0]).toMatchObject({ id: accountId, status: 'reauth-required' })
  })

  it('classifies temporary refresh failures for signalled and pre-cancelled waiters', async () => {
    const signalled = setup(90_000)
    signalled.provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await signalled.service.login(signalled.provider.id)
    signalled.provider.refreshResults.push(new Error('temporary unsafe detail'))
    const active = new AbortController()
    await expect(signalled.service.ensureFresh(accountId, { signal: active.signal }))
      .rejects.toMatchObject({ code: 'refresh-temporary', retryable: true })

    const preCancelled = setup(90_000)
    preCancelled.provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await preCancelled.service.login(preCancelled.provider.id)
    const held = deferred<OAuthCredential>()
    preCancelled.provider.refreshResults.push(held.promise)
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(preCancelled.service.ensureFresh(accountId, { signal: cancelled.signal }))
      .rejects.toMatchObject({ code: 'refresh-temporary', retryable: true })
    held.resolve(credential({ expiresAt: 200_000 }))
    await preCancelled.provider.waitForRefreshCalls(1)

    const resolving = setup(90_000)
    resolving.provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await resolving.service.login(resolving.provider.id)
    resolving.provider.refreshResults.push(credential({ expiresAt: 200_000 }))
    await expect(resolving.service.ensureFresh(accountId, { signal: new AbortController().signal })).resolves.toBeUndefined()
  })

  it('persists rotated credentials before surfacing bridge publication failure', async () => {
    const provider = providerWith()
    const store = new FakeOAuthStore()
    let publishes = 0
    const publisher: OAuthCredentialPublisher = {
      async publish() {
        publishes += 1
        if (publishes > 1) throw new Error('unsafe publish detail')
      },
      async clear() {},
    }
    const service = new OAuthServiceImpl({
      providers: [provider],
      store,
      publisher,
      refreshWindowMs,
      now: () => 90_000,
      createAccountId: () => accountId,
    })
    provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await service.login(provider.id)
    provider.refreshResults.push(credential({ refreshToken: 'persisted-before-publish', expiresAt: 200_000 }))
    await expect(service.rotate(accountId)).rejects.toMatchObject({ code: 'storage-unavailable' })
    expect((await store.get(accountId))?.credential.refreshToken).toBe('persisted-before-publish')
    expect((await store.get(accountId))?.account.status).toBe('error')
  })

  it('blocks new work on logout, drains refresh, clears local state despite revoke failure, and rejects disposed work', async () => {
    const { provider, publisher, service, store } = setup(90_000)
    provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await service.login('openai-codex')
    const heldRefresh = deferred<OAuthCredential>()
    provider.refreshResults.push(heldRefresh.promise)
    provider.revokeError = new Error('remote response included refresh-initial-secret')

    const refreshing = service.ensureFresh(accountId)
    await provider.waitForRefreshCalls(1)
    const logout = service.logout(accountId)
    await expect(service.ensureFresh(accountId)).rejects.toMatchObject({ code: 'reauth-required' })
    heldRefresh.reject(new DOMException('aborted', 'AbortError'))

    await expect(refreshing).rejects.toBeInstanceOf(OAuthError)
    await expect(logout).resolves.toBeUndefined()
    expect(await store.get(accountId)).toBeUndefined()
    expect(publisher.values.has('DSH_OAUTH_CODEX')).toBe(false)
    expect(provider.revokeCalls).toHaveLength(1)
    const clear = publisher.events.at(-1)
    const deletion = store.events.at(-1)
    expect(clear!.sequence).toBeLessThan(deletion!.sequence)

    await service.dispose()
    await expect(service.login('openai-codex')).rejects.toMatchObject({ code: 'internal' })
  })

  it('dispose aborts and drains in-flight login and refresh operations before clearing bridge values', async () => {
    const { provider, publisher, service } = setup(90_000)
    provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await service.login('openai-codex')
    const heldRefresh = deferred<OAuthCredential>()
    provider.refreshResults.push(heldRefresh.promise)
    const refreshing = service.ensureFresh(accountId)
    await provider.waitForRefreshCalls(1)

    const disposal = service.dispose()
    expect(provider.refreshCalls[0]!.signal.aborted).toBe(true)
    heldRefresh.reject(new DOMException('aborted', 'AbortError'))

    await expect(refreshing).rejects.toBeInstanceOf(OAuthError)
    await disposal
    expect(publisher.values.size).toBe(0)
    await expect(service.ensureFresh(accountId)).rejects.toMatchObject({ code: 'internal' })
    await expect(service.dispose()).resolves.toBeUndefined()
  })

  it('attempts both local logout removals and reports either storage failure safely', async () => {
    const clearProvider = providerWith()
    const clearStore = new FakeOAuthStore()
    const clearPublisher: OAuthCredentialPublisher = {
      async publish() {},
      async clear() { throw new Error('clear secret') },
    }
    const clearService = new OAuthServiceImpl({
      providers: [clearProvider],
      store: clearStore,
      publisher: clearPublisher,
      refreshWindowMs,
      now: () => 1,
      createAccountId: () => accountId,
    })
    clearProvider.loginResults.push(credential())
    await clearService.login(clearProvider.id)
    await expect(clearService.logout(accountId)).rejects.toMatchObject({ code: 'storage-unavailable' })
    expect(await clearStore.get(accountId)).toBeUndefined()

    const deleteProvider = providerWith()
    const backing = new FakeOAuthStore()
    const deleteStore: OAuthCredentialStore = {
      list: () => backing.list(),
      get: id => backing.get(id),
      put: record => backing.put(record),
      async delete() { throw new Error('delete secret') },
    }
    const deletePublisher = new FakeCredentialPublisher()
    const deleteService = new OAuthServiceImpl({
      providers: [deleteProvider],
      store: deleteStore,
      publisher: deletePublisher,
      refreshWindowMs,
      now: () => 1,
      createAccountId: () => accountId,
    })
    deleteProvider.loginResults.push(credential())
    await deleteService.login(deleteProvider.id)
    await expect(deleteService.logout(accountId)).rejects.toMatchObject({ code: 'storage-unavailable' })
    expect(deletePublisher.values.size).toBe(0)
  })

  it('handles missing accounts, store read failure, and providers without revoke during logout', async () => {
    const missing = setup()
    await expect(missing.service.logout(accountId)).resolves.toBeUndefined()

    const failingStore: OAuthCredentialStore = {
      async list() { return [] },
      async get() { throw new Error('unsafe read') },
      async put() {},
      async delete() {},
    }
    const failing = new OAuthServiceImpl({
      providers: [providerWith()],
      store: failingStore,
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
    })
    await expect(failing.logout(accountId)).rejects.toMatchObject({ code: 'storage-unavailable' })

    const fake = providerWith()
    const provider: OAuthProvider = {
      id: fake.id,
      route: fake.route,
      credentialRef: fake.credentialRef,
      issuer: fake.issuer,
      audience: fake.audience,
      scopes: fake.scopes,
      async login() { return credential() },
      async refresh(value) { return value },
    }
    const noRevoke = new OAuthServiceImpl({
      providers: [provider],
      store: new FakeOAuthStore(),
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
      now: () => 1,
      createAccountId: () => accountId,
    })
    await noRevoke.login(provider.id)
    await expect(noRevoke.logout(accountId)).resolves.toBeUndefined()
  })

  it('drains preflight reads and providers that ignore refresh aborts', async () => {
    const backing = new FakeOAuthStore()
    const pendingGet = deferred<StoredOAuthAccount | undefined>()
    const delayedStore: OAuthCredentialStore = {
      list: () => backing.list(),
      get: () => pendingGet.promise,
      put: record => backing.put(record),
      delete: id => backing.delete(id),
    }
    const delayedService = new OAuthServiceImpl({
      providers: [providerWith()],
      store: delayedStore,
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
      now: () => 90_000,
    })
    const preflight = delayedService.ensureFresh(accountId)
    const delayedDisposal = delayedService.dispose()
    pendingGet.resolve(stored())
    await expect(preflight).rejects.toMatchObject({ code: 'internal' })
    await delayedDisposal

    for (const lifecycle of ['dispose', 'logout'] as const) {
      const refreshResult = deferred<OAuthCredential>()
      const refreshStarted = deferred<void>()
      const fake = providerWith()
      const provider: OAuthProvider = {
        id: fake.id,
        route: fake.route,
        credentialRef: fake.credentialRef,
        issuer: fake.issuer,
        audience: fake.audience,
        scopes: fake.scopes,
        async login() { return credential() },
        async refresh() {
          refreshStarted.resolve()
          return await refreshResult.promise
        },
      }
      const store = new FakeOAuthStore()
      await store.put(stored())
      const service = new OAuthServiceImpl({
        providers: [provider],
        store,
        publisher: new FakeCredentialPublisher(),
        refreshWindowMs,
        now: () => 90_000,
      })
      const refreshing = service.ensureFresh(accountId)
      await refreshStarted.promise
      const ending = lifecycle === 'dispose' ? service.dispose() : service.logout(accountId)
      refreshResult.resolve(credential({ expiresAt: 200_000 }))
      await expect(refreshing).rejects.toMatchObject({ code: lifecycle === 'dispose' ? 'internal' : 'reauth-required' })
      await ending
    }
  })

  it('handles disposal store failure and records owned by an unavailable provider', async () => {
    const listFailure: OAuthCredentialStore = {
      async list() { throw new Error('unsafe list') },
      async get() { return undefined },
      async put() {},
      async delete() {},
    }
    await expect(new OAuthServiceImpl({
      providers: [],
      store: listFailure,
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
    }).dispose()).resolves.toBeUndefined()

    const orphaned = new FakeOAuthStore()
    await orphaned.put(stored('removed-provider'))
    await expect(new OAuthServiceImpl({
      providers: [],
      store: orphaned,
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
    }).dispose()).resolves.toBeUndefined()
  })

  it('normalizes store failures, absent accounts, and unavailable stored providers', async () => {
    const writeFailure: OAuthCredentialStore = {
      async list() { return [] },
      async get() { return undefined },
      async put() { throw new Error('unsafe write') },
      async delete() {},
    }
    const writeProvider = providerWith()
    writeProvider.loginResults.push(credential())
    await expect(new OAuthServiceImpl({
      providers: [writeProvider],
      store: writeFailure,
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
    }).login(writeProvider.id)).rejects.toMatchObject({ code: 'storage-unavailable' })

    const readFailure: OAuthCredentialStore = {
      async list() { throw new Error('unsafe list') },
      async get() { throw new Error('unsafe get') },
      async put() {},
      async delete() {},
    }
    const readService = new OAuthServiceImpl({
      providers: [providerWith()],
      store: readFailure,
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
    })
    await expect(readService.accounts()).rejects.toMatchObject({ code: 'storage-unavailable' })
    await expect(readService.accountCredential(accountId)).rejects.toMatchObject({ code: 'storage-unavailable' })

    const absent = setup()
    await expect(absent.service.accountCredential(accountId)).rejects.toMatchObject({ code: 'reauth-required' })

    const orphaned = new FakeOAuthStore()
    await orphaned.put(stored('removed-provider'))
    const orphanedService = new OAuthServiceImpl({
      providers: [],
      store: orphaned,
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
    })
    await expect(orphanedService.accountCredential(accountId)).rejects.toMatchObject({ code: 'configuration' })
  })

  it('keeps the classified failure when status persistence also fails', async () => {
    const backing = new FakeOAuthStore()
    let writes = 0
    const store: OAuthCredentialStore = {
      list: () => backing.list(),
      get: id => backing.get(id),
      async put(record) {
        writes += 1
        if (writes > 1) throw new Error('status write secret')
        await backing.put(record)
      },
      delete: id => backing.delete(id),
    }
    const provider = providerWith()
    const service = new OAuthServiceImpl({
      providers: [provider],
      store,
      publisher: new FakeCredentialPublisher(),
      refreshWindowMs,
      now: () => 90_000,
      createAccountId: () => accountId,
    })
    provider.loginResults.push(credential({ expiresAt: 100_000 }))
    await service.login(provider.id)
    provider.refreshResults.push(new OAuthError({ code: 'reauth-required' }))
    await expect(service.ensureFresh(accountId)).rejects.toMatchObject({ code: 'reauth-required' })
  })

  it('rejects duplicate managed routes during construction', () => {
    const { provider, publisher, store } = setup()
    const duplicate = new FakeOAuthProvider({
      id: 'duplicate',
      route: provider.route,
      credentialRef: 'DSH_OAUTH_DUPLICATE',
      issuer: 'https://duplicate.example',
      audience: 'duplicate-api',
      scopes: ['openid'],
    })

    expect(() => new OAuthServiceImpl({
      providers: [provider, duplicate],
      store,
      publisher,
      refreshWindowMs,
    })).toThrowError(expect.objectContaining({ code: 'route-conflict' }))
  })
})
