import type { Engine } from "@freebirdai/connect";
import { Priority, resolveRequestedRange, type RecordReader } from "@freebirdai/connect/host";
import { executeWidget } from "@freebirdai/dash-runtime";
import {
  getOp,
  interpolateValue,
  paramsForWidget,
  readField,
  type ColumnMeta,
  type ConnectionSpec,
  type DashboardSpec,
  type TrackedValue,
  type WidgetSpec,
} from "@freebirdai/dash-spec";

/**
 * What a report reads, and how: a widget as its tab would read it, and a
 * tracked value as one number. Both go through the engine's single read at
 * background priority, so they share the cache with every tile and never
 * jump ahead of somebody looking at a board.
 */

/** A widget, read and run through its own pipeline. */
export interface WidgetReading {
  readonly rows: readonly Record<string, unknown>[];
  readonly columns: readonly ColumnMeta[];
  readonly warnings: readonly string[];
}

export type WidgetReader = (dashboard: DashboardSpec, widget: WidgetSpec) => Promise<WidgetReading>;

/** How old an answer a report accepts: whatever the keeper refreshed within the hour. */
const REPORT_MAX_AGE_MS = 60 * 60_000;

const RANGES = ["1h", "24h", "7d", "30d", "90d", "12mo", "ytd"] as const;
type RangePreset = (typeof RANGES)[number];
const rangeOf = (dashboard: DashboardSpec): RangePreset => {
  const wanted = (dashboard.params as { defaultRange?: string }).defaultRange;
  return (RANGES as readonly string[]).includes(wanted ?? "") ? (wanted as RangePreset) : "30d";
};

export const widgetReader =
  (deps: {
    readonly read: Engine["read"];
    readonly connection: (id: string) => ConnectionSpec | null | undefined;
    /** Told about each connection before it is read: the engine registers it. */
    readonly prepare?: (connection: ConnectionSpec) => void;
    readonly now?: () => number;
  }): WidgetReader =>
  async (dashboard, widget) => {
    const now = (deps.now ?? Date.now)();
    const base = { range: resolveRequestedRange({ preset: rangeOf(dashboard) }, now), filters: {} };
    const resolved = paramsForWidget(widget, base, now);
    const warnings: string[] = [];

    const readOne = async (source: { readonly connection: string; readonly op: string; readonly params: Readonly<Record<string, string | number | boolean>> }) => {
      const connection = deps.connection(source.connection);
      if (!connection) throw new Error(`The connection "${source.connection}" is gone.`);
      const op = getOp(connection, source.op);
      if (!op) throw new Error(`${connection.title} no longer has the endpoint "${source.op}".`);
      deps.prepare?.(connection);
      const params: Record<string, string | number | boolean> = {};
      for (const [name, value] of Object.entries(source.params)) params[name] = interpolateValue(value, resolved);
      const answer = await deps.read({ connection, op, params, resolved, mode: "refresh", maxAgeMs: REPORT_MAX_AGE_MS, priority: Priority.Background });
      warnings.push(...answer.meta.warnings);
      if (answer.changed) warnings.push(answer.changed);
      if (answer.reading && answer.reading.state !== "done") warnings.push("Not every record had been read yet.");
      return { body: answer.outcome.body, resolved: answer.resolved };
    };

    let body: unknown;
    let params = resolved;
    if (widget.sources.length > 0) {
      const bodies: Record<string, unknown> = {};
      for (const source of widget.sources) bodies[source.as] = (await readOne(source)).body;
      body = bodies;
    } else if (widget.source) {
      const one = await readOne(widget.source);
      body = one.body;
      params = one.resolved;
    } else {
      throw new Error("This widget reads nothing.");
    }
    const executed = executeWidget(widget, body, { now, params });
    if (!executed.ok && executed.errors.length > 0) warnings.push(...executed.errors);
    return { rows: executed.rows, columns: executed.columns, warnings };
  };

/* ── tracked values ────────────────────────────────────────────────────── */

const numberOf = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/[,$%\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
};

/** The one number a tracked value is, from the rows it reads. Null when there is nothing to say. */
export const aggregateRows = (rows: readonly unknown[], value: TrackedValue["value"]): number | null => {
  if (value.aggregate === "count") return rows.length;
  const numbers = rows.map((row) => numberOf(readField(row as Record<string, unknown>, value.field ?? ""))).filter((one): one is number => one !== null);
  if (value.aggregate === "latest") return numbers.length > 0 ? numbers[numbers.length - 1]! : null;
  if (numbers.length === 0) return value.aggregate === "sum" ? 0 : null;
  switch (value.aggregate) {
    case "sum":
      return numbers.reduce((total, one) => total + one, 0);
    case "avg":
      return numbers.reduce((total, one) => total + one, 0) / numbers.length;
    case "min":
      return Math.min(...numbers);
    case "max":
      return Math.max(...numbers);
  }
};

export type TrackedReader = (tracked: TrackedValue) => Promise<{ readonly value: number | null; readonly complete: boolean }>;

/** Reads a tracked value's records through the record reader, narrowed by its filter, and works out its number. */
export const trackedReader =
  (read: RecordReader): TrackedReader =>
  async (tracked) => {
    const { source } = tracked;
    const answer = await read(
      source.connection,
      {
        ...(source.op ? { op: source.op } : { record: source.record! }),
        params: source.params,
        filter: source.filter,
        fresh: "1h",
        waitMs: 60_000,
      },
      Priority.Background,
    );
    return { value: aggregateRows(answer.rows, tracked.value), complete: answer.complete };
  };
