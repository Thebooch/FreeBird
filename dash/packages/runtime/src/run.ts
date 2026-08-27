import type { ExprAst, Grain } from "@freebirdai/dash-expr";
import {
  advanceBucket,
  evalExpr,
  evalPredicate,
  extractRows,
  parseExpr,
  toEpochMs,
  toNumber,
  truncateToBucket,
} from "@freebirdai/dash-expr";
import type { Aggregation, GroupStep, PipelineStep, ResolvedParams } from "@freebirdai/dash-spec";
import { applyCoercion, interpolate, parseAggregation, resolveGrain } from "@freebirdai/dash-spec";
import { inferColumns } from "./columns.js";
import type {
  CompiledExpression,
  CompiledWidget,
  RowHighlight,
  RunContext,
  RunResult,
  Row,
  StepTrace,
} from "./types.js";

const DEFAULT_MAX_ROWS = 50_000;

/**
 * Expressions carrying `{{…}}` params cannot be parsed until the params are
 * known. There are only ever a handful of distinct resolutions in play, so a
 * small global cache keeps the per-run cost at zero without holding onto a
 * compiled widget.
 */
const astCache = new Map<string, ExprAst>();
const AST_CACHE_LIMIT = 200;

const resolveAst = (expression: CompiledExpression, params: ResolvedParams): ExprAst => {
  if (expression.ast) return expression.ast;
  const source = interpolate(expression.source, params);
  const cached = astCache.get(source);
  if (cached) return cached;
  const ast = parseExpr(source);
  if (astCache.size >= AST_CACHE_LIMIT) astCache.clear();
  astCache.set(source, ast);
  return ast;
};

/** A primitive row still needs to be addressable, so it becomes `{ value }`. */
const toRow = (value: unknown): Row => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Row;
  }
  return { value };
};

const nullish = (value: unknown): boolean => value === null || value === undefined;

/** Nulls sort last in both directions — they are absent, not smallest. */
const compareValues = (a: unknown, b: unknown): number => {
  const an = nullish(a);
  const bn = nullish(b);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
};

const compareForSort = (a: unknown, b: unknown, dir: "asc" | "desc"): number => {
  const an = nullish(a);
  const bn = nullish(b);
  if (an || bn) return compareValues(a, b); // direction never moves nulls off the end
  return dir === "asc" ? compareValues(a, b) : -compareValues(a, b);
};

const aggregate = (fn: Aggregation, field: string | null, rows: readonly Row[]): unknown => {
  switch (fn) {
    case "count":
      return field === null ? rows.length : rows.filter((row) => !nullish(row[field])).length;

    case "countDistinct": {
      if (field === null) return rows.length;
      const distinct = new Set<unknown>();
      for (const row of rows) {
        const value = row[field];
        if (!nullish(value)) {
          distinct.add(typeof value === "object" ? JSON.stringify(value) : value);
        }
      }
      return distinct.size;
    }

    case "sum": {
      if (field === null) return 0;
      let total = 0;
      for (const row of rows) {
        const n = toNumber(row[field]);
        if (n !== null) total += n;
      }
      return total;
    }

    case "avg": {
      if (field === null) return null;
      let total = 0;
      let count = 0;
      for (const row of rows) {
        const n = toNumber(row[field]);
        if (n !== null) {
          total += n;
          count++;
        }
      }
      return count === 0 ? null : total / count;
    }

    case "min":
    case "max": {
      if (field === null) return null;
      let best: unknown = null;
      for (const row of rows) {
        const value = row[field];
        if (nullish(value)) continue;
        if (best === null) {
          best = value;
          continue;
        }
        const order = compareValues(value, best);
        if (fn === "min" ? order < 0 : order > 0) best = value;
      }
      return best;
    }

    case "first":
      return field === null ? null : (rows[0]?.[field] ?? null);

    case "last":
      return field === null ? null : (rows[rows.length - 1]?.[field] ?? null);
  }
};

/** Aggregations that mean "none of them" rather than "unknown" in an empty bucket. */
const ZERO_FILLED = new Set<Aggregation>(["count", "countDistinct", "sum"]);

interface GroupKeyDef {
  readonly field: string;
  readonly as: string;
  readonly grain: Grain | null;
}

