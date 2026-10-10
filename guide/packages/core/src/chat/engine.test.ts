import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatEngine, createCiteStripper, type ChatStreamEvent } from "./engine.js";
import { createComponentRegistry } from "../components/registry.js";
import { createKnowledgeGraph } from "../knowledge/graph.js";
import { FakeLlm, type FakeLlmResponse } from "../testing/fakeLlm.js";
import { MemoryDb } from "../testing/memoryDb.js";
import type { AuthContext } from "../types.js";
import type { ActionState } from "../actions/types.js";
import type { LlmAdapter, LlmGenerateOptions, LlmMessage, LlmStreamChunk, LlmTool } from "../adapters/llm.js";

const auth: AuthContext = { userId: "u1" };

const setup = (responses: FakeLlmResponse[] = []) => {
  const registry = createComponentRegistry();
  registry.register({
    id: "settings",
    title: "Settings",
    description: "User settings",
    grid: { minW: 4, minH: 3 },
    actions: [
      {
        id: "set_theme",
        description: "Set the theme",
        schema: z.object({ theme: z.enum(["light", "dark"]) }),
        handler: async () => ({}),
      },
    ],
  });
  registry.register({
    id: "digest",
    title: "Digest",
    description: "Email digest",
    grid: { minW: 4, minH: 3 },
    actions: [
      {
        id: "configure_digest",
        description: "Configure the email digest",
        schema: z.object({
          email: z.string().email(),
          frequency: z.enum(["daily", "weekly"]),
        }),
        handler: async () => ({}),
      },
    ],
  });
  const db = new MemoryDb();
  const llm = new FakeLlm(responses);
  const knowledge = createKnowledgeGraph(registry);
  return { registry, db, llm, knowledge };
};

const startCollecting = async (
  llm: FakeLlm,
  db: MemoryDb,
): Promise<{ sessionId: string; pendingState: ActionState }> => {
  const session = await db.createSession({ title: "T" }, auth);
  return {
    sessionId: session.id,
    pendingState: {
      phase: "idle",
      pending: null,
      journal: [],
      workflowStack: [],
    },
  };
};

const collect = async (
  iter: AsyncIterable<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> => {
  const out: ChatStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
};

describe("ChatEngine — auto-loop after a tool-only turn", () => {
  it("loops once when start_action lands in collecting and then emits text", async () => {
    const { registry, db, llm, knowledge } = setup([
      // Step 1: LLM only calls start_action with NO args.
      {
        kind: "toolCall",
        name: "start_action",
        args: {
          action: "digest:configure_digest",
          label: "configure email digest",
          args: {},
        },
      },
      // Step 2 (auto-loop): plain text asking the user for the missing fields.
      {
        kind: "text",
        text: "Sure — what email should I send the digest to?",
      },
    ]);
    const { sessionId, pendingState } = await startCollecting(llm, db);
    const engine = new ChatEngine({ db, llm, registry, knowledge });

    const events = await collect(
      engine.send(
        {
          sessionId,
          text: "Set up my weekly digest",
          activeComponentIds: ["digest"],
          actionState: pendingState,
        },
        auth,
      ),
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("action_started");
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("assistant_saved");
    // The assistant message persisted and contains the inner-step prose.
    const saved = events.find((e) => e.kind === "assistant_saved");
    expect(saved?.assistantMessage?.content).toContain("email");
    // The action_started came BEFORE assistant_saved (auto-loop ran).
    expect(kinds.indexOf("action_started")).toBeLessThan(
      kinds.indexOf("assistant_saved"),
    );
  });

  it("does not loop when the first step already produces user-visible text", async () => {
    const { registry, db, llm, knowledge } = setup([
      {
        kind: "toolCall",
        name: "start_action",
        args: {
          action: "settings:set_theme",
          args: { theme: "dark" },
        },
        followUpText: "Setting your theme to dark.",
      },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({ db, llm, registry, knowledge });

    const events = await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "Use dark mode",
          activeComponentIds: ["settings"],
        },
        auth,
      ),
    );

    // Only one LLM call should have been consumed.
    expect((llm as unknown as { queue: unknown[] }).queue.length).toBe(0);
    const saved = events.find((e) => e.kind === "assistant_saved");
    expect(saved?.assistantMessage?.content).toContain("Setting your theme");
  });

  it("respects maxToolSteps=1 (auto-loop disabled)", async () => {
    const { registry, db, llm, knowledge } = setup([
      {
        kind: "toolCall",
        name: "start_action",
        args: {
          action: "digest:configure_digest",
          args: {},
        },
      },
      // Should NOT be consumed when maxToolSteps=1.
      { kind: "text", text: "extra prose" },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      maxToolSteps: 1,
    });

    await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "configure digest",
          activeComponentIds: ["digest"],
        },
        auth,
      ),
    );
    // The follow-up "extra prose" response is still in the queue.
    expect((llm as unknown as { queue: unknown[] }).queue.length).toBe(1);
  });
});

