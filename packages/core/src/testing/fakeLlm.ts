import type {
  LlmAdapter,
  LlmGenerateOptions,
  LlmStreamChunk,
  LlmTokenUsage,
  LlmTool,
} from "../adapters/llm.js";

/**
 * Scripted LLM adapter for tests. Feed it an array of responses and each
 * call consumes one. Responses can be plain text or tool calls.
 */
export type FakeLlmResponse =
  | {
      kind: "text";
      text: string;
      /** Optional final usage chunk (mirrors OpenAI `include_usage`). */
      usage?: LlmTokenUsage;
      model?: string;
    }
  | {
      kind: "toolCall";
      name: string;
      args: unknown;
      followUpText?: string;
      usage?: LlmTokenUsage;
      model?: string;
    };

export class FakeLlm implements LlmAdapter {
  readonly defaultModel = "fake-llm-1";
  private readonly queue: FakeLlmResponse[];

  constructor(responses: FakeLlmResponse[] = []) {
    this.queue = [...responses];
  }

  enqueue(...responses: FakeLlmResponse[]): void {
    this.queue.push(...responses);
  }

  private nextResponse(): FakeLlmResponse {
    const r = this.queue.shift();
    if (!r) return { kind: "text", text: "(fake llm: no more responses queued)" };
    return r;
  }

  async *stream<TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ): AsyncIterable<LlmStreamChunk> {
    const r = this.nextResponse();
    if (r.kind === "text") {
      for (const word of r.text.split(/(\s+)/)) {
        yield { textDelta: word };
      }
      if (r.usage) {
        yield {
          usage: r.usage,
          model: r.model ?? opts.model ?? this.defaultModel,
        };
      }
      return;
    }
    yield { toolCall: { id: `call_${Math.random().toString(36).slice(2, 8)}`, name: r.name, args: r.args } };
    if (r.followUpText) yield { textDelta: r.followUpText };
    if (r.usage) {
      yield {
        usage: r.usage,
        model: r.model ?? opts.model ?? this.defaultModel,
      };
    }
  }

  async generate<TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ) {
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

export const createFakeLlm = (responses: FakeLlmResponse[] = []): FakeLlm =>
  new FakeLlm(responses);
