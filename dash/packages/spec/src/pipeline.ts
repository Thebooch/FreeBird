import { parseExpr, parsePath } from "@freebirdai/dash-expr";
import { z } from "zod";
import { parseAggregation } from "./aggregation.js";
import { coercionSchema } from "./coercion.js";
import { grainSchema } from "./params.js";
import { semanticTypeSchema } from "./semantics.js";

const fieldNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "field names must be [a-zA-Z_][a-zA-Z0-9_]*");

/**
 * Expressions and bucket grains may carry `{{…}}` params. To validate the
 * syntax around them we substitute a neutral literal first — `created >=
 * {{range.start}}` has to parse as an expression, and it does once the token
 * becomes a number.
 */
const TOKEN_PROBE = /\{\{[^{}]*\}\}/g;

export const validateExpressionSource = (source: string): string | null => {
  try {
    parseExpr(source.replace(TOKEN_PROBE, "0"));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * Draw attention to rows that need it.
 *
 * A core property of any widget rather than a feature of one component: the
 * question "which of these needs looking at?" is asked of a table, a record
 * and a feed alike, and answering it three different ways is how the three
 * come to disagree.
 *
 * `label` is required, and that is not a stylistic choice. A tone renders as a
 * colour, and a reader who cannot distinguish those colours — or is printing,
 * or is in forced-colours mode — gets nothing from a bare tint. The label is
 * the channel that always survives; the colour is the one that speeds it up.
 */
export const highlightSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, "ids must be [a-zA-Z0-9_-]"),
    /** A predicate over a finished row. Same language as `filter.where`. */
    when: z.string().min(1).max(400),
    tone: z.enum(["good", "warning", "serious", "critical", "neutral"]),
    label: z.string().min(1).max(60),
    /** Tint the whole row, or mark one field of it. */
    scope: z.enum(["row", "field"]).default("row"),
    field: fieldNameSchema.optional(),
  })
  .superRefine((highlight, ctx) => {
    const error = validateExpressionSource(highlight.when);
    if (error) ctx.addIssue({ code: "custom", message: error, path: ["when"] });
    if (highlight.scope === "field" && !highlight.field) {
      ctx.addIssue({
        code: "custom",
        message: "a field-scoped highlight needs a field",
        path: ["field"],
      });
    }
  });

export type HighlightSpec = z.infer<typeof highlightSchema>;

export const validatePathSource = (source: string): string | null => {
  try {
    parsePath(source);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

export const extractStepSchema = z.object({
  op: z.literal("extract"),
  path: z.string().min(1),
});

export const coerceStepSchema = z.object({
  op: z.literal("coerce"),
  fields: z.record(fieldNameSchema, coercionSchema),
});

export const filterStepSchema = z.object({
  op: z.literal("filter"),
  where: z.string().min(1),
});

export const deriveStepSchema = z.object({
  op: z.literal("derive"),
  fields: z.record(fieldNameSchema, z.string().min(1)),
});

export const groupKeySchema = z.object({
  field: fieldNameSchema,
  /** A grain literal or `{{range.grain}}`. Omit for a plain categorical key. */
  bucket: z.union([grainSchema, z.string().regex(/^\{\{.*\}\}$/)]).optional(),
  /** Name of the produced column. Defaults to `field`. */
  as: fieldNameSchema.optional(),
});

export const groupStepSchema = z.object({
  op: z.literal("group"),
  by: z.array(groupKeySchema).min(1),
  agg: z.record(fieldNameSchema, z.string().min(1)),
  /**
   * Emit empty buckets between the first and last point so a gap in the data
   * reads as a gap rather than as a straight line across it.
   */
  fillGaps: z.boolean().optional(),
});

export const sortStepSchema = z.object({
  op: z.literal("sort"),
  by: z
    .array(
      z.object({
        field: fieldNameSchema,
        dir: z.enum(["asc", "desc"]).default("asc"),
      }),
    )
    .min(1),
});

export const limitStepSchema = z.object({
  op: z.literal("limit"),
  count: z.number().int().min(1).max(10_000),
  /** Keep the last N instead of the first N. */
  from: z.enum(["start", "end"]).default("start"),
});

export const renameStepSchema = z.object({
  op: z.literal("rename"),
  fields: z.record(fieldNameSchema, fieldNameSchema),
});

export const selectStepSchema = z.object({
  op: z.literal("select"),
  fields: z.array(fieldNameSchema).min(1),
});

export const annotateStepSchema = z.object({
  op: z.literal("annotate"),
  /** Pin a column's semantic type when the guess would be wrong. */
  fields: z.record(fieldNameSchema, semanticTypeSchema),
});

export const pipelineStepSchema = z.discriminatedUnion("op", [
  extractStepSchema,
  coerceStepSchema,
  filterStepSchema,
  deriveStepSchema,
  groupStepSchema,
  sortStepSchema,
  limitStepSchema,
  renameStepSchema,
  selectStepSchema,
  annotateStepSchema,
]);

export type PipelineStep = z.infer<typeof pipelineStepSchema>;
export type ExtractStep = z.infer<typeof extractStepSchema>;
export type GroupStep = z.infer<typeof groupStepSchema>;

/**
 * The step list, with every embedded expression, path and aggregation parsed
 * at validation time. A spec that survives this cannot fail to compile later
 * — which is what makes the agent's repair loop converge on something real
 * rather than on something that merely looks plausible.
 */
export const pipelineSchema = z.array(pipelineStepSchema).superRefine((steps, ctx) => {
  steps.forEach((step, index) => {
    switch (step.op) {
      case "extract": {
        const error = validatePathSource(step.path);
        if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error, path: [index, "path"] });
        break;
      }
      case "filter": {
        const error = validateExpressionSource(step.where);
        if (error) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: error, path: [index, "where"] });
        }
        break;
      }
      case "derive": {
        for (const [name, source] of Object.entries(step.fields)) {
          const error = validateExpressionSource(source);
          if (error) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: error,
              path: [index, "fields", name],
            });
          }
        }
        break;
      }
      case "group": {
        for (const [name, source] of Object.entries(step.agg)) {
          if (!parseAggregation(source)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `"${source}" is not an aggregation — expected sum(field), avg(field), count(), countDistinct(field), min/max/first/last(field)`,
              path: [index, "agg", name],
            });
          }
        }
        break;
      }
      default:
        break;
    }
  });

  const extracts = steps.filter((step) => step.op === "extract");
  if (extracts.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a pipeline can only extract once",
      path: [steps.findIndex((step, i) => step.op === "extract" && i > 0)],
    });
  }
  if (extracts.length === 1 && steps[0]?.op !== "extract") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "extract must be the first step",
      path: [steps.findIndex((step) => step.op === "extract")],
    });
  }
});
