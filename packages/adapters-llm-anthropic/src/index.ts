import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  LlmAdapter,
  LlmGenerateOptions,
  LlmMessage,
  LlmStreamChunk,
  LlmTool,
} from "@freebirdai/core";

export interface AnthropicAdapterOptions {
  apiKey?: string;
  defaultModel?: string;
  baseURL?: string;
}

/**
 * Anthropic Claude adapter.
 *
 * Anthropic's API splits `system` from `messages`, and accepts tool schemas
 * as JSON Schema. We map both.
 */
export class AnthropicAdapter implements LlmAdapter {
  readonly defaultModel: string;
  private readonly client: Anthropic;

  constructor(opts: AnthropicAdapterOptions = {}) {
    this.defaultModel = opts.defaultModel ?? "claude-3-5-sonnet-latest";
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: opts.baseURL,
    });
  }

  async *stream<TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ): AsyncIterable<LlmStreamChunk> {
    const { system, messages } = splitSystem(opts.messages);
    const stream = this.client.messages.stream(
      {
        model: opts.model ?? this.defaultModel,
        max_tokens: opts.maxOutputTokens ?? 1024,
        temperature: opts.temperature,
        system,
        messages: messages as any,
        tools: toAnthropicTools(opts.tools),
      },
      { signal: opts.signal as any },
    );

    const partialTools = new Map<number, { id: string; name: string; argsRaw: string }>();

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          partialTools.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            argsRaw: "",
          });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { textDelta: event.delta.text };
        } else if (event.delta.type === "input_json_delta") {
          const buf = partialTools.get(event.index);
          if (buf) buf.argsRaw += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        const buf = partialTools.get(event.index);
        if (buf) {
          yield {
            toolCall: {
              id: buf.id,
              name: buf.name,
              args: safeParseJson(buf.argsRaw),
            },
          };
          partialTools.delete(event.index);
        }
      }
    }
  }

  async generate<TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ) {
    let text = "";
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
    for await (const c of this.stream(opts)) {
      if (c.textDelta) text += c.textDelta;
      if (c.toolCall) toolCalls.push(c.toolCall);
    }
    return { text, toolCalls };
  }
}

export const createAnthropicAdapter = (opts: AnthropicAdapterOptions = {}): AnthropicAdapter =>
  new AnthropicAdapter(opts);

const splitSystem = (messages: LlmMessage[]) => {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages
    .filter((m) => m.role !== "system" && m.role !== "tool")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  return { system: systemParts.join("\n\n") || undefined, messages: rest };
};

const toAnthropicTools = (tools?: Record<string, LlmTool>) => {
  if (!tools || Object.keys(tools).length === 0) return undefined;
  return Object.values(tools).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.schema) as unknown as {
      type: "object";
      properties?: Record<string, unknown>;
      required?: string[];
    },
  }));
};

const safeParseJson = (s: string): unknown => {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __parseError: true, raw: s };
  }
};
