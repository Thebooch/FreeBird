import type { LlmAdapter, LlmTokenUsage, LlmTool } from "@freebirdai/dash-agent";
import { z } from "zod";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER,
  type LlmTask,
  type Provider,
  TIER_MODELS,
  capabilitiesFor,
  envVarForTask,
  findTask,
  providerFor,
} from "./models.js";
import { RATES_AS_OF, costOf, formatUsd } from "./pricing.js";

/**
 * Minimal OpenAI- and Anthropic-shaped adapters.
 *
 * These implement the `LlmAdapter` interface copied byte-for-byte from
 * `@freebirdai/core`, so when `@freebirdai/adapters-llm-*` are published they drop
 * in and this file is deleted.
 */

interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
  enum?: readonly (string | number)[];
}

/**
 * A zod→JSON Schema converter for the flat subset the proposal tool uses:
 * objects of strings and arrays of flat objects, plus `optional` and
 * `describe`. This is exactly why the tool schema is constrained to be dull —
 * no refinements, records or unions means no dependency on
 * `zod-to-json-schema` and none of its failure modes.
 */
export const toJsonSchema = (schema: z.ZodTypeAny): JsonSchema => {
  const def = schema._def as { typeName: string; [key: string]: unknown };

  switch (def.typeName) {
    case "ZodOptional":
    case "ZodDefault":
      return toJsonSchema(def.innerType as z.ZodTypeAny);
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodArray":
      return { type: "array", items: toJsonSchema(def.type as z.ZodTypeAny) };
    /*
     * A closed set of strings is still flat — one field, one scalar, a listed
     * set of accepted values — and it is how an action says "pick one of these"
     * without relying on prose in the description to be obeyed.
     */
    case "ZodEnum":
      return { type: "string", enum: def.values as readonly string[] };
    case "ZodLiteral":
      return { type: typeof def.value === "number" ? "number" : "string", enum: [def.value as string | number] };
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [name, field] of Object.entries(shape)) {
        const inner = toJsonSchema(field);
        const description = (field._def as { description?: string }).description;
        properties[name] = description ? { ...inner, description } : inner;
        if (!field.isOptional()) required.push(name);
      }
      return { type: "object", properties, required, additionalProperties: false };
    }
    default:
      // Anything outside the flat subset is a bug in the tool definition, not
      // something to paper over with `{}` and debug at runtime.
      throw new Error(`tool schemas must stay flat; got ${def.typeName}`);
  }
};

const toolPayloads = (
  tools: Record<string, LlmTool> | undefined,
): Array<{ name: string; description: string; schema: JsonSchema }> =>
  Object.values(tools ?? {}).map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: toJsonSchema(tool.schema as z.ZodTypeAny),
  }));

/** Adapters surface malformed arguments as a sentinel rather than throwing. */
const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return { __parseError: text.slice(0, 200) };
  }
};

/* ── server-sent events ───────────────────────────────────────────────────
 *
 * Both providers stream the same way: `text/event-stream`, one JSON object per
 * `data:` line, blank line between events. Thirty lines of parsing rather than
 * an SDK, for the same reason the rest of this file is hand-rolled — and the
 * two adapters share it because a difference in how the bytes are split is
 * never a difference worth having twice.
 */

/**
 * The `data:` payloads of an SSE response, in order.
 *
 * The buffering is the whole job. A chunk boundary falls wherever the network
 * puts it, routinely mid-line and mid-JSON, so anything that parses per chunk
 * works locally and drops deltas over a real connection.
 */
async function* sseData(response: Response, label: string): AsyncGenerator<unknown> {
  const body = response.body;
  if (!body) throw new Error(`${label} returned no response body to stream`);

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    let cut = buffer.indexOf("\n");
    while (cut !== -1) {
      const line = buffer.slice(0, cut).replace(/\r$/, "");
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");

      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      // OpenAI's terminator. Anthropic ends with an event instead, so both
      // paths still have to notice their own end-of-stream.
      if (payload === "" || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // A payload that is not JSON is not something to guess at. Skipping it
        // loses one delta; throwing loses the whole reply.
      }
    }
  }
}

