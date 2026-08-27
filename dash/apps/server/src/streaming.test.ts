import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicAdapter, openAiAdapter } from "./llm.js";
import type { LlmStreamChunk } from "@freebirdai/dash-agent";

/**
 * Streaming, which the chat column reads as its primary path.
 *
 * The interesting behaviour is all in the seams: a chunk boundary falls where
 * the network puts it, routinely mid-line and mid-JSON, so anything that
 * parses per chunk works in a test and drops deltas over a real connection.
 * Every case here splits the bytes somewhere awkward on purpose.
 */

/** An SSE body delivered in whatever pieces the test wants to simulate. */
const sseResponse = (pieces: readonly string[], status = 200): Response => {
  const encoder = new TextEncoder();
  const body = {
    async *[Symbol.asyncIterator]() {
      for (const piece of pieces) yield encoder.encode(piece);
    },
  };
  return {
    ok: status < 400,
    status,
    body,
    text: async () => pieces.join(""),
  } as unknown as Response;
};

const collect = async (stream: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> => {
  const out: LlmStreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};

const stubFetch = (response: Response): ReturnType<typeof vi.fn> => {
  const spy = vi.fn(async () => response);
  vi.stubGlobal("fetch", spy);
  return spy;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const event = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

describe("anthropic streaming", () => {
  it("yields text as it arrives, not as one lump at the end", async () => {
    stubFetch(
      sseResponse([
        event({ type: "message_start", message: { model: "claude-sonnet-5", usage: { input_tokens: 12 } } }),
        event({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Your " } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "leases" } }),
        event({ type: "content_block_stop", index: 0 }),
        event({ type: "message_delta", usage: { output_tokens: 5 } }),
      ]),
    );

    const chunks = await collect(anthropicAdapter("k").stream({ messages: [] }));
    expect(chunks.filter((chunk) => chunk.textDelta).map((chunk) => chunk.textDelta)).toEqual([
      "Your ",
      "leases",
    ]);
  });

  it("reassembles a delta split across network chunks", async () => {
    // The one failure mode a naive parser has: this event is delivered in
    // three pieces, none of which is valid JSON on its own.
    const whole = event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    });
    stubFetch(sseResponse([whole.slice(0, 14), whole.slice(14, 40), whole.slice(40)]));

    const chunks = await collect(anthropicAdapter("k").stream({ messages: [] }));
    expect(chunks.map((chunk) => chunk.textDelta)).toEqual(["hello"]);
  });

  it("assembles a tool call from its argument fragments and emits it once whole", async () => {
    stubFetch(
      sseResponse([
        event({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "start_setup" },
        }),
        event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"end' } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'point":"leases"}' } }),
        event({ type: "content_block_stop", index: 0 }),
      ]),
    );

    const chunks = await collect(anthropicAdapter("k").stream({ messages: [] }));
    const calls = chunks.filter((chunk) => chunk.toolCall);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolCall).toEqual({
      id: "toolu_1",
      name: "start_setup",
      args: { endpoint: "leases" },
    });
  });

  it("treats a tool call with no arguments as {}, not as malformed", async () => {
    stubFetch(
      sseResponse([
        event({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_2", name: "read_board" },
        }),
        event({ type: "content_block_stop", index: 0 }),
      ]),
    );

    const chunks = await collect(anthropicAdapter("k").stream({ messages: [] }));
    expect(chunks[0]?.toolCall?.args).toEqual({});
  });

  it("reports usage on a final chunk, summing cache reads into the prompt total", async () => {
    stubFetch(
      sseResponse([
        event({
          type: "message_start",
          message: {
            model: "claude-sonnet-5",
            usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
          },
        }),
        event({ type: "message_delta", usage: { output_tokens: 40 } }),
      ]),
    );

    const chunks = await collect(anthropicAdapter("k").stream({ messages: [] }));
    const last = chunks[chunks.length - 1];
    expect(last?.model).toBe("claude-sonnet-5");
    expect(last?.usage).toEqual({
      promptTokens: 1050,
      completionTokens: 40,
      totalTokens: 1090,
      cachedPromptTokens: 900,
      cacheWriteTokens: 50,
    });
  });

  it("throws on a mid-stream error rather than presenting a truncated reply as whole", async () => {
    stubFetch(
      sseResponse([
        event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "part" } }),
        event({ type: "error", error: { message: "overloaded" } }),
      ]),
    );

    await expect(collect(anthropicAdapter("k").stream({ messages: [] }))).rejects.toThrow(
      /overloaded/,
    );
  });

  it("reports a failed request with the status", async () => {
    stubFetch(sseResponse(['{"error":"nope"}'], 429));
    await expect(collect(anthropicAdapter("k").stream({ messages: [] }))).rejects.toThrow(/429/);
  });

  it("omits temperature for a model that removed it", async () => {
    const spy = stubFetch(sseResponse([]));
    await collect(anthropicAdapter("k").stream({ messages: [], model: "claude-sonnet-5" }));
    const body = JSON.parse((spy.mock.calls[0]?.[1] as { body: string }).body) as {
      temperature?: number;
      stream?: boolean;
    };
    expect(body.stream).toBe(true);
    expect(body.temperature).toBeUndefined();
  });
});

describe("openai streaming", () => {
  it("yields text deltas and assembles the tool call at the end", async () => {
    stubFetch(
      sseResponse([
        event({ model: "gpt-4o-mini", choices: [{ delta: { content: "one " } }] }),
        event({ choices: [{ delta: { content: "two" } }] }),
        event({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "revise_setup", arguments: '{"a"' } }],
              },
            },
          ],
        }),
        event({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }],
        }),
        event({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } }),
        "data: [DONE]\n\n",
      ]),
    );

    const chunks = await collect(openAiAdapter("k").stream({ messages: [] }));
    expect(chunks.filter((chunk) => chunk.textDelta).map((chunk) => chunk.textDelta)).toEqual([
      "one ",
      "two",
    ]);
    const call = chunks.find((chunk) => chunk.toolCall)?.toolCall;
    expect(call).toEqual({ id: "call_1", name: "revise_setup", args: { a: 1 } });
    expect(chunks[chunks.length - 1]?.usage?.totalTokens).toBe(38);
  });

  it("asks for usage, which is otherwise never sent on a streamed call", async () => {
    const spy = stubFetch(sseResponse(["data: [DONE]\n\n"]));
    await collect(openAiAdapter("k").stream({ messages: [] }));
    const body = JSON.parse((spy.mock.calls[0]?.[1] as { body: string }).body) as {
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
    expect(body.stream).toBe(true);
    expect(body.stream_options?.include_usage).toBe(true);
  });
});
