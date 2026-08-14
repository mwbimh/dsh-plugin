# dsh-quota

`@dsh-plugins/dsh-quota` is a provider-neutral quota snapshot plugin for DeepSeek Harness. It normalizes provider-native quota windows, keeps a process-local cache, and exposes the namespaced `dsh-quota` service.

This contract-foundation milestone includes the public model, stable redacted errors, provider registry, deterministic fake provider, TTL/stale fallback, waiter-aware per-account single-flight, concurrency bounds, cancellation/disposal, and provider-opted bounded retry for network and 429 failures. It includes no real provider, network client, provider-console scraper, real-account test, background polling, billing, or usage accounting.

## Public contract

`observedAt` and `resetAt` are Unix epoch timestamps in milliseconds. Quota values are finite and non-negative. Contradictory values are rejected. Unknown values remain absent; the package neither requires nor synthesizes `remainingPercent`.

The service exposes:

- `listAccounts()`
- `getSnapshot(account, signal?)`
- `refresh(account, signal?)`

Snapshots preserve all validated provider-native windows. Provider results are normalized into detached, deeply frozen public objects before caching. A failed refresh may return the last successful snapshot with `stale: true` and a safe `lastError`; its original `observedAt` is unchanged.

Optional OAuth integration uses `ctx.get('dsh-oauth')` dynamically and is not an injected dependency. `accountCredential(accountId, { signal })` is treated as an OAuth freshness barrier and runs inside the same owned timeout/cancellation boundary as provider requests. Only token-free account metadata and a validated opaque credential-reference name cross the seam. Quota never resolves the reference or reads a credential value.

`refresh()` rejects pre-aborted callers before creating a flight. Concurrent callers share one account flight; cancelling one waiter leaves surviving waiters running, while cancelling the final waiter aborts the owned OAuth/provider operation. A provider or OAuth implementation that ignores abort cannot hold disposal or mutate cache through late settlement.

Provider implementations are composed programmatically through the published `createQuotaPlugin({ providers })` factory:

```ts
import { createQuotaPlugin } from '@dsh-plugins/dsh-quota'

export default createQuotaPlugin({
  providers: (_ctx, _policy) => [provider],
})
```

Provider objects, endpoints, and credentials do not enter Loader YAML. The canonical `apply()` remains a standalone empty-provider foundation until a host deliberately loads a composed module. Account discovery is atomic and fail-fast in this milestone: a provider failure is safely classified and no partial account list is returned. Partial-provider diagnostics and availability are not claimed.

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
