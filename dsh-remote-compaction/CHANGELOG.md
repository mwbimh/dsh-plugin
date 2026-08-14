# Changelog

## 0.1.0

- Add the version-pinned `RemoteCompactionEngine` subclass and bundle patch.
- Add the bounded OpenAI `/responses/compact` transport, response normalization, structural error classification, capability cache, timeout, caller abort, credential re-resolution, and disposal cleanup.
- Add explicit `auto` Basic fallback and `remote-only` failure behavior.
- Fail closed on canonical opaque OpenAI output until DSH exposes a lossless public replay-state compaction seam.
- Add unit, 100% coverage, real Loader composition, invariant, build, pack, and optional with-key API test lanes.
