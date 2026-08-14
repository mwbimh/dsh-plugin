# dsh-remote-compaction

Version-pinned OpenAI compaction transport and capability scaffold for DeepSeek Harness (DSH). It is not a usable remote compaction provider on DSH `0.1.0-rc.5`. The package extends `BasicCompactionEngine` and overrides only its protected `summarize()` hook. Pressure detection, range selection, transaction markers, surface replacement, history, commit, rollback, and fallback summarization remain owned by Basic.

This package is marked `private: true` and is not publishable. Exact rc.5 artifacts are required before the protected hook and real profile installation can be release-qualified.

## Current behavior

This release is a fail-closed transport spike, not an enabled remote replacement. The official [`POST /v1/responses/compact`](https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint) response is a canonical context window containing opaque provider items. OpenAI requires callers to pass that output to the next Responses request as-is and not prune it. DSH `0.1.0-rc.5` Basic accepts only a text-oriented `SummaryResult` and then writes a replacement `user/message`; it has no lossless slot for the canonical OpenAI output.

The plugin validates the response envelope, usage counters, and a non-empty `type` discriminator on each opaque output item. It does not implement or claim canonical `ResponseOutputItem` schema validation, and it never converts opaque items into a fake text summary:

- `mode: auto` calls `super.summarize()` after unsupported, temporary, transport, timeout, incompatible-input, or incompatible-response outcomes.
- `mode: remote-only` fails explicitly for every remote failure; even an official successful OpenAI response fails with `incompatible-response` because its opaque context cannot be represented as `ContentBlock[]`.
- `mode: disabled` bypasses the remote path and uses the inherited Basic summarizer.
- Authentication, invalid requests, malformed/oversized responses, and caller cancellation fail loudly in every mode.
- A remote failure cannot write `compaction/summary` or replace surface history. Basic may still record its normal failed `compaction/start` / `compaction/end` transaction markers.

## Compatibility

Runtime peer dependencies express the intended DSH `0.1.0-rc.5` target, based on source review at `deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`. They do not mean rc.5 runtime compatibility has passed. `@deepseek-ai/dsh-compaction-basic` is pinned exactly because the protected hook is not a public provider seam, and the remaining minimal input boundary still follows that private ABI.

The npm registry does not currently contain `@deepseek-ai/dsh-compaction-basic@0.1.0-rc.5` or the matching definition packages. This repository uses published `0.1.0-rc.6` packages only as a build, declaration-consumer, Loader, and public-transaction test host after comparing the hook signature with rc.5 source. None of those tests qualify rc.5. A real rc.5 tarball/profile install cannot be completed until the exact artifacts or a private registry are supplied.

## Configuration

The shipping bundle patch leaves the existing `compaction-basic` row and all of its configuration untouched. It installs the invariant companion and inserts the Remote row with Loader `disabled: true` and config `mode: disabled`; installation without `OPENAI_API_KEY` therefore leaves Basic active and sends no remote request.

Enabling the spike is an explicit paired profile overlay. Loader patch `config` values replace the whole config object rather than deep-merging it, so copy every existing Basic field (for example `auto`, retention, thresholds, models, and retry settings) into the Remote row before switching:

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true
- id: dsh-remote-compaction
  name: dsh-remote-compaction
  disabled: false
  config:
    auto: false # migrated from the prior Basic row
    mode: auto  # or remote-only
    provider: openai
    credentialRef: OPENAI_API_KEY
```

Required and remote-specific fields are:

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `disabled` | `auto` permits Basic fallback; `remote-only` never falls back; `disabled` uses Basic directly. |
| `provider` | `openai` | Only `openai` is accepted. |
| `model` | empty | Optional fallback model; the latest durable route, then agent route, wins. A request with no complete target fails loudly. |
| `baseURL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint root; non-loopback HTTP is rejected. |
| `credentialRef` | `OPENAI_API_KEY` | DSH credential reference resolved again for every operation. |
| `timeoutMs` | `30000` | Complete remote-operation timeout. |
| `maxRequestBytes` | `4000000` | UTF-8 JSON request bound enforced before network I/O. |
| `maxResponseBytes` | `4000000` | Response bound applied before JSON normalization. |
| `capabilityTtlMs` | `3600000` | In-memory supported-target TTL. |
| `unavailableTtlMs` | `30000` | In-memory unsupported/temporary TTL. |

All `BasicCompactionConfig` fields remain available. The remote fields are stripped before calling the Basic constructor.

## Capability and errors

The exact cache identity is `provider + model + normalized baseURL`. OpenAI exposes no separate capability-probe endpoint, so the first real compact operation establishes capability. Concurrent unknown operations wait for that capability conclusion; after support is known, each caller sends its own request and no response is shared across sessions. The cache stores only capability and expiry; it stores no conversation content, credential, or response.

HTTP classification uses status codes rather than error text: 401 is authentication; 403 is permission; 404/405/501 are unsupported; 408/409/429/5xx are temporarily unavailable; other non-success statuses are invalid requests. Transport, timeout, malformed JSON, envelope/item-discriminator validation, size bounds, and caller abort remain distinct. External fetch, stream, JSON, and URL parse causes are not retained on public errors.

## Security and data handling

The plugin sends only the range passed to `summarize()`. It currently accepts only text blocks and falls back or fails before network I/O for blocks it cannot serialize losslessly. API keys are resolved from `ctx.credentials` per operation and are never cached. Diagnostics omit Authorization values, request content, response content, and provider error bodies. Disposal aborts in-flight operations and clears the in-memory capability cache.

## Development

Use Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0` from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter dsh-remote-compaction test
pnpm --filter dsh-remote-compaction test:coverage
pnpm --filter dsh-remote-compaction typecheck
pnpm --filter dsh-remote-compaction lint
pnpm --filter dsh-remote-compaction build
pnpm --filter dsh-remote-compaction pack:check
```

The optional live API smoke self-skips unless both variables are present:

```sh
OPENAI_API_KEY=... OPENAI_COMPACTION_MODEL=... pnpm --filter dsh-remote-compaction test:e2e
```

Default tests use local fetch mocks. The Loader suite boots YAML through the real Cordis Loader and drives the public compaction API through real Basic transactions on the rc.6 test host. It covers safe no-key installation, successful Basic fallback commit order, remote-only/fallback/abort/range-change failure atomicity, invariant composition, and HMR disposal.

## Known limitations and deferred work

- Remote compaction cannot become the committed DSH checkpoint until DSH has a public summarizer/replay-state seam that can persist and replay the canonical OpenAI output unchanged.
- This private spike cannot be published until exact rc.5 artifacts pass build, declaration consumer, Loader, profile install, public transaction, restart, and uninstall gates.
- `strategy`, endpoint, and cross-provider compatibility provenance have no rc.5 public event fields; Basic retains only provider/model and drops extra override fields.
- The exact rc.5 packages are absent from npm, blocking the final tarball install, `dsh plugin add`, `--dump-config`, restart, and uninstall smoke.
- Tools, tool calls/results, reasoning blocks, images, and other non-text inputs fail closed rather than being serialized incompletely.
- No Settings UI is included because the out-of-tree package has no stable rc.5 client slot for this state.
