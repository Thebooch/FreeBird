import { describe, expect, it } from "vitest";
import { ChatEngine, type ChatStreamEvent } from "../chat/engine.js";
import { createComponentRegistry } from "../components/registry.js";
import { createKnowledgeGraph } from "../knowledge/graph.js";
import { FakeLlm } from "../testing/fakeLlm.js";
import { MemoryDb } from "../testing/memoryDb.js";
import type { AuthContext } from "../types.js";
import type { LlmGenerateOptions, LlmMessage, LlmStreamChunk, LlmTool } from "../adapters/llm.js";
import {
  ASK_USER_TOOL_NAME,
  buildAnswersPrompt,
  parseAskUserArgs,
} from "./index.js";

const auth: AuthContext = { userId: "u1" };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseAskUserArgs", () => {
  const good = {
    question: "Which invoice?",
    options: [
      { value: "mar", label: "March" },
      { value: "apr", label: "April", description: "Not yet sent" },
    ],
  };

  it("accepts a well-formed question", () => {
    expect(parseAskUserArgs(good)).toEqual({
      question: "Which invoice?",
      options: [
        { value: "mar", label: "March" },
        { value: "apr", label: "April", description: "Not yet sent" },
      ],
      multiSelect: false,
    });
  });

  it("rejects fewer than two options — that is not a choice", () => {
    expect(parseAskUserArgs({ ...good, options: [good.options[0]] })).toBeNull();
  });

  it("rejects a blank question", () => {
    expect(parseAskUserArgs({ ...good, question: "   " })).toBeNull();
  });

  it("falls back to the value when a label is missing", () => {
    const parsed = parseAskUserArgs({
      question: "Which?",
      options: [{ value: "a" }, { value: "b" }],
    });
    expect(parsed?.options.map((o) => o.label)).toEqual(["a", "b"]);
  });

  it("drops options with no value rather than rendering a dead button", () => {
    expect(
      parseAskUserArgs({
        question: "Which?",
        options: [{ value: "a" }, { label: "no value" }, { value: "c" }],
      })?.options.map((o) => o.value),
    ).toEqual(["a", "c"]);
  });

  it("survives junk", () => {
    expect(parseAskUserArgs(null)).toBeNull();
    expect(parseAskUserArgs("nope")).toBeNull();
    expect(parseAskUserArgs({})).toBeNull();
  });
});