const runGroup = (
  rows: readonly Row[],
  step: GroupStep,
  params: ResolvedParams,
  warnings: string[],
): Row[] => {
  const keyDefs: GroupKeyDef[] = step.by.map((key) => {
    let grain: Grain | null = null;
    if (key.bucket) {
      grain = resolveGrain(key.bucket, params);
      if (!grain) {
        warnings.push(`"${key.bucket}" is not a grain — grouping "${key.field}" without buckets`);
      }
    }
    return { field: key.field, as: key.as ?? key.field, grain };
  });

  const groups = new Map<string, { key: unknown[]; rows: Row[] }>();

  for (const row of rows) {
    const key = keyDefs.map((def) => {
      const raw = row[def.field];
      if (!def.grain) return nullish(raw) ? null : raw;
      const ms = toEpochMs(raw);
      return ms === null ? null : truncateToBucket(ms, def.grain);
    });
    const id = JSON.stringify(key);
    const existing = groups.get(id);
    if (existing) existing.rows.push(row);
    else groups.set(id, { key, rows: [row] });
  }

  const aggregations = Object.entries(step.agg).map(([name, source]) => {
    const parsed = parseAggregation(source);
    return { name, parsed };
  });

  const build = (key: readonly unknown[], groupRows: readonly Row[]): Row => {
    const out: Row = {};
    keyDefs.forEach((def, index) => {
      out[def.as] = key[index] ?? null;
    });
    for (const { name, parsed } of aggregations) {
      out[name] = parsed ? aggregate(parsed.fn, parsed.field, groupRows) : null;
    }
    return out;
  };

  let result = [...groups.values()].map((group) => build(group.key, group.rows));

  // Grouped output is always ordered by its key. A time series that comes back
  // in hash order looks like a bug even when the numbers are right; an
  // explicit sort step still overrides this.
  result.sort((a, b) => {
    for (const def of keyDefs) {
      const order = compareValues(a[def.as], b[def.as]);
      if (order !== 0) return order;
    }
    return 0;
  });

  if (step.fillGaps) {
    const bucketed = keyDefs.filter((def) => def.grain !== null);
    if (bucketed.length !== 1 || keyDefs.length !== 1) {
      warnings.push("fillGaps needs exactly one bucketed group key — skipped");
    } else {
      const def = bucketed[0]!;
      const grain = def.grain!;
      const stamps = result
        .map((row) => row[def.as])
        .filter((value): value is number => typeof value === "number");

      if (stamps.length > 1) {
        const filled: Row[] = [];
        const byStamp = new Map(
          result.map((row) => [row[def.as], row] as const),
        );
        const last = stamps[stamps.length - 1]!;
        let cursor = stamps[0]!;
        let guard = 0;
        while (cursor <= last && guard++ < 10_000) {
          const existing = byStamp.get(cursor);
          if (existing) {
            filled.push(existing);
          } else {
            const blank: Row = { [def.as]: cursor };
            for (const { name, parsed } of aggregations) {
              blank[name] = parsed && ZERO_FILLED.has(parsed.fn) ? 0 : null;
            }
            filled.push(blank);
          }
          cursor = advanceBucket(cursor, grain);
        }
        // Null-keyed rows have no place on a time axis; keep them at the end.
        const orphans = result.filter((row) => typeof row[def.as] !== "number");
        result = [...filled, ...orphans];
      }
    }
  }

  return result;
};

/**
 * Execute a compiled widget against a payload.
 *
 * Pure: no network, no clock, no globals. The same payload plus the same
 * params always produces the same rows, which is what makes the golden
 * fixtures a real regression net and what lets the inspector claim that the
 * numbers on screen came from exactly these steps.
 */
