import type { z } from "zod";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

/**
 * Declarative tool schema the LLM adapter converts to its provider's format.
 * Using zod keeps args validated end-to-end.
 */
export interface LlmTool<TArgs = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TArgs>;
}

/**
 * Token counts from a single completion. Populated when an adapter
 * supports usage reporting (e.g. OpenAI with `includeUsage: true`).
 */
export interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmStreamChunk {
  /** Plain text delta — append to the assistant message. */
  textDelta?: string;
  /**
   * A complete tool call (we don't stream tool-call arguments because we
   * need the whole JSON to validate against the zod schema).
   */
  toolCall?: {
    id: string;
    name: string;
    args: unknown;
  };
  /**
   * Present on the **final** chunk of a completion when the provider
   * includes aggregate usage (streaming or not).
   */
  usage?: LlmTokenUsage;
  /**
   * Resolved model id for this completion (when known). Often sent
   * alongside {@link usage}.
   */
  model?: string;
}

export interface LlmGenerateOptions<TTools extends Record<string, LlmTool> = {}> {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  messages: LlmMessage[];
  tools?: TTools;
  /** If set, the LLM must call one of the named tools. */
  toolChoice?: "auto" | { name: keyof TTools & string };
  /** Abort signal for client disconnect etc. */
  signal?: AbortSignal;
}

export interface LlmAdapter {
  /** Model id used when options.model is not supplied. */
  readonly defaultModel: string;
  /** Streaming generation. The iterator is the primary path used by chat. */
  stream: <TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ) => AsyncIterable<LlmStreamChunk>;
  /**
   * Single-shot generation used for non-streaming paths (layout planning,
   * digest summaries). Implementations may delegate to `stream()`.
   */
  generate: <TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ) => Promise<{
    text: string;
    toolCalls: Array<{ id: string; name: string; args: unknown }>;
    usage?: LlmTokenUsage;
    model?: string;
  }>;
}
