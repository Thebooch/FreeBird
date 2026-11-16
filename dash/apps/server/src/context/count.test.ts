import { describe, expect, it } from "vitest";
import { runContextHarness } from "./harness.js";
import { buildJudgePrompt, countAll, judgeEvidence } from "./judge.js";
import type { Candidate, Evidence } from "./types.js";

/**
 * "How many" over everything that was read.
 *
 * A model is shown a sample of fifty rows, and used to count those: asked how
 * many posts one author wrote, it said ten "among the 50 records read" while
 * a hundred were in hand. The rows it is not shown are now counted in code,
 * from conditions the model names, and only when those conditions pick, among
 * the rows it saw, exactly the rows it said matched.
 */

const candidate: Candidate = { kind: "widget", id: "posts", title: "posts", describes: "", connection: "acme", op: "posts", fields: ["userId", "title"], cached: true };

/** 100 posts, ten to each of ten authors: userId 1 for ids 1-10, and so on. */
const posts = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, userId: Math.floor(index / 10) + 1, title: `Post ${index + 1}`, status: index % 4 === 0 ? "Draft" : "Published" }));

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  candidate,
  rows: posts.slice(0, 50),
  rest: posts.slice(50),
  columns: ["id", "userId", "title", "status"],
  coverage: { scanned: 50, of: 100, orderedBy: null, partial: true },
  warnings: [],
  requests: 0,
  ...over,
});

const indices = (test: (row: (typeof posts)[number]) => boolean, within = 50) => posts.slice(0, within).flatMap((row, index) => (test(row) ? [index] : []));

const judging = (args: Record<string, unknown>) => {
  const prompts: string[] = [];
  return {
    prompts,
    llm: {
      defaultModel: "test",
      stream: async function* () {},
      generate: async (options: { messages: Array<{ content: string }>; tools?: Record<string, unknown> }) => {
        prompts.push(options.messages.map((message) => message.content).join("\n"));
        const name = options.tools && "rank_sources" in options.tools ? "rank_sources" : "judge_evidence";
        return { text: "", toolCalls: [{ id: "1", name, args: name === "rank_sources" ? { sources: ["posts"], reason: "" } : args }] };
      },
    } as never,
  };
};

describe("countAll", () => {
  it("counts every row read when the conditions pick exactly the rows the model matched", () => {
    const counted = countAll(evidence(), [{ field: "userId", equals: 3 }], indices((row) => row.userId === 3));
    expect(counted).toMatchObject({ matches: 10, of: 100 });
    expect(counted?.says).toBe('10 of the 100 records read have userId is 3. Every record read was counted.');

    /* Past the sample is where it matters: author 8's posts are all unseen. */
    expect(countAll(evidence(), [{ field: "userId", equals: 8 }], [])).toMatchObject({ matches: 10, of: 100 });
    expect(countAll(evidence(), [{ field: "status", equals: "draft" }], indices((row) => row.status === "Draft"))).toMatchObject({ matches: 25, of: 100 });
    expect(countAll(evidence(), [{ field: "userId", equals: "3" }, { field: "status", equals: "Published" }], indices((row) => row.userId === 3 && row.status === "Published"))).toMatchObject({ matches: 7 });
  });

  it("counts nothing when the conditions and the model's own matches disagree", () => {
    /* It matched author 3's rows but named author 4: not what it meant. */
    expect(countAll(evidence(), [{ field: "userId", equals: 4 }], indices((row) => row.userId === 3))).toBeNull();
    /* It listed only some of the rows its conditions pick. */
    expect(countAll(evidence(), [{ field: "userId", equals: 3 }], indices((row) => row.userId === 3).slice(0, 4))).toBeNull();
    /* It listed a row its conditions do not pick. */
    expect(countAll(evidence(), [{ field: "userId", equals: 3 }], [...indices((row) => row.userId === 3), 0])).toBeNull();
  });

  it("counts nothing for a column the rows do not have, or when nothing is unseen", () => {
    expect(countAll(evidence(), [{ field: "author", equals: 3 }], [])).toBeNull();
    const all = evidence({ rows: posts.slice(0, 20), rest: undefined, coverage: { scanned: 20, of: 20, orderedBy: null, partial: false } });
    expect(countAll(all, [{ field: "userId", equals: 1 }], indices((row) => row.userId === 1, 20))).toBeNull();
  });
});