export const runPipeline = (
  widget: CompiledWidget,
  body: unknown,
  ctx: RunContext,
): RunResult => {
  const maxRows = ctx.maxRows ?? DEFAULT_MAX_ROWS;
  const warnings: string[] = [];
  const traces: StepTrace[] = [];
  let coercionFailures = 0;

  let rows: Row[] = (Array.isArray(body) ? body : [body]).map(toRow);
  const rowsIn = rows.length;

  const cap = (input: Row[], op: PipelineStep["op"]): Row[] => {
    if (input.length <= maxRows) return input;
    warnings.push(`"${op}" produced ${input.length} rows; kept the first ${maxRows}`);
    return input.slice(0, maxRows);
  };

  for (const compiled of widget.steps) {
    const before = rows.length;
    let note: string | undefined;

    switch (compiled.op) {
      case "extract": {
        rows = cap(extractRows(compiled.path, body).map(toRow), "extract");
        note = compiled.path.source;
        break;
      }

      case "coerce": {
        const entries = Object.entries(compiled.step.fields);
        let failures = 0;
        rows = rows.map((row) => {
          const next: Row = { ...row };
          for (const [field, coercion] of entries) {
            const original = next[field];
            const coerced = applyCoercion(original, coercion);
            if (coerced === null && !nullish(original)) failures++;
            next[field] = coerced;
          }
          return next;
        });
        coercionFailures += failures;
        if (failures > 0) {
          warnings.push(`${failures} value(s) could not be coerced and became empty`);
        }
        note = entries.map(([field, coercion]) => `${field}: ${coercion}`).join(", ");
        break;
      }

      case "filter": {
        const ast = resolveAst(compiled.where, ctx.params);
        rows = rows.filter((row) => evalPredicate(ast, row, { now: ctx.now }));
        note = compiled.where.source;
        break;
      }

      case "derive": {
        rows = rows.map((row) => {
          const next: Row = { ...row };
          // Every expression sees the row as it was before this step, so the
          // result never depends on key order.
          for (const [name, expression] of compiled.fields) {
            const ast = resolveAst(expression, ctx.params);
            next[name] = evalExpr(ast, row, { now: ctx.now });
          }
          return next;
        });
        note = compiled.fields.map(([name]) => name).join(", ");
        break;
      }

      case "group": {
        rows = runGroup(rows, compiled.step, ctx.params, warnings);
        note = `by ${compiled.step.by.map((key) => key.field).join(", ")}`;
        break;
      }

      case "sort": {
        const keys = compiled.step.by;
        rows = [...rows].sort((a, b) => {
          for (const key of keys) {
            const order = compareForSort(a[key.field], b[key.field], key.dir);
            if (order !== 0) return order;
          }
          return 0;
        });
        note = keys.map((key) => `${key.field} ${key.dir}`).join(", ");
        break;
      }

      case "limit": {
        const { count, from } = compiled.step;
        rows = from === "end" ? rows.slice(-count) : rows.slice(0, count);
        note = `${from === "end" ? "last" : "first"} ${count}`;
        break;
      }

      case "rename": {
        const entries = Object.entries(compiled.step.fields);
        rows = rows.map((row) => {
          const next: Row = { ...row };
          for (const [from, to] of entries) {
            if (from in next) {
              next[to] = next[from];
              delete next[from];
            }
          }
          return next;
        });
        note = entries.map(([from, to]) => `${from} → ${to}`).join(", ");
        break;
      }

      case "select": {
        const fields = compiled.step.fields;
        rows = rows.map((row) => {
          const next: Row = {};
          for (const field of fields) next[field] = row[field] ?? null;
          return next;
        });
        note = fields.join(", ");
        break;
      }

      case "annotate":
        // Purely a compile-time hint about meaning; the rows are untouched.
        note = Object.entries(compiled.step.fields)
          .map(([field, semantic]) => `${field}: ${semantic}`)
          .join(", ");
        break;
    }

    traces.push({
      op: compiled.op,
      rowsIn: before,
      rowsOut: rows.length,
      ...(note ? { note } : {}),
    });
  }

  const columns = inferColumns({ rows, semanticHints: widget.semanticHints });
  const marked = evaluateHighlights(widget, rows, ctx);
  if (marked) {
    traces.push({
      op: "highlight",
      rowsIn: rows.length,
      rowsOut: rows.length,
      note: marked.note,
    });
  }

  return {
    rows,
    columns,
    meta: {
      steps: traces,
      warnings,
      coercionFailures,
      rowsIn,
      rowsOut: rows.length,
      ...(marked ? { highlightCounts: marked.counts } : {}),
    },
    ...(marked ? { highlights: marked.hits } : {}),
  };
};

/**
 * Mark the rows a widget wants attention drawn to.
 *
 * Runs after the pipeline, over the finished rows, which is what makes a
 * predicate able to name the columns actually rendered — including ones a
 * `rename` or a join produced — and leaves the one-extract-at-index-0 rule
 * completely alone.
 */
export const evaluateHighlights = (
  widget: CompiledWidget,
  rows: readonly Row[],
  ctx: RunContext,
): { hits: RowHighlight[][]; counts: Record<string, number>; note: string } | null => {
  if (widget.highlights.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const highlight of widget.highlights) counts[highlight.id] = 0;

  const hits = rows.map((row) => {
    const matched: RowHighlight[] = [];
    for (const highlight of widget.highlights) {
      const ast = resolveAst(highlight.when, ctx.params);
      if (!evalPredicate(ast, row, { now: ctx.now })) continue;
      counts[highlight.id] = (counts[highlight.id] ?? 0) + 1;
      matched.push({
        id: highlight.id,
        tone: highlight.tone,
        label: highlight.label,
        ...(highlight.field ? { field: highlight.field } : {}),
      });
    }
    return matched;
  });

  const note = widget.highlights
    .map((highlight) => `${highlight.label}: ${counts[highlight.id]} of ${rows.length}`)
    .join(" · ");

  return { hits, counts, note };
};
