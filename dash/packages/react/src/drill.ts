import type { ColumnMeta, EntityLinkView, WidgetSpec } from "@freebirdai/dash-spec";
import { ALL_ROWS, nameOfObject, parseAggregation } from "@freebirdai/dash-spec";
import { rankKeyFields } from "@freebirdai/dash-components";

/**
 * The rows behind a number.
 *
 * A stat's pipeline ends by grouping every row into one and counting or adding
 * them. Everything before that group step is a list of records; dropping the
 * group and whatever follows it gives back exactly the rows the number was
 * taken over, read by the same request, so the cache answers it without a
 * second fetch.
 *
 * Only a number taken over *all* the rows is offered. A stat over months shows
 * the latest month's total, and the rows behind that are a subset nothing here
 * can name without re-implementing the bucket — so it stays a plain number.
 * The same goes for an average or a maximum: the rows are there, but none of
 * them adds up to what the tile says.
 */
export interface StatDrill {
  /** The widget, ending before its group step, drawn as a table. */
  readonly spec: WidgetSpec;
  readonly measure: { readonly fn: "count" } | { readonly fn: "sum"; readonly field: string };
}

export const statDrill = (widget: WidgetSpec): StatDrill | null => {
  if (widget.component !== "stat") return null;
  // A group inside a source shapes that source alone; what reaches the tile is no longer records.
  if (widget.sources.some((source) => source.pipeline.some((step) => step.op === "group"))) return null;

  const index = widget.pipeline.findIndex((step) => step.op === "group");
  if (index < 0) return null;
  const group = widget.pipeline[index];
  if (group?.op !== "group") return null;
  if (group.by.length !== 1 || group.by[0]?.field !== ALL_ROWS) return null;

  const valueColumn = widget.roles["value"];
  if (typeof valueColumn !== "string") return null;
  const source = group.agg[valueColumn];
  const parsed = source ? parseAggregation(source) : null;
  if (!parsed) return null;
  if (parsed.fn !== "count" && parsed.fn !== "sum") return null;
  if (parsed.fn === "sum" && !parsed.field) return null;

  /* The constant the group was keyed on means nothing once there is no group. */
  const before = widget.pipeline
    .slice(0, index)
    .flatMap((step) => {
      if (step.op !== "derive" || !(ALL_ROWS in step.fields)) return [step];
      const fields = Object.fromEntries(Object.entries(step.fields).filter(([name]) => name !== ALL_ROWS));
      return Object.keys(fields).length > 0 ? [{ ...step, fields }] : [];
    });

  const measure: StatDrill["measure"] =
    parsed.fn === "sum" ? { fn: "sum", field: parsed.field! } : { fn: "count" };

  return {
    measure,
    spec: {
      ...widget,
      component: "table",
      pipeline: before,
      /*
       * Bound to the summed column where there is one. The table is drawn with
       * the columns picked once the rows arrive (`drillColumns`), so this only
       * has to be something the binding check can name.
       */
      roles: { columns: measure.fn === "sum" ? [measure.field] : [] },
      facets: [],
      highlights: [],
      drilldown: undefined,
    },
  };
};

/** `Vendor.Name` as the column a derive step would have made of it. */
const columnFor = (path: string): string => path.replace(/\./g, "_");

/**
 * The columns the list behind a number shows: what names each record first,
 * then whatever reads best, the summed column always among them.
 */
export const drillColumns = (
  columns: readonly ColumnMeta[],
  link: EntityLinkView | undefined,
  measure: StatDrill["measure"],
  cap = 5,
  rows: readonly Readonly<Record<string, unknown>>[] = [],
): string[] => {
  /*
   * A column of nested records that do not say what they are called would
   * draw as `{Id, Type, …}` on every row: left out, so a readable one takes
   * its place. One whose records are named reads as the name and stays.
   */
  const unreadable = (name: string): boolean =>
    rows.some((row) => {
      const value = row[name];
      return value !== null && typeof value === "object" && (Array.isArray(value) || nameOfObject(value) === undefined);
    });
  const ranked = rankKeyFields(
    columns.filter((column) => !unreadable(column.name)).map((column) => ({
      key: column.name,
      semantic: column.semantic,
      valueType: column.valueType,
    })),
    {
      title: (link?.title ?? []).map(columnFor),
      ...(link?.identity ? { identity: columnFor(link.identity) } : {}),
    },
    columns.length,
  );
  /*
   * A column that says on every row what an earlier one already says — a
   * work order's task, named by the same title as the work order — spends a
   * slot on nothing; the next readable column has it instead.
   */
  const said = (row: Readonly<Record<string, unknown>>, name: string): string => {
    const value = row[name];
    return value !== null && typeof value === "object" ? (nameOfObject(value) ?? "") : String(value ?? "");
  };
  const sampled = rows.filter((row) => Object.keys(row).length > 0);
  const distinct: string[] = [];
  for (const name of ranked) {
    const repeats = sampled.length > 0 && distinct.some((earlier) => sampled.every((row) => said(row, earlier) === said(row, name)));
    if (!repeats) distinct.push(name);
  }
  const picked = distinct.slice(0, cap);
  if (measure.fn !== "sum") return picked;
  const field = measure.field;
  if (!columns.some((column) => column.name === field)) return picked;
  return picked.includes(field) ? picked : [...picked.slice(0, cap - 1), field];
};

/** What the tile's button says: "Show the 42 records". */
export const drillLabel = (count: number | null, many: string | undefined): string => {
  const noun = (many ?? "records").toLowerCase();
  return count === null ? `Show the ${noun} behind this number` : `Show the ${count.toLocaleString()} ${noun}`;
};
