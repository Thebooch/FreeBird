import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatEngine, createCiteStripper, type ChatStreamEvent } from "./engine.js";
import { createComponentRegistry } from "../components/registry.js";
import { createKnowledgeGraph } from "../knowledge/graph.js";
import { FakeLlm, type FakeLlmResponse } from "../testing/fakeLlm.js";
import { MemoryDb } from "../testing/memoryDb.js";
import type { AuthContext } from "../types.js";
import type { ActionState } from "../actions/types.js";
import type { LlmAdapter } from "../adapters/llm.js";

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
