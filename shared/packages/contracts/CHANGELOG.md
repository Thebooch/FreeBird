# @freebirdai/contracts

## 0.2.0

### Minor Changes

- cacc921: Close the gaps between Connect on its own and Connect inside Dash.
  - One read: `createEngine().read` carries a read capped at its page limit on in the background, refreshes an answer a background read owns the same way, and watches each fresh answer's shape. Dash's tile route and `connect.read()` both go through it. `connect.read()` waits for the whole answer by default (`wait: false` returns early with `progress`), and `ReadResult` gains `complete`, `completion`, `pages`, `reportedTotal`, `progress` and `changed`.
  - Drift: `DriftWatch` moves into Connect. A host says whether anything it saved reads the fields that changed (`readsFields`); on its own, every change is reported and the endpoint checked again.
  - Shared packages: the expression language is now `@freebirdai/expr` (formerly `@freebirdai/dash-expr`), and the LLM adapter contract and approval digest move into `@freebirdai/contracts`, which `@freebirdai/core` re-exports. Connect no longer depends on `@freebirdai/core`.
  - `allowlistEgress` and `configureEgress` are exported from `@freebirdai/connect`, as its integration guide says; a test now checks every import the Connect guides show.

- a907857: Prompt caching that works with the provider's help or without it.
  - `@freebirdai/contracts`: `LlmMessage.cachePoint`, a hint that everything up to and including that message (the tools, then the messages before it) reads the same from one call to the next. An adapter for a provider that caches only when asked puts its cache point there; any other adapter ignores it, and the request is the same either way.
  - `@freebirdai/core`: every step now opens with what reads the same each turn: the tools, the system prompt and the list of actions. A step's own hint now comes after the list rather than before it. Providers that cache a repeated prefix by themselves (OpenAI, vLLM, SGLang, llama.cpp) reuse that opening unasked, and the engine marks its end with `cachePoint`, as it does the system prompt of the written reply (`finalReply`). `buildHarnessTurn` reports `stableMessages`, how many of its messages are the list.
  - `@freebirdai/adapters-llm-anthropic`: honours `cachePoint` by sending the system prompt as two blocks, the first marked for Anthropic's cache. On by default; `promptCache: false` turns it off.
