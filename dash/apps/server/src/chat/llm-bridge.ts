import type { LlmAdapter as DashLlm } from "@freebirdai/dash-agent";
import type { LlmAdapter as FreeBirdLlm } from "@freebirdai/core";

/**
 * Hand Dash's LLM adapter to FreeBird's chat engine.
 *
 * The two `LlmAdapter` interfaces are byte-identical — `@freebirdai/dash-agent`'s copy
 * carries a comment saying as much and warning against drift — so the shapes
 * line up without translation. Two real jobs remain.
 *
 * **1. Keep chat on the capability table.** Do not reach for
 * `@freebirdai/adapters-llm-openai` / `-anthropic` here. They build their own
 * requests and would bypass `models.ts`, which exists because providers now
 * *remove* request parameters between generations: sending `temperature` to
 * Sonnet 5 / Opus 5 / Opus 4.8 / 4.7 is a hard 400, not a silently ignored
 * field, and that outage — every AI action failing the moment a key was added
 * — is what the table was written to prevent. Dash's adapters gate on it per
 * call, so routing chat through them keeps chat on the same protection and
 * keeps the model picker working for it too.
 *
 * **2. Type alignment, and nothing else.** This used to synthesize a stream by
 * awaiting `generate` and yielding the whole reply as one delta, because
 * Dash's adapters did not stream. They do now — SSE parsing lives in `llm.ts`,
 * beside the request it belongs to — so the stream is forwarded rather than
 * faked, and text reaches the column as the model produces it.
 *
 * `generate` is still the authoring agent's path and still non-streaming, for
 * the reason it always was: a tool call cannot be validated until its argument
 * JSON is whole, so assembling deltas for it would be work done twice to
 * arrive back where it started.
 */
export const toFreeBirdLlm = (llm: DashLlm): FreeBirdLlm => ({
  defaultModel: llm.defaultModel,
  generate: ((opts: never) => llm.generate(opts)) as FreeBirdLlm["generate"],
  stream: ((opts: never) => llm.stream(opts)) as unknown as FreeBirdLlm["stream"],
});

/**
 * Resolve the chat model the same way every other AI action resolves it.
 *
 * Late-bound on purpose: `buildServer` takes a resolver rather than an
 * instance so choosing a different model in the UI takes effect on the next
 * message instead of the next restart.
 */
export interface ChatLlmResolver {
  (): DashLlm | null;
}

/**
 * The engine requires an adapter, but a fresh install has no key.
 *
 * Rather than refusing to mount chat — which would make the whole column
 * vanish with no explanation — this stands in and says the one useful thing.
 * The same shape as a real adapter, so nothing downstream special-cases it.
 */
export const noKeyLlm = (message: string): FreeBirdLlm => {
  const reply = {
    text: message,
    toolCalls: [] as Array<{ id: string; name: string; args: unknown }>,
  };
  return {
    defaultModel: "none",
    generate: async () => reply,
    stream: async function* () {
      yield { textDelta: message };
    },
  };
};

export const NO_KEY_MESSAGE =
  "Chat needs an AI key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart, " +
  "then pick a model from the toolbar.";

/** The adapter chat should use right now, falling back to the explainer. */
export const resolveChatLlm = (resolve: ChatLlmResolver): FreeBirdLlm => {
  const llm = resolve();
  return llm ? toFreeBirdLlm(llm) : noKeyLlm(NO_KEY_MESSAGE);
};
