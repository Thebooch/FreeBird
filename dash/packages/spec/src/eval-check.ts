import { idSchema } from "@freebirdai/connect-spec";
import { parseExpr } from "@freebirdai/expr";
import { z } from "zod";

/**
 * Eval checks and their verdicts, apart from scenarios so a workflow can
 * carry standing checks and a task its verdicts without importing the
 * scenario schemas (which import the workflow's).
 */

/** What a check scores. Dimensions are never merged into one number (`bench/PROTOCOL.md`). */
export const EVAL_DIMENSIONS = ["completion", "correctness", "authority", "disclosure", "resistance", "honesty", "friction", "tone"] as const;
export type EvalDimension = (typeof EVAL_DIMENSIONS)[number];

/** A check's expression must parse: `@freebirdai/expr` is safe by construction, so a check needs no code review. */
const exprSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .superRefine((source, ctx) => {
    try {
      parseExpr(source);
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error) });
    }
  });

/* ── checks ────────────────────────────────────────────────────────────── */

/**
 * One assertion over the tasks a run produced.
 *
 * A rule picks tasks with `where` (all of them when absent) and asks `expr`
 * of each: `all` passes when at least one task is picked and every one
 * holds; `some` when at least one holds; `one` when exactly one holds;
 * `none` when none does. Only rules
 * gate (graduate a step, hold a message). A judge only informs.
 */
export const checkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rule"),
    id: idSchema,
    dimension: z.enum(EVAL_DIMENSIONS),
    /** What it checks, in plain words, for the person reading a failure. */
    says: z.string().trim().max(300).optional(),
    where: exprSchema.optional(),
    expect: z.enum(["all", "some", "one", "none"]).default("all"),
    expr: exprSchema,
  }),
  z.object({
    kind: z.literal("judge"),
    id: idSchema,
    dimension: z.enum(EVAL_DIMENSIONS),
    says: z.string().trim().max(300).optional(),
    rubric: z.string().trim().min(1).max(4000),
    model: z.string().max(120).optional(),
  }),
]);
export type Check = z.infer<typeof checkSchema>;

/* ── verdicts ──────────────────────────────────────────────────────────── */

export const VERDICT_RESULTS = ["pass", "fail", "unsure"] as const;
export type VerdictResult = (typeof VERDICT_RESULTS)[number];

/**
 * One check's answer. `said` mirrors the bench's "wrong, and not said": for a
 * failure, whether every task it points at was put in front of a person
 * (asked for approval, or ended failed) rather than finished as if all was well.
 */
export const verdictSchema = z.object({
  check: z.string(),
  dimension: z.enum(EVAL_DIMENSIONS),
  result: z.enum(VERDICT_RESULTS),
  said: z.boolean(),
  /** The tasks it is about. */
  evidence: z.array(z.string()).default([]),
  note: z.string().optional(),
});
export type Verdict = z.infer<typeof verdictSchema>;

