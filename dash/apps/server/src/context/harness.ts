import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { Evidence, HarnessOutcome, HarnessResult } from "./types.js";
import { judgeEvidence } from "./judge.js";
import { rankSources } from "./sources.js";
import type { Candidate } from "./types.js";

/**
 * The loop: pick, read, judge, and pick again when it did not answer.
 *
 * Server-side and not chat tool steps, for the reason `pickEndpoints` and
 * `proposeWidget` are: `ChatEngine`'s inner loop exits the moment a step
 * produces prose and hints the model toward text from step one. It is "one
 * action then summarise", not an agentic loop, and an iterative search cannot
 * live in it. This runs whole inside one processing tool call instead.
 */

export interface Budget {
  /** Sources read before the loop gives up. */
  readonly sources: number;
  /** Upstream requests spendable across the whole turn. */
  readonly requests: number;
}

/**
 * Four sources and eight requests.
 *
 * The ceiling is set against what the board itself costs: opening a tab with
 * eight widgets on it makes about eight requests, so a question can never cost
 * more than looking at the answer would have. On a pay-per-request API that is
 * the difference between a feature and a liability, and an honest "here is
 * what I looked at" beats an unbounded search every time.
 */
export const DEFAULT_BUDGET: Budget = { sources: 4, requests: 8 };

export interface HarnessDeps {
  /** Cheap model. Ranking and judging are reading tasks, not judgement calls. */
  readonly llm: LlmAdapter;
  readonly model?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly candidates: readonly Candidate[];
  /** Reads one candidate. Returns null when it could not be read at all. */
  readonly readCandidate: (
    candidate: Candidate,
    spent: Budget,
  ) => Promise<Evidence | null>;
  readonly budget?: Budget;
}

export const runContextHarness = async (
  question: string,
  deps: HarnessDeps,
): Promise<HarnessResult> => {
  const budget = deps.budget ?? DEFAULT_BUDGET;
  const evidence: Evidence[] = [];
  const tried: string[] = [];
  let requests = 0;
  let sources = 0;
  let missing = "";
  let answer = "";
  let answered = false;
  let matched: Record<string, unknown>[] = [];
  let matchedFrom: Evidence | null = null;

  if (deps.candidates.length === 0) {
    return {
      outcome: "no-sources",
      evidence: [],
      tried: [],
      missing: "there is nothing connected to read",
      answer: "",
      matched: [],
      matchedFrom: null,
      spent: { requests: 0, sources: 0 },
      canGoDeeper: false,
    };
  }

  /*
   * Re-ranked each round rather than once.
   *
   * The judge's `missing` is the most valuable input the next pick can have -
   * "these are leases, the question was about the units they are on" turns a
   * blind second guess into a directed one. Ranking is a cheap call against a
   * list that is already in memory; a wasted upstream read is not.
   */
  while (sources < budget.sources && requests < budget.requests) {
    const ranked = await rankSources(
      deps.llm,
      {
        question,
        candidates: deps.candidates,
        exclude: tried,
        ...(missing ? { missing } : {}),
      },
      { ...(deps.model ? { model: deps.model } : {}), ...(deps.signal ? { signal: deps.signal } : {}) },
    );
    const next = ranked.sources[0];
    if (!next) {
      // Nothing left worth reading. Not a failure of the loop - an answer.
      if (!missing && ranked.reason) missing = ranked.reason;
      break;
    }

    const candidate = deps.candidates.find((entry) => entry.id === next);
    if (!candidate) break;
    tried.push(candidate.id);
    sources += 1;

    const read = await deps.readCandidate(candidate, {
      sources: budget.sources - sources,
      requests: budget.requests - requests,
    });
    if (!read) continue;
    requests += read.requests;

    const verdict = await judgeEvidence(
      deps.llm,
      { question, evidence: read },
      { ...(deps.model ? { model: deps.model } : {}), ...(deps.signal ? { signal: deps.signal } : {}) },
    );

    /*
     * A miss still keeps the evidence when nothing else has been found.
     *
     * "I read your leases and they carry no rent" is a real answer, and the
     * response step needs the rows to say it without hedging. What a miss
     * never does is stop the search.
     */
    if (verdict.verdict !== "miss" || evidence.length === 0) evidence.push(read);
    missing = verdict.missing || missing;
    // A partial answer is still an answer, and the next round may not improve
    // on it — so it is kept rather than only taken on "found".
    if (verdict.answer) answer = verdict.answer;
    /*
     * The rows the question was about, kept whole. `read.rows` is the
     * unnarrowed set and the judge answered with positions into it, so this is
     * the full record rather than the trimmed copy the judge was shown.
     */
    if (verdict.matched.length > 0) {
      const picked = verdict.matched
        .map((index) => read.rows[index])
        .filter((row): row is Record<string, unknown> => row !== undefined);
      if (picked.length > 0) {
        matched = picked;
        matchedFrom = read;
      }
    }

    if (verdict.verdict === "found") {
      answered = true;
      missing = "";
      break;
    }
  }

  const hitCap = sources >= budget.sources || requests >= budget.requests;
  const outcome: HarnessOutcome = answered
    ? "found"
    : evidence.length === 0
      ? hitCap
        ? "exhausted"
        : "not-found"
      : hitCap
        ? "exhausted"
        : "partial";

  return {
    outcome,
    evidence,
    tried,
    missing,
    answer,
    matched,
    matchedFrom,
    spent: { requests, sources },
    /*
     * Whether "dig deeper" is worth offering. Only true when something was
     * actually read and part of it was left unread - offering to go further
     * into a source that was read completely is an offer that cannot help.
     */
    canGoDeeper: evidence.some((entry) => entry.coverage.partial),
  };
};
