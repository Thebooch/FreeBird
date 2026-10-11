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
  /**
   * Ask Anthropic to cache the request up to a message's `cachePoint`: the
   * tools and the part of the system prompt that reads the same on every
   * call. Default `true`. A cached prefix is read back at a fraction of the
   * input price and written at a premium, so a host whose calls are rarely
   * minutes apart may turn it off.
   */
  promptCache?: boolean;
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
  private readonly promptCache: boolean;

  constructor(opts: AnthropicAdapterOptions = {}) {
    this.defaultModel = opts.defaultModel ?? "claude-3-5-sonnet-latest";
    this.promptCache = opts.promptCache ?? true;
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: opts.baseURL,
    });
  }

  async *stream<TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ): AsyncIterable<LlmStreamChunk> {
    const { system, messages } = splitSystem(opts.messages, this.promptCache);
    const stream = this.client.messages.stream(
      {
        model: opts.model ?? this.defaultModel,
        max_tokens: opts.maxOutputTokens ?? 1024,
        temperature: opts.temperature,
        // A block list with `cache_control` when there is a cache point; the
        // installed SDK's types predate it, the API takes it.
        system: system as any,
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

/** Between system messages, as the model reads them. */
const SYSTEM_JOIN = "\n\n";

export const createAnthropicAdapter = (opts: AnthropicAdapterOptions = {}): AnthropicAdapter =>
  new AnthropicAdapter(opts);

/**
 * Anthropic takes the system prompt apart from the messages. A `cachePoint`
 * (`@freebirdai/contracts`) splits it in two text blocks: up to and including
 * that message, marked for the cache (the tools come first, so they are cached
 * with it), then the rest, opening with the separator so the cached block
 * reads the same whatever follows. With no cache point, or caching off, it is
 * one string. The model reads the same words either way.
 */
export const splitSystem = (messages: LlmMessage[], promptCache = true) => {
  const sep = SYSTEM_JOIN;
  const systemMessages = messages.filter((m) => m.role === "system");
  const joined = (part: LlmMessage[]) => part.map((m) => m.content).join(sep);
  const rest = messages
    .filter((m) => m.role !== "system" && m.role !== "tool")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  const point = promptCache ? systemMessages.findIndex((m) => m.cachePoint) : -1;
  const stable = joined(systemMessages.slice(0, point + 1));
  if (point < 0 || !stable) return { system: joined(systemMessages) || undefined, messages: rest };
  const after = joined(systemMessages.slice(point + 1));
  return {
    system: [
      { type: "text" as const, text: stable, cache_control: { type: "ephemeral" as const } },
      ...(after ? [{ type: "text" as const, text: sep + after }] : []),
    ],
    messages: rest,
  };
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
