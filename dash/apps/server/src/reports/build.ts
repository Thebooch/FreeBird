import {
  formatValue,
  humanLabel,
  REPORT_WINDOW_DAYS,
  type DashboardSpec,
  type Report,
  type ReportWindow,
  type TrackedValue,
  type WidgetSpec,
} from "@freebirdai/dash-spec";
import { dayOf } from "../history/record.js";
import type { HistoryPoint, SnapshotStore } from "../history/store.js";
import type { WidgetReader } from "./read.js";

/**
 * A report's blocks, read and put into words: what the email shows and what
 * the summary is written from. Nothing here sends anything.
 *
 * A tab expands to its widgets in the order the tab shows them. A number
 * tile says its number and how it moved since the last time the report went
 * out (or the last week, the first time), from the history Dash keeps. Every
 * other widget becomes a short table of what it shows. A block that cannot
 * be read says why, in its place, and the rest of the report still goes.
 */

/** Where a tracked value's days are kept in the snapshot store: a board id no board can have. */
export const TRACKED_DASHBOARD = "__tracked__";

export interface Change {
  readonly from: number;
  readonly fromDay: string;
  /** "+12 (+8%) since Mar 3". */
  readonly text: string;
  readonly direction: "up" | "down" | "flat";
}

export interface ReportTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Rows not shown. */
  readonly more: number;
}

export type ReportSection =
  | { readonly kind: "heading"; readonly title: string }
  | {
      readonly kind: "value";
      readonly name: string;
      readonly value: string | null;
      readonly raw: number | null;
      readonly change: Change | null;
      readonly window: ReportWindow;
      /** The first day it was kept, when that is inside the window. */
      readonly since?: string;
      readonly error?: string;
    }
  | {
      readonly kind: "widget";
      readonly title: string;
      readonly tab: string;
      readonly component: string;
      readonly headline?: string;
      readonly raw?: number | null;
      readonly change?: Change | null;
      readonly table?: ReportTable;
      readonly warnings: readonly string[];
      readonly error?: string;
    }
  | { readonly kind: "text"; readonly markdown: string };

export interface BuildDeps {
  readonly dashboards: () => readonly DashboardSpec[];
  readonly readWidget: WidgetReader;
  readonly snapshots: SnapshotStore;
  readonly tracked: (id: string) => Promise<TrackedValue | null>;
  readonly now: () => number;
  readonly locale?: string;
}

