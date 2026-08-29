import { fakeLlm } from "@freebirdai/dash-agent";
import { describe, expect, it } from "vitest";
import { type Focus, MemoryFocusStore, focusIds, mergeRecords, parseFocus } from "./focus.js";
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

  /*
   * The gap this closes. Two records are held, the follow-up names one, and
   * opening whichever sorts first spends a request to describe the other —
   * which reads exactly like a correct answer.
   */
  it("names which of the held records the follow-up is about", async () => {
    const llm = ask({ decision: "related", wants: "the notes", records: [1] });
    const result = await recallFromFocus(llm, {
      question: "notes on the second one?",
      focus: focus({ records: [{ Id: 1 }, { Id: 2 }] }),
    });
    expect(result.records).toEqual([1]);
  });

  it("takes an empty list as meaning all of them", async () => {
    const llm = ask({ decision: "related", wants: "the notes" });
    const result = await recallFromFocus(llm, {
      question: "any notes on those?",
      focus: focus({ records: [{ Id: 1 }, { Id: 2 }] }),
    });
    expect(result.records).toEqual([]);
  });

  /* An out-of-range position would silently drop a subject. */
  it("discards a position the held records do not have", async () => {
    const llm = ask({ decision: "related", wants: "the notes", records: [0, 7, 0] });
    const result = await recallFromFocus(llm, {
      question: "notes?",
      focus: focus({ records: [{ Id: 1 }] }),
    });
    expect(result.records).toEqual([0]);
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


/**
 * The gap this closes: a follow-up that opened the wrong record.
 *
 * Two tasks are found, the follow-up names one, and opening whichever happened
 * to sort first spends a request to describe the other one — which reads
 * exactly like a correct answer.
 */
describe("mergeRecords", () => {
  const held = [
    { Id: 1, Title: "Dishwasher" },
    { Id: 2, Title: "Washing machine" },
  ];

  it("replaces the summary with the record opened in full", () => {
    const merged = mergeRecords(held, [{ Id: 1, Title: "Dishwasher", Description: "not draining" }], "Id");
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ Id: 1, Description: "not draining" });
  });

  /*
   * "And the other one?" is the next thing anybody asks, so the records beside
   * the one just opened have to survive.
   */
  it("keeps the records it did not open", () => {
    const merged = mergeRecords(held, [{ Id: 1, Description: "x" }], "Id");
    expect(merged.find((record) => record["Id"] === 2)).toMatchObject({ Title: "Washing machine" });
  });

  it("matches a numeric id against a string one", () => {
    const merged = mergeRecords([{ Id: "1", Title: "a" }], [{ Id: 1, Title: "a", Extra: true }], "Id");
    expect(merged).toHaveLength(1);
  });

  /*
   * Without an identifier there is nothing to match on. Leading with the
   * opened records is worse than merging and better than pretending two
   * records are the same because they arrived together.
   */
  it("leads with the opened records when nothing identifies them", () => {
    const merged = mergeRecords(held, [{ Title: "opened" }], null);
    expect(merged[0]).toEqual({ Title: "opened" });
    expect(merged).toHaveLength(3);
  });

  it("is the held records when nothing was opened", () => {
    expect(mergeRecords(held, [], "Id")).toEqual(held);
  });
});
