import { executeWidget } from "@freebirdai/dash-runtime";
import type { ResolvedParams, WidgetSpec } from "@freebirdai/dash-spec";
import { interpolateValue, widgetSources } from "@freebirdai/dash-spec";
import type { Candidate, Coverage, Evidence, OpReader } from "./types.js";

/**
 * Reading a source, bounded.
 *
 * A widget is read by running the widget: same spec, same runtime, same
 * pipeline the browser runs, so what the assistant talks about is what the
 * tile shows rather than a second interpretation of the same endpoint. The
 * server's query cache is keyed identically to the browser's, so a widget the
 * user has been looking at costs nothing to read.
 */

/** What one dump hands to the model, and what the bubble says it read. */
export const PAGE_SIZE = 50;

/**
 * Fan-out sources are deliberately not driven here.
 *
 * A fan-out is one request per row of another source — capped at 25, but 25 is
 * already three times the whole harness budget. `runPlan` treats a source with
 * no body as empty and says so in its warnings, so skipping them degrades the
 * read and reports it rather than silently pretending. If somebody needs that
 * data, "dig deeper" is the place to spend it.
 */
const isDirect = (source: { fanOut?: unknown }): boolean => !source.fanOut;

/**
 * Dates as dates, not as the numbers the pipeline turned them into.
 *
 * A `coerce` step normalises every date to epoch milliseconds, which is what
 * the renderer wants and the worst possible thing to hand a language model.
 * Asked when a task was due, one was given `DueDate: 1786924800000` and
 * answered "July 16, 2025" — the record says the 17th of August 2026. It was
 * not hallucinating so much as doing thirteen-digit arithmetic in its head,
 * which is not a thing to rely on.
 *
 * ISO 8601 rather than the tile's own formatting: it is exact, it carries the
 * timezone, and the reply step can phrase it however reads best. `semantic` is
 * what the runtime already worked out, so nothing is being guessed here.
 */
const TIME_SEMANTICS = new Set(["timestamp", "relative_time"]);

export const readableDates = (
  rows: readonly Record<string, unknown>[],
  columns: readonly { name: string; semantic?: string | undefined }[],
): Record<string, unknown>[] => {
  const timeFields = columns
    .filter((column) => column.semantic && TIME_SEMANTICS.has(column.semantic))
    .map((column) => column.name);
  if (timeFields.length === 0) return [...rows];

  return rows.map((row) => {
    let changed: Record<string, unknown> | null = null;
    for (const field of timeFields) {
      const value = row[field];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const asDate = new Date(value);
      if (Number.isNaN(asDate.getTime())) continue;
      changed ??= { ...row };
      changed[field] = asDate.toISOString();
    }
    return changed ?? row;
  });
};

/**
 * Whether the widget's own pipeline threw rows away.
 *
 * A `limit` step is the case that matters. Its rows come back looking whole -
 * ten rows out of ten - so `rows.length` alone reports "all ten records" about
 * a source holding four hundred. Every other step that reduces the count does
 * so legitimately: a `group` turning twenty rows into four buckets has not
 * hidden anything, and a `filter` is the question being asked.
 */
export const pipelineCut = (meta: { steps: readonly { op: string; rowsIn: number; rowsOut: number }[] } | null): boolean =>
  (meta?.steps ?? []).some(
    (step) => step.op.endsWith("limit") && step.rowsOut < step.rowsIn,
  );

/**
 * The field rows are ordered by, when the widget states one.
 *
 * Only a real sort counts. Guessing that a `Date`-ish column implies recency
 * would make "the 50 most recent" a claim about rows nobody sorted, which is
 * exactly the kind of confidently-wrong sentence the coverage note exists to
 * prevent.
 */
export const orderedByOf = (widget: WidgetSpec): string | null => {
  // The last sort wins, the same way it does when the pipeline runs.
  let field: string | null = null;
  for (const step of widget.pipeline) {
    if (step.op !== "sort") continue;
    const first = step.by[0];
    if (first) field = first.field;
  }
  return field;
};

export const coverageOf = (input: {
  readonly total: number;
  readonly orderedBy: string | null;
  readonly window?: { readonly start: number; readonly end: number };
}): Coverage => ({
  scanned: Math.min(input.total, PAGE_SIZE),
  of: input.total,
  orderedBy: input.orderedBy,
  partial: input.total > PAGE_SIZE,
  ...(input.window ? { window: input.window } : {}),
});

export interface ReadWidgetInput {
  readonly candidate: Candidate;
  readonly widget: WidgetSpec;
  readonly resolved: ResolvedParams;
  readonly read: OpReader;
  readonly cacheOnly: boolean;
  readonly now: number;
  readonly timeZone: string;
  readonly limit?: number;
}

