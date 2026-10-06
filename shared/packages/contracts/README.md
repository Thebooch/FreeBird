# @freebirdai/contracts

The contracts FreeBird's products share, so guide, Connect and Dash agree on them without depending on one another:

- **`LlmAdapter`** and its types: how a model is plugged in. `@freebirdai/adapters-llm-anthropic` and `-openai` implement it.
- **`digest`** and `canonicalize`: the content digest an approval is checked against.

`@freebirdai/core` re-exports all of it.
