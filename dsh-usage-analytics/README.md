# dsh-usage-analytics

Local usage analytics for DeepSeek Harness.

The plugin registers the `dshUsageAnalytics` unit with `ctx.sessionProjections` and exposes a privacy-minimized per-session projection of durable conversation usage. It counts only successful final `assistant/message.usage` records. Stream chunks, compaction, session-title calls, failed requests, provider invoices, pricing, cross-session aggregation, Remote APIs, and UI are not included.

The package is tested against the exact DSH npm prerelease `0.1.0-rc.6` and Cordis `4.0.1`. It does not claim compatibility with other DSH release candidates.

The included `cordis.patch.yml` mounts the Host projection plugin and its invariant companion as namespaced, reversible Loader rows.

## Development

Run from the repository root:

```sh
pnpm --filter dsh-usage-analytics test
pnpm --filter dsh-usage-analytics test:coverage
pnpm --filter dsh-usage-analytics typecheck
pnpm --filter dsh-usage-analytics build
pnpm --filter dsh-usage-analytics pack:check
```

The package smoke check creates a real tarball, verifies its exact file list and package-local `LICENSE`, installs it into a clean temporary ESM consumer, imports both public entry points, and runs a strict NodeNext TypeScript consumer check. The optional DSH profile add/dump/remove gate is skipped with an explicit message unless `DSH_USAGE_ANALYTICS_DSH_CLI` points to an installed `dsh` executable or launcher artifact; Loader activation remains covered by the composition tests.

The projection stores only provider/model identifiers, context capacity, call counts, and token totals. It never returns prompts, responses, tool definitions, credentials, or reasoning content.

Route attribution uses the final `AssistantMessage.source` provenance, so a stale or mismatched request header cannot relabel measured usage. Checkpoint state contains per-route totals plus one latest-step replacement slot; it does not retain one sample per historical call.

## Known limitations

- The fold treats reasoning tokens as a subset of output tokens.
- A fork's per-session projection includes its inherited seed prefix. Cross-session aggregation must account for lineage before summing sessions.
- Missing provider usage is reported as a missing sample; token counts are not estimated.
- The package has no cross-session persistence, daily aggregation, pricing, Typert Remote, or browser UI yet.