describe("ChatEngine — empty-bubble handling", () => {
  it("persists clarification questions instead of leaving an empty bubble", async () => {
    const { registry, db, llm, knowledge } = setup([
      // Step 1: tool-only.
      {
        kind: "toolCall",
        name: "start_action",
        args: {
          action: "digest:configure_digest",
          args: {},
        },
      },
      // Step 2: clarification tool (no prose). Auto-loop runs, then exits.
      {
        kind: "toolCall",
        name: "request_clarification",
        args: { question: "What's your email?" },
      },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      requireAssistantReply: false,
    });

    const events = await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "configure digest",
          activeComponentIds: ["digest"],
        },
        auth,
      ),
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("assistant_saved");
    const saved = events.find((e) => e.kind === "assistant_saved");
    expect(saved?.assistantMessage?.content).toBe("What's your email?");

    const stored = await db.listMessages(session.id, auth);
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("uses fallbackToolOnlyPhrase when configured (string form)", async () => {
    const { registry, db, llm, knowledge } = setup([
      {
        kind: "toolCall",
        name: "start_action",
        args: {
          action: "digest:configure_digest",
          args: {},
        },
      },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      // Disable the auto-loop so the turn ends tool-only with no prose.
      maxToolSteps: 1,
      fallbackToolOnlyPhrase: "Working on that…",
    });

    const events = await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "configure digest",
          activeComponentIds: ["digest"],
        },
        auth,
      ),
    );

    // The host phrase fills and persists the bubble — no extra LLM call.
    const saved = events.find((e) => e.kind === "assistant_saved");
    expect(saved?.assistantMessage?.content).toBe("Working on that…");
    expect((llm as unknown as { queue: unknown[] }).queue.length).toBe(0);
  });

  it("function form returning null falls back to a persisted engine summary", async () => {
    const { registry, db, llm, knowledge } = setup([
      {
        kind: "toolCall",
        name: "start_action",
        args: {
          action: "digest:configure_digest",
          args: {},
        },
      },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      maxToolSteps: 1,
      requireAssistantReply: false,
      fallbackToolOnlyPhrase: ({ phase }) =>
        phase === "awaiting_confirmation" ? "Ready to apply." : null,
    });

    const events = await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "configure digest",
          activeComponentIds: ["digest"],
        },
        auth,
      ),
    );

    // Phase is "collecting" → the hook returns null → the engine's own
    // phase summary still persists a visible assistant message.
    const saved = events.find((e) => e.kind === "assistant_saved");
    expect(saved?.assistantMessage?.content).toBeTruthy();
    expect(saved?.assistantMessage?.content).not.toBe("Ready to apply.");

    const stored = await db.listMessages(session.id, auth);
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("ChatEngine — LLM usage / cost hooks", () => {
  it("emits llm_usage and calls onLlmUsage when the adapter yields usage", async () => {
    const usage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };
    const { registry, db, llm, knowledge } = setup([
      {
        kind: "text",
        text: "Hello",
        usage,
        model: "gpt-4o-mini",
      },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const seen: unknown[] = [];
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      emitLlmUsage: true,
      onLlmUsage: (p) => seen.push(p),
      estimateLlmCostUsd: (model, u) =>
        model === "gpt-4o-mini" && u.totalTokens === 150 ? 0.0001 : null,
    });

    const events = await collect(
      engine.send({ sessionId: session.id, text: "Hi" }, auth),
    );

    const uev = events.find((e) => e.kind === "llm_usage");
    expect(uev?.llmUsage?.usage).toEqual(usage);
    expect(uev?.llmUsage?.model).toBe("gpt-4o-mini");
    expect(uev?.llmUsage?.stepIndex).toBe(0);
    expect(uev?.llmUsage?.estimatedUsd).toBe(0.0001);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { estimatedUsd: number }).estimatedUsd).toBe(0.0001);
  });

  it("omits estimatedUsd when no estimateLlmCostUsd is configured", async () => {
    const usage = {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    };
    const { registry, db, llm, knowledge } = setup([
      { kind: "text", text: "x", usage, model: "custom-model" },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      emitLlmUsage: true,
    });
    const events = await collect(
      engine.send({ sessionId: session.id, text: "Hi" }, auth),
    );
    const uev = events.find((e) => e.kind === "llm_usage");
    expect(uev?.llmUsage?.usage).toEqual(usage);
    expect(uev?.llmUsage).not.toHaveProperty("estimatedUsd");
  });
});

