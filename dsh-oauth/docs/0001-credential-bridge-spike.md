# ADR 0001: OpenAI Codex credential bridge spike

## Status

Accepted for the P0 spike. This decision does not approve the production OAuth provider, token store, login flow, or arbitrary refresh endpoints.

## Question

Can a single OpenAI Codex OAuth access-token string cross DSH's public credential seam and authenticate the existing `llm-pi-ai` `openai-codex` route after request-time refresh?

## Evidence

The reviewed DSH source reports version `0.1.0-rc.5`. That exact `@deepseek-ai/dsh-llm-pi-ai` version is not published, so the executable harness pins the current published `0.1.0-rc.6`; its public `llm/stream`, credential, Loader, and `apiKeyEnv` APIs match the reviewed source. Both resolve `@earendil-works/pi-ai` `0.82.1`.

In pi-ai `0.82.1`, the `openai-codex-responses` implementation accepts one access-token string, extracts `https://api.openai.com/auth.chatgpt_account_id` from its JWT payload, and constructs `Authorization`, `chatgpt-account-id`, `originator`, `User-Agent`, `OpenAI-Beta`, `Accept`, and `Content-Type`. No separate account-id or structured-auth argument is required at the DSH adapter boundary.

The keyless Loader composition proves:

- an expired managed token is refreshed before the same request enters `llm-pi-ai`, and the old token is never emitted;
- two concurrent requests share one refresh flight;
- the local Codex server receives the complete Codex authentication header set;
- an unmanaged route delegates unchanged through the waterfall;
- disposing the Loader entry removes the listener and aborts/drains an in-flight refresh without downstream dispatch;
- an inherited launch-environment value that shadows `credentials-local.set()` fails loud before any Codex request.

## Decision

PASS. A credential bridge is technically sufficient for the first production slice, provided the stored value is explicitly treated as an OAuth access token and never represented to users or provider code as a conventional API key. `apiKeyEnv` is only the existing DSH credential-reference field used to transport the opaque string.

The production implementation must retain structured OAuth state—refresh token, expiry, scopes, issuer, audience, subject, and account metadata—in its private provider/store layer. Only the short-lived access-token string crosses the DSH credential seam. If a future Codex protocol requires additional structured authentication fields, the bridge decision must be revisited rather than encoding them into the string.

The spike's configurable `refreshEndpoint` is a test seam. A production provider must own static or strictly allowlisted endpoints and must not expose an arbitrary OAuth refresh proxy.

## Verification

From `dsh-oauth/`:

```sh
npm ci
npm run check
```
