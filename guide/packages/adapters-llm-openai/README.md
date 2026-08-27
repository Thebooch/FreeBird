# @freebirdai/adapters-llm-openai

OpenAI LLM adapter for [FreeBird](../../README.md).

## Install

```bash
pnpm add @freebirdai/adapters-llm-openai
```

## Usage

```ts
import { createOpenAiAdapter } from "@freebirdai/adapters-llm-openai";

const llm = createOpenAiAdapter({
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: "gpt-4o-mini",
});
```

Works with any OpenAI-compatible endpoint (Azure, Together, Groq, etc.) via `baseURL`.

## Usage & cost visibility (optional)

Enable token usage on each streaming completion, then surface it from the chat engine:

```ts
import {
  createOpenAiAdapter,
  estimateOpenAiChatCostUsd,
} from "@freebirdai/adapters-llm-openai";
import { createChatEngine } from "@freebirdai/core";

const llm = createOpenAiAdapter({
  includeUsage: true, // requests OpenAI `stream_options.include_usage`
  defaultModel: "gpt-4o-mini",
});

const chat = createChatEngine({
  db,
  llm,
  registry,
  knowledge,
  emitLlmUsage: true, // SSE event `llm_usage` for the client
  estimateLlmCostUsd: estimateOpenAiChatCostUsd, // optional ~USD (bundled table)
  onLlmUsage: (info) => {
    // optional server-side metering
    console.log(info.usage, info.estimatedUsd);
  },
});
```

`estimateOpenAiChatCostUsd` uses a small built-in price table for common
models and returns `null` when the model id is unknown — refresh
`src/pricing.ts` when OpenAI changes list prices, or pass your own
`estimateLlmCostUsd` function.

The React/Vue/Angular stores keep the latest payload on
`lastLlmUsage` when events flow through the default transport.
