# Security and token storage

This reference defines the security boundary for `@dsh-plugins/dsh-oauth`.

## Sensitive and public data

Access tokens, refresh tokens, authorization codes, client secrets, cookies, complete token responses, PKCE verifiers, device codes, and provider error bodies are sensitive. They must not appear in public account objects, credential-reference lookup results, command input or output, SessionEvent data, Remote APIs, logs, telemetry, crash reports, test snapshots, or configuration files.

Public account metadata may contain an opaque local account ID, provider ID, display name, stable provider subject when the provider guarantees it, scopes, status, expiry, and timestamps. The optional credential lookup adds only a credential reference. A credential reference is a name; it is not the credential value and must not be resolved by quota or UI consumers.

Unknown provider failures are normalized into stable error codes and safe fields. Their original messages and causes are not retained when they could carry credentials or complete responses.

## Storage ownership

The OAuth store owns the structured credential: access token, refresh token, expiry, scopes, issuer, audience, subject, route, provider metadata, and account-scoped credential reference. A future production store must use the operating system's secret facility; this contract foundation does not implement one:

| Platform | Required production backend |
| --- | --- |
| Windows | Credential Manager |
| macOS | Keychain |
| Linux | Secret Service |

The in-memory fake store is for tests and local contract development only. The package does not implement an encrypted-file fallback; encoding, obfuscation, or a fixed key stored beside ciphertext is not secure storage.

The bridge publisher owns only the short-lived access-token copy exposed to the existing DSH adapter. With `credentials-local`, that copy is written to `$DSH_HOME/.credentials.yaml`. DSH creates replacement files with owner-only permissions and rejects group- or world-readable files on POSIX. Windows protection follows the file ACL because POSIX mode bits are unavailable there.

An inherited process-environment value has higher priority than `.credentials.yaml` and is read-only. If it shadows the managed reference, publishing or clearing the bridge fails loud. Remove the environment value and restart; do not accept a successful-looking rotation that leaves the old value active.

## Lifecycle ordering

Login and refresh validate provider, issuer, audience, route, required scopes, token fields, and expiry before publishing. Rotated credentials are persisted in non-ready state first; only successful bridge publication followed by the ready-state commit makes them usable. Publication failure attempts to clear the account-scoped bridge reference, keeps the stored account non-ready, and blocks managed-route delegation until republishing succeeds.

Concurrent refresh decisions for one account share a flight beginning before the store read. Different accounts and their bridge references remain isolated. Caller cancellation removes one waiter; the final waiter aborts the owned provider/store flight. Logout blocks new work, drains or aborts refresh, persists revoked cleanup state, and deletes it only after bridge clearing succeeds. Disposal aborts and drains tracked reads, login, and refresh operations before clearing every reference still traceable from the store.

## Provider requirements

A production provider owns static or strictly allowlisted authorization, token, and revocation endpoints. It must validate redirect URI, state, PKCE, issuer, audience, scopes, token response fields, and any ID-token signature and claims required by its public protocol. Loopback callbacks bind locally and have short, single-use state. Device authorization follows the provider's polling interval, expiry, and cancellation rules.

The repository does not include a real provider until its public protocol, permitted client registration, and required scopes are confirmed. Implementations must not copy a private third-party OAuth client secret, imitate an official client to bypass restrictions, scrape a provider console, or capture browser cookies.

## Incident-safe diagnostics

Errors expose only a stable code, provider ID, opaque account ID, retryability, and an optional safe retry delay. Authentication, authorization, `invalid_grant`, scope mismatch, and audience mismatch do not retry indefinitely. Temporary network failures and rate limits use bounded policy and honor `Retry-After` when a real provider contract permits retries.

Before sharing diagnostics, verify that output contains no bearer header, credential value, cookie, authorization code, complete response, or local secret-store content. Treat a suspected disclosure as a credential compromise and revoke or rotate the affected account through the provider's supported mechanism.