describe("ChatEngine — enablePlanLayout", () => {
  /** Records the tool names offered on each stream() call, delegating to a FakeLlm. */
  const recordingLlm = (inner: FakeLlm) => {
    const toolNamesPerCall: string[][] = [];
    const llm: LlmAdapter = {
      defaultModel: inner.defaultModel,
      stream: (opts) => {
        toolNamesPerCall.push(Object.keys(opts.tools ?? {}));
        return inner.stream(opts as never);
      },
      generate: (opts) => inner.generate(opts as never),
    };
    return { llm, toolNamesPerCall };
  };

  it("enablePlanLayout: false never offers plan_layout even when generateLayout !== false", async () => {
    const { registry, db, knowledge } = setup();
    const inner = new FakeLlm([{ kind: "text", text: "hi" }]);
    const { llm, toolNamesPerCall } = recordingLlm(inner);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({ db, llm, registry, knowledge, enablePlanLayout: false });

    await collect(engine.send({ sessionId: session.id, text: "hello" }, auth));

    expect(toolNamesPerCall[0]).not.toContain("plan_layout");
  });

  it("default options: a plan_layout call does not auto-loop for prose", async () => {
    const { registry, db, llm, knowledge } = setup([
      { kind: "toolCall", name: "plan_layout", args: { items: [{ componentId: "digest" }] } },
      // Should NOT be consumed — plan_layout intentionally stops the turn.
      { kind: "text", text: "extra prose that should not be reached" },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({ db, llm, registry, knowledge });

    const events = await collect(
      engine.send({ sessionId: session.id, text: "show me the digest" }, auth),
    );

    expect((llm as unknown as { queue: unknown[] }).queue.length).toBe(1);
    const saved = events.find((e) => e.kind === "assistant_saved");
    expect(saved?.assistantMessage?.content).not.toBe("extra prose that should not be reached");
  });
});

describe("ChatEngine — citations", () => {
  /** Records the system messages sent on each stream() call, delegating to a FakeLlm. */
  const recordingLlm = (inner: FakeLlm) => {
    const messagesPerCall: Array<Array<{ role: string; content: string }>> = [];
    const llm: LlmAdapter = {
      defaultModel: inner.defaultModel,
      stream: (opts) => {
        messagesPerCall.push(opts.messages as never);
        return inner.stream(opts as never);
      },
      generate: (opts) => inner.generate(opts as never),
    };
    return { llm, messagesPerCall };
  };

  const setupWithHours = (responses: FakeLlmResponse[]) => {
    const registry = createComponentRegistry();
    registry.register({
      id: "hours",
      title: "Opening Hours",
      description: "Weekly opening hours table",
      grid: { minW: 4, minH: 3 },
      knowledge: [{ text: "Open Mon-Fri 9am-5pm." }],
      domAnchor: { selector: "#hours" },
    });
    const db = new MemoryDb();
    const inner = new FakeLlm(responses);
    const knowledge = createKnowledgeGraph(registry);
    return { registry, db, inner, knowledge };
  };

  it("does not inject a citations prompt or parse markers when disabled (default)", async () => {
    const { registry, db, inner, knowledge } = setupWithHours([
      { kind: "text", text: "We're open weekdays. [[cite:hours]]" },
    ]);
    const { llm, messagesPerCall } = recordingLlm(inner);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({ db, llm, registry, knowledge });

    const events = await collect(
      engine.send({ sessionId: session.id, text: "when are you open?" }, auth),
    );

    const systemContents = messagesPerCall[0]!.filter((m) => m.role === "system").map(
      (m) => m.content,
    );
    // The citations prompt block is absent (the knowledge-context prompt may
    // still mention cite markers — that's a separate, independently-toggled
    // feature).
    expect(systemContents.some((c) => c.includes("## Citations"))).toBe(false);
    const saved = events.find((e) => e.kind === "assistant_saved");
    expect(saved?.assistantMessage?.content).toBe("We're open weekdays. [[cite:hours]]");
    expect(saved?.assistantMessage?.toolPayload).toBeUndefined();
  });

  it("injects the citations prompt when enabled and a component is citable", async () => {
    const { registry, db, inner, knowledge } = setupWithHours([
      { kind: "text", text: "We're open weekdays. [[cite:hours]]" },
    ]);
    const { llm, messagesPerCall } = recordingLlm(inner);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      citations: { enabled: true },
    });

    await collect(engine.send({ sessionId: session.id, text: "when are you open?" }, auth));

    const systemContents = messagesPerCall[0]!.filter((m) => m.role === "system").map(
      (m) => m.content,
    );
    expect(systemContents.some((c) => c.includes("hours: Opening Hours"))).toBe(true);
  });

  it("strips the marker and attaches a resolved ComponentCitation via toolPayload", async () => {
    const { registry, db, inner, knowledge } = setupWithHours([
      { kind: "text", text: "We're open weekdays. [[cite:hours]]" },
    ]);
    const { llm } = recordingLlm(inner);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      citations: { enabled: true },
    });

    const events = await collect(
      engine.send({ sessionId: session.id, text: "when are you open?" }, auth),
    );

    const saved = events.find((e) => e.kind === "assistant_saved");
    expect(saved?.assistantMessage?.content).toBe("We're open weekdays.");
    expect(saved?.assistantMessage?.toolPayload).toEqual({
      citations: [
        {
          componentId: "hours",
          title: "Opening Hours",
          directive: "highlight",
          selector: "#hours",
        },
      ],
    });
  });

  it("drops a hallucinated citation id and leaves toolPayload unset", async () => {
    const { registry, db, inner, knowledge } = setupWithHours([
      { kind: "text", text: "We're open weekdays. [[cite:doesNotExist]]" },
    ]);
    const { llm } = recordingLlm(inner);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      citations: { enabled: true },
    });

    const events = await collect(
      engine.send({ sessionId: session.id, text: "when are you open?" }, auth),
    );

    const saved = events.find((e) => e.kind === "assistant_saved");
    expect(saved?.assistantMessage?.content).toBe("We're open weekdays.");
    expect(saved?.assistantMessage?.toolPayload).toBeUndefined();
  });
});

