import { fakeLlm } from "@freebirdai/dash-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, runContextHarness } from "./harness.js";
import { cheapestFirst } from "./sources.js";
import type { Candidate, Evidence } from "./types.js";

/**
 * The three things the loop has to get right: it stops when it has the answer,
 * it keeps looking when it does not, and it never spends more than its budget.
 */

const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  kind: "widget",
  id,
  title: id,
  describes: "",
  connection: "acme",
  op: "list_things",
  fields: ["name"],
  cached: true,
  ...over,
});

const evidenceFor = (
  c: Candidate,
  rows: Record<string, unknown>[],
  requests = 0,
): Evidence => ({
  candidate: c,
  rows,
  columns: rows[0] ? Object.keys(rows[0]) : [],
  coverage: { scanned: rows.length, of: rows.length, orderedBy: null, partial: false },
  warnings: [],
  requests,
});

/** rank, judge, rank, judge — the order the loop calls them in. */
const script = (...turns: unknown[]) => fakeLlm(turns.map((args) => ({ args })));

describe("runContextHarness", () => {
  it("stops as soon as a source answers the question", async () => {
    const llm = script(
      { sources: ["leases"], reason: "" },
      { verdict: "found", answer: "38 active", missing: "" },
    );
    const reads: string[] = [];

    const result = await runContextHarness("how many active leases?", {
      llm,
      candidates: [candidate("leases"), candidate("rent")],
      readCandidate: async (c) => {
        reads.push(c.id);
        return evidenceFor(c, [{ status: "active" }]);
      },
    });

    expect(result.outcome).toBe("found");
    expect(reads).toEqual(["leases"]);
    expect(result.evidence).toHaveLength(1);
    expect(result.missing).toBe("");
  });

  it("keeps looking when the first source does not answer it", async () => {
    const llm = script(
      { sources: ["leases"], reason: "" },
      { verdict: "miss", answer: "", missing: "no rent column here" },
      { sources: ["rent"], reason: "" },
      { verdict: "found", answer: "4,200", missing: "" },
    );
    const reads: string[] = [];

    const result = await runContextHarness("what is the highest rent?", {
      llm,
      candidates: [candidate("leases"), candidate("rent")],
      readCandidate: async (c) => {
        reads.push(c.id);
        return evidenceFor(c, [{ rent: 4200 }]);
      },
    });

    expect(reads).toEqual(["leases", "rent"]);
    expect(result.outcome).toBe("found");
  });

  it("passes what is still missing into the next pick", async () => {
    const llm = script(
      { sources: ["leases"], reason: "" },
      { verdict: "miss", answer: "", missing: "these are leases, not units" },
      { sources: ["units"], reason: "" },
      { verdict: "found", answer: "12", missing: "" },
    );
    await runContextHarness("how many units?", {
      llm,
      candidates: [candidate("leases"), candidate("units")],
      readCandidate: async (c) => evidenceFor(c, [{ a: 1 }]),
    });
    const secondRank = llm.calls[2]!.messages.map((m) => m.content).join("\n");
    expect(secondRank).toContain("these are leases, not units");
  });

  it("never reads a source twice", async () => {
    const llm = script(
      { sources: ["leases"], reason: "" },
      { verdict: "miss", answer: "", missing: "not here" },
      { sources: ["leases"], reason: "" },
      { verdict: "miss", answer: "", missing: "not here" },
    );
    const reads: string[] = [];
    await runContextHarness("q", {
      llm,
      candidates: [candidate("leases")],
      readCandidate: async (c) => {
        reads.push(c.id);
        return evidenceFor(c, [{ a: 1 }]);
      },
    });
    // The second rank is offered nothing, so the loop ends rather than
    // re-reading what it already has.
    expect(reads).toEqual(["leases"]);
  });

  it("stops at the request cap and reports it", async () => {
    const alwaysMiss = fakeLlm([{ args: { sources: ["a", "b", "c", "d", "e"], reason: "" } }]);
    const result = await runContextHarness("q", {
      llm: {
        ...alwaysMiss,
        generate: async (opts) => {
          const name = (opts.toolChoice as { name?: string } | undefined)?.name;
          if (name === "judge_evidence") {
            return {
              text: "",
              toolCalls: [
                {
                  id: "j",
                  name: "judge_evidence",
                  args: { verdict: "miss", answer: "", missing: "no" },
                },
              ],
            };
          }
          return alwaysMiss.generate(opts);
        },
      },
      candidates: ["a", "b", "c", "d", "e"].map((id) => candidate(id, { cached: false })),
      budget: { sources: 10, requests: 3 },
      readCandidate: async (c) => evidenceFor(c, [{ a: 1 }], 1),
    });
    expect(result.spent.requests).toBe(3);
    expect(result.outcome).toBe("exhausted");
  });

  /*
   * The judge has already read the sample to decide whether it answered.
   * Discarding what it found and asking the writing step to re-derive it pays
   * twice and lets the two disagree.
   */
  it("carries the answer the judge read out of the rows", async () => {
    const llm = script(
      { sources: ["leases"], reason: "" },
      { verdict: "found", answer: "38 active", missing: "" },
    );
    const result = await runContextHarness("how many active?", {
      llm,
      candidates: [candidate("leases")],
      readCandidate: async (c) => evidenceFor(c, [{ status: "active" }]),
    });
    expect(result.answer).toBe("38 active");
  });

  it("keeps a partial answer rather than only taking a found one", async () => {
    const llm = script(
      { sources: ["leases"], reason: "" },
      { verdict: "partial", answer: "at least 38 so far", missing: "only part read" },
    );
    const result = await runContextHarness("how many active?", {
      llm,
      candidates: [candidate("leases")],
      readCandidate: async (c) => evidenceFor(c, [{ status: "active" }]),
    });
    expect(result.answer).toBe("at least 38 so far");
  });

  it("reports having nothing to read rather than calling a model", async () => {
    const llm = script();
    const result = await runContextHarness("q", {
      llm,
      candidates: [],
      readCandidate: async () => null,
    });
    expect(result.outcome).toBe("no-sources");
    expect(llm.calls).toHaveLength(0);
  });

  it("keeps a miss as evidence when nothing better was found", async () => {
    const llm = script(
      { sources: ["leases"], reason: "" },
      { verdict: "miss", answer: "", missing: "no rent column here" },
    );
    const result = await runContextHarness("what is the highest rent?", {
      llm,
      candidates: [candidate("leases")],
      readCandidate: async (c) => evidenceFor(c, [{ status: "active" }]),
    });
    // "I read your leases and they carry no rent" needs the rows to be said.
    expect(result.evidence).toHaveLength(1);
    expect(result.missing).toBe("no rent column here");
  });

  it("offers to dig deeper only when part of a source was left unread", async () => {
    const llm = script(
      { sources: ["leases"], reason: "" },
      { verdict: "partial", answer: "so far 38", missing: "only 50 read" },
    );
    const result = await runContextHarness("how many?", {
      llm,
      candidates: [candidate("leases")],
      readCandidate: async (c) => ({
        ...evidenceFor(c, [{ a: 1 }]),
        coverage: { scanned: 50, of: 400, orderedBy: "Date", partial: true },
      }),
    });
    expect(result.canGoDeeper).toBe(true);
  });

  it("does not offer to dig deeper into a source that was read whole", async () => {
    const llm = script(
      { sources: ["leases"], reason: "" },
      { verdict: "found", answer: "3", missing: "" },
    );
    const result = await runContextHarness("how many?", {
      llm,
      candidates: [candidate("leases")],
      readCandidate: async (c) => evidenceFor(c, [{ a: 1 }]),
    });
    expect(result.canGoDeeper).toBe(false);
  });
});

