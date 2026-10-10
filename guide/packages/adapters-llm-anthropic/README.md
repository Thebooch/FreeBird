# @freebirdai/adapters-llm-anthropic

Anthropic Claude adapter for FreeBird.

```ts
import { createAnthropicAdapter } from "@freebirdai/adapters-llm-anthropic";

const llm = createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultModel: "claude-3-5-sonnet-latest",
});
```

## Prompt caching

The chat engine marks the end of what reads the same on every call (the
system prompt, and the list of actions) with `cachePoint` on that message.
This adapter asks Anthropic to cache up to there, tools included: a cached
prefix is read back at a fraction of the input price and written at a
premium. The model reads the same words either way. Turn it off with
`promptCache: false`, for a host whose calls are rarely minutes apart.