/** Run a widget server-side and return what it would be showing. */
export const readWidget = async (input: ReadWidgetInput): Promise<Evidence | null> => {
  const { widget, resolved } = input;
  const sources = widgetSources(widget).filter(isDirect);
  if (sources.length === 0) return null;

  const bodies: Record<string, unknown> = {};
  let requests = 0;
  let got = 0;
  let truncated = false;
  /** Sources the API refused, with its own words for why. */
  const refusals: string[] = [];

  for (const source of sources) {
    const params: Record<string, string | number | boolean> = {};
    for (const [name, value] of Object.entries(source.params)) {
      params[name] = interpolateValue(value, resolved);
    }
    const outcome = await input.read({
      connection: source.connection,
      op: source.op,
      params,
      resolved,
      cacheOnly: input.cacheOnly,
    });
    if (!outcome) continue;
    if (!outcome.ok) {
      refusals.push(`${source.op}: ${outcome.reason}`);
      continue;
    }
    requests += outcome.requests;
    if (outcome.truncated) truncated = true;
    bodies[source.as] = outcome.body;
    got += 1;
  }

  /*
   * Nothing came back at all — and *why* decides whether that is evidence.
   *
   * `readEndpoint` below already draws this line: a refusal is an answer
   * somebody can act on, and returning null reports it as though nothing had
   * been tried. This path did not draw it, and the asymmetry ran the wrong
   * way: a widget with ONE dead source surfaced the reason in `warnings`, and
   * a widget whose sources were ALL refused returned null and threw the
   * reasons away. The more total the failure, the less the user was told —
   * and upstream, an empty search reads as "I looked and it is not there",
   * which is a confident claim about data nobody was able to see.
   *
   * So the two cases are separated here rather than collapsed. `ReadOutcome`
   * already distinguishes them (see `context/types.ts`): a null outcome is a
   * cache-only miss and "carries no blame", while `ok: false` is the API
   * saying no, in its own words.
   */
  if (got === 0) {
    if (refusals.length === 0) return null;
    return {
      candidate: input.candidate,
      rows: [],
      columns: [],
      coverage: { scanned: 0, of: null, orderedBy: null, partial: true },
      warnings: refusals,
      refused: true,
      requests,
    };
  }

  /*
   * `executeWidget` routes on `spec.sources`, so a single-source widget must be
   * handed its body directly rather than a map. Handing the wrong shape shapes
   * nothing and reports an empty widget, which reads exactly like a real gap.
   */
  const executed =
    widget.sources.length > 0
      ? executeWidget(widget, bodies, {
          now: input.now,
          params: resolved,
          timeZone: input.timeZone,
        })
      : executeWidget(widget, bodies[sources[0]!.as], {
          now: input.now,
          params: resolved,
          timeZone: input.timeZone,
        });

  const limit = input.limit ?? PAGE_SIZE;
  const orderedBy = orderedByOf(widget);
  const columns = executed.columns.map((column) => column.name);
  /*
   * What the tile draws, as opposed to what the row carries. Roles name the
   * bound columns; anything a role names that really is a column is on screen.
   */
  const bound = new Set(
    Object.values(widget.roles).flatMap((value) =>
      Array.isArray(value) ? value : typeof value === "string" ? [value] : [],
    ),
  );
  const shows = columns.filter((name) => bound.has(name));
  return {
    candidate: input.candidate,
    rows: readableDates(
      executed.rows.slice(0, limit) as Record<string, unknown>[],
      executed.columns,
    ),
    columns,
    ...(shows.length > 0 ? { shows } : {}),
    coverage: {
      ...coverageOf({ total: executed.rows.length, orderedBy }),
      scanned: Math.min(executed.rows.length, limit),
      /*
       * Two different reasons the read is partial, and both have to count. The
       * obvious one is that more rows came back than are being handed over.
       * The quiet one is that the endpoint's page cap stopped the fetch before
       * the API ran out - in which case `rows.length` is the whole of what was
       * fetched and looks complete, while the account holds more.
       */
      partial: executed.rows.length > limit || truncated || pipelineCut(executed.meta),
      /*
       * A total is only knowable when nothing was cut short - upstream by the
       * page cap, or by the widget's own `limit` step.
       */
      of: truncated || pipelineCut(executed.meta) ? null : executed.rows.length,
      ...(resolved.range
        ? { window: { start: resolved.range.start, end: resolved.range.end } }
        : {}),
    },
    warnings: [
      ...(executed.meta?.warnings ?? []),
      ...refusals,
      ...(got < sources.length - refusals.length
        ? [`${sources.length - got - refusals.length} of this widget's sources returned nothing`]
        : []),
      ...(widgetSources(widget).some((source) => !isDirect(source))
        ? ["this widget also draws on a per-record lookup that was not run"]
        : []),
    ],
    requests,
  };
};

export interface ReadEndpointInput {
  readonly candidate: Candidate;
  readonly resolved: ResolvedParams;
  readonly read: OpReader;
  readonly cacheOnly: boolean;
  readonly rowsPath: string;
  readonly limit?: number;
  /** Flattens a body into rows the way the rest of the product does. */
  readonly rowsOf: (body: unknown, rowsPath: string) => Record<string, unknown>[];
}

/** Read an endpoint directly, for a question no widget covers. */
export const readEndpoint = async (
  input: ReadEndpointInput,
): Promise<Evidence | null> => {
  const outcome = await input.read({
    connection: input.candidate.connection,
    op: input.candidate.op,
    params: {},
    resolved: input.resolved,
    cacheOnly: input.cacheOnly,
  });
  if (!outcome) return null;
  /*
   * A refusal is evidence, not a blank. "This endpoint exists and your key is
   * not allowed to read it" is an answer somebody can act on; returning null
   * would report it as though nothing had been tried.
   */
  if (!outcome.ok) {
    return {
      candidate: input.candidate,
      rows: [],
      columns: [],
      coverage: { scanned: 0, of: null, orderedBy: null, partial: true },
      warnings: [outcome.reason],
      refused: true,
      requests: 0,
    };
  }

  const rows = input.rowsOf(outcome.body, input.rowsPath);
  const limit = input.limit ?? PAGE_SIZE;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return {
    candidate: input.candidate,
    rows: rows.slice(0, limit),
    columns,
    coverage: {
      ...coverageOf({ total: rows.length, orderedBy: null }),
      scanned: Math.min(rows.length, limit),
      partial: rows.length > limit || outcome.truncated,
      of: outcome.truncated ? null : rows.length,
    },
    warnings: [],
    requests: outcome.requests,
  };
};
