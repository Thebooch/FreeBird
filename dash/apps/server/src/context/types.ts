import type { ResolvedParams } from "@freebirdai/dash-spec";

/**
 * Going and finding the answer, rather than hoping it is already in the prompt.
 *
 * The assistant is given the *shape* of the workspace on every turn — what
 * widgets exist, which endpoints they read, what the fields are called. What it
 * is never given is the data, because there is far too much of it and almost
 * none of it is relevant to any one question. Dumping a sample of everything
 * per turn would be expensive on every turn and still miss most answers.
 *
 * So this is a search instead: pick where the answer most likely is, read a
 * bounded amount of it, ask whether that actually answered the question, and
 * move on to the next candidate if it did not. Cheap models do the picking and
 * the judging; the reading is bounded by a budget the user's connection can
 * afford. Nothing is spent on a turn that does not ask for data.
 */

/** Where an answer might be, cheapest kind first. */
export type SourceKind =
  /** A widget that exists. Free when its rows are still in the query cache. */
  | "widget"
  /** The endpoint behind a widget, read with different parameters. */
  | "endpoint";

export interface Candidate {
  readonly kind: SourceKind;
  /** Workspace handle for a widget; op id for an endpoint. */
  readonly id: string;
  readonly title: string;
  /** What the records ARE, in the API's own words where it said. */
  readonly describes: string;
  readonly connection: string;
  readonly op: string;
  /** Field names, so ranking can tell a rent column from a date one. */
  readonly fields: readonly string[];
  /** True when reading this is known to cost no upstream request. */
  readonly cached: boolean;
  /** Which tab a widget sits on. Absent for a bare endpoint. */
  readonly tab?: string;
}

/**
 * How much of a source was actually looked at.
 *
 * Carried all the way to the chat bubble, because "the highest rent is 4,200"
 * and "the highest rent among the 50 records I read is 4,200" are different
 * claims and only one of them is true. `orderedBy` is null when the source has
 * no time field to sort on — in which case the honest phrasing is "the first
 * 50 this shows", never "the 50 most recent".
 */
export interface Coverage {
  readonly scanned: number;
  /** Total records where that is knowable, else null. */
  readonly of: number | null;
  readonly orderedBy: string | null;
  /** True when more records exist beyond what was read. */
  readonly partial: boolean;
  /** The time window the read was scoped to, when one applied. */
  readonly window?: { readonly start: number; readonly end: number };
}

export interface Evidence {
  readonly candidate: Candidate;
  readonly rows: readonly Record<string, unknown>[];
  readonly columns: readonly string[];
  /**
   * The columns the widget actually puts on screen, when it says.
   *
   * A tile shows six columns out of a row carrying thirty, and the thirty are
   * mostly nested objects and href URLs. When a sample has to be narrowed to
   * fit, these are what to keep: they are what the user is looking at and
   * therefore what they are asking about.
   */
  readonly shows?: readonly string[];
  readonly coverage: Coverage;
  /**
   * What the judge read out of *these* rows, and how many it matched.
   *
   * Per source rather than per turn, because a question asked across several
   * connected platforms has an answer per platform — "three here, four there"
   * — and one combined sentence cannot be attributed back to either. Absent
   * until the source has been judged.
   */
  readonly answer?: string;
  readonly matched?: number;
  /** Caveats the runtime raised — dropped joins, page caps, coercion failures. */
  readonly warnings: readonly string[];
  /** Upstream requests this cost. Zero when it came out of the cache. */
  readonly requests: number;
}

/** Why the loop stopped. */
export type HarnessOutcome =
  /** A source answered the question. */
  | "found"
  /** Something was read, but it does not fully answer it. */
  | "partial"
  /** Everything tried was read and none of it held the answer. */
  | "not-found"
  /** The budget ran out before every candidate had been tried. */
  | "exhausted"
  /** There was nothing to read at all. */
  | "no-sources";

export interface HarnessResult {
  readonly outcome: HarnessOutcome;
  readonly evidence: readonly Evidence[];
  /** Candidates looked at and rejected, so the reply can say what was tried. */
  readonly tried: readonly string[];
  /** What is still missing, in the judge's words. Empty when `found`. */
  readonly missing: string;
  /**
   * The answer the judge read out of the rows.
   *
   * Carried rather than recomputed. The judge has already been over the sample
   * to decide whether it answered the question - discarding what it found and
   * asking the writing step to re-derive it from the same rows pays twice and
   * lets the two disagree, which is how a reply comes to contradict the
   * verdict that produced it.
   */
  readonly answer: string;
  /**
   * The records the question turned out to be about, whole.
   *
   * Kept unnarrowed and separate from `evidence`, because these are what the
   * conversation becomes about: a follow-up needing a different field of the
   * same record should not need a second search, and its identifier is what
   * makes anything related reachable.
   */
  readonly matched: readonly Record<string, unknown>[];
  /** Which evidence the matches came from, so their source can be named. */
  readonly matchedFrom: Evidence | null;
  readonly spent: { readonly requests: number; readonly sources: number };
  /**
   * Things the reply is required to say, because they cost something.
   *
   * Opening a record, fanning out over several sources — anything that spends
   * a request the user did not explicitly ask for has to be stated. A lookup
   * nobody asked for and nobody was told about is the kind of cost that gets a
   * feature switched off.
   */
  readonly notes: readonly string[];
  /** True when more could be read if the user asks for it. */
  readonly canGoDeeper: boolean;
}

/**
 * What one read came back with.
 *
 * Three outcomes, not two. `null` is "nothing here" — a cache-only read that
 * missed — and carries no blame. A refusal is different: the API was asked and
 * said no, and *why* is the most useful sentence in the reply. A 403 means the
 * key works and lacks a scope, which the person can act on; folding that into
 * "could not be read" throws away the only actionable part.
 */
export type ReadOutcome =
  | {
      readonly ok: true;
      readonly body: unknown;
      readonly requests: number;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** One upstream read, through the same cache and accounting the board uses. */
export interface OpReader {
  (input: {
    readonly connection: string;
    readonly op: string;
    readonly params: Readonly<Record<string, string | number | boolean>>;
    readonly resolved: ResolvedParams;
    /**
     * When true, answer from the cache or not at all. This is what makes a
     * widget the user is looking at free to talk about.
     */
    readonly cacheOnly: boolean;
  }): Promise<ReadOutcome | null>;
}
