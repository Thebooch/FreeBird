import OpenAI from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  LlmAdapter,
  LlmGenerateOptions,
  LlmMessage,
  LlmStreamChunk,
  LlmTokenUsage,
  LlmTool,
} from "@freebirdai/core";

export interface OpenAiAdapterOptions {
  /** API key. Falls back to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /** Default model. Falls back to `gpt-4o-mini`. */
  defaultModel?: string;
  /** Custom base URL (e.g. Azure / proxy). */
  baseURL?: string;
  /**
   * When `true`, streaming completions request `include_usage` and the
   * adapter yields a final {@link LlmStreamChunk} with `usage` + `model`.
   * Pair with `ChatEngine` options `emitLlmUsage` / `onLlmUsage` and
   * optionally {@link estimateOpenAiChatCostUsd} for USD hints.
   */
  includeUsage?: boolean;
  /** Extra OpenAI client options. */
  client?: ConstructorParameters<typeof OpenAI>[0];
}

/**
 * OpenAI LLM adapter. Implements the FreeBird `LlmAdapter` contract using
 * the official `openai` Node SDK. Tool schemas are converted from zod to
 * JSON Schema via `zod-to-json-schema` so the LLM receives the exact shape
 * it needs to satisfy FreeBird's zod validation on the other side.
 */
export class OpenAiAdapter implements LlmAdapter {
  readonly defaultModel: string;
  private readonly client: OpenAI;
  private readonly includeUsage: boolean;

  constructor(opts: OpenAiAdapterOptions = {}) {
    this.defaultModel = opts.defaultModel ?? "gpt-4o-mini";
    this.includeUsage = opts.includeUsage ?? false;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: opts.baseURL,
      ...opts.client,
    });
  }

  async *stream<TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ): AsyncIterable<LlmStreamChunk> {
    const resolvedModel = opts.model ?? this.defaultModel;
    const stream = await this.client.chat.completions.create(
      {
        model: resolvedModel,
        temperature: opts.temperature,
        max_tokens: opts.maxOutputTokens,
        messages: toOpenAiMessages(opts.messages),
        tools: toOpenAiTools(opts.tools),
        tool_choice: toOpenAiToolChoice(opts.toolChoice),
        stream: true,
        ...(this.includeUsage
          ? { stream_options: { include_usage: true } }
          : {}),
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
      { signal: opts.signal },
    );

    const toolBuffers = new Map<
      string,
      { id: string; name: string; argsRaw: string }
    >();

    for await (const chunk of stream) {
      if (this.includeUsage && chunk.usage) {
        const u = chunk.usage;
        yield {
          usage: {
            promptTokens: u.prompt_tokens,
            completionTokens: u.completion_tokens,
            totalTokens: u.total_tokens,
          },
          model: (chunk as { model?: string }).model ?? resolvedModel,
        };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta.content) {
        yield { textDelta: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index;
        const key = String(idx);
        const buf = toolBuffers.get(key) ?? { id: tc.id ?? "", name: "", argsRaw: "" };
        if (tc.id) buf.id = tc.id;
        if (tc.function?.name) buf.name = tc.function.name;
        if (tc.function?.arguments) buf.argsRaw += tc.function.arguments;
        toolBuffers.set(key, buf);
      }
      if (choice.finish_reason === "tool_calls") {
        for (const buf of toolBuffers.values()) {
          if (!buf.name) continue;
          yield {
            toolCall: {
              id: buf.id,
              name: buf.name,
              args: safeParseJson(buf.argsRaw),
            },
          };
        }
        toolBuffers.clear();
      }
    }

    // Some providers never emit finish_reason mid-stream when args are tiny; flush.
    for (const buf of toolBuffers.values()) {
      if (!buf.name) continue;
      yield {
        toolCall: {
          id: buf.id,
          name: buf.name,
          args: safeParseJson(buf.argsRaw),
        },
      };
    }
  }

  async generate<TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ): Promise<{
    text: string;
    toolCalls: Array<{ id: string; name: string; args: unknown }>;
    usage?: LlmTokenUsage;
    model?: string;
  }> {
    let text = "";
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
    let usage: LlmTokenUsage | undefined;
    let model: string | undefined;
    for await (const c of this.stream(opts)) {
      if (c.textDelta) text += c.textDelta;
      if (c.toolCall) toolCalls.push(c.toolCall);
      if (c.usage) usage = c.usage;
      if (c.model) model = c.model;
    }
    return { text, toolCalls, usage, model };
  }
}

export const createOpenAiAdapter = (opts: OpenAiAdapterOptions = {}): OpenAiAdapter =>
  new OpenAiAdapter(opts);

export {
  estimateOpenAiChatCostUsd,
  normalizeOpenAiModelId,
} from "./pricing.js";

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const toOpenAiMessages = (msgs: LlmMessage[]) =>
  msgs.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
      };
    }
    return { role: m.role, content: m.content };
  });

const toOpenAiTools = (tools?: Record<string, LlmTool>) => {
  if (!tools || Object.keys(tools).length === 0) return undefined;
  return Object.values(tools).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema, { target: "openAi" }) as Record<string, unknown>,
    },
  }));
};

const toOpenAiToolChoice = (
  choice: LlmGenerateOptions<any>["toolChoice"],
): "auto" | "none" | { type: "function"; function: { name: string } } | undefined => {
  if (!choice) return undefined;
  if (choice === "auto") return "auto";
  return { type: "function", function: { name: (choice as { name: string }).name } };
};

const safeParseJson = (s: string): unknown => {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __parseError: true, raw: s };
  }
};