describe("cheapestFirst", () => {
  it("puts cached sources ahead of ones that cost a request", () => {
    const candidates = [
      candidate("paid", { cached: false }),
      candidate("free", { cached: true }),
    ];
    expect(cheapestFirst(["paid", "free"], candidates)).toEqual(["free", "paid"]);
  });

  it("keeps the model's own order within a cost group", () => {
    const candidates = [candidate("a", { cached: true }), candidate("b", { cached: true })];
    expect(cheapestFirst(["b", "a"], candidates)).toEqual(["b", "a"]);
  });
});

describe("DEFAULT_BUDGET", () => {
  it("costs no more than opening a board would", () => {
    expect(DEFAULT_BUDGET.requests).toBeLessThanOrEqual(8);
    expect(DEFAULT_BUDGET.sources).toBeLessThanOrEqual(4);
  });
});

/**
 * The failure this was built from, as a test.
 *
 * Asked for the notes on a particular task, the judge correctly picked the row
 * and correctly said the description was not in it — and the loop then ranked a
 * different source, which could only ever find the same summary again. The
 * record itself was one request away the whole time.
 */
describe("opening the record a row named", () => {
  it("expands a matched row that does not carry the answer, and judges again", async () => {
    const llm = script(
      { sources: ["tasks"], reason: "" },
      { verdict: "partial", answer: "", missing: "the description is not in these rows", matched: [1] },
      { verdict: "found", answer: "water is pooling by the downpipe", missing: "" },
    );

    const opened: Record<string, unknown>[][] = [];
    const result = await runContextHarness("what are the notes on the water task?", {
      llm,
      candidates: [candidate("tasks"), candidate("other")],
      readCandidate: async (c) =>
        evidenceFor(c, [{ Id: 1, Title: "Turn" }, { Id: 2, Title: "Water on side of house" }]),
      reach: async ({ matched, from }) => {
        opened.push([...matched]);
        return {
          note: "Opened the full task record — 1 request(s).",
          considered: [{ title: "The full task record", note: "every field the list left out" }],
          evidence: evidenceFor(
            from.candidate,
            [{ Id: 2, Title: "Water on side of house", Description: "water is pooling by the downpipe" }],
            1,
          ),
        };
      },
    });

    // Only the row the judge matched, never the whole page.
    expect(opened).toEqual([[{ Id: 2, Title: "Water on side of house" }]]);
    expect(result.outcome).toBe("found");
    expect(result.answer).toContain("downpipe");
    expect(result.missing).toBe("");
    // The reply is required to say it spent something.
    expect(result.notes).toEqual(["Opened the full task record — 1 request(s)."]);
    expect(result.spent.requests).toBe(1);
  });

  /*
   * The focus becomes the full record, not the summary the row was. That is
   * what makes the next question about any other field of it free.
   */
  it("leaves the opened record as what the question was about", async () => {
    const llm = script(
      { sources: ["tasks"], reason: "" },
      { verdict: "partial", answer: "", missing: "no description", matched: [0] },
      { verdict: "found", answer: "…", missing: "" },
    );
    const result = await runContextHarness("notes?", {
      llm,
      candidates: [candidate("tasks")],
      readCandidate: async (c) => evidenceFor(c, [{ Id: 2, Title: "Water" }]),
      reach: async ({ from }) => ({
        note: "opened",
        considered: [],
        evidence: evidenceFor(from.candidate, [{ Id: 2, Title: "Water", Description: "full" }], 1),
      }),
    });
    expect(result.matched).toEqual([{ Id: 2, Title: "Water", Description: "full" }]);
  });

  it("does not open anything when no row was matched", async () => {
    const llm = script(
      { sources: ["tasks"], reason: "" },
      { verdict: "miss", answer: "", missing: "nothing here", matched: [] },
      { sources: [], reason: "nothing else could hold it" },
    );
    let opened = 0;
    await runContextHarness("how many tasks are there?", {
      llm,
      candidates: [candidate("tasks")],
      readCandidate: async (c) => evidenceFor(c, [{ Id: 1 }]),
      reach: async () => {
        opened += 1;
        return null;
      },
    });
    expect(opened).toBe(0);
  });

  /*
   * An API with no by-id endpoint returns null, and the loop carries on as it
   * always did rather than treating the absence as a failure.
   */
  it("carries on when the API cannot open a record", async () => {
    const llm = script(
      { sources: ["tasks"], reason: "" },
      { verdict: "partial", answer: "", missing: "no description", matched: [0] },
      { sources: [], reason: "nothing else holds it" },
    );
    const result = await runContextHarness("notes?", {
      llm,
      candidates: [candidate("tasks")],
      readCandidate: async (c) => evidenceFor(c, [{ Id: 1 }]),
      reach: async () => null,
    });
    expect(result.outcome).toBe("partial");
    expect(result.notes).toEqual([]);
  });

  /*
   * The steer is what the judge said was missing, not the question.
   *
   * "Are there any notes on them? Any correlating issue?" cannot pick between
   * a record's detail and a history collection. "The rows carry no notes" can.
   */
  it("hands the reach step what the judge said was still missing", async () => {
    const llm = script(
      { sources: ["tasks"], reason: "" },
      { verdict: "partial", answer: "", missing: "no notes on these rows", matched: [0] },
      { verdict: "found", answer: "the tenant opened it manually", missing: "" },
    );
    let steer = "";
    await runContextHarness("are there any notes on them? any correlating issue?", {
      llm,
      candidates: [candidate("tasks")],
      readCandidate: async (c) => evidenceFor(c, [{ Id: 1 }]),
      reach: async ({ missing, from }) => {
        steer = missing;
        return {
          note: "opened",
          considered: [],
          evidence: evidenceFor(from.candidate, [{ Note: "opened it manually" }], 1),
        };
      },
    });
    expect(steer).toBe("no notes on these rows");
  });

  /*
   * The half that makes a dead end legible. Somebody told "I don't have notes"
   * asks again for the thing that was already tried; somebody told what was
   * checked knows the search happened and where it went.
   */
  it("records what it could check even when none of it held the answer", async () => {
    const llm = script(
      { sources: ["tasks"], reason: "" },
      { verdict: "partial", answer: "", missing: "no notes here", matched: [0] },
      { sources: [], reason: "nothing else could hold it" },
    );
    const result = await runContextHarness("any notes?", {
      llm,
      candidates: [candidate("tasks")],
      readCandidate: async (c) => evidenceFor(c, [{ Id: 1 }]),
      reach: async () => ({
        note: "",
        evidence: null,
        considered: [
          { title: "The full task record", note: "fields the list left out" },
          { title: "History entries", note: "records of history entry" },
        ],
      }),
    });

    expect(result.considered.map((entry) => entry.title)).toEqual([
      "The full task record",
      "History entries",
    ]);
    // Nothing was read, so nothing is claimed to have been spent.
    expect(result.notes).toEqual([]);
    expect(result.spent.requests).toBe(0);
  });

  it("records what it checked when the answer did come from there", async () => {
    const llm = script(
      { sources: ["tasks"], reason: "" },
      { verdict: "partial", answer: "", missing: "no notes here", matched: [0] },
      { verdict: "found", answer: "opened manually", missing: "" },
    );
    const result = await runContextHarness("any notes?", {
      llm,
      candidates: [candidate("tasks")],
      readCandidate: async (c) => evidenceFor(c, [{ Id: 1 }]),
      reach: async ({ from }) => ({
        note: "Read the history of 1 task — 1 request(s).",
        considered: [{ title: "History entries", note: "records of history entry" }],
        evidence: evidenceFor(from.candidate, [{ Note: "opened manually" }], 1),
      }),
    });
    expect(result.outcome).toBe("found");
    expect(result.considered).toHaveLength(1);
    expect(result.notes).toEqual(["Read the history of 1 task — 1 request(s)."]);
  });

  it("does not open a record once the budget is spent", async () => {
    const llm = script(
      { sources: ["tasks"], reason: "" },
      { verdict: "partial", answer: "", missing: "no description", matched: [0] },
    );
    let opened = 0;
    await runContextHarness("notes?", {
      llm,
      candidates: [candidate("tasks")],
      budget: { sources: 2, requests: 1 },
      readCandidate: async (c) => evidenceFor(c, [{ Id: 1 }], 1),
      reach: async () => {
        opened += 1;
        return null;
      },
    });
    expect(opened).toBe(0);
  });
});