describe("ChatEngine — a processing tool that ran must be answered from", () => {
  /**
   * The failure this covers, seen end to end in a real app.
   *
   * A model asked "what maintenance endpoints do I have?" replied "I'll look
   * up what endpoints are available" *and* called the lookup tool in the same
   * step. The tool ran and its result was queued — then the loop broke,
   * because looping after a processing tool required the step to have been
   * silent. The user got a promise and no answer, and whether it happened at
   * all came down to whether the model narrated first, which varies run to
   * run: the same question worked when it called the tool without preamble.
   *
   * Text written in the same step as the call cannot be the answer, because
   * the result did not exist yet. It is a preamble, and the turn continues.
   */
  const lookUpTool = {
    name: "look_up",
    description: "Look something up",
    schema: z.object({ query: z.string() }),
  };

  it("keeps going when the model narrates before the result arrives", async () => {
    const { registry, db, llm, knowledge } = setup([
      {
        kind: "toolCall",
        name: "look_up",
        args: { query: "maintenance" },
        followUpText: "I'll look that up for you.",
      },
      { kind: "text", text: "There are three: tasks, work orders and categories." },
    ]);

    const calls: string[] = [];
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      executeExtraTool: async (name, args) => {
        calls.push(name);
        return { found: 3, names: ["tasks", "work orders", "categories"], args };
      },
    });

    const session = await db.createSession({ title: "T" }, auth);
    const events = await collect(
      engine.send(
        { sessionId: session.id, text: "what maintenance endpoints do I have?", extraTools: { look_up: lookUpTool } },
        auth,
      ),
    );

    expect(calls).toEqual(["look_up"]);

    const saved = events.find((ev) => ev.kind === "assistant_saved");
    const content = (saved as { assistantMessage?: { content?: string } })?.assistantMessage?.content ?? "";
    // The answer is there, and the preamble is kept rather than replaced —
    // the user reads "I'll look that up" and then what was found.
    expect(content).toContain("work orders");
    expect(content).toContain("I'll look that up");
  });

  it("still answers when the model calls the tool without narrating", async () => {
    // The case that already worked, kept so the fix does not trade one for
    // the other.
    const { registry, db, llm, knowledge } = setup([
      { kind: "toolCall", name: "look_up", args: { query: "maintenance" } },
      { kind: "text", text: "Three: tasks, work orders and categories." },
    ]);

    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      executeExtraTool: async () => ({ found: 3 }),
    });

    const session = await db.createSession({ title: "T" }, auth);
    const events = await collect(
      engine.send(
        { sessionId: session.id, text: "what endpoints?", extraTools: { look_up: lookUpTool } },
        auth,
      ),
    );

    const saved = events.find((ev) => ev.kind === "assistant_saved");
    const content = (saved as { assistantMessage?: { content?: string } })?.assistantMessage?.content ?? "";
    expect(content).toContain("work orders");
  });

  it("does not loop forever when the model keeps calling the tool", async () => {
    const { registry, db, llm, knowledge } = setup([
      { kind: "toolCall", name: "look_up", args: { query: "a" }, followUpText: "Looking." },
      { kind: "toolCall", name: "look_up", args: { query: "b" }, followUpText: "Still looking." },
      { kind: "toolCall", name: "look_up", args: { query: "c" }, followUpText: "And again." },
      { kind: "toolCall", name: "look_up", args: { query: "d" }, followUpText: "Never stops." },
    ]);

    const calls: string[] = [];
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      maxToolSteps: 3,
      executeExtraTool: async (name) => {
        calls.push(name);
        return { ok: true };
      },
    });

    const session = await db.createSession({ title: "T" }, auth);
    await collect(
      engine.send(
        { sessionId: session.id, text: "loop please", extraTools: { look_up: lookUpTool } },
        auth,
      ),
    );

    // Bounded by maxToolSteps, so a model that never concludes cannot run away.
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});