/** The provider's error body, truncated — it can echo the request back, key included. */
const streamFailure = async (response: Response, label: string): Promise<Error> => {
  const detail = await response.text().catch(() => "");
  return new Error(`${label} request failed (${response.status}): ${detail.slice(0, 200)}`);
};

export const openAiAdapter = (
  apiKey: string,
  options: { baseUrl?: string; model?: string } = {},
): LlmAdapter => {
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  /*
   * The provider default, not a literal. A hardcoded id here outlives the
   * catalogue: when the 4.x models were retired this still named one, so an
   * adapter built without an explicit model would have called something the
   * picker no longer offers and the price table no longer knows — logging
   * every one of those calls as unpriced.
   */
  const defaultModel = options.model ?? DEFAULT_MODEL_BY_PROVIDER.openai;

  // Typed through the interface so the generic signature is preserved —
  // annotating the parameter concretely makes it unassignable to LlmAdapter.
  const generate: LlmAdapter["generate"] = async (opts) => {
    const tools = toolPayloads(opts.tools);
    const model = opts.model ?? defaultModel;
    // Reasoning models reject sampling parameters outright, so this is decided
    // per call from the model actually being used — not once per adapter.
    const { supportsTemperature } = capabilitiesFor(model);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      ...(opts.signal ? { signal: opts.signal } : {}),
      body: JSON.stringify({
        model,
        ...(supportsTemperature ? { temperature: opts.temperature ?? 0.2 } : {}),
        /*
         * `max_completion_tokens`, not `max_tokens`.
         *
         * The current OpenAI models reject `max_tokens` outright — a 400 on
         * every call, before the prompt is even looked at. Anthropic still
         * takes `max_tokens`, which is why this differs between the two
         * adapters in this file rather than being shared.
         */
        max_completion_tokens: opts.maxOutputTokens ?? 4096,
        messages: opts.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        /*
         * Reasoning off whenever tools are in play.
         *
         * The current OpenAI models refuse function tools and reasoning
         * together on `/v1/chat/completions` — a 400 naming `reasoning_effort`
         * and offering two ways out: move to `/v1/responses`, or turn it off.
         * Nearly every call this product makes is a forced tool call, so
         * without this none of them work at all.
         *
         * Scoped to calls that actually send tools, so the one step that does
         * not — the final reply, which is prose and nothing else — keeps
         * whatever reasoning the model does by default. Sending it
         * unconditionally would trade that away for nothing.
         */
        ...(tools.length > 0 ? { reasoning_effort: "none" } : {}),
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.schema,
                },
              })),
              tool_choice:
                typeof opts.toolChoice === "object"
                  ? { type: "function", function: { name: opts.toolChoice.name } }
                  : "auto",
            }
          : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      // Truncate: a provider error body can echo the request back, key included.
      throw new Error(`OpenAI request failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
      model?: string;
    };

    const message = payload.choices?.[0]?.message;
    return {
      text: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        args: safeParse(call.function.arguments),
      })),
      ...(payload.usage
        ? {
            usage: {
              promptTokens: payload.usage.prompt_tokens,
              completionTokens: payload.usage.completion_tokens,
              totalTokens: payload.usage.total_tokens,
              // Priced at a quarter to a tenth of a fresh prompt token, so a
              // cost figure that ignores it overstates a cached conversation.
              cachedPromptTokens: payload.usage.prompt_tokens_details?.cached_tokens ?? 0,
            },
          }
        : {}),
      ...(payload.model ? { model: payload.model } : {}),
    };
  };

  /**
   * The same request with `stream: true`, yielded as it arrives.
   *
   * Chat calls this as its primary path, and until it existed a reply landed
   * in one lump after the whole completion had been generated — correct, and
   * indistinguishable from a hang for the ten seconds it took.
   *
   * `generate` above is deliberately untouched. The authoring agent needs a
   * whole tool-call JSON before it can validate one, so assembling deltas for
   * it would be doing this work twice to arrive back where it started.
   */
  const stream: LlmAdapter["stream"] = async function* (opts) {
    const tools = toolPayloads(opts.tools);
    const model = opts.model ?? defaultModel;
    const { supportsTemperature } = capabilitiesFor(model);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      ...(opts.signal ? { signal: opts.signal } : {}),
      body: JSON.stringify({
        model,
        stream: true,
        // Without this the usage block never arrives and every streamed call
        // is logged as unpriced — a running total you cannot trust.
        stream_options: { include_usage: true },
        ...(supportsTemperature ? { temperature: opts.temperature ?? 0.2 } : {}),
        /*
         * `max_completion_tokens`, not `max_tokens`.
         *
         * The current OpenAI models reject `max_tokens` outright — a 400 on
         * every call, before the prompt is even looked at. Anthropic still
         * takes `max_tokens`, which is why this differs between the two
         * adapters in this file rather than being shared.
         */
        max_completion_tokens: opts.maxOutputTokens ?? 4096,
        messages: opts.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        /*
         * Reasoning off whenever tools are in play.
         *
         * The current OpenAI models refuse function tools and reasoning
         * together on `/v1/chat/completions` — a 400 naming `reasoning_effort`
         * and offering two ways out: move to `/v1/responses`, or turn it off.
         * Nearly every call this product makes is a forced tool call, so
         * without this none of them work at all.
         *
         * Scoped to calls that actually send tools, so the one step that does
         * not — the final reply, which is prose and nothing else — keeps
         * whatever reasoning the model does by default. Sending it
         * unconditionally would trade that away for nothing.
         */
        ...(tools.length > 0 ? { reasoning_effort: "none" } : {}),
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.schema,
                },
              })),
              tool_choice:
                typeof opts.toolChoice === "object"
                  ? { type: "function", function: { name: opts.toolChoice.name } }
                  : "auto",
            }
          : {}),
      }),
    });

    if (!response.ok) throw await streamFailure(response, "OpenAI");

    /*
     * Tool calls arrive as deltas keyed by index, name first and arguments in
     * fragments after it. They are assembled and emitted at the end rather
     * than as they arrive: a caller cannot act on half a JSON argument, and
     * emitting a partial one would invite it to try.
     */
    const building = new Map<number, { id: string; name: string; args: string }>();
    let reported: { model?: string; usage?: LlmTokenUsage } = {};

    for await (const event of sseData(response, "OpenAI")) {
      const frame = event as {
        model?: string;
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };

      if (frame.model) reported.model = frame.model;
      if (frame.usage) {
        reported.usage = {
          promptTokens: frame.usage.prompt_tokens,
          completionTokens: frame.usage.completion_tokens,
          totalTokens: frame.usage.total_tokens,
          cachedPromptTokens: frame.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }

      const delta = frame.choices?.[0]?.delta;
      if (delta?.content) yield { textDelta: delta.content };

      for (const call of delta?.tool_calls ?? []) {
        const held = building.get(call.index) ?? { id: "call", name: "", args: "" };
        if (call.id) held.id = call.id;
        if (call.function?.name) held.name = call.function.name;
        if (call.function?.arguments) held.args += call.function.arguments;
        building.set(call.index, held);
      }
    }

    for (const held of building.values()) {
      if (held.name) yield { toolCall: { id: held.id, name: held.name, args: safeParse(held.args) } };
    }
    if (reported.usage || reported.model) yield { ...reported };
  };

  return { defaultModel, stream, generate };
};

export const anthropicAdapter = (
  apiKey: string,
  options: { model?: string } = {},
): LlmAdapter => {
  const defaultModel = options.model ?? "claude-sonnet-5";

  const generate: LlmAdapter["generate"] = async (opts) => {
    const tools = toolPayloads(opts.tools);
    const model = opts.model ?? defaultModel;
    const { supportsTemperature } = capabilitiesFor(model);
    const system = opts.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
      body: JSON.stringify({
        model,
        // Anthropic defaults this to 1024 and truncates silently.
        max_tokens: opts.maxOutputTokens ?? 4096,
        // `temperature` was REMOVED on Sonnet 5 / Opus 5 / Opus 4.8 / 4.7 —
        // sending it is a 400, not a warning. Omitted unless the table says
        // this model still takes it.
        ...(supportsTemperature ? { temperature: opts.temperature ?? 0.2 } : {}),
        ...(system ? { system } : {}),
        messages: opts.messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content,
          })),
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.schema,
              })),
              ...(typeof opts.toolChoice === "object"
                ? { tool_choice: { type: "tool", name: opts.toolChoice.name } }
                : {}),
            }
          : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Anthropic request failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      model?: string;
    };

    const blocks = payload.content ?? [];
    return {
      text: blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(""),
      toolCalls: blocks
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id ?? "call",
          name: block.name ?? "",
          args: block.input,
        })),
      ...(payload.usage
        ? {
            usage: {
              /*
               * Anthropic reports cache hits and writes *outside* `input_tokens`,
               * so the prompt total is the sum — reading `input_tokens` alone
               * under-reports a cached call rather than over-reporting it, which
               * is the more misleading direction for a spend figure.
               */
              promptTokens:
                payload.usage.input_tokens +
                (payload.usage.cache_read_input_tokens ?? 0) +
                (payload.usage.cache_creation_input_tokens ?? 0),
              completionTokens: payload.usage.output_tokens,
              totalTokens:
                payload.usage.input_tokens +
                (payload.usage.cache_read_input_tokens ?? 0) +
                (payload.usage.cache_creation_input_tokens ?? 0) +
                payload.usage.output_tokens,
              cachedPromptTokens: payload.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: payload.usage.cache_creation_input_tokens ?? 0,
            },
          }
        : {}),
      ...(payload.model ? { model: payload.model } : {}),
    };
  };

  /**
   * The same request with `stream: true`, yielded as it arrives.
   *
   * Anthropic streams content as numbered blocks rather than as one text
   * field: `content_block_start` opens a block, `content_block_delta` extends
   * it, `content_block_stop` closes it. A text block's deltas are the reply;
   * a tool block's deltas are *fragments of the argument JSON*, which is why
   * they are accumulated per block and only emitted once the block closes.
   */
  const stream: LlmAdapter["stream"] = async function* (opts) {
    const tools = toolPayloads(opts.tools);
    const model = opts.model ?? defaultModel;
    const { supportsTemperature } = capabilitiesFor(model);
    const system = opts.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: opts.maxOutputTokens ?? 4096,
        // Same capability gate as `generate`: sending `temperature` to a model
        // that has removed it is a hard 400, not an ignored field.
        ...(supportsTemperature ? { temperature: opts.temperature ?? 0.2 } : {}),
        ...(system ? { system } : {}),
        messages: opts.messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content,
          })),
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.schema,
              })),
              ...(typeof opts.toolChoice === "object"
                ? { tool_choice: { type: "tool", name: opts.toolChoice.name } }
                : {}),
            }
          : {}),
      }),
    });

    if (!response.ok) throw await streamFailure(response, "Anthropic");

    const blocks = new Map<number, { id: string; name: string; args: string }>();
    let reportedModel: string | undefined;
    /*
     * Input tokens arrive on `message_start` and output tokens on
     * `message_delta`, so the usage figure is assembled across the stream and
     * emitted once at the end — the shape `meter` already expects.
     */
    let input = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let output = 0;
    let sawUsage = false;

    for await (const event of sseData(response, "Anthropic")) {
      const frame = event as {
        type?: string;
        index?: number;
        message?: {
          model?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
        usage?: { output_tokens?: number };
        error?: { message?: string };
      };

      switch (frame.type) {
        case "message_start": {
          reportedModel = frame.message?.model ?? reportedModel;
          const usage = frame.message?.usage;
          if (usage) {
            sawUsage = true;
            input += usage.input_tokens ?? 0;
            cacheRead += usage.cache_read_input_tokens ?? 0;
            cacheWrite += usage.cache_creation_input_tokens ?? 0;
            output += usage.output_tokens ?? 0;
          }
          break;
        }
        case "content_block_start":
          if (frame.content_block?.type === "tool_use" && frame.index !== undefined) {
            blocks.set(frame.index, {
              id: frame.content_block.id ?? "call",
              name: frame.content_block.name ?? "",
              args: "",
            });
          }
          break;
        case "content_block_delta": {
          if (frame.delta?.type === "text_delta" && frame.delta.text) {
            yield { textDelta: frame.delta.text };
          } else if (frame.delta?.type === "input_json_delta" && frame.index !== undefined) {
            const held = blocks.get(frame.index);
            if (held) held.args += frame.delta.partial_json ?? "";
          }
          break;
        }
        case "content_block_stop": {
          if (frame.index === undefined) break;
          const held = blocks.get(frame.index);
          if (held && held.name) {
            blocks.delete(frame.index);
            /*
             * An empty argument string is `{}`, not a parse error. A tool with
             * no required arguments legitimately streams no `input_json_delta`
             * at all, and reporting that as malformed would refuse a valid
             * call.
             */
            yield {
              toolCall: {
                id: held.id,
                name: held.name,
                args: held.args.trim() === "" ? {} : safeParse(held.args),
              },
            };
          }
          break;
        }
        case "message_delta":
          if (frame.usage?.output_tokens !== undefined) {
            sawUsage = true;
            output += frame.usage.output_tokens;
          }
          break;
        case "error":
          /*
           * A mid-stream error is reported, never swallowed. The HTTP status
           * was 200 — the failure happened after the headers — so silently
           * ending the iteration would present a truncated reply as a complete
           * one, which is the worst available outcome.
           */
          throw new Error(`Anthropic stream failed: ${frame.error?.message ?? "unknown error"}`);
        default:
          break;
      }
    }

    if (sawUsage || reportedModel) {
      yield {
        ...(reportedModel ? { model: reportedModel } : {}),
        ...(sawUsage
          ? {
              usage: {
                // Cache hits and writes sit outside `input_tokens`, so the
                // prompt total is the sum — reading the one field alone
                // under-reports a cached call.
                promptTokens: input + cacheRead + cacheWrite,
                completionTokens: output,
                totalTokens: input + cacheRead + cacheWrite + output,
                cachedPromptTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
              },
            }
          : {}),
      };
    }
  };

  return { defaultModel, stream, generate };
};

/* ── metering ─────────────────────────────────────────────────────────── */

/**
 * What every model call has cost this process, printed as it happens.
 *
 * A decorator on the adapter rather than a line at each call site: there are
 * five places that reach for a model — suggestions, the authoring agent, chat,
 * discovery's docs rung, and search — and any accounting that has to be
 * remembered at each of them will be wrong within a release. Wrapping the one
 * factory below means a sixth caller is metered without knowing it exists.
 */
const spend = { usd: 0, calls: 0, unpriced: 0 };

export interface SpendTotals {
  readonly usd: number;
  readonly calls: number;
  readonly unpriced: number;
}

/*
 * The same totals, split by the task that spent them.
 *
 * Kept because "AI cost $4.10" cannot be acted on and "building widgets cost
 * $3.90 of it" can. The label already rides along to the log line; keeping a
 * tally beside it is the difference between a number and a decision.
 *
 * Keyed by the label as given rather than by the task table, so a call site
 * that passes something unexpected is visible here instead of vanishing.
 */
const byTask = new Map<string, { usd: number; calls: number; unpriced: number }>();

/** Totals since the process started. Cleared only by a restart, or a test. */
export const llmSpend = (): SpendTotals & { byTask: Record<string, SpendTotals> } => ({
  ...spend,
  byTask: Object.fromEntries([...byTask].map(([task, totals]) => [task, { ...totals }])),
});

export const resetLlmSpend = (): void => {
  spend.usd = 0;
  spend.calls = 0;
  spend.unpriced = 0;
  byTask.clear();
};

const tally = (label: string, usd: number, priced: boolean): void => {
  spend.calls += 1;
  if (priced) spend.usd += usd;
  else spend.unpriced += 1;

  const totals = byTask.get(label) ?? { usd: 0, calls: 0, unpriced: 0 };
  totals.calls += 1;
  if (priced) totals.usd += usd;
  else totals.unpriced += 1;
  byTask.set(label, totals);
};

const thousands = (value: number): string => value.toLocaleString("en-US");

/** Exported so the log line and the running total can be tested directly. */
export const meter = (adapter: LlmAdapter, label: string): LlmAdapter => {
  const record = (
    usage: LlmTokenUsage | undefined,
    model: string | undefined,
    startedAt: number,
  ): void => {
    const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    /*
     * A provider that returns no usage block is reported, not skipped. The
     * alternative — a silent gap — makes the running total quietly too low,
     * and a total you cannot trust is worth less than no total at all.
     */
    if (!usage) {
      console.info(`[llm] ${label} · ${model ?? "unknown"} · no usage reported · ${elapsed}`);
      tally(label, 0, false);
      return;
    }

    const cost = costOf(model, usage);
    tally(label, cost.usd, cost.priced);

    const cached = usage.cachedPromptTokens ?? 0;
    const written = usage.cacheWriteTokens ?? 0;
    const cacheNote =
      cached > 0 || written > 0
        ? ` (cached ${thousands(cached)}, written ${thousands(written)})`
        : "";

    console.info(
      `[llm] ${label} · ${model ?? "unknown"}` +
        ` · in ${thousands(usage.promptTokens)}${cacheNote}` +
        ` · out ${thousands(usage.completionTokens)}` +
        ` · ${cost.priced ? formatUsd(cost.usd) : `unpriced (no rate as of ${RATES_AS_OF})`}` +
        ` · ${elapsed}` +
        ` — session ${formatUsd(spend.usd)} over ${spend.calls} call${spend.calls === 1 ? "" : "s"}` +
        (spend.unpriced > 0 ? ` (${spend.unpriced} unpriced)` : ""),
    );
  };

  return {
    defaultModel: adapter.defaultModel,
    generate: async (opts) => {
      const startedAt = Date.now();
      const result = await adapter.generate(opts);
      record(result.usage, result.model ?? opts.model ?? adapter.defaultModel, startedAt);
      return result;
    },
    stream: (opts) => {
      const startedAt = Date.now();
      const source = adapter.stream(opts);
      // Usage arrives on a late chunk, so the log lands when the stream ends
      // rather than when it opens — and only if a chunk actually carried it.
      return (async function* metered() {
        let usage: LlmTokenUsage | undefined;
        let model: string | undefined;
        try {
          for await (const chunk of source) {
            if (chunk.usage) usage = chunk.usage;
            if (chunk.model) model = chunk.model;
            yield chunk;
          }
        } finally {
          // In `finally` so an abandoned or failed stream still reports what
          // it burned — those are exactly the calls worth seeing.
          record(usage, model ?? opts.model ?? adapter.defaultModel, startedAt);
        }
      })();
    },
  };
};

/** Which providers the environment can actually reach. */
export const availableProviders = (): { anthropic: boolean; openai: boolean } => ({
  anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  openai: Boolean(process.env.OPENAI_API_KEY),
});

/**
 * Build an adapter for a specific model, routing to the provider that owns it.
 *
 * Returns null when the model's provider has no key, which the route reports
 * as "that model needs a key" rather than failing at request time.
 */
export const llmForModel = (modelId: string, label = "llm"): LlmAdapter | null => {
  const provider = providerFor(modelId);
  // Every adapter leaves through here, so metering is applied once rather
  // than remembered at five call sites — see `meter` above.
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return meter(anthropicAdapter(process.env.ANTHROPIC_API_KEY, { model: modelId }), label);
  }
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return meter(openAiAdapter(process.env.OPENAI_API_KEY, { model: modelId }), label);
  }
  return null;
};

/**
 * The model used when nobody has picked one: an explicit `DASH_LLM_MODEL`,
 * else the default for whichever provider is in force.
 */
export const defaultModelId = (settings?: ModelChoices | null): string | null => {
  if (process.env.DASH_LLM_MODEL) return process.env.DASH_LLM_MODEL;
  const provider = preferredProvider(settings);
  return provider ? DEFAULT_MODEL_BY_PROVIDER[provider] : null;
};

/**
 * Whose models to reach for when nothing more specific has said.
 *
 * The stored choice leads, because somebody sat in the picker and made it.
 * Everything after it is a fallback in the same order: `DEFAULT_PROVIDER`
 * first, then whatever has a key.
 *
 * A chosen provider with no key falls through rather than routing every action
 * into a 401 — the picker says the key is missing, and meanwhile the app still
 * works. This is the one place the choice is not obeyed literally, and it is
 * the difference between a warning and an outage.
 */
export const preferredProvider = (settings?: ModelChoices | null): Provider | null => {
  const providers = availableProviders();
  const chosen = settings?.provider;
  if (chosen && providers[chosen]) return chosen;
  if (providers[DEFAULT_PROVIDER]) return DEFAULT_PROVIDER;
  const other = DEFAULT_PROVIDER === "anthropic" ? "openai" : "anthropic";
  return providers[other] ? other : null;
};

/**
 * `DASH_REVIEW_MODEL` predates per-task selection and did exactly this for one
 * task, so it keeps working rather than becoming a line in a changelog.
 */
const TASK_ENV_ALIASES: Partial<Record<LlmTask, string>> = { suggest: "DASH_REVIEW_MODEL" };

/** The settings this resolution reads, structurally — see `SettingsStore`. */
export interface ModelChoices {
  /** Whose models to use for anything that falls through to a tier default. */
  readonly provider?: Provider | null;
  readonly model: string | null;
  readonly models: Partial<Record<LlmTask, string>>;
}

/**
 * Which model runs one task, and why — the single resolution order.
 *
 * Most specific wins, and each rung exists because something asks for it:
 *
 *   1. `DASH_MODEL_WIDGET` and friends — pin one task from the environment.
 *   2. `DASH_LLM_MODEL` — pin *everything* from the environment. Above the
 *      stored choices because the picker greys itself out when this is set,
 *      and a control that says it cannot change anything must be telling the
 *      truth.
 *   3. An explicit per-task choice.
 *   4. "Use one model for everything", chosen in the picker.
 *   5. The task's tier, resolved against the provider in force — the
 *      default, and what almost everyone runs. Picking a provider moves every
 *      one of these at once, which is the choice most people actually want.
 *   6. The provider default, for a task somehow outside the table.
 *
 * Returns null only when there is no key at all, which every caller already
 * reports as "add an AI key" rather than failing at request time.
 */
export const modelForTask = (task: LlmTask, settings?: ModelChoices | null): string | null => {
  const pinned = process.env[envVarForTask(task)];
  if (pinned) return pinned;

  const alias = TASK_ENV_ALIASES[task];
  const aliased = alias ? process.env[alias] : undefined;
  if (aliased) return aliased;

  if (process.env.DASH_LLM_MODEL) return process.env.DASH_LLM_MODEL;

  const chosen = settings?.models?.[task];
  if (chosen) return chosen;
  if (settings?.model) return settings.model;

  const provider = preferredProvider(settings);
  if (!provider) return null;

  const tier = findTask(task)?.tier;
  return tier ? TIER_MODELS[provider][tier] : DEFAULT_MODEL_BY_PROVIDER[provider];
};

/** Why a task resolved the way it did, for the picker and for `/api/models`. */
export type ModelSource = "env" | "task" | "global" | "tier" | "none";

export const sourceForTask = (task: LlmTask, settings?: ModelChoices | null): ModelSource => {
  const alias = TASK_ENV_ALIASES[task];
  if (process.env[envVarForTask(task)]) return "env";
  if (alias && process.env[alias]) return "env";
  if (process.env.DASH_LLM_MODEL) return "env";
  if (settings?.models?.[task]) return "task";
  if (settings?.model) return "global";
  return preferredProvider(settings) ? "tier" : "none";
};

/**
 * Build an adapter from the environment. Returns null when no key is set, so
 * the route can say "add an AI key" instead of failing obscurely.
 */
export const llmFromEnv = (label = "llm", settings?: ModelChoices | null): LlmAdapter | null => {
  const model = defaultModelId(settings);
  return model ? llmForModel(model, label) : null;
};
