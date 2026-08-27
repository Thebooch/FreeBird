import type { WidgetSpec } from "@freebirdai/dash-spec";
import { widgetSources } from "@freebirdai/dash-spec";
import { compileWidget } from "./compile.js";
import { runPipeline } from "./run.js";
import type { CompileError, CompiledWidget, Row, RunContext, RunResult } from "./types.js";

/**
 * A widget that reads more than one endpoint.
 *
 * The runtime stays pure and synchronous: it never fetches. The caller resolves
 * each named source into a response body and hands over a map of them, exactly
 * as it already hands over one body for a single-source widget. That keeps all
 * I/O at the edges, keeps the shared query cache in charge of deduplication,
 * and keeps every step visible to the inspector.
 */

export interface CompiledPlan {
  readonly widget: CompiledWidget;
  /** Per-source shaping, compiled. Empty for a single-source widget. */
  readonly sources: ReadonlyArray<{ readonly as: string; readonly compiled: CompiledWidget }>;
}

export type CompilePlanResult =
  | { readonly ok: true; readonly plan: CompiledPlan }
  | { readonly ok: false; readonly errors: readonly CompileError[] };

/**
 * Compile the widget pipeline and each source's own pipeline.
 *
 * A source is compiled as a widget in its own right, because a per-source
 * pipeline is an ordinary pipeline — same steps, same validation, same
 * one-extract-at-index-0 rule. Nothing new has to be taught about them.
 */
export const compilePlan = (spec: WidgetSpec): CompilePlanResult => {
  const errors: CompileError[] = [];

  const main = compileWidget(spec);
  if (!main.ok) errors.push(...main.errors);

  const sources: Array<{ as: string; compiled: CompiledWidget }> = [];
  for (const source of spec.sources) {
    const result = compileWidget({
      ...spec,
      id: `${spec.id}__${source.as}`,
      pipeline: source.pipeline,
      // Roles are validated against the *joined* columns, not a single
      // source's, so they are deliberately dropped here.
      roles: {},
      sources: [],
      source: { connection: source.connection, op: source.op, params: source.params },
    });
    if (!result.ok) {
      errors.push(
        ...result.errors.map((error) => ({
          ...error,
          message: `source "${source.as}": ${error.message}`,
        })),
      );
      continue;
    }
    sources.push({ as: source.as, compiled: result.widget });
  }

  if (errors.length > 0 || !main.ok) return { ok: false, errors };
  return { ok: true, plan: { widget: main.widget, sources } };
};

/**
 * Merge a right-hand row into a left-hand one.
 *
 * Right columns are always prefixed, never conditionally. A shape that depends
 * on whether two field names happened to collide cannot be written against
 * with any confidence, and the collision would be silent.
 */
const merge = (left: Row, right: Row | null, rightAs: string, rightKeys: readonly string[]): Row => {
  const out: Row = { ...left };
  for (const key of rightKeys) out[`${rightAs}_${key}`] = right ? (right[key] ?? null) : null;
  return out;
};

/** Every column name any row in the set carries, in first-seen order. */
const keysOf = (rows: readonly Row[]): string[] => {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) keys.add(key);
  return [...keys];
};

export interface JoinResult {
  readonly rows: Row[];
  readonly warnings: string[];
}

/**
 * Join two row sets on one field each.
 *
 * `left` keeps every left row whether or not it matched; `inner` keeps only
 * matches. A left row matching several right rows produces one output row per
 * match, which is ordinary relational behaviour and is reported, because it is
 * the one case where a join silently multiplies a total someone is about to
 * read as a count.
 */
export const joinRows = (
  left: readonly Row[],
  right: readonly Row[],
  options: {
    leftField: string;
    rightField: string;
    rightAs: string;
    kind: "inner" | "left";
    maxRows: number;
  },
): JoinResult => {
  const warnings: string[] = [];
  const rightKeys = keysOf(right);

  const index = new Map<string, Row[]>();
  for (const row of right) {
    const value = row[options.rightField];
    if (value === undefined || value === null) continue;
    const key = String(value);
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }

  const rows: Row[] = [];
  let unmatched = 0;
  let multiplied = 0;

  for (const row of left) {
    const value = row[options.leftField];
    const matches = value === undefined || value === null ? [] : (index.get(String(value)) ?? []);

    if (matches.length === 0) {
      unmatched++;
      if (options.kind === "left") rows.push(merge(row, null, options.rightAs, rightKeys));
      continue;
    }
    if (matches.length > 1) multiplied++;
    for (const match of matches) {
      if (rows.length >= options.maxRows) break;
      rows.push(merge(row, match, options.rightAs, rightKeys));
    }
    if (rows.length >= options.maxRows) {
      warnings.push(`the join produced more than ${options.maxRows} rows and was cut short`);
      break;
    }
  }

  if (unmatched > 0) {
    warnings.push(
      options.kind === "left"
        ? `${unmatched} row(s) had no match on "${options.rightField}" and were kept with empty ${options.rightAs} columns`
        : `${unmatched} row(s) had no match on "${options.rightField}" and were dropped`,
    );
  }
  if (multiplied > 0) {
    warnings.push(
      `${multiplied} row(s) matched more than one ${options.rightAs} record, so they appear more than once`,
    );
  }

  return { rows, warnings };
};

