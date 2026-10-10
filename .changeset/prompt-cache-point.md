---
"@freebirdai/contracts": minor
"@freebirdai/core": minor
"@freebirdai/adapters-llm-anthropic": minor
---

Prompt caching that works with the provider's help or without it.

- `@freebirdai/contracts`: `LlmMessage.cachePoint`, a hint that everything up to and including that message (the tools, then the messages before it) reads the same from one call to the next. An adapter for a provider that caches only when asked puts its cache point there; any other adapter ignores it, and the request is the same either way.
- `@freebirdai/core`: every step now opens with what reads the same each turn: the tools, the system prompt and the list of actions. A step's own hint now comes after the list rather than before it. Providers that cache a repeated prefix by themselves (OpenAI, vLLM, SGLang, llama.cpp) reuse that opening unasked, and the engine marks its end with `cachePoint`, as it does the system prompt of the written reply (`finalReply`). `buildHarnessTurn` reports `stableMessages`, how many of its messages are the list.
- `@freebirdai/adapters-llm-anthropic`: honours `cachePoint` by sending the system prompt as two blocks, the first marked for Anthropic's cache. On by default; `promptCache: false` turns it off.
