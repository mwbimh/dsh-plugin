# ADR 0001: OpenAI Codex credential bridge

## Status

Accepted for the OAuth credential bridge. This decision does not approve a production OpenAI Codex provider, login flow, token store, client registration, or arbitrary refresh endpoint.

## Question

Can one OpenAI Codex OAuth access-token string cross DSH's public credential seam and authenticate the existing `llm-pi-ai` `openai-codex` route after request-time refresh?

## Evidence

The reviewed DSH source is `master@47f943859b` and reports version `0.1.0-rc.5`. Matching `@deepseek-ai/dsh-llm-pi-ai` packages were not published, so the executable harness pins `0.1.0-rc.6`. Its public `llm/stream`, credential, Loader, and `apiKeyEnv` APIs match the reviewed source. Both resolve `@earendil-works/pi-ai` `0.82.1`.

In pi-ai `0.82.1`, `openai-codex-responses` accepts one access-token string, extracts `https://api.openai.com/auth.chatgpt_account_id` from its JWT payload, and constructs `Authorization`, `chatgpt-account-id`, `originator`, `User-Agent`, `OpenAI-Beta`, `Accept`, and `Content-Type`. The verified adapter boundary does not require a separate account ID or structured-auth argument.

The keyless Loader composition proves:

- An expired managed token refreshes before the same request enters `llm-pi-ai`, and the old token is never emitted.
- Two concurrent requests share one refresh flight.
- The local Codex server receives the complete Codex authentication header set.
- An unmanaged route delegates through the `llm/stream` waterfall.
- Disposing the Loader entry removes the listener and aborts and drains an active refresh without downstream dispatch.
- An inherited launch-environment value that shadows `credentials-local.set()` fails loud before any Codex request.

## Decision

PASS. The first production slice may use DSH's credential reference to transport the short-lived access-token string. The plugin and its users must treat the value as an OAuth access token, not a conventional API key. `apiKeyEnv` is only the existing DSH field that names the opaque credential slot.

The provider and store retain the structured OAuth state: refresh token, expiry, scopes, issuer, audience, subject, account metadata, and route. Only the short-lived access-token string crosses the DSH credential seam. A future Codex protocol that needs additional structured authentication fields invalidates this decision and requires a public structured or ephemeral credential seam or a native adapter; those fields must not be encoded into the string.

The spike's configurable `refreshEndpoint` is a deterministic test seam, not a production configuration. A production provider owns static or strictly allowlisted endpoints and must not expose a general OAuth refresh proxy.

This decision does not establish a permitted OpenAI Codex authorization flow. A real provider remains deferred until a public, stable protocol and permitted client registration are confirmed. The implementation must not copy a private OAuth client secret, imitate an official client, scrape a console, or capture browser cookies.

## Verification

From the monorepo root:

```sh
pnpm --filter @dsh-plugins/dsh-oauth test -- bridge-spike.spec.ts
pnpm --filter @dsh-plugins/dsh-oauth typecheck
pnpm --filter @dsh-plugins/dsh-oauth build
```
