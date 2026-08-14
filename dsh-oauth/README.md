# @dsh-plugins/dsh-oauth

OAuth account and short-lived access-token lifecycle support for DeepSeek Harness (DSH).

This package is pre-release. It provides the OAuth plugin runtime and token-free account and credential-reference service types. Its package-local contract harness uses deterministic fake provider, store, and publisher implementations. It does **not** ship a real OpenAI Codex login provider: no public, stable provider authorization protocol has been accepted for this release.

## What it provides

- The namespaced Cordis service `dsh-oauth`.
- Token-free public account metadata and credential-reference lookup for optional consumers such as `dsh-quota`.
- Per-account refresh single-flight, refresh-token rotation ordering, logout, revoke, and disposal behavior.
- One `/dsh-oauth` command with `accounts`, `login`, `logout`, and `rotate` subcommands.
- Package-local fake provider, store, and credential publisher implementations for keyless contract tests.
- A verified credential bridge into DSH `credentials-local` and the existing `llm-pi-ai` `openai-codex` route.

The credential bridge transports one short-lived OAuth access-token string through DSH's credential-reference API. Provider and storage code retain the structured credential state; the access token is not represented to users as an API key. See [ADR 0001](docs/0001-credential-bridge-spike.md).

## Requirements

- Node.js `^22.19.0 || >=24.0.0`.
- pnpm `11.7.0` for workspace development.
- The exact DSH package pins listed in `package.json`; see [Compatibility](#compatibility).

## Install

Build and pack from a checkout:

```sh
pnpm --filter @dsh-plugins/dsh-oauth build
pnpm --dir dsh-oauth pack
```

Install the produced tarball into a DSH profile:

```sh
dsh plugin --profile <profile> add ./dsh-plugins-dsh-oauth-<version>.tgz
```

The package is not yet an npm release. Do not substitute an unpublished registry version for the verified tarball. The shipped bundle row is disabled because this release has no production provider or secret-store composition; installing the tarball proves package and Loader integration but does not enable OAuth login.

## Configure

The only Loader configuration field is the non-secret refresh policy:

```yaml
refreshWindowMs: 30000
```

`refreshWindowMs` is a finite, non-negative duration in milliseconds and defaults to `30000`. Provider endpoints, client registration, the structured credential store, and the access-token publisher are deliberately not Loader configuration.

The package's canonical `apply()` fails with `configuration` because this release does not ship those production dependencies. Provider composition remains package-internal until a permitted real provider and production store exist; no published factory accepts provider endpoints, client registration, store objects, or credential values. The package-local fake provider, fake store, and fake credential publisher exercise the complete lifecycle but are not published APIs.

The `openai-codex` LLM route must explicitly reference the credential managed by OAuth:

```yaml
llm-pi-ai:
  providers:
    openai-codex:
      apiKeyEnv: DSH_OAUTH_OPENAI_CODEX
```

`apiKeyEnv` is DSH's existing credential-reference field. It names an opaque credential slot; it does not change the OAuth token into a provider API key. Do not set the same reference in the inherited process environment: `credentials-local` treats that layer as read-only and rejects rotation rather than silently leaving the old token active.

A future real provider must define static or strictly allowlisted authorization, token, and revocation endpoints. This package does not expose a configurable arbitrary refresh endpoint.

## Commands

When a managed service is composed, the plugin registers one namespaced command:

```text
/dsh-oauth accounts [provider]
/dsh-oauth login <provider>
/dsh-oauth logout <account-id>
/dsh-oauth rotate <account-id>
```

Command output contains only account metadata and safe error fields. Access tokens, refresh tokens, authorization codes, client secrets, cookies, complete provider responses, and raw provider errors are never valid command output. In this release, `login` operates only inside the package-local contract composition; it does not start an OpenAI Codex login flow.

## Public service

When a managed service is present, optional consumers obtain it by its exact key:

```ts
const oauth = ctx.get('dsh-oauth')
```

The public `OAuthService` methods are `providers()`, `accounts(provider?)`, `accountCredential(accountId)`, `login(provider, options?)`, `logout(accountId)`, `ensureFresh(accountId, options?)`, `rotate(accountId, options?)`, and `ensureFreshForRoute(route, options?)`. The optional consumer interface `OAuthAccountService` contains only `accounts()` and `accountCredential()`. Type-only consumers import these token-free contracts from `@dsh-plugins/dsh-oauth/types`.

`accountCredential()` returns account metadata plus `credentialRef`; it never resolves or returns the credential value. Consumers must handle an absent service and a rejected or absent account selection explicitly. They must not import this package's store or provider internals or read `.credentials.yaml`.

Public account IDs are opaque local identifiers. They are not email addresses, provider usernames, subjects, access tokens, or refresh tokens. Scope, issuer, audience, route, and provider checks remain provider-owned authorization requirements rather than display-only metadata.

## Invariant companion

`@dsh-plugins/dsh-oauth/invariant` registers package ownership with DSH's invariant registry and releases it on disposal. It intentionally installs no runtime assertion: refresh state is private, credential mutation validity belongs to the DSH credentials service, and this package exposes no authoritative event stream or readable projection from which to assert that relationship.

## Credential storage and safety

Structured OAuth credentials include refresh tokens and must be stored by an OS-backed secret-store implementation. The fake store is memory-only and is not a production secret store. This release does not provide a custom encrypted-file fallback.

The credential bridge may publish the short-lived access token through `credentials-local`, which persists it in `$DSH_HOME/.credentials.yaml`. That file is a credential document, not ordinary settings; on POSIX, DSH requires owner-only permissions. The preferred future integration is a DSH public ephemeral or composite credential provider so access tokens remain in memory. See [Security and token storage](docs/security.md).

This project does not copy a private OAuth client secret, imitate an official client, scrape an account console, capture browser cookies, or place authorization codes or tokens in command input, SessionEvent data, settings, telemetry, or logs.

## Compatibility

| Surface | Reviewed or executed version | Status |
| --- | --- | --- |
| DSH source | `master@47f943859b` / `0.1.0-rc.5` | Source review only; the exact npm packages were not published. |
| DSH Loader, credentials, LLM, and `llm-pi-ai` packages | `0.1.0-rc.6` | Executable package pin used by keyless real-composition tests. |
| Cordis | `4.0.1` | Executed through the real Loader and Include path. |
| `@earendil-works/pi-ai` | `0.82.1` | Transitive implementation reviewed for Codex auth headers. |
| Node.js | `^22.19.0 || >=24.0.0` | Supported runtime range. |

Compatibility does not extend across untested DSH release candidates. Upgrade the exact pins only with provider-contract, lifecycle, Loader real-composition, build, pack, and clean-install verification.

## Development and verification

From the monorepo root:

```sh
pnpm install
pnpm --filter @dsh-plugins/dsh-oauth test
pnpm --filter @dsh-plugins/dsh-oauth test:coverage
pnpm --filter @dsh-plugins/dsh-oauth typecheck
pnpm --filter @dsh-plugins/dsh-oauth lint
pnpm --filter @dsh-plugins/dsh-oauth build
pnpm --filter @dsh-plugins/dsh-oauth pack:check
pnpm --filter @dsh-plugins/dsh-oauth check
```

`check` runs the package test, typecheck, lint, build, pack-manifest, clean-install, and NodeNext-consumer checks in their required order. The root checks coordinate the whole workspace:

```sh
pnpm test
pnpm test:coverage
pnpm typecheck
pnpm lint
pnpm build
pnpm pack:check
```

Default tests are keyless. Fake providers and local mock HTTP servers cover provider responses and Codex request composition; no default test accesses a real account.

## Known Limitations and Deferred Work

- No real OpenAI Codex or other provider login implementation is shipped. A provider will be added only after a public, stable authorization protocol and permitted client registration are confirmed.
- The access-token bridge can persist a short-lived token in `.credentials.yaml`; an ephemeral DSH credential provider is preferred but is not available through the verified public API.
- The reviewed `rc.5` source was not available as matching npm packages, so executable verification pins `rc.6`.
- Compatibility is exact and pre-release. No other DSH RC, Node.js version, provider API, browser flow, or OS secret-store backend is implied.
- The package-local fake store, provider, and publisher are contract-harness fixtures, not exported APIs or production security implementations.
- The installed bundle row is disabled, and canonical Loader `apply()` fails loud without a host-owned `createService` composition. This release is an integration foundation, not an end-user login flow.
- Multi-account selection remains explicit. The service never chooses the first account when selection is missing or ambiguous.
