import { z } from "zod";
import { aggregationSchema } from "./semantics.js";
import { grainSchema } from "./params.js";
import { validateExpressionSource, type PipelineStep } from "./pipeline.js";

/**
 * What a widget measures, over what buckets, filtered how.
 *
 * The piece that was missing. Everything above the runtime could say *which
 * endpoint* and *which fields*, and nothing could say *what shape* — so
 * "how many listings per month" was inexpressible while "the sum of their rent
 * per month" was not. The system could state the wrong answer and not the
 * right one.
 *
 * Three properties make this worth being its own concept rather than more
 * fields on the draft:
 *
 * **It is one grammar, not a second one.** The filter is checked by the same
 * `validateExpressionSource` a pipeline filter is; the bucket is the same
 * `grainSchema` a group key already takes; the aggregations are the set
 * `parseAggregation` already parses. Nothing here is a new language, so
 * nothing here can drift from what the runtime executes.
 *
 * **It is emitted once.** `shapeSteps` is the only thing that turns a shape
 * into pipeline steps, and both the preview and the saved widget go through
 * it. The three progressively narrower re-implementations that used to sit
 * between the model and the runtime were each losing expressiveness in a
 * different place.
 *
 * **It is stored.** A shape on the draft is a shape on the widget: saved,
 * inspectable, and editable as one control per decision. "Count the records,
 * bucket them by the date they were created, monthly" stops being something
 * that happened once during a conversation and becomes a property of the thing
 * that was built.
 */

/** A field name, in the same restricted alphabet the pipeline uses. */
const fieldNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "field names must be [a-zA-Z_][a-zA-Z0-9_]*");

/**
 * One axis the rows are grouped along.
 *
 * `bucket` may be a literal grain or the `{{range.grain}}` token, which is what
 * makes a chart follow the dashboard's own grain control rather than pinning
 * itself to whatever was chosen the day it was built.
 */
export const groupByShapeSchema = z.object({
  field: fieldNameSchema,
  bucket: z.union([grainSchema, z.string().regex(/^\{\{.*\}\}$/)]).optional(),
  /** Name of the produced column. Defaults to the field's own name. */
  as: fieldNameSchema.optional(),
});

export type GroupByShape = z.infer<typeof groupByShapeSchema>;

/**
 * One number the rows are reduced to.
 *
 * `field` is required for every aggregation except `count`, and that single
 * rule is the whole of what made counting impossible. Counting rows is what
 * "how many" means; it takes no column, and a schema that demanded one forced
 * every such request to name the nearest number instead — which is a confident,
 * beautiful, wrong answer to a question nobody asked.
 */
