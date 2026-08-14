# Compatibility

The package targets Node.js `^22.19.0 || >=24.0.0`, Cordis `4.0.1`, Schemastery `3.18.1`, and DSH invariants `0.1.0-rc.6`.

The public service key is `dsh-quota`. The optional OAuth service key is `dsh-oauth` and is deliberately absent from `inject`, so Quota can start alone and observes OAuth installation or removal dynamically. No source import or package dependency on `@dsh-plugins/dsh-oauth` exists.

Provider APIs, service shapes, timestamps, event names, and config keys are public contracts once published. The root package exports `createQuotaPlugin({ providers })` as the supported programmatic provider-composition seam; provider objects are never Loader configuration. The canonical `apply()` has no providers by itself. This contract-foundation milestone has no real-provider compatibility claim.

Discovery is atomic and fail-fast: malformed or failed provider discovery is safely classified and prevents a partial account list. Partial-provider availability, per-provider diagnostics, and background health isolation remain outside this milestone.
