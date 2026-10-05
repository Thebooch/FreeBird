import type { z } from "zod";

/**
 * Copied byte-for-byte from `@freebirdai/core`'s `adapters/llm.ts` so the
 * published `@freebirdai/adapters-llm-openai` and `-anthropic` drop straight in
 * once they ship. Do not let these drift.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

export interface LlmTool<TArgs = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TArgs>;
}

export interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens served from the provider's cache, counted within
   * `promptTokens` rather than in addition to it.
   *
   * Reported because it is priced at roughly a tenth of a fresh prompt token —
   * a cost figure that ignores it can be an order of magnitude wrong on a
   * conversation that reuses a long prefix, which is most of them.
   */
  cachedPromptTokens?: number;
  /** Prompt tokens written to cache, billed at a premium on some providers. */
  cacheWriteTokens?: number;
}

export interface LlmStreamChunk {
  textDelta?: string;
  toolCall?: {
    id: string;
    name: string;
    args: unknown;
  };
  usage?: LlmTokenUsage;
  model?: string;
}

export interface LlmGenerateOptions<TTools extends Record<string, LlmTool> = {}> {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  messages: LlmMessage[];
  tools?: TTools;
  toolChoice?: "auto" | { name: keyof TTools & string };
  signal?: AbortSignal;
}

export interface LlmAdapter {
  readonly defaultModel: string;
  stream: <TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ) => AsyncIterable<LlmStreamChunk>;
  generate: <TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ) => Promise<{
    text: string;
    toolCalls: Array<{ id: string; name: string; args: unknown }>;
    usage?: LlmTokenUsage;
    model?: string;
  }>;
}

/**
 * A scripted adapter for tests and for running the whole flow offline —
 * the same philosophy as FreeBird's echo LLM: an offline path that goes
 * *through* the production code is worth more than a mock that goes around it.
 */
/** What `fakeLlm` records — the fields a test actually asserts on. */
export interface RecordedCall {
  readonly messages: readonly LlmMessage[];
  readonly toolChoice: "auto" | { name: string } | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly temperature: number | undefined;
  readonly model: string | undefined;
  readonly toolNames: readonly string[];
}

export const fakeLlm = (
  responses: Array<{ args: unknown } | { text: string }>,
): LlmAdapter & { calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  let index = 0;

  const generate: LlmAdapter["generate"] = async (opts) => {
    calls.push({
      messages: opts.messages,
      toolChoice: opts.toolChoice as "auto" | { name: string } | undefined,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature,
      model: opts.model,
      toolNames: Object.keys(opts.tools ?? {}),
    });
    const next = responses[Math.min(index++, responses.length - 1)];
    if (!next) return { text: "", toolCalls: [] };
    if ("text" in next) return { text: next.text, toolCalls: [] };
    const toolName =
      typeof opts.toolChoice === "object" ? opts.toolChoice.name : Object.keys(opts.tools ?? {})[0];
    return {
      text: "",
      toolCalls: [{ id: `call_${index}`, name: toolName ?? "propose_widget", args: next.args }],
    };
  };

  return {
    defaultModel: "fake",
    generate,
    stream: async function* (opts) {
      const result = await generate(opts);
      if (result.text) yield { textDelta: result.text };
      for (const call of result.toolCalls) yield { toolCall: call };
    },
    calls,
  };
};