/**
 * "Has anyone mentioned running late?" is a different question from "what is
 * the highest rent?".
 *
 * The second is answered by one source and a second cannot improve on it. The
 * first is answered by every source that could hold it, and stopping at the
 * first hit reports one platform's three while never mentioning the other's
 * four — which is not a partial answer but a wrong one.
 */
describe("across every source", () => {
  it("keeps reading after the first source answers", async () => {
    const llm = script(
      { sources: ["platform-x"], reason: "" },
      { verdict: "found", answer: "3 mention it", missing: "", matched: [0] },
      { sources: ["platform-y"], reason: "" },
      { verdict: "found", answer: "4 mention it", missing: "", matched: [0] },
      { sources: [], reason: "nothing else holds conversations" },
    );
    const reads: string[] = [];
    const result = await runContextHarness("has anyone mentioned running late?", {
      llm,
      scope: { mode: "all" },
      candidates: [
        candidate("platform-x", { connection: "x" }),
        candidate("platform-y", { connection: "y" }),
      ],
      readCandidate: async (c) => {
        reads.push(c.id);
        return evidenceFor(c, [{ text: "running late" }]);
      },
    });

    expect(reads).toEqual(["platform-x", "platform-y"]);
    expect(result.outcome).toBe("found");
    expect(result.evidence).toHaveLength(2);
  });

  /*
   * Itemizing needs each source's own reading. One combined sentence cannot be
   * attributed back to either platform.
   */
  it("keeps what each source said, separately", async () => {
    const llm = script(
      { sources: ["platform-x"], reason: "" },
      { verdict: "found", answer: "3 mention it", missing: "", matched: [0] },
      { sources: ["platform-y"], reason: "" },
      { verdict: "found", answer: "4 mention it", missing: "", matched: [0] },
      { sources: [], reason: "" },
    );
    const result = await runContextHarness("who is running late?", {
      llm,
      scope: { mode: "all" },
      candidates: [
        candidate("platform-x", { connection: "x" }),
        candidate("platform-y", { connection: "y" }),
      ],
      readCandidate: async (c) => evidenceFor(c, [{ text: "late" }]),
    });

    expect(result.evidence.map((entry) => entry.answer)).toEqual([
      "3 mention it",
      "4 mention it",
    ]);
    expect(result.evidence.map((entry) => entry.matched)).toEqual([1, 1]);
    expect(result.evidence.map((entry) => entry.candidate.connection)).toEqual(["x", "y"]);
  });

  it("still stops at the first answer when not asked to go wide", async () => {
    const llm = script(
      { sources: ["platform-x"], reason: "" },
      { verdict: "found", answer: "3", missing: "", matched: [0] },
    );
    const reads: string[] = [];
    const result = await runContextHarness("how many?", {
      llm,
      candidates: [candidate("platform-x"), candidate("platform-y")],
      readCandidate: async (c) => {
        reads.push(c.id);
        return evidenceFor(c, [{ text: "x" }]);
      },
    });
    expect(reads).toEqual(["platform-x"]);
    expect(result.evidence).toHaveLength(1);
  });

  /* The budget is still the budget. Going wide cannot mean going unbounded. */
  it("stops at the budget however many sources could hold it", async () => {
    const llm = script(
      { sources: ["a"], reason: "" },
      { verdict: "found", answer: "1", missing: "", matched: [0] },
      { sources: ["b"], reason: "" },
      { verdict: "found", answer: "1", missing: "", matched: [0] },
      { sources: ["c"], reason: "" },
      { verdict: "found", answer: "1", missing: "", matched: [0] },
    );
    const reads: string[] = [];
    await runContextHarness("anywhere?", {
      llm,
      scope: { mode: "all" },
      budget: { sources: 2, requests: 8 },
      candidates: [candidate("a"), candidate("b"), candidate("c")],
      readCandidate: async (c) => {
        reads.push(c.id);
        return evidenceFor(c, [{ text: "x" }]);
      },
    });
    expect(reads).toEqual(["a", "b"]);
  });

  /*
   * A source that refused is not a source that answered "no".
   *
   * The distinction the whole `unreadable` path exists for: reporting an
   * expired key as `not-found` is a confident claim about records nobody was
   * able to see, and it is the answer the user is most likely to believe.
   */
  describe("when a source cannot be read at all", () => {
    const refusal = (c: Candidate, reason: string): Evidence => ({
      candidate: c,
      rows: [],
      columns: [],
      coverage: { scanned: 0, of: null, orderedBy: null, partial: true },
      warnings: [reason],
      refused: true,
      requests: 0,
    });

    it("reports 'unreadable' rather than 'not-found' when nothing could be read", async () => {
      const llm = script({ sources: ["leases"], reason: "" });

      const result = await runContextHarness("how many active leases?", {
        llm,
        candidates: [candidate("leases")],
        readCandidate: async (c) => refusal(c, "the key has expired"),
      });

      expect(result.outcome).toBe("unreadable");
      expect(result.evidence).toHaveLength(0);
      expect(result.unreadable).toHaveLength(1);
      expect(result.unreadable[0]?.reason).toContain("expired");
      expect(result.unreadable[0]?.candidate.id).toBe("leases");
    });

    /*
     * Judging zero rows can only ever return "miss", and a miss is a statement
     * about the data. Paying a model to make a false one is the worst of both.
     */
    it("does not spend a judge call on a refusal", async () => {
      // Two entries: a rank for each round. A judge call would consume one of
      // them out of turn and the second rank would come back as the wrong
      // shape, so mis-scripting fails loudly rather than passing by accident.
      const llm = script(
        { sources: ["leases"], reason: "" },
        { sources: ["rent"], reason: "" },
      );

      const result = await runContextHarness("what is the highest rent?", {
        llm,
        candidates: [candidate("leases"), candidate("rent")],
        readCandidate: async (c) => refusal(c, "403 from the API"),
      });

      expect(result.outcome).toBe("unreadable");
      expect(result.unreadable).toHaveLength(2);
    });

    /* One dead source does not erase an answer another source gave. */
    it("still reports 'found' when a later source answers", async () => {
      const llm = script(
        { sources: ["leases"], reason: "" },
        { sources: ["rent"], reason: "" },
        { verdict: "found", answer: "4,200", missing: "" },
      );

      const result = await runContextHarness("what is the highest rent?", {
        llm,
        candidates: [candidate("leases"), candidate("rent")],
        readCandidate: async (c) =>
          c.id === "leases"
            ? refusal(c, "the key has expired")
            : evidenceFor(c, [{ rent: 4200 }]),
      });

      expect(result.outcome).toBe("found");
      expect(result.answer).toBe("4,200");
      expect(result.unreadable).toHaveLength(1);
      expect(result.unreadable[0]?.candidate.id).toBe("leases");
    });
  });

  /*
   * The money ceiling is a cap like the other two, and reaching it is
   * `exhausted` for the same reason reaching `budget.sources` is: there was
   * more that could have been looked at.
   */
  it("stops between rounds when the turn is out of budget", async () => {
    const llm = script(
      { sources: ["a"], reason: "" },
      { verdict: "miss", answer: "", missing: "not here" },
    );
    const reads: string[] = [];
    let spent = false;

    const result = await runContextHarness("anything?", {
      llm,
      candidates: [candidate("a"), candidate("b")],
      overBudget: () => spent,
      readCandidate: async (c) => {
        reads.push(c.id);
        // The first read is what tips it over.
        spent = true;
        return evidenceFor(c, [{ text: "x" }]);
      },
    });

    expect(reads).toEqual(["a"]);
    expect(result.outcome).toBe("exhausted");
  });
});