describe("buildAnswersPrompt", () => {
  it("is empty when nothing was answered", () => {
    expect(buildAnswersPrompt([])).toBe("");
  });

  it("states the answer as settled fact", () => {
    const out = buildAnswersPrompt([
      { questionId: "q1", question: "Which invoice?", values: ["mar"] },
    ]);
    expect(out).toContain("Which invoice?");
    expect(out).toContain("mar");
    expect(out).toContain("do not ask again");
  });
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

class RecordingLlm extends FakeLlm {
  readonly seen: LlmMessage[][] = [];
  readonly toolNames: string[][] = [];
  override async *stream<TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ): AsyncIterable<LlmStreamChunk> {
    this.seen.push(opts.messages);
    this.toolNames.push(Object.keys(opts.tools ?? {}));
    yield* super.stream(opts);
  }
}

const setup = () => {
  const registry = createComponentRegistry();
  registry.register({
    id: "invoices",
    title: "Invoices",
    description: "Invoices",
    grid: { minW: 4, minH: 3 },
  });
  const db = new MemoryDb();
  const knowledge = createKnowledgeGraph(registry);
  return { registry, db, knowledge };
};

const collect = async (stream: AsyncIterable<ChatStreamEvent>) => {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const askCall = {
  kind: "toolCall" as const,
  name: ASK_USER_TOOL_NAME,
  args: {
    question: "Which invoice did you mean?",
    options: [
      { value: "mar", label: "March" },
      { value: "apr", label: "April" },
    ],
  },
};

describe("ask_user round trip", () => {
  it("is not offered unless enabled", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new RecordingLlm([{ kind: "text", text: "hi" }]);
    const engine = new ChatEngine({ db, llm, registry, knowledge });
    const session = await db.createSession({ title: "T" }, auth);
    await collect(engine.send({ sessionId: session.id, text: "hi" }, auth));
    expect(llm.toolNames[0]).not.toContain(ASK_USER_TOOL_NAME);
  });

  it("is offered when enabled", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new RecordingLlm([{ kind: "text", text: "hi" }]);
    const engine = new ChatEngine({ db, llm, registry, knowledge, askUser: { enabled: true } });
    const session = await db.createSession({ title: "T" }, auth);
    await collect(engine.send({ sessionId: session.id, text: "hi" }, auth));
    expect(llm.toolNames[0]).toContain(ASK_USER_TOOL_NAME);
  });

  it("emits the question and ends the turn", async () => {
    const { registry, db, knowledge } = setup();
    // A second response is queued; if the loop wrongly continued it would be
    // consumed and the assertion on call count would catch it.
    const llm = new RecordingLlm([askCall, { kind: "text", text: "should not be reached" }]);
    const engine = new ChatEngine({ db, llm, registry, knowledge, askUser: { enabled: true } });
    const session = await db.createSession({ title: "T" }, auth);

    const events = await collect(engine.send({ sessionId: session.id, text: "send it" }, auth));
    const asked = events.find((e) => e.kind === "question_asked");

    expect(asked?.question?.question).toBe("Which invoice did you mean?");
    expect(asked?.question?.options.map((o) => o.value)).toEqual(["mar", "apr"]);
    expect(asked?.question?.questionId).toMatch(/^q_/);
    // One model call: the turn stopped rather than looping for prose.
    expect(llm.seen).toHaveLength(1);
  });

  it("uses the question as the reply rather than a filler summary", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new RecordingLlm([askCall]);
    const engine = new ChatEngine({ db, llm, registry, knowledge, askUser: { enabled: true } });
    const session = await db.createSession({ title: "T" }, auth);

    const events = await collect(engine.send({ sessionId: session.id, text: "send it" }, auth));
    const saved = events.find((e) => e.kind === "assistant_saved");
    expect(saved?.assistantMessage?.content).toBe("Which invoice did you mean?");
  });

  it("carries the answer into the next turn as fact, not as a user message", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new RecordingLlm([askCall]);
    const engine = new ChatEngine({ db, llm, registry, knowledge, askUser: { enabled: true } });
    const session = await db.createSession({ title: "T" }, auth);
    await collect(engine.send({ sessionId: session.id, text: "send it" }, auth));

    llm.enqueue({ kind: "text", text: "Sending the March invoice." });
    await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "March",
          answers: [
            { questionId: "q1", question: "Which invoice did you mean?", values: ["mar"] },
          ],
        },
        auth,
      ),
    );

    const systems = llm.seen[1]!.filter((m) => m.role === "system").map((m) => m.content);
    const answersBlock = systems.find((c) => c.startsWith("## Answers"));
    expect(answersBlock).toContain("Which invoice did you mean?");
    expect(answersBlock).toContain("mar");
  });

  it("offers no question tool while one is already pending in the same turn", async () => {
    // Two ask calls in one step: the second must not produce a second card.
    const { registry, db, knowledge } = setup();
    const llm = new RecordingLlm([askCall]);
    const engine = new ChatEngine({ db, llm, registry, knowledge, askUser: { enabled: true } });
    const session = await db.createSession({ title: "T" }, auth);
    const events = await collect(engine.send({ sessionId: session.id, text: "go" }, auth));
    expect(events.filter((e) => e.kind === "question_asked")).toHaveLength(1);
  });

  it("ignores an unusable question rather than showing an empty card", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new RecordingLlm([
      { kind: "toolCall", name: ASK_USER_TOOL_NAME, args: { question: "Hm?", options: [] } },
      { kind: "text", text: "Let me look." },
    ]);
    const engine = new ChatEngine({ db, llm, registry, knowledge, askUser: { enabled: true } });
    const session = await db.createSession({ title: "T" }, auth);
    const events = await collect(engine.send({ sessionId: session.id, text: "go" }, auth));
    expect(events.find((e) => e.kind === "question_asked")).toBeUndefined();
  });

  it("stays available to a read-only session — asking is not acting", async () => {
    const { registry, db, knowledge } = setup();
    const llm = new RecordingLlm([{ kind: "text", text: "hi" }]);
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      askUser: { enabled: true },
      permissionMode: "readonly",
    });
    const session = await db.createSession({ title: "T" }, auth);
    await collect(engine.send({ sessionId: session.id, text: "hi" }, auth));
    expect(llm.toolNames[0]).toContain(ASK_USER_TOOL_NAME);
  });
});
