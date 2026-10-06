import { z } from "zod";
import { idSchema } from "@freebirdai/connect-spec";

/**
 * What a number means, stated.
 *
 * A total is valid arithmetic over whatever rows arrive, and the same rows
 * can answer several questions: "revenue" issued, collected or net; a count
 * of records or of the people they belong to; dollars and euros added up as
 * one. None of that shows in the number. The metric says it: what is counted
 * or added, over which records, narrowed how, dated by what, in which
 * currency, and what was checked. Compiled from the brief, deterministically,
 * and shown on the tile, so the reader can see what the number is before
 * acting on it.
 *
 * Rules come from this contract, never from a universal policy:
 * - Records are counted as they arrive. Only a declared identity at a
 *   declared grain would justify counting two rows as one, and nothing
 *   declares one yet.
 * - A currency comes from a currency field on the records, or one the request
 *   narrowed to. Nothing is assumed from a symbol.
 * - A check that relates fields (`parts` adding up to a `total`) is a
 *   question when it fails, never an error: the total may hold something the
 *   parts do not name.
 */

/** Fields that should add up to another, on each record. */
export const reconcileRuleSchema = z.object({
  /** The field the parts should add up to, e.g. `total`. */
  total: z.string().min(1).max(120),
  parts: z
    .array(
      z.object({
        field: z.string().min(1).max(120),
        /** A discount is taken away. */
        sign: z.union([z.literal(1), z.literal(-1)]).default(1),
      }),
    )
    .min(2)
    .max(8),
  /** How far apart they may be and still agree, in the total's own unit (rounding). */
  tolerance: z.number().min(0).max(1_000_000).default(0.01),
  /** `declared`: somebody stated it. `inferred`: read from the fields' names, so a mismatch is a question. */
  basis: z.enum(["declared", "inferred"]).default("inferred"),
});
export type ReconcileRule = z.infer<typeof reconcileRuleSchema>;

export const metricSchema = z.object({
  measure: z.object({
    agg: z.enum(["count", "sum"]),
    /** What is added up; absent for a count. */
    field: z.string().min(1).max(120).optional(),
    label: z.string().max(120).optional(),
  }),
  /** The record type counted or added over. */
  of: z.object({ entity: idSchema, many: z.string().min(1).max(120) }),
  /** Each narrowing, in words: "status is delivered". */
  where: z.array(z.string().min(1).max(200)).max(8).default([]),
  /** Which date decides whether a record is in the window, where the request named a time. */
  dateBasis: z.object({ field: z.string().min(1).max(120), label: z.string().max(120) }).optional(),
  /**
   * Which time the records are read over. `own`: the request named one
   * (`dateBasis`). `board`: the endpoint reads the board's time range, and the
   * request named none, so the number is only what falls in the board's range
   * — said, because "how many" reads as "ever". Absent: every
   * record, whatever the board shows.
   */
  window: z.enum(["own", "board", "all"]).optional(),
  /**
   * Where the currency comes from. `field`: each record carries it, and the
   * total says when it adds more than one. `code`: the request narrowed to one.
   * Absent: the records do not say.
   */
  currency: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("field"), field: z.string().min(1).max(120) }),
      z.object({ kind: z.literal("code"), code: z.string().min(1).max(12) }),
    ])
    .optional(),
  /**
   * The documentation says the added field is in the smallest currency unit,
   * and nothing confirmed it enough to rescale: the total is in that unit, and
   * says so.
   */
  unit: z.literal("minor").optional(),
  /** Where the number is counted by the API itself rather than from records. */
  countedBy: z.enum(["records", "api"]).default("records"),
  /** Checks on each record's fields, said on the tile when any fails. */
  checks: z.array(reconcileRuleSchema).max(4).default([]),
  /** Narrowings the request asked for that nothing here expresses, in its words. The tile says them. */
  unmet: z.array(z.string().min(1).max(160)).max(4).default([]),
  /**
   * A word in the request that reads several ways, and the reading built:
   * "revenue", read as invoiced totals. The other reading is offered beside
   * the widget, as one click.
   */
  reading: z
    .object({ term: z.string().min(1).max(60), as: z.string().min(1).max(160) })
    .optional(),
  /** All of the above, in one sentence a reader can check the number against. */
  says: z.string().min(1).max(400),
});
export type MetricDefinition = z.infer<typeof metricSchema>;

/** A metric's sentence: "Sum of Weight over Shipments whose status is delivered, dated by Delivery date." */
export const describeMetric = (metric: Omit<MetricDefinition, "says">): string => {
  const what =
    metric.measure.agg === "count"
      ? `Number of ${metric.of.many}`
      : `Sum of ${metric.measure.label ?? metric.measure.field}${metric.unit === "minor" ? " (in the smallest currency unit)" : ""} over ${metric.of.many}`;
  const where = metric.where.length > 0 ? ` whose ${metric.where.join(" and ")}` : "";
  const dated = metric.dateBasis
    ? `, dated by ${metric.dateBasis.label}`
    : metric.window === "board"
      ? ", within the board's time range"
      : metric.window === "all"
        ? ", over all time"
        : "";
  const money =
    metric.currency?.kind === "code"
      ? `, in ${metric.currency.code}`
      : metric.currency?.kind === "field"
        ? `, in each record's own currency`
        : "";
  const by = metric.countedBy === "api" ? ", as the API counts them" : "";
  const read = metric.reading ? `"${metric.reading.term}" read as ${metric.reading.as}: ` : "";
  const unmet = metric.unmet.length > 0 ? ` It does not leave out: ${metric.unmet.join("; ")}.` : "";
  return `${read}${what}${where}${dated}${money}${by}.${unmet}`.slice(0, 400);
};
