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
  /**
   * Open the records a round matched, in full.
   *
   * The step that turns "I found the task you mean but its notes are not in
   * these rows" into an answer. A collection endpoint returns a summary of
   * each record and the record's own endpoint returns everything, so a row
   * that names the right record and lacks the asked-for field is not a dead
   * end — it is an identifier. Returns null when the API exposes no by-id
   * endpoint, when nothing could be opened, or when there is no identifier.
   */
  readonly expand?:
    | ((
        matched: readonly Record<string, unknown>[],
        from: Evidence,
      ) => Promise<{ evidence: Evidence; note: string } | null>)
    | undefined;
  readonly budget?: Budget;
  /**
   * How wide to look.
   *
   * `best` stops at the first source that answers, which is right for "what is
   * the highest rent?" — a second source cannot improve on an answer that is
   * already complete.
   *
   * `all` reads every candidate worth reading and judges each **separately**,
   * which is the only way to answer "has anyone mentioned running late?"
   * across several connected platforms. Stopping at the first hit there would
   * report one platform's three and never mention the other's four, which is
   * not a partial answer but a wrong one.
   */
  readonly scope?: { readonly mode?: "best" | "all" } | undefined;
}

export const runContextHarness = async (
  question: string,
  deps: HarnessDeps,
): Promise<HarnessResult> => {
  const budget = deps.budget ?? DEFAULT_BUDGET;
  const mode = deps.scope?.mode ?? "best";
  const evidence: Evidence[] = [];
  const tried: string[] = [];
  let requests = 0;
  let sources = 0;
  let missing = "";
  let answer = "";
  let answered = false;
  let matched: Record<string, unknown>[] = [];
  let matchedFrom: Evidence | null = null;
  const notes: string[] = [];

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
      notes: [],
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
    const picked = verdict.matched
      .map((index) => read.rows[index])
      .filter((row): row is Record<string, unknown> => row !== undefined);

    /*
     * The judge's reading is attached to the source it read, not to the turn.
     * A question asked across several platforms has an answer per platform,
     * and one combined sentence cannot be attributed back to either.
     */
    const judged: Evidence = {
      ...read,
      ...(verdict.answer ? { answer: verdict.answer } : {}),
      matched: picked.length,
    };
    if (verdict.verdict !== "miss" || evidence.length === 0) evidence.push(judged);
    missing = verdict.missing || missing;
    // A partial answer is still an answer, and the next round may not improve
    // on it — so it is kept rather than only taken on "found".
    if (verdict.answer) answer = verdict.answer;
    /*
     * The rows the question was about, kept whole. `read.rows` is the
     * unnarrowed set and the judge answered with positions into it, so this is
     * the full record rather than the trimmed copy the judge was shown.
     */
    if (picked.length > 0) {
      matched = picked;
      matchedFrom = judged;
    }

    if (verdict.verdict === "found") {
      answered = true;
      missing = "";
      /*
       * Across every source, one hit is not the answer. "Platform X has three"
       * is only half of "platform X has three and platform Y has four", and
       * the half that stops early is indistinguishable from the whole.
       */
      if (mode === "best") break;
      continue;
    }

    /*
     * The rows named the record and did not carry the answer.
     *
     * This is the shape the whole loop used to fail on: asked for the notes on
     * a particular task, the judge correctly picked the row and correctly said
     * the description was not in it, and the loop moved on to rank a different
     * source — which could only ever find the same summary again. The record
     * itself was one request away.
     *
     * Only when a row was actually matched. Without one there is no identifier
     * and nothing to open, and expanding on a whim would spend a request per
     * turn for nothing.
     */
    if (deps.expand && picked.length > 0 && requests < budget.requests) {
      const opened = await deps.expand(picked, read);
      if (opened) {
        requests += opened.evidence.requests;
        evidence.push(opened.evidence);
        notes.push(opened.note);

        const second = await judgeEvidence(
          deps.llm,
          { question, evidence: opened.evidence },
          {
            ...(deps.model ? { model: deps.model } : {}),
            ...(deps.signal ? { signal: deps.signal } : {}),
          },
        );
        if (second.answer) answer = second.answer;
        missing = second.verdict === "found" ? "" : second.missing || missing;
        if (opened.evidence.rows.length > 0) {
          matched = [...opened.evidence.rows];
          matchedFrom = opened.evidence;
        }
        if (second.verdict === "found") {
          answered = true;
          break;
        }
      }
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
    notes,
    /*
     * Whether "dig deeper" is worth offering. Only true when something was
     * actually read and part of it was left unread - offering to go further
     * into a source that was read completely is an offer that cannot help.
     */
    canGoDeeper: evidence.some((entry) => entry.coverage.partial),
  };
};
