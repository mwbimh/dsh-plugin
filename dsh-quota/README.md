# dsh-quota

`@dsh-plugins/dsh-quota` is a provider-neutral quota snapshot plugin for DeepSeek Harness. It normalizes provider-native quota windows, keeps a process-local cache, and exposes the namespaced `dsh-quota` service.

This milestone includes the public model, stable redacted errors, provider registry, deterministic fake provider, TTL/stale fallback, per-account single-flight, concurrency bounds, cancellation/disposal, and provider-opted bounded retry for network and 429 failures. It includes no real provider, network client, provider-console scraper, real-account test, background polling, billing, or usage accounting.

## Public contract

`observedAt` and `resetAt` are Unix epoch timestamps in milliseconds. Quota values are finite and non-negative. Contradictory values are rejected. Unknown values remain absent; the package neither requires nor synthesizes `remainingPercent`.

The service exposes:

- `listAccounts()`
- `getSnapshot(account, signal?)`
- `refresh(account, signal?)`

Snapshots preserve all provider-native windows. A failed refresh may return the last successful snapshot with `stale: true` and a safe `lastError`; its original `observedAt` is unchanged.

Optional OAuth integration uses `ctx.get('dsh-oauth')` dynamically and is not an injected dependency. Only token-free account metadata and a validated opaque credential-reference name cross the seam. Quota never resolves the reference or reads a credential value.

## Configuration

```yaml
- id: dsh-quota
  name: '@dsh-plugins/dsh-quota'
  config:
    cacheTtlMs: 60000
    timeoutMs: 10000
    maxConcurrency: 4
```

The bundled `cordis.patch.yml` inserts this entry disabled so installation does not silently enable behavior.

## Development

From the repository root:

```sh
pnpm --dir dsh-quota test
pnpm --dir dsh-quota test:coverage
pnpm --dir dsh-quota typecheck
pnpm --dir dsh-quota lint
pnpm --dir dsh-quota build
pnpm --dir dsh-quota pack:check
```

See [security](docs/security.md), [compatibility](docs/compatibility.md), and [verification](docs/verification.md).
