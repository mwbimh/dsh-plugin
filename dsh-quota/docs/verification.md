# Verification

From the repository root:

```sh
pnpm exec vitest run --root . dsh-quota/tests
pnpm exec vitest run --root . --coverage
pnpm --dir dsh-quota typecheck
pnpm --dir dsh-quota lint
pnpm --dir dsh-quota build
pnpm --dir dsh-quota pack:check
```

Default tests are deterministic, keyless, offline with respect to provider APIs, and never use real accounts. The pack smoke builds and packs the exact allowlisted artifact, installs it in a temporary NodeNext consumer, typechecks public imports, and executes the ESM entry points.