describe("ChatEngine - finalReply", () => {
  const textOf = (events: ChatStreamEvent[]): string =>
    events
      .filter((e) => e.kind === "text_delta")
      .map((e) => e.textDelta ?? "")
      .join("");

  const savedContent = (events: ChatStreamEvent[]): string => {
    const saved = events.find((e) => e.kind === "assistant_saved");
    return saved?.assistantMessage?.content ?? "";
  };

  it('mode "always" never streams the loop prose and lets the final step write the reply', async () => {
    const { registry, db, llm, knowledge } = setup([
      { kind: "text", text: "DRAFT-PROSE" },
      { kind: "text", text: "The finished answer." },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      finalReply: { mode: "always" },
    });

    const events = await collect(
      engine.send({ sessionId: session.id, text: "hi" }, auth),
    );

    const streamed = textOf(events);
    expect(streamed).not.toContain("DRAFT-PROSE");
    expect(streamed).toContain("The finished answer.");
    expect(savedContent(events)).toBe("The finished answer.");
  });

  it("hands the loop prose to the final step as a draft", async () => {
    const { registry, db, llm, knowledge } = setup([
      { kind: "text", text: "DRAFT-PROSE" },
      { kind: "text", text: "rewritten" },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    let sawDraft = "";
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      finalReply: {
        mode: "always",
        render: (ctx) => {
          sawDraft = ctx.draft;
          return "write something";
        },
      },
    });

    await collect(engine.send({ sessionId: session.id, text: "hi" }, auth));
    expect(sawDraft).toBe("DRAFT-PROSE");
  });

  it('default ("fallback") still lets the model prose be the reply, with no extra call', async () => {
    const { registry, db, llm, knowledge } = setup([
      { kind: "text", text: "Answered directly." },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({ db, llm, registry, knowledge });

    const events = await collect(
      engine.send({ sessionId: session.id, text: "hi" }, auth),
    );
    expect(textOf(events)).toContain("Answered directly.");
    expect(savedContent(events)).toBe("Answered directly.");
  });

  /*
   * A stored session id can outlive the database it was made in. The append
   * then throws before the try block, and the turn used to end having yielded
   * nothing at all - no message, no error, no reason.
   */
  it("reports a session it cannot write to instead of ending in silence", async () => {
    const { registry, db, llm, knowledge } = setup([{ kind: "text", text: "hi" }]);
    const broken = {
      ...db,
      appendMessage: async () => {
        throw new Error("no such session");
      },
    } as unknown as typeof db;
    const engine = new ChatEngine({ db: broken, llm, registry, knowledge });

    const events = await collect(engine.send({ sessionId: "cs_gone", text: "hi" }, auth));
    const error = events.find((e) => e.kind === "error");
    expect(error?.error).toMatch(/session/i);
    expect(events).not.toHaveLength(0);
  });

  it("writes the final reply with its own model when one is given", async () => {
    const { registry, db, llm, knowledge } = setup([{ kind: "text", text: "DRAFT" }]);
    const writer = new FakeLlm([{ kind: "text", text: "the finished answer" }]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      finalReply: { mode: "always", llm: writer },
    });

    const events = await collect(engine.send({ sessionId: session.id, text: "hi" }, auth));
    expect(savedContent(events)).toBe("the finished answer");
    // The loop's model was asked once, and never for the reply.
    expect((llm as unknown as { queue: unknown[] }).queue).toHaveLength(0);
  });

  /*
   * The loop only routes under "always" — it never writes a sentence — so
   * handing it a whole tool result pays twice for material one step uses.
   */
  it("gives the loop an excerpt of a tool result, not the whole thing", async () => {
    const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i, pad: "x".repeat(40) })) };
    const seen: string[] = [];
    const scripted: LlmAdapter = {
      defaultModel: "fake",
      generate: async () => ({ text: "", toolCalls: [] }),
      stream: async function* (opts) {
        seen.push(opts.messages.map((m) => m.content).join("\n"));
        if (seen.length === 1) {
          yield { toolCall: { id: "t", name: "look_up", args: { q: "x" } } };
          return;
        }
        yield { textDelta: "done" };
      },
    };
    const { registry, db, knowledge } = setup();
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm: scripted,
      registry,
      knowledge,
      finalReply: { mode: "always" },
      executeExtraTool: async () => big,
    });

    await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "look it up",
          extraTools: {
            look_up: {
              name: "look_up",
              description: "look something up",
              schema: z.object({ q: z.string() }),
            },
          },
        },
        auth,
      ),
    );

    const continuation = seen[1] ?? "";
    expect(continuation).toContain("do NOT summarize them here");
    // The whole payload is ~10KB; the excerpt is capped well below it.
    expect(continuation.length).toBeLessThan(JSON.stringify(big).length);
  });

  it("still gives the loop the whole result in the default mode", async () => {
    const payload = { rows: [{ marker: "FULL-RESULT-MARKER" }] };
    const seen: string[] = [];
    const scripted: LlmAdapter = {
      defaultModel: "fake",
      generate: async () => ({ text: "", toolCalls: [] }),
      stream: async function* (opts) {
        seen.push(opts.messages.map((m) => m.content).join("\n"));
        if (seen.length === 1) {
          yield { toolCall: { id: "t", name: "look_up", args: { q: "x" } } };
          return;
        }
        yield { textDelta: "done" };
      },
    };
    const { registry, db, knowledge } = setup();
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm: scripted,
      registry,
      knowledge,
      executeExtraTool: async () => payload,
    });

    await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "look it up",
          extraTools: {
            look_up: {
              name: "look_up",
              description: "look something up",
              schema: z.object({ q: z.string() }),
            },
          },
        },
        auth,
      ),
    );
    expect(seen[1] ?? "").toContain("FULL-RESULT-MARKER");
  });

  it("carries a processing tool's payload onto the assistant message", async () => {
    const { registry, db, llm, knowledge } = setup([
      { kind: "toolCall", name: "look_up", args: { q: "x" } },
      { kind: "text", text: "Found it." },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      executeExtraTool: async () => ({
        answer: "42",
        payload: { coverage: { scanned: 50 } },
      }),
    });

    const events = await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "look it up",
          extraTools: {
            look_up: {
              name: "look_up",
              description: "look something up",
              schema: z.object({ q: z.string() }),
            },
          },
        },
        auth,
      ),
    );

    const saved = events.find((e) => e.kind === "assistant_saved");
    const payload = saved?.assistantMessage?.toolPayload as
      | { toolPayloads?: Array<{ tool: string; payload: unknown }> }
      | undefined;
    expect(payload?.toolPayloads).toEqual([
      { tool: "look_up", payload: { coverage: { scanned: 50 } } },
    ]);
  });

  it("does not carry a payload from a tool that failed", async () => {
    const { registry, db, llm, knowledge } = setup([
      { kind: "toolCall", name: "look_up", args: { q: "x" } },
      { kind: "text", text: "That did not work." },
    ]);
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      executeExtraTool: async () => {
        throw new Error("upstream refused");
      },
    });

    const events = await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "look it up",
          extraTools: {
            look_up: {
              name: "look_up",
              description: "look something up",
              schema: z.object({ q: z.string() }),
            },
          },
        },
        auth,
      ),
    );
    const saved = events.find((e) => e.kind === "assistant_saved");
    const payload = saved?.assistantMessage?.toolPayload as
      | { toolPayloads?: unknown }
      | undefined;
    expect(payload?.toolPayloads).toBeUndefined();
  });
});

