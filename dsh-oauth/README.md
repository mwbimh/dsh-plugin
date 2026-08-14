# dsh-oauth credential bridge spike

This package-local spike tests whether one OpenAI Codex OAuth access-token string can pass through DSH `credentials-local` and `llm-pi-ai` without pretending a structured OAuth credential is an API key. It is not the production OAuth plugin.

The source API reviewed was DeepSeek Harness `0.1.0-rc.5`; that exact npm version was not published. The executable harness pins the current published `0.1.0-rc.6` packages, whose credential and LLM APIs match the reviewed source. `@earendil-works/pi-ai` is resolved transitively as `0.82.1`.

Run from this directory:

```sh
npm install
npm run check
```

The real-composition test boots an actual Cordis Loader and Include tree containing DSH `credentials-local`, `llm`, `llm-pi-ai`, and the minimal refresh listener. A local HTTP server acts as both the refresh provider and Codex backend.

The configurable `refreshEndpoint` exists only to make this keyless spike deterministic. A production provider must own static or strictly allowlisted token endpoints; this spike must not be promoted as a general OAuth refresh proxy.
