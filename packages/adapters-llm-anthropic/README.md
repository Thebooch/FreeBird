# @freebirdai/adapters-llm-anthropic

Anthropic Claude adapter for FreeBird.

```ts
import { createAnthropicAdapter } from "@freebirdai/adapters-llm-anthropic";

const llm = createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultModel: "claude-3-5-sonnet-latest",
});
```
