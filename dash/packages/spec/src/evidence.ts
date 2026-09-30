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
 * on the tile, not only in the check's records (plan, track D).
 *
 * Only what this read shows: its pages, whether the cap stopped it, and the
 * API's own count where it gave one. Null when the read was cut short, which
 * is said elsewhere, in the words that say what was left out.
 */
export const readCoverage = (
  read: { readonly pages: number; readonly truncated: boolean; readonly reportedTotal?: number | undefined },
  records: number,
): ReadCoverage | null => {
  if (read.truncated) return null;
  const n = records.toLocaleString("en-US");
  if (read.reportedTotal !== undefined && read.reportedTotal === records) {
    return {
      level: "count-reconciled",
      said: `all ${n} read`,
      detail: `All ${n} records were read — as many as the API says it holds.`,
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