const DEFAULT_MAX_ROWS = 50_000;

/**
 * Run a multi-source widget: shape each source, join, then run the widget's
 * own pipeline over the result.
 *
 * `bodies` is keyed by each source's `as`. A missing body is treated as empty
 * rather than throwing, so one failed endpoint degrades the widget instead of
 * blanking it — and the warning says which one.
 */
export const runPlan = (
  plan: CompiledPlan,
  bodies: Readonly<Record<string, unknown>>,
  ctx: RunContext,
): RunResult => {
  const spec = plan.widget.spec;
  const warnings: string[] = [];
  const steps: Array<RunResult["meta"]["steps"][number]> = [];
  let coercionFailures = 0;
  let rowsIn = 0;

  // 1. Each source is shaped on its own, through the ordinary pipeline runner.
  const shaped = new Map<string, Row[]>();
  for (const source of plan.sources) {
    const body = bodies[source.as];
    if (body === undefined) {
      warnings.push(`"${source.as}" returned nothing`);
      shaped.set(source.as, []);
      continue;
    }
    const result = runPipeline(source.compiled, body, ctx);
    shaped.set(source.as, [...result.rows]);
    rowsIn += result.meta.rowsIn;
    coercionFailures += result.meta.coercionFailures;
    warnings.push(...result.meta.warnings.map((w) => `${source.as}: ${w}`));
    steps.push(
      ...result.meta.steps.map((step) => ({ ...step, op: `${source.as}.${step.op}` })),
    );
  }

  // 2. Combine.
  let rows: Row[] = [];
  const combine = spec.combine;
  if (combine?.op === "union") {
    /*
     * Stack every source's rows and write in where each came from.
     *
     * Order follows `sources`, so a legend reads in the order the widget was
     * written rather than in whatever order the fetches happened to settle —
     * two runs of the same widget should not swap the series around.
     *
     * The label is written unconditionally, overwriting any column of the same
     * name a pipeline produced. A row that says it came from two places is
     * worse than one whose stray column got replaced, and the alternative is
     * silently keeping the wrong provenance.
     */
    const labelled: Row[] = [];
    for (const source of plan.sources) {
      const declared = spec.sources.find((candidate) => candidate.as === source.as);
      /*
       * A source fetched only to drive a fan-out is not one of the things
       * being measured, so it contributes no rows. Stacking it anyway drew a
       * third series nobody asked for, measuring something else entirely.
       */
      if (declared?.hidden) continue;
      const label = declared?.label ?? source.as;
      for (const row of shaped.get(source.as) ?? []) {
        labelled.push({ ...row, [combine.as]: label });
      }
    }
    rows = labelled;
    steps.push({
      op: "union",
      rowsIn: labelled.length,
      rowsOut: labelled.length,
      note: `${plan.sources.length} source(s) tagged in "${combine.as}"`,
    });
  } else if (combine) {
    const left = shaped.get(combine.left) ?? [];
    const right = shaped.get(combine.right) ?? [];
    const joined = joinRows(left, right, {
      leftField: combine.on.left,
      rightField: combine.on.right,
      rightAs: combine.right,
      kind: combine.kind,
      maxRows: ctx.maxRows ?? DEFAULT_MAX_ROWS,
    });
    rows = joined.rows;
    warnings.push(...joined.warnings);
    steps.push({
      op: "join", rowsIn: left.length, rowsOut: rows.length, note: `${combine.left}.${combine.on.left} = ${combine.right}.${combine.on.right}` });
  } else {
    rows = shaped.get(plan.sources[0]?.as ?? "") ?? [];
  }

  // 3. The widget's own pipeline runs over the joined rows. Feeding them back
  //    in as a body works because seeding already accepts an array.
  const final = runPipeline(plan.widget, rows, ctx);

  /*
   * Highlights come back from that final `runPipeline` already evaluated
   * against the *joined* rows — the only point at which the widget's real
   * shape exists, which is the same reason `validateBinding` waits until here.
   */
  return {
    rows: final.rows,
    columns: final.columns,
    meta: {
      steps: [...steps, ...final.meta.steps],
      warnings: [...warnings, ...final.meta.warnings],
      coercionFailures: coercionFailures + final.meta.coercionFailures,
      rowsIn,
      rowsOut: final.rows.length,
      ...(final.meta.highlightCounts ? { highlightCounts: final.meta.highlightCounts } : {}),
    },
    ...(final.highlights ? { highlights: final.highlights } : {}),
  };
};

/** Which endpoints this widget reads, single- or multi-source alike. */
export const planSources = widgetSources;
