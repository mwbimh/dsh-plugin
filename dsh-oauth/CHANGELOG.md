# Changelog

All notable changes to `@dsh-plugins/dsh-oauth` are documented here.

## Unreleased

### Added

- Namespaced `dsh-oauth` account and credential-reference service contracts with token-free public results.
- Token-free type-only public API at `@dsh-plugins/dsh-oauth/types`; provider, store, publisher, and structured credential contracts remain package-internal.
- Fake OAuth provider, in-memory secret store, and credential publisher seams for deterministic keyless tests.
- Login, per-account refresh single-flight, refresh-token rotation ordering, logout, revoke, and disposal lifecycle behavior.
- `/dsh-oauth` command parser for `accounts`, `login`, `logout`, and `rotate`.
- Keyless real-composition coverage for DSH Loader, `credentials-local`, `llm`, and `llm-pi-ai` on the `openai-codex` route.
- Package, invariant, build, pack, and clean-install verification.

### Security

- Public services, commands, errors, logs, and test output omit access tokens, refresh tokens, authorization codes, client secrets, cookies, and complete provider responses.
- Structured credentials are stored before access-token publication; logout and disposal drain active work before clearing local credentials.
- No real provider is included until a public, stable authorization protocol is confirmed. The package does not copy a private OAuth client secret or scrape browser cookies or provider consoles.
