# Changelog

All notable changes to `@dsh-plugins/dsh-quota` are documented here.

## Unreleased

### Added

- Provider-neutral quota model with millisecond timestamps, finite non-negative values, identity validation, and contradictory-window rejection.
- Stable redacted errors, provider registry, deterministic fake provider, in-memory TTL cache, stale fallback, per-account single-flight, cancellation, timeout, disposal, concurrency bounds, and opt-in bounded retry for network and 429 failures.
- Optional dynamic token-free `dsh-oauth` account and opaque credential-reference integration without token access.
- Loader, invariant, build, coverage, pack, and clean NodeNext consumer verification.
- Published `createQuotaPlugin({ providers })` programmatic provider-composition seam; the canonical empty-provider entry remains safe and standalone.
- Pre-abort gating, waiter-refcount cancellation, final-waiter provider abort, and timeout/cancellation of OAuth freshness lookup with late-settlement containment.
- Detached deeply frozen snapshot normalization and bounded `Retry-After` timer values.
- Stable `provider-response` classification for malformed discovery results and explicit atomic fail-fast discovery semantics.

### Security

- No real provider, network client, console scraper, token resolver, real account, or background poller is included.
- Public errors and snapshots exclude tokens, raw provider responses, unsafe identifiers, and credential references.
