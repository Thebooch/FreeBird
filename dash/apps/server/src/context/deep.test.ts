import { fakeLlm } from "@freebirdai/dash-agent";
import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, analyseDeep, chunkRows } from "./deep.js";
import type { Candidate, Evidence } from "./types.js";

/**
 * Reading a lot of records instead of a sample.
 *
 * What matters here is the failure behaviour. A map-reduce over twenty model
 * calls has twenty ways to go half-wrong, and every one of them must end in a
 * narrower answer that says it is narrower — never in a confident summary of
 * chunks that reported nothing.
 */

const candidate: Candidate = {
  kind: "widget",
  id: "leases",
  title: "Leases",
  describes: "",
  connection: "acme",
  op: "list_leases",
  fields: [],
  cached: false,
};

const evidenceOf = (count: number): Evidence => ({
  candidate,
  rows: Array.from({ length: count }, (_, i) => ({ Id: i, Status: i % 3 === 0 ? "past" : "active" })),
  columns: ["Id", "Status"],
  coverage: { scanned: count, of: count, orderedBy: null, partial: false },
  warnings: [],
  requests: 1,
});

/** n chunk replies, then the join. */
const script = (chunks: number, join?: unknown) =>
  fakeLlm([
    ...Array.from({ length: chunks }, (_, i) => ({
      args: { direct: `chunk ${i} says 4`, related: "", trends: i === 0 ? "one property dominates" : "" },
    })),
    { args: join ?? { answer: "12 in total", trends: "one property dominates", caveats: "" } },
  ]);

describe("chunkRows", () => {
  it("cuts into hundreds", () => {
    const sizes = chunkRows(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length);
    expect(sizes).toEqual([CHUNK_SIZE, CHUNK_SIZE, 50]);
  });

  it("leaves a short list as one chunk", () => {
    expect(chunkRows([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it("makes no chunks out of nothing", () => {
    expect(chunkRows([])).toEqual([]);
  });
});

describe("analyseDeep", () => {
  it("reads every chunk and joins what they found", async () => {
    const llm = script(3);
    const deep = await analyseDeep(llm, {
      question: "how many past leases?",
      evidence: evidenceOf(250),
    });

    expect(deep.chunkCount).toBe(3);
    expect(deep.scanned).toBe(250);
    expect(deep.answer).toBe("12 in total");
    // 3 chunk calls plus one join.
    expect(llm.calls).toHaveLength(4);
  });

  it("asks each chunk for patterns nobody asked about, and keeps them", async () => {
    const llm = script(2);
    const deep = await analyseDeep(llm, {
      question: "how many past leases?",
      evidence: evidenceOf(150),
    });
    expect(deep.trends).toContain("one property dominates");
  });

  it("tells each reader which stretch it is looking at", async () => {
    const llm = script(2);
    await analyseDeep(llm, { question: "q", evidence: evidenceOf(150) });
    const first = llm.calls[0]!.messages.map((m) => m.content).join("\n");
    expect(first).toContain("Chunk 1 of 2");
  });

  it("gives the join what every chunk reported, not just the last", async () => {
    const llm = script(3);
    await analyseDeep(llm, { question: "q", evidence: evidenceOf(250) });
    const join = llm.calls[3]!.messages.map((m) => m.content).join("\n");
    expect(join).toContain("chunk 0 says 4");
    expect(join).toContain("chunk 2 says 4");
  });

  /*
   * The cap is in chunks, not records: past it the honest move is to say how
   * much was read rather than to keep spending.
   */
  it("stops at the chunk cap and says how much it left", async () => {
    const llm = script(2);
    const deep = await analyseDeep(
      llm,
      { question: "q", evidence: evidenceOf(500) },
      { maxChunks: 2 },
    );
    expect(deep.chunkCount).toBe(2);
    expect(deep.scanned).toBe(200);
    expect(deep.skipped).toBe(3);
  });

  it("tells the join what it was not shown", async () => {
    const llm = script(2);
    await analyseDeep(llm, { question: "q", evidence: evidenceOf(500) }, { maxChunks: 2 });
    const join = llm.calls[2]!.messages.map((m) => m.content).join("\n");
    expect(join).toContain("3 further chunk(s) were not read");
  });

  /*
   * The one that matters most: consolidating silence produces a confident
   * summary of nothing, which reads exactly like an answer.
   */
  it("does not call the join when no chunk said anything", async () => {
    const llm = fakeLlm([{ args: { direct: "", related: "", trends: "" } }]);
    const deep = await analyseDeep(llm, { question: "q", evidence: evidenceOf(150) });
    expect(deep.answer).toBe("");
    expect(deep.caveats).toContain("said anything about this");
    // Two chunks, and no join.
    expect(llm.calls).toHaveLength(2);
  });

  it("keeps the chunk findings when the join fails", async () => {
    const llm = fakeLlm([
      { args: { direct: "chunk 0 says 4", related: "", trends: "" } },
      { args: { direct: "chunk 1 says 8", related: "", trends: "" } },
      { text: "not a tool call" },
    ]);
    const deep = await analyseDeep(llm, { question: "q", evidence: evidenceOf(150) });
    expect(deep.answer).toContain("chunk 0 says 4");
    expect(deep.answer).toContain("chunk 1 says 8");
    expect(deep.caveats).toContain("could not be consolidated");
  });

  it("loses one failed chunk rather than the whole read", async () => {
    let call = 0;
    const base = fakeLlm([{ args: { answer: "joined", trends: "", caveats: "" } }]);
    const flaky: typeof base = {
      ...base,
      generate: async (opts) => {
        const name = (opts.toolChoice as { name?: string } | undefined)?.name;
        if (name === "read_chunk") {
          call += 1;
          if (call === 1) throw new Error("timed out");
          return {
            text: "",
            toolCalls: [
              { id: "c", name: "read_chunk", args: { direct: "chunk 2 says 4", related: "", trends: "" } },
            ],
          };
        }
        return base.generate(opts);
      },
    } as typeof base;
    const deep = await analyseDeep(flaky, { question: "q", evidence: evidenceOf(150) });
    expect(deep.chunks).toHaveLength(2);
    expect(deep.chunks[0]?.direct).toBe("");
    expect(deep.answer).toBe("joined");
  });

  it("records how many rows each chunk actually held", async () => {
    const llm = script(3);
    const deep = await analyseDeep(llm, { question: "q", evidence: evidenceOf(250) });
    expect(deep.chunks.map((c) => c.rows)).toEqual([100, 100, 50]);
  });
});