describe("createCiteStripper", () => {
  const run = (deltas: string[], enabled = true): string => {
    const s = createCiteStripper(enabled);
    return deltas.map((d) => s.push(d)).join("") + s.flush();
  };

  it("passes text through untouched when citations are off", () => {
    expect(run(["a [[cite:x]] b"], false)).toBe("a [[cite:x]] b");
  });

  it("removes a marker that arrives whole", () => {
    expect(run(["done [[cite:leases]] here"])).toBe("done  here");
  });

  it("removes a marker split across chunks", () => {
    expect(run(["done [[cit", "e:lea", "ses]] here"])).toBe("done  here");
  });

  it("never emits a partial marker", () => {
    const s = createCiteStripper(true);
    const first = s.push("all good [[cite:lea");
    expect(first).toBe("all good ");
    expect(first).not.toContain("[[");
  });

  it("releases a bracket that turns out not to be a marker", () => {
    expect(run(["see [1] and [note]"])).toBe("see [1] and [note]");
  });

  /*
   * A malformed marker survives `extractCitations` too, so it will be in the
   * persisted reply. Emitting it keeps the streamed bubble and the saved
   * message identical, which matters more than hiding the model's typo.
   */
  it("releases an unterminated marker on flush, matching what gets persisted", () => {
    expect(run(["text [[cite:unfinis"])).toBe("text [[cite:unfinis");
  });
});