export const measureShapeSchema = z
  .object({
    /** The column this produces, and what a role binds to. */
    as: fieldNameSchema,
    agg: aggregationSchema,
    /** The column being aggregated. Omitted only for a plain row count. */
    field: fieldNameSchema.optional(),
    /** What to call it on screen, when the column name is not the answer. */
    label: z.string().min(1).max(80).optional(),
  })
  .superRefine((measure, ctx) => {
    if (measure.agg !== "count" && !measure.field) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${measure.agg}() needs a field to aggregate; only count() may omit one`,
        path: ["field"],
      });
    }
  });

export type MeasureShape = z.infer<typeof measureShapeSchema>;

export const widgetShapeSchema = z.object({
  /**
   * Rows to keep, as an expression in the pipeline's own language.
   *
   * This is where "active listings" lives — a request that used to be dropped
   * silently between the model proposing it and the draft being unable to hold
   * it.
   */
  filter: z.string().min(1).max(400).optional(),
  /**
   * Two at most. One axis and one series is what every chart here can draw;
   * a third grouping produces rows no component has a role for.
   */
  groupBy: z.array(groupByShapeSchema).max(2).default([]),
  measures: z.array(measureShapeSchema).max(4).default([]),
  sort: z
    .array(z.object({ field: fieldNameSchema, dir: z.enum(["asc", "desc"]).default("asc") }))
    .max(2)
    .default([]),
  limit: z.number().int().min(1).max(10_000).optional(),
});

export type WidgetShape = z.infer<typeof widgetShapeSchema>;

/** Nothing to do: no filter, no grouping, no measure. */
export const isEmptyShape = (shape: WidgetShape | undefined): boolean =>
  !shape ||
  (!shape.filter &&
    shape.groupBy.length === 0 &&
    shape.measures.length === 0 &&
    shape.sort.length === 0 &&
    shape.limit === undefined);

/** The column a group key produces, which is what a role has to bind to. */
export const groupColumn = (key: GroupByShape): string => key.as ?? key.field;

/**
 * A shape as pipeline steps. **The only place this translation happens.**
 *
 * Deliberately dull, and deliberately in `@freebirdai/dash-spec` rather than in the agent:
 * the preview built during a proposal and the widget written on confirm both
 * come through here, and when they were two separate constructions they
 * disagreed about whether a count was even possible.
 *
 * Emits nothing for an empty shape, so a widget that simply lists rows is
 * untouched — the shape is additive, and absent means exactly today's
 * behaviour.
 */
export const shapeSteps = (shape: WidgetShape | undefined): PipelineStep[] => {
  if (!shape || isEmptyShape(shape)) return [];
  const steps: PipelineStep[] = [];

  if (shape.filter) steps.push({ op: "filter", where: shape.filter });

  /*
   * A measure without a grouping still needs one: totalling every row is
   * grouping on a constant, which is how the pipeline expresses "all of them"
   * without a special case. `mapProposal` already did this for a stat; doing
   * it here means every component gets it.
   */
  if (shape.measures.length > 0) {
    const agg: Record<string, string> = {};
    for (const measure of shape.measures) {
      agg[measure.as] = measure.field ? `${measure.agg}(${measure.field})` : `${measure.agg}()`;
    }

    if (shape.groupBy.length > 0) {
      steps.push({
        op: "group",
        by: shape.groupBy.map((key) => ({
          field: key.field,
          ...(key.bucket ? { bucket: key.bucket } : {}),
          ...(key.as ? { as: key.as } : {}),
        })),
        agg,
      });
    } else {
      steps.push({ op: "derive", fields: { _all: "1" } });
      steps.push({ op: "group", by: [{ field: "_all" }], agg });
    }
  } else if (shape.groupBy.length > 0) {
    /*
     * Grouping with nothing to measure is still meaningful — it is how you ask
     * for the distinct values of something — so it counts, which is the answer
     * to "how many of each" whether or not anybody said the word.
     */
    steps.push({
      op: "group",
      by: shape.groupBy.map((key) => ({
        field: key.field,
        ...(key.bucket ? { bucket: key.bucket } : {}),
        ...(key.as ? { as: key.as } : {}),
      })),
      agg: { count: "count()" },
    });
  }

  if (shape.sort.length > 0) {
    steps.push({ op: "sort", by: shape.sort.map((key) => ({ field: key.field, dir: key.dir })) });
  }
  if (shape.limit !== undefined) steps.push({ op: "limit", count: shape.limit, from: "start" });

  return steps;
};

/**
 * The roles a shape decides, so nobody is asked about them.
 *
 * This is the other half of the fix. A role binds to a *column*, and a count is
 * not a column until the group step above creates one — so the question "which
 * field should be the value?" was unanswerable for a counting widget, and the
 * machine asked it anyway, offering whichever numbers happened to be on the
 * endpoint.
 *
 * A bucketed group key is a time axis; a plain one is a category. The first
 * measure is the value. A second group key splits the series, and where the
 * rows were stacked from several sources instead, `seriesColumn` names the
 * column carrying the label.
 */
export const rolesForShape = (
  shape: WidgetShape | undefined,
  seriesColumn?: string,
): Readonly<Record<string, string>> => {
  if (!shape || (shape.groupBy.length === 0 && shape.measures.length === 0)) return {};

  const roles: Record<string, string> = {};
  const [first, second] = shape.groupBy;

  if (first) {
    if (first.bucket) roles.time = groupColumn(first);
    else roles.category = groupColumn(first);
  }
  const measure = shape.measures[0];
  if (measure) roles.value = measure.as;
  else if (shape.groupBy.length > 0) roles.value = "count";

  /*
   * A source label wins over a second group key. Both would split the chart,
   * and when rows have been stacked from several endpoints the split that
   * matters is which endpoint they came from — that is the whole point of the
   * comparison.
   */
  if (seriesColumn) roles.series = seriesColumn;
  else if (second) roles.series = groupColumn(second);

  return roles;
};

/**
 * Whether a shape names only fields the endpoint really has.
 *
 * Executability, never meaning — the same line every other validation in this
 * codebase draws. Whether counting by `CreatedDate` answers what somebody
 * meant is a question about the request, and the honest way to answer it is to
 * render the thing and let them look.
 *
 * The produced columns are in scope for `sort`, because sorting by the bucket
 * or by the measure is the ordinary case and neither exists on the raw rows.
 */
export const shapeProblems = (
  shape: WidgetShape,
  available: readonly string[],
): string[] => {
  const known = new Set(available);
  const problems: string[] = [];

  if (shape.filter) {
    const error = validateExpressionSource(shape.filter);
    if (error) problems.push(`the filter does not parse: ${error}`);
  }

  for (const key of shape.groupBy) {
    if (!known.has(key.field)) problems.push(`"${key.field}" is not a field on these rows`);
  }
  for (const measure of shape.measures) {
    if (measure.field && !known.has(measure.field)) {
      problems.push(`"${measure.field}" is not a field on these rows`);
    }
    if (measure.agg !== "count" && !measure.field) {
      problems.push(`${measure.agg}() needs a field to aggregate`);
    }
  }

  const produced = new Set<string>([
    ...shape.groupBy.map(groupColumn),
    ...shape.measures.map((measure) => measure.as),
    ...(shape.measures.length === 0 && shape.groupBy.length > 0 ? ["count"] : []),
  ]);
  for (const key of shape.sort) {
    if (!known.has(key.field) && !produced.has(key.field)) {
      problems.push(`"${key.field}" is neither a field on these rows nor something this produces`);
    }
  }

  return problems;
};