describe("the judge, with rows held past the sample", () => {
  it("is told how many rows it was not shown, and only then", () => {
    expect(buildJudgePrompt({ question: "how many?", evidence: evidence() })).toContain("50 more row(s) were read and are held, but not shown to you.");
    const whole = evidence({ rows: posts.slice(0, 20), rest: undefined, coverage: { scanned: 20, of: 20, orderedBy: null, partial: false } });
    expect(buildJudgePrompt({ question: "how many?", evidence: whole })).not.toContain("not shown to you");
  });

  it("never puts a held row in front of the model", () => {
    const prompt = buildJudgePrompt({ question: "how many?", evidence: evidence() });
    expect(prompt).toContain('"Post 50"');
    expect(prompt).not.toContain('"Post 51"');
    expect(prompt).not.toContain('"Post 100"');
  });

  it("answers with the count over every row, as found, in place of the sample's answer", async () => {
    const { llm } = judging({ verdict: "partial", answer: "10 among the 50 shown", missing: "the other 50", matched: indices((row) => row.userId === 3), count: { where: [{ field: "userId", equals: 3 }] } });
    const verdict = await judgeEvidence(llm, { question: "How many posts has user 3 written?", evidence: evidence() });
    expect(verdict.verdict).toBe("found");
    expect(verdict.answer).toBe('10 of the 100 records read have userId is 3. Every record read was counted.');
    expect(verdict.missing).toBe("");
    expect(verdict.counted).toEqual({ matches: 10, of: 100 });
  });

  it("stays partial, and says why, when the API itself holds more than was read", async () => {
    const { llm } = judging({ verdict: "partial", answer: "", missing: "", matched: indices((row) => row.userId === 3), count: { where: [{ field: "userId", equals: 3 }] } });
    const capped = evidence({ coverage: { scanned: 50, of: null, orderedBy: null, partial: true } });
    const verdict = await judgeEvidence(llm, { question: "How many posts has user 3 written?", evidence: capped });
    expect(verdict.verdict).toBe("partial");
    expect(verdict.answer).toContain("10 of the 100 records read");
    expect(verdict.answer).toContain("The API holds more records than were read");
  });

  it("keeps the model's own answer when its conditions do not hold up", async () => {
    const { llm } = judging({ verdict: "partial", answer: "10 among the 50 shown", missing: "the other 50", matched: indices((row) => row.userId === 3), count: { where: [{ field: "userId", equals: 9 }] } });
    const verdict = await judgeEvidence(llm, { question: "How many posts has user 3 written?", evidence: evidence() });
    expect(verdict).toMatchObject({ verdict: "partial", answer: "10 among the 50 shown", missing: "the other 50" });
    expect(verdict.counted).toBeUndefined();
  });
});

describe("the search, with a count over every row", () => {
  it("reports all the rows as read, and the question as answered", async () => {
    const { llm } = judging({ verdict: "partial", answer: "10 among the 50 shown", missing: "", matched: indices((row) => row.userId === 3), count: { where: [{ field: "userId", equals: 3 }] } });
    const result = await runContextHarness("How many posts has user 3 written?", { llm, candidates: [candidate], readCandidate: async () => evidence() });
    expect(result.outcome).toBe("found");
    expect(result.answer).toContain("10 of the 100 records read");
    expect(result.evidence[0]!.coverage).toMatchObject({ scanned: 100, of: 100, partial: false });
    expect(result.canGoDeeper).toBe(false);
    expect(result.spent).toEqual({ requests: 0, sources: 1 });
  });
});