describe("ChatEngine — the whole app from one conversation", () => {
  /** A fake model that also keeps what each step was sent. */
  class RecordingLlm extends FakeLlm {
    readonly seen: Array<{ tools: string[]; messages: string }> = [];
    override async *stream<TTools extends Record<string, LlmTool> = {}>(opts: LlmGenerateOptions<TTools>): AsyncIterable<LlmStreamChunk> {
      this.seen.push({ tools: Object.keys(opts.tools ?? {}).sort(), messages: JSON.stringify(opts.messages) });
      yield* super.stream(opts);
    }
  }

  it("tells the model what is on screen and what is open, and still offers every other action", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new RecordingLlm([{ kind: "text", text: "Sure." }]);
    const { sessionId, pendingState } = await startCollecting(llm, db);
    const engine = new ChatEngine({ db, llm, registry, knowledge });
    await collect(
      engine.send(
        { sessionId, text: "make this weekly", activeComponentIds: ["digest"], focus: { componentId: "digest", itemId: "monday", label: "Monday digest" }, actionState: pendingState },
        auth,
      ),
    );
    expect(llm.seen[0]?.messages).toContain("On screen now.");
    expect(llm.seen[0]?.messages).toContain("Digest (`digest`): Email digest");
    expect(llm.seen[0]?.messages).toContain("Open in Digest: Monday digest (`monday`).");
    expect(llm.seen[0]?.tools).toContain("start_action__settings__set_theme");
    expect(llm.seen[0]?.tools).toContain("start_action__digest__configure_digest");
  });

  it("in catalog mode, keeps an action collecting while a value does not fit, with the reason, until it is corrected", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new RecordingLlm([
      { kind: "toolCall", name: "start_action", args: { action: "digest:configure_digest", args: { email: "a@b.co", frequency: "fortnightly", cadence: "x" } } },
      { kind: "toolCall", name: "update_action_args", args: { args: { frequency: "weekly" } } },
      { kind: "text", text: "Ready for you to approve." },
    ]);
    const { sessionId, pendingState } = await startCollecting(llm, db);
    const engine = new ChatEngine({ db, llm, registry, knowledge, harnessArgsMode: "catalog" });
    const events = await collect(engine.send({ sessionId, text: "weekly digest to a@b.co", actionState: pendingState }, auth));

    expect(llm.seen[0]?.tools).toEqual(expect.arrayContaining(["start_action"]));
    expect(llm.seen[0]?.tools.some((name) => name.startsWith("start_action__"))).toBe(false);
    const started = events.find((event) => event.kind === "action_started") as unknown as { action: { args: Record<string, unknown>; missing: string[] } };
    expect(started.action.args).toEqual({ email: "a@b.co", frequency: "fortnightly" });
    expect(started.action.missing.join("\n")).toContain("cadence: not an argument of this action");
    expect(started.action.missing.join("\n")).toMatch(/frequency: Invalid enum value/);
    /* The collecting step showed what was wrong, and the corrected value cleared it. */
    expect(llm.seen[1]?.messages).toContain("frequency: Invalid enum value");
    const updated = events.find((event) => event.kind === "action_args_updated") as unknown as { action: { missing: string[] } };
    expect(updated.action.missing).toEqual([]);
  });

  it("hands what a search found to the next step, when a host sets a budget that defers the tools", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new RecordingLlm([
      { kind: "toolCall", name: "tool_search", args: { query: "digest" } },
      { kind: "toolCall", name: "start_action", args: { action: "digest:configure_digest", args: { email: "a@b.co", frequency: "weekly" } } },
      { kind: "text", text: "Here is the change to approve." },
    ]);
    const { sessionId, pendingState } = await startCollecting(llm, db);
    const engine = new ChatEngine({ db, llm, registry, knowledge, toolBudgetBytes: 10 });
    const events = await collect(engine.send({ sessionId, text: "Send me the digest weekly", actionState: pendingState }, auth));

    expect(llm.seen[0]?.tools).toContain("tool_search");
    expect(llm.seen[1]?.messages).toContain("digest:configure_digest");
    expect(llm.seen[1]?.messages).toContain("You looked actions up above.");
    expect(events.find((event) => event.kind === "action_started")).toMatchObject({ action: { componentId: "digest", actionId: "configure_digest" } });
  });
});

describe("ChatEngine — a prefix a provider can cache", () => {
  /** A fake model that keeps every message list it was sent. */
  class KeepingLlm extends FakeLlm {
    readonly calls: LlmMessage[][] = [];
    override async *stream<TTools extends Record<string, LlmTool> = {}>(opts: LlmGenerateOptions<TTools>): AsyncIterable<LlmStreamChunk> {
      this.calls.push(opts.messages.map((message) => ({ ...message })));
      yield* super.stream(opts);
    }
  }
  const pointsOf = (messages: LlmMessage[]) => messages.flatMap((message, index) => (message.cachePoint ? [index] : []));

  it("marks the end of what reads the same every turn: the system prompt, then the list of actions", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new KeepingLlm([
      { kind: "text", text: "One." },
      { kind: "text", text: "Two." },
    ]);
    const { sessionId, pendingState } = await startCollecting(llm, db);
    const engine = new ChatEngine({ db, llm, registry, knowledge, harnessArgsMode: "catalog", systemPrompt: "You help." });
    await collect(engine.send({ sessionId, text: "hi", actionState: pendingState, activeComponentIds: ["digest"] }, auth));
    await collect(engine.send({ sessionId, text: "and the settings?", actionState: pendingState, activeComponentIds: ["settings"] }, auth));

    const [first, second] = llm.calls;
    expect(pointsOf(first!)).toEqual([1]);
    expect(first![0]!.content).toBe("You help.");
    expect(first![1]!.content).toContain("Everything you can do in this app");
    /* A different question on a different screen: the same prefix, word for word. */
    expect(second!.slice(0, 2)).toEqual(first!.slice(0, 2));
    expect(second!.slice(2)).not.toEqual(first!.slice(2));
  });

  it("marks only the system prompt while an action is under way, and keeps a step's hint after the list", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new KeepingLlm([
      { kind: "toolCall", name: "start_action", args: { action: "digest:configure_digest", args: { email: "a@b.co" } } },
      { kind: "text", text: "Which frequency?" },
    ]);
    const { sessionId, pendingState } = await startCollecting(llm, db);
    const engine = new ChatEngine({ db, llm, registry, knowledge, harnessArgsMode: "catalog", systemPrompt: "You help." });
    await collect(engine.send({ sessionId, text: "digest to a@b.co", actionState: pendingState }, auth));

    expect(pointsOf(llm.calls[0]!)).toEqual([1]);
    /* Collecting: the list is gone, so the point is the system prompt, and the step's hint comes after it. */
    expect(pointsOf(llm.calls[1]!)).toEqual([0]);
    expect(llm.calls[1]![0]!.content).toBe("You help.");
  });

  it("marks the system prompt of the written reply, and leaves the conversation unmarked", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new KeepingLlm([
      { kind: "text", text: "Draft." },
      { kind: "text", text: "Final." },
    ]);
    const { sessionId, pendingState } = await startCollecting(llm, db);
    const engine = new ChatEngine({ db, llm, registry, knowledge, systemPrompt: "You help.", finalReply: { mode: "always" } });
    await collect(engine.send({ sessionId, text: "hi", actionState: pendingState }, auth));

    const reply = llm.calls.at(-1)!;
    expect(pointsOf(reply)).toEqual([0]);
    expect(reply.filter((message) => message.role !== "system").some((message) => message.cachePoint)).toBe(false);
  });
});

