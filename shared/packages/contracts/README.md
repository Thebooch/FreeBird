# @freebirdai/contracts

The contracts FreeBird's products share, so guide, Connect and Dash agree on them without depending on one another:

- **`LlmAdapter`** and its types: how a model is plugged in. `@freebirdai/adapters-llm-anthropic` and `-openai` implement it. `LlmMessage.cachePoint` marks where the part of a request that reads the same on every call ends: an adapter for a provider that caches only when asked puts its cache point there, and any other adapter ignores it.
- **`digest`** and `canonicalize`: the content digest an approval is checked against.

`@freebirdai/core` re-exports all of it.
