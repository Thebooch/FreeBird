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
