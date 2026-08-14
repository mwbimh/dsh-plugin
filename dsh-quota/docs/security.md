# Security boundary

`dsh-quota` never reads tokens, cookies, authorization headers, browser state, provider consoles, or credential values. Optional OAuth integration is structural and dynamic through `ctx.get('dsh-oauth')`; it receives token-free account metadata and an opaque credential-reference name only. The reference is validated, passed only to an OAuth-aware provider, never resolved through `ctx.credentials`, and never returned in snapshots or errors.

Provider implementations must use fixed or allowlisted targets, enforce response-size and timeout limits, normalize responses before returning, and avoid raw response/error retention. This milestone includes no real provider or network client.

Errors expose stable codes and bounded safe metadata. Identifiers containing control characters or exceeding public limits are omitted. Unknown provider messages and causes are discarded. Provider accounts and snapshots are copied field-by-field into frozen public objects, so provider-owned objects and unknown fields cannot mutate or leak through account results or cache. Only finite non-negative quota values are accepted; contradictory values and mismatched account identity never enter cache.

Concurrent refreshes share one account flight. A pre-aborted caller starts no work; the final cancelled waiter aborts the owned flight. OAuth freshness lookup and provider requests both race an owned timeout/abort signal, so ignored cancellation and late settlement cannot block disposal or write cache. Network and 429 retries require provider opt-in, are bounded, and cap timer-compatible `retryAfterMs`; timeout, authentication, and authorization failures do not retry automatically.