describe("ChatEngine — taking the person somewhere", () => {
  const anchored = () => {
    const { registry, db, knowledge } = setup();
    registry.upsert({ ...registry.get("digest")!, domAnchor: { selector: '[data-freebird-component="digest"]', page: "#/digest" } });
    return { registry, db, knowledge };
  };

  it("opens a component when asked, with navigation on, and says so", async () => {
    const { registry, db, knowledge } = anchored();
    const llm = new FakeLlm([
      { kind: "toolCall", name: "open_component", args: { componentId: "digest", itemId: "monday" } },
      { kind: "text", text: "Opened the digest." },
    ]);
    const { sessionId, pendingState } = await startCollecting(llm, db);
    const engine = new ChatEngine({ db, llm, registry, knowledge, navigation: { enabled: true } });
    const events = await collect(engine.send({ sessionId, text: "take me to the digest", actionState: pendingState }, auth));
    expect(events.find((event) => event.kind === "navigate")?.navigation).toEqual({
      componentId: "digest",
      title: "Digest",
      directive: "scroll-to",
      kind: "component",
      page: "#/digest",
      selector: '[data-freebird-component="digest"] [data-freebird-item="monday"]',
    });
    expect((events.find((event) => event.kind === "assistant_saved")?.assistantMessage?.content ?? "")).toContain("Opened the digest.");
  });

  it("offers no such tool unless the host turns navigation on", async () => {
    const { registry, db, knowledge } = anchored();
    const llm = new FakeLlm([{ kind: "toolCall", name: "open_component", args: { componentId: "digest" } }, { kind: "text", text: "ok" }]);
    const { sessionId, pendingState } = await startCollecting(llm, db);
    const engine = new ChatEngine({ db, llm, registry, knowledge });
    const events = await collect(engine.send({ sessionId, text: "take me to the digest", actionState: pendingState }, auth));
    expect(events.some((event) => event.kind === "navigate")).toBe(false);
  });
});

describe("ChatEngine — what preflight fills in reaches the card", () => {
  it("re-derives the preview from the resolved arguments", async () => {
    const registry = createComponentRegistry();
    registry.register({
      id: "types",
      title: "Appointment types",
      description: "What people can book",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "update_type",
          description: "Change an appointment type",
          schema: z.object({ type: z.string(), approval: z.enum(["none", "always"]), current: z.string().optional() }),
          preflight: async (args) => ({ ok: true, resolvedArgs: { type: args.type.toLowerCase(), current: "none" } }),
          preview: (args) => ({ title: `Change ${args.type}`, summary: "", rows: [{ label: "Approval", value: `${args.current ?? "?"} → ${args.approval}` }] }),
          handler: async () => ({}),
        },
      ],
    });
    const db = new MemoryDb();
    const llm = new FakeLlm([
      { kind: "toolCall", name: "start_action__types__update_type", args: { type: "Showing", approval: "always" } },
      { kind: "text", text: "Ready." },
    ]);
    const knowledge = createKnowledgeGraph(registry);
    const { sessionId, pendingState } = await startCollecting(llm, db);
    const engine = new ChatEngine({ db, llm, registry, knowledge });
    const events = await collect(engine.send({ sessionId, text: "make showings need approval", actionState: pendingState }, auth));
    const updated = events.filter((event) => event.kind === "action_args_updated").pop() as unknown as { action: { args: Record<string, unknown>; preview?: { title: string; rows: Array<{ value: string }> } } };
    expect(updated.action.args).toEqual({ type: "showing", current: "none" });
    expect(updated.action.preview?.title).toBe("Change showing");
    expect(updated.action.preview?.rows[0]?.value).toBe("none → always");
  });
});
