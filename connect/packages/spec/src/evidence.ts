import { z } from "zod";
import { idSchema, paginationSchema } from "./primitives.js";

/**
 * What has been shown about reading an endpoint, and no more than that.
 *
 * A single "verified" or "complete" flag claims more than any one observation
 * supports. A page that advanced proves one continuation worked, not that the
 * last page will be reached; reaching an end proves the rule stopped, not
 * that it stopped in the right place. So each claim is one rung of a ladder,
 * recorded with the scope it was observed under, the configuration it was
 * observed with, when, and the limits it ran within. See `dash/RELIABILITY.md`.
 */

export const EVIDENCE_LEVELS = [
  /** This request was accepted. */
  "accepted",
  /** This continuation returned different records. */
  "advanced",
  /** The configured continuation rule reached an end. */
  "traversed",
  /** The records retrieved match a count stated under the same scope. */
  "count-reconciled",
  /** A calculation matches an independent expected result. */
  "metric-reconciled",
] as const;

export const evidenceLevelSchema = z.enum(EVIDENCE_LEVELS);
export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;

export const evidenceSchema = z.object({
  /** The workspace it belongs to. One `local` workspace in the open-source build. */
  workspace: z.string().min(1).max(64).default("local"),
  connection: idSchema,
  op: z.string().min(1).max(200),
  level: evidenceLevelSchema,
  /** What was asked: the request's inputs, never a credential. */
  scope: z
    .object({
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      /** The account, when the connection has an address with blanks. */
      account: z.string().max(200).optional(),
      /**
       * The read's whole scope as a digest — address, inputs, filters, range
       * (`resolveReadRequest`). A count proves something only about records
       * read under the same one.
       */
      digest: z.string().max(64).optional(),
    })
    .default({}),
  /** `fingerprintConnection` of the configuration it was observed with. */
  configVersion: z.string().min(1).max(64),
  at: z.string().datetime(),
  /** What it ran within: a claim under a page cap is a claim about those pages. */
  limits: z
    .object({
      pages: z.number().int().min(0),
      maxPages: z.number().int().min(0),
      requests: z.number().int().min(0),
    })
    .default({ pages: 0, maxPages: 0, requests: 0 }),
  /** What was seen. Counts and settings, never values from the account. */
  observed: z
    .object({
      rows: z.number().int().min(0).optional(),
      reportedTotal: z.number().int().min(0).optional(),
      pagination: paginationSchema.optional(),
      note: z.string().max(400).optional(),
    })
    .default({}),
  /** What produced it. */
  by: z.enum(["probe", "integrate", "read", "reconcile"]),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const evidenceRank = (level: EvidenceLevel): number => EVIDENCE_LEVELS.indexOf(level);

/**
 * The strongest claim still standing for one endpoint.
 *
 * Only evidence gathered with the connection's current configuration counts:
 * a page that advanced under an old address or old credentials says nothing
 * about this one.
 */
export const strongestEvidence = (
  records: readonly Evidence[],
  configVersion: string,
): Evidence | null => {
  let best: Evidence | null = null;
  for (const record of records) {
    if (record.configVersion !== configVersion) continue;
    if (!best || evidenceRank(record.level) > evidenceRank(best.level)) best = record;
  }
  return best;
};

/** What a level means, in words a person reading a tile can act on. */
export const EVIDENCE_WORDS: Record<EvidenceLevel, string> = {
  accepted: "The API answered this request.",
  advanced: "Reading on to the next page returned different records.",
  traversed: "Reading reached the last page.",
  "count-reconciled": "Every record the API says it holds was read.",
  "metric-reconciled": "This number matches one worked out independently.",
};

/**
 * How a read ended, as the reader of it saw it happen.
 *
 * `traversed`: the read reached the end its rule defines — the last page, a
 * single answer the endpoint gives whole, code that says it read everything.
 * `partial`: something stopped it first, and it says what. `unknown`: nothing
 * says either way — paging never confirmed, or connector code that returned
 * records without saying whether they were all of them. Never a claim the
 * read cannot back: only `traversed` lets a tile say a read went to the
 * end.
 */
export type CompletionState = "traversed" | "partial" | "unknown";

export type CompletionReason =
  /* traversed */
  | "single-response"
  | "empty-page"
  | "short-page"
  | "no-cursor"
  | "has-more-false"
  | "no-next"
  | "past-last-page"
  | "windows-covered"
  | "connector-all"
  /** A read made once per record of another endpoint, every part read to its end. */
  | "each-read"
  /* partial */
  | "each-capped"
  /** A read made once per record of another endpoint, some of whose parts the API would not answer. */
  | "each-failed"
  | "page-cap"
  | "later-page-refused"
  | "repeated-page"
  | "rows-missing"
  | "unmerged"
  | "stream-window"
  | "reported-more"
  /** The answer itself says there is more — `isLast: false`, a next token — and nothing read it. */
  | "said-more"
  | "connector-partial"
  | "run-limit"
  /* unknown */
  | "unconfirmed-paging"
  | "connector-silent"
  | "each-unsure";

export interface ReadCompletion {
  readonly state: CompletionState;
  readonly reason: CompletionReason;
}

/** What a read says about itself, as far as how much of it there is. */
export interface ReadExtent {
  readonly pages: number;
  readonly truncated: boolean;
  readonly reportedTotal?: number | undefined;
  readonly completion?: ReadCompletion | undefined;
  /** What the read asked for, as a digest: see `resolveReadRequest`. */
  readonly scope?: string | undefined;
  /** The scope the stated total was given under, when it was given under this read's own. */
  readonly totalScope?: string | undefined;
}

/**
 * Whether every record the API says it holds was read: the count matches,
 * nothing cut the read short or left its end unsaid, and the count was stated
 * under the read's own scope — the same filters, account and range. A total
 * of every order is no evidence about a read of last month's.
 */
export const countReconciled = (read: ReadExtent, records: number): boolean =>
  !read.truncated &&
  read.completion?.state !== "partial" &&
  read.completion?.state !== "unknown" &&
  read.reportedTotal !== undefined &&
  read.reportedTotal === records &&
  (read.scope === undefined || read.totalScope === read.scope);

/** How far one read of a tile got, from what the read itself shows. */
export interface ReadCoverage {
  readonly level: Extract<EvidenceLevel, "accepted" | "traversed" | "count-reconciled">;
  /** A few words for beside a row count. */
  readonly said: string;
  /** The whole claim, and the limit of it, for a title or a reader who asks. */
  readonly detail: string;
}

/**
 * The strongest claim a tile's own read supports, in plain words — the ladder
 * on the tile, not only in the check's records.
 *
 * Only what this read shows: how it ended, its pages, and the API's own count
 * where it gave one under the same scope. Null when the read was cut short or
 * cannot say where it ended — each says so elsewhere, in the words that say
 * what may be missing.
 */
export const readCoverage = (read: ReadExtent, records: number): ReadCoverage | null => {
  if (read.truncated || read.completion?.state === "partial" || read.completion?.state === "unknown") return null;
  const n = records.toLocaleString("en-US");
  if (countReconciled(read, records)) {
    return {
      level: "count-reconciled",
      said: `all ${n} read`,
      detail: `All ${n} records were read — as many as the API says it holds.`,
    };
  }
  if (read.completion?.reason === "connector-all") {
    return {
      level: "traversed",
      said: "read to the end",
      detail: `The connector read to the end, by its own account: ${n} records. The API did not say how many it holds, so nothing checks the count.`,
    };
  }
  if (read.pages > 1) {
    return {
      level: "traversed",
      said: "every page read",
      detail: `Every page was read, to the last: ${n} records. The API did not say how many it holds, so nothing checks the count.`,
    };
  }
  return {
    level: "accepted",
    said: "read in one request",
    detail: "Read in one request. Nothing in the answer says whether the API holds more.",
  };
};
