import type { LlmAdapter, LlmMessage } from "@freebirdai/contracts";

/**
 * The LLM adapter shape is `@freebirdai/contracts`', the one guide's core uses
 * too, so guide and the engine plug in a model the same way: `@freebirdai/adapters-llm-openai` and `-anthropic`
 * drop straight in.
 */
export type {
  LlmAdapter,
  LlmGenerateOptions,
  LlmMessage,
  LlmStreamChunk,
  LlmTokenUsage,
  LlmTool,
} from "@freebirdai/contracts";

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
