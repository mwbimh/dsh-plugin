# DSH Plugins

This monorepo contains independently built, tested, versioned, and published DeepSeek Harness plugins.

## Development

Use Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

```sh
pnpm install
pnpm test
pnpm test:coverage
pnpm typecheck
pnpm lint
pnpm build
pnpm pack:check
```

The root commands coordinate the workspace. Each plugin owns its runtime dependencies, package scripts, documentation, tests, build, and package smoke checks.