const TABLE_ROWS = 8;
const TABLE_COLUMNS = 6;
/** A cell longer than this is cut: an email table is for scanning, and the tab has the rest. */
const CELL_CHARS = 80;
const cell = (value: string): string => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > CELL_CHARS ? `${text.slice(0, CELL_CHARS - 1).trimEnd()}…` : text;
};
const DAY_MS = 86_400_000;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const shortDay = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const plain = (value: number): string => (Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/** The kept point on or before a day, or the first one after it when history starts later. */
const pointAt = (points: readonly HistoryPoint[], day: string, today: string): HistoryPoint | null => {
  let found: HistoryPoint | null = null;
  for (const point of points) if (point.day <= day) found = point;
  if (found) return found;
  const first = points[0];
  return first && first.day < today ? first : null;
};

export const changeOf = (now: number, then: HistoryPoint | null, show: (value: number) => string): Change | null => {
  if (!then) return null;
  const delta = now - then.value;
  const percent = then.value !== 0 ? ` (${delta >= 0 ? "+" : ""}${Math.round((delta / Math.abs(then.value)) * 100)}%)` : "";
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const text = direction === "flat" ? `No change since ${shortDay(then.day)}` : `${delta > 0 ? "+" : "−"}${show(Math.abs(delta))}${percent} since ${shortDay(then.day)}`;
  return { from: then.value, fromDay: then.day, text, direction };
};

/** The widgets of a tab, in the order it shows them: top to bottom, left to right. */
export const widgetsInOrder = (dashboard: DashboardSpec): WidgetSpec[] => {
  const place = new Map(dashboard.layout.cells.map((cell) => [cell.widgetId, cell.y * 100 + cell.x]));
  return [...dashboard.widgets].sort((a, b) => (place.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (place.get(b.id) ?? Number.MAX_SAFE_INTEGER));
};

const columnFor = (widget: WidgetSpec, role: string, fallback: string): string => {
  const bound = widget.roles[role];
  return typeof bound === "string" ? bound : fallback;
};

/** Each block once: the same widget picked twice, or a widget already inside a whole tab, is read once. */
const reportBlocksKeyed = (blocks: Report["blocks"]): Array<[string, Report["blocks"][number]]> => {
  const tabs = new Set(blocks.flatMap((block) => (block.kind === "tab" ? [block.dashboard] : [])));
  return blocks.flatMap((block, index): Array<[string, Report["blocks"][number]]> => {
    switch (block.kind) {
      case "tab":
        return [[`tab:${block.dashboard}`, block]];
      case "widget":
        return tabs.has(block.dashboard) ? [] : [[`widget:${block.dashboard}:${block.widget}`, block]];
      case "value":
        return [[`value:${block.tracked}:${block.window}`, block]];
      case "text":
        return [[`text:${index}`, block]];
    }
  });
};

export const buildSections = async (deps: BuildDeps, report: Pick<Report, "blocks" | "lastSentAt">): Promise<ReportSection[]> => {
  const now = deps.now();
  const today = dayOf(now);
  const boards = new Map(deps.dashboards().map((one) => [one.id, one]));
  /* A number tile compares with the last time this report went out, or with a week ago. */
  const compareDay = dayOf(report.lastSentAt ? Math.min(Date.parse(report.lastSentAt), now - DAY_MS) : now - 7 * DAY_MS);
  const locale = deps.locale ?? "en-US";

  const widgetSection = async (dashboard: DashboardSpec, widget: WidgetSpec): Promise<ReportSection> => {
    const base = { kind: "widget" as const, title: widget.title, tab: dashboard.title, component: widget.component };
    try {
      const reading = await deps.readWidget(dashboard, widget);
      if (widget.component === "stat") {
        const column = columnFor(widget, "value", "value");
        const value = reading.rows[0]?.[column];
        const raw = typeof value === "number" && Number.isFinite(value) ? value : null;
        const format = widget.format[column];
        const show = (one: number) => formatValue(one, format, { locale });
        const points = raw === null ? [] : await deps.snapshots.list(dashboard.id, widget.id).catch(() => []);
        return {
          ...base,
          headline: value === undefined ? "—" : formatValue(value, format, { locale }),
          raw,
          change: raw === null ? null : changeOf(raw, pointAt(points, compareDay, today), show),
          warnings: reading.warnings,
        };
      }
      const columns = reading.columns.filter((column) => !column.name.startsWith("__")).slice(0, TABLE_COLUMNS);
      const table: ReportTable = {
        headers: columns.map((column) => column.label ?? humanLabel(column.name)),
        rows: reading.rows.slice(0, TABLE_ROWS).map((row) => columns.map((column) => cell(formatValue(row[column.name], widget.format[column.name], { locale })))),
        more: Math.max(0, reading.rows.length - TABLE_ROWS),
      };
      return { ...base, table, warnings: reading.warnings };
    } catch (error) {
      return { ...base, warnings: [], error: `Could not be read: ${message(error)}` };
    }
  };

  const valueSection = async (id: string, window: ReportWindow): Promise<ReportSection> => {
    const tracked = await deps.tracked(id);
    if (!tracked) return { kind: "value", name: "A tracked value", value: null, raw: null, change: null, window, error: "This tracked value was removed." };
    const points = await deps.snapshots.list(TRACKED_DASHBOARD, tracked.id).catch(() => [] as HistoryPoint[]);
    const latest = points[points.length - 1] ?? null;
    const show = (one: number) =>
      tracked.unit === "currency" ? `$${plain(one)}` : tracked.unit === "percent" ? `${plain(one)}%` : plain(one);
    const from = dayOf(now - REPORT_WINDOW_DAYS[window] * DAY_MS);
    const first = points[0];
    return {
      kind: "value",
      name: tracked.name,
      value: latest ? show(latest.value) : null,
      raw: latest?.value ?? null,
      change: latest ? changeOf(latest.value, pointAt(points.filter((one) => one.day < latest.day), from, latest.day), show) : null,
      window,
      ...(first && first.day > from ? { since: first.day } : {}),
      ...(latest ? {} : { error: "Nothing has been recorded yet. Dash records it once a day from the day it was first tracked." }),
    };
  };

  const out: ReportSection[] = [];
  for (const block of [...new Map(reportBlocksKeyed(report.blocks)).values()]) {
    if (block.kind === "text") out.push({ kind: "text", markdown: block.markdown });
    else if (block.kind === "value") out.push(await valueSection(block.tracked, block.window));
    else {
      const dashboard = boards.get(block.dashboard);
      if (!dashboard) {
        out.push({ kind: "widget", title: "A tab that was removed", tab: block.dashboard, component: "", warnings: [], error: "This tab no longer exists." });
        continue;
      }
      if (block.kind === "tab") {
        out.push({ kind: "heading", title: dashboard.title });
        for (const widget of widgetsInOrder(dashboard)) out.push(await widgetSection(dashboard, widget));
        continue;
      }
      const widget = dashboard.widgets.find((one) => one.id === block.widget);
      out.push(
        widget
          ? await widgetSection(dashboard, widget)
          : { kind: "widget", title: "A widget that was removed", tab: dashboard.title, component: "", warnings: [], error: `This widget is no longer on ${dashboard.title}.` },
      );
    }
  }
  return out;
};

/** The numbers the summary is written from: short, and only what the email shows. */
export const factsOf = (sections: readonly ReportSection[]): unknown[] =>
  sections.flatMap((section): unknown[] => {
    switch (section.kind) {
      case "heading":
        return [{ tab: section.title }];
      case "text":
        return [];
      case "value":
        return [{ value: section.name, now: section.value, change: section.change?.text ?? null, error: section.error ?? null }];
      case "widget":
        return [
          {
            widget: section.title,
            ...(section.headline !== undefined ? { now: section.headline, change: section.change?.text ?? null } : {}),
            ...(section.table ? { columns: section.table.headers, rows: section.table.rows.slice(0, 5), moreRows: section.table.more } : {}),
            ...(section.error ? { error: section.error } : {}),
          },
        ];
    }
  });
