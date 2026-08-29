import { fakeLlm } from "@freebirdai/dash-agent";
import { describe, expect, it } from "vitest";
import { type Focus, MemoryFocusStore, focusIds, parseFocus } from "./focus.js";
import { recallFromFocus } from "./recall.js";

/**
 * What the conversation is about, between turns.
 *
 * The behaviour these hold: a follow-up about the record just discussed costs
 * nothing, a question about something else does not quietly get answered from
 * the wrong records, and an unrecognisable stored blob loses a shortcut rather
 * than breaking the turn.
 */

const focus = (over: Partial<Focus> = {}): Focus => ({
  question: "any dishwasher tasks?",
  source: "all-tasks",
  sourceTitle: "All Tasks",
  connection: "acme",
  op: "list_tasks",
  idField: "Id",
  records: [
    { Id: 5216612, Title: "Dishwasher", Description: "It is not draining.", Status: "InProgress" },
  ],
  savedAt: new Date().toISOString(),
  ...over,
});

describe("MemoryFocusStore", () => {
  it("holds a focus per conversation, not globally", async () => {
    const store = new MemoryFocusStore();
    await store.put("session-a", focus());
    expect(await store.get("session-a")).not.toBeNull();
    // Two people on the same board are asking about different things.
    expect(await store.get("session-b")).toBeNull();
  });

  it("forgets one that has gone stale", async () => {
    let now = 0;
    const store = new MemoryFocusStore(() => now);
    await store.put("s", focus());
    now = 3 * 60 * 60 * 1000;
    expect(await store.get("s")).toBeNull();
  });

  it("replaces rather than accumulating", async () => {
    const store = new MemoryFocusStore();
    await store.put("s", focus());
    await store.put("s", focus({ question: "any leases?", records: [{ Id: 1 }] }));
    const held = await store.get("s");
    expect(held?.records).toHaveLength(1);
    expect(held?.question).toBe("any leases?");
  });

  it("clears", async () => {
    const store = new MemoryFocusStore();
    await store.put("s", focus());
    await store.clear("s");
    expect(await store.get("s")).toBeNull();
  });
});

describe("focusIds", () => {
  it("reads identifiers out of the held records", () => {
    expect(focusIds(focus())).toEqual(["5216612"]);
  });

  /*
   * An API whose records have no established identity cannot do related
   * lookups. Saying so beats picking a field that looks like an id.
   */
  it("is empty when no identity field was established", () => {
    expect(focusIds(focus({ idField: null }))).toEqual([]);
  });

  it("skips records missing the identifier, and de-duplicates", () => {
    const held = focus({
      records: [{ Id: 1 }, { Id: null }, { Title: "no id" }, { Id: 1 }, { Id: 2 }],
    });
    expect(focusIds(held)).toEqual(["1", "2"]);
  });
});

describe("parseFocus", () => {
  it("reads back what was stored", () => {
    expect(parseFocus(JSON.parse(JSON.stringify(focus())))?.source).toBe("all-tasks");
  });

  /*
   * Once it is not this process's own memory it is untrusted input. An
   * unparseable focus reads as "nothing in hand", which costs a search.
   */
  it("treats an unrecognisable blob as nothing in hand", () => {
    expect(parseFocus({ nonsense: true })).toBeNull();
    expect(parseFocus(null)).toBeNull();
    expect(parseFocus("not an object")).toBeNull();
  });
});

describe("recallFromFocus", () => {
  const ask = (args: unknown) => fakeLlm([{ args }]);

  it("answers from the held records without reading anything", async () => {
    const llm = ask({ decision: "answer", answer: "It is not draining.", wants: "" });
    const result = await recallFromFocus(llm, {
      question: "what was the dishwasher issue?",
      focus: focus(),
    });
    expect(result.decision).toBe("answer");
    expect(result.answer).toBe("It is not draining.");
  });

  it("recognises a question about something attached to the records", async () => {
    const llm = ask({ decision: "related", answer: "", wants: "notes on the task" });
    const result = await recallFromFocus(llm, {
      question: "any notes on that?",
      focus: focus(),
    });
    expect(result.decision).toBe("related");
    expect(result.wants).toBe("notes on the task");
  });

  it("sends a new subject back to a search", async () => {
    const llm = ask({ decision: "search", answer: "", wants: "" });
    const result = await recallFromFocus(llm, {
      question: "how many properties do I have?",
      focus: focus(),
    });
    expect(result.decision).toBe("search");
  });

  it("does not call a model when nothing is held", async () => {
    const llm = ask({ decision: "answer", answer: "should not be used", wants: "" });
    const result = await recallFromFocus(llm, {
      question: "anything",
      focus: focus({ records: [] }),
    });
    expect(result.decision).toBe("search");
    expect(llm.calls).toHaveLength(0);
  });

  /*
   * A decision that contradicts itself is not acted on. Answering from the
   * wrong records is silent; searching again is merely slower.
   */
  it("falls back to a search when the decision says nothing", async () => {
    expect(
      (await recallFromFocus(ask({ decision: "answer", answer: "", wants: "" }), {
        question: "q",
        focus: focus(),
      })).decision,
    ).toBe("search");

    expect(
      (await recallFromFocus(ask({ decision: "related", answer: "", wants: "" }), {
        question: "q",
        focus: focus(),
      })).decision,
    ).toBe("search");
  });

  it("falls back to a search when the model fails", async () => {
    const broken = {
      ...fakeLlm([]),
      generate: async () => {
        throw new Error("timed out");
      },
    } as ReturnType<typeof fakeLlm>;
    const result = await recallFromFocus(broken, { question: "q", focus: focus() });
    expect(result.decision).toBe("search");
    expect(result.error).toContain("timed out");
  });

  it("tells the decision which records it is looking at and where they came from", async () => {
    const llm = ask({ decision: "search", answer: "", wants: "" });
    await recallFromFocus(llm, { question: "q", focus: focus() });
    const prompt = llm.calls[0]!.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("All Tasks");
    expect(prompt).toContain("Dishwasher");
    expect(prompt).toContain("any dishwasher tasks?");
  });
});
