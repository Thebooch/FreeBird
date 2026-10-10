import {
  formatValue,
  humanLabel,
  REPORT_WINDOW_DAYS,
  type DashboardSpec,
  type FormatSpec,
  type Report,
  type ReportWindow,
  type TrackedValue,
  type WidgetSpec,
} from "@freebirdai/dash-spec";
import { dayOf } from "../history/record.js";
import type { HistoryPoint, SnapshotStore } from "../history/store.js";
import type { WidgetReader, WidgetReading } from "./read.js";

/**
 * A report's blocks, read and turned into something to read rather than a
 * copy of the widgets. Nothing here sends anything.
 *
 * A report is a list of **parts**. A whole tab is one part: one summary, then
 * a picture of each widget's numbers. A widget picked on its own is a part of
 * its own, and so is a tracked value: its summary, then its picture. Each
 * part carries what the reader asked to hear about (`emphasis`), which its
 * summary answers first.
 *
 * The picture is chosen by what the numbers are, not by how the widget
 * draws them:
 * - one number (a stat, a gauge): the number and how it moved since the last
 *   send, or the last week the first time;
 * - a series over time: a small column chart, the latest value and the change
 *   from the first point;
 * - values by category (bars, a funnel, a distribution, a metric row, a board
 *   grouped by status): bars, largest first, the rest counted;
 * - records (a table, cards, a list, a feed): how many, and the first five.
 *
 * A block that cannot be read says why in its place, and the rest still goes.
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

export type ReportVisual =
  | { readonly kind: "number"; readonly value: string; readonly raw: number | null; readonly change: Change | null }
  | {
      readonly kind: "bars";
      readonly bars: ReadonlyArray<{ readonly label: string; readonly value: number; readonly text: string }>;
      /** Categories not drawn, and what they add up to. */
      readonly more: number;
      readonly moreText?: string;
    }
  | {
      readonly kind: "trend";
      readonly points: ReadonlyArray<{ readonly label: string; readonly value: number }>;
      readonly latest: string;
      readonly change: Change | null;
    }
  | {
      readonly kind: "list";
      readonly count: number;
      readonly items: ReadonlyArray<{ readonly title: string; readonly detail?: string }>;
      readonly more: number;
    };

export type ReportSection =
  | {
      readonly kind: "value";
      readonly name: string;
      readonly visual: ReportVisual | null;
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
      readonly visual?: ReportVisual;
      readonly warnings: readonly string[];
      readonly error?: string;
      /** More of what was read than the picture shows, for the summary only. */
      readonly facts?: unknown;
    }
  | { readonly kind: "text"; readonly markdown: string };

export interface ReportPart {
  readonly key: string;
  /** A whole tab's name, over its summary. */
  readonly heading?: string;
  /** What the reader most wants to know, in their words. */
  readonly emphasis?: string;
  /** Whether this part gets a summary of its own. Notes do not. */
  readonly summarize: boolean;
  readonly sections: readonly ReportSection[];
}

export interface BuildDeps {
  readonly dashboards: () => readonly DashboardSpec[];
  readonly readWidget: WidgetReader;
  readonly snapshots: SnapshotStore;
  readonly tracked: (id: string) => Promise<TrackedValue | null>;
  readonly now: () => number;
  readonly locale?: string;
}

const BARS = 6;
const LIST_ITEMS = 5;
const TREND_POINTS = 24;
/** Rows the summary may read, past what the picture shows: enough to answer "did X come up?". */
const FACT_ROWS = 40;
const TEXT_CHARS = 80;
const DAY_MS = 86_400_000;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One line of text: whitespace folded, long text cut. */
const line = (value: string, max = TEXT_CHARS): string => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

const shortDay = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const plain = (value: number): string => (Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 }));

const numberOf = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/[,$%\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** The kept point on or before a day, or the first one after it when history starts later. */
const pointAt = (points: readonly HistoryPoint[], day: string, today: string): HistoryPoint | null => {
  let found: HistoryPoint | null = null;
  for (const point of points) if (point.day <= day) found = point;
  if (found) return found;
  const first = points[0];
  return first && first.day < today ? first : null;
};

const changeText = (now: number, then: number, since: string, show: (value: number) => string): Change["text"] => {
  const delta = now - then;
  if (delta === 0) return `No change since ${since}`;
  const percent = then !== 0 ? ` (${delta > 0 ? "+" : "−"}${Math.abs(Math.round((delta / Math.abs(then)) * 100))}%)` : "";
  return `${delta > 0 ? "+" : "−"}${show(Math.abs(delta))}${percent} since ${since}`;
};

export const changeOf = (now: number, then: HistoryPoint | null, show: (value: number) => string): Change | null => {
  if (!then) return null;
  const delta = now - then.value;
  return { from: then.value, fromDay: then.day, text: changeText(now, then.value, shortDay(then.day), show), direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat" };
};

/** The widgets of a tab, in the order it shows them: top to bottom, left to right. */
export const widgetsInOrder = (dashboard: DashboardSpec): WidgetSpec[] => {
  const place = new Map(dashboard.layout.cells.map((cell) => [cell.widgetId, cell.y * 100 + cell.x]));
  return [...dashboard.widgets].sort((a, b) => (place.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (place.get(b.id) ?? Number.MAX_SAFE_INTEGER));
};

/** The column a widget binds to a role, the first of several, or null. */
const roleColumn = (widget: WidgetSpec, ...roles: string[]): string | null => {
  for (const role of roles) {
    const bound = widget.roles[role];
    if (typeof bound === "string" && bound) return bound;
    if (Array.isArray(bound) && typeof bound[0] === "string") return bound[0];
  }
  return null;
};

const ONE_NUMBER = new Set(["stat", "gauge"]);
const OVER_TIME = new Set(["timeseries"]);
const BY_CATEGORY: Readonly<Record<string, readonly [label: readonly string[], value: readonly string[]]>> = {
  bar: [["category"], ["value"]],
  funnel: [["stage"], ["value"]],
  distribution: [["bucket"], ["count"]],
  metricRow: [["label"], ["value"]],
  progress: [["label"], ["value"]],
};

/** The picture of what a widget read, and the rows its summary may look at. */
export const visualOf = (widget: WidgetSpec, reading: WidgetReading, show: (value: unknown, column: string) => string): { visual: ReportVisual; facts: unknown } => {
  const rows = reading.rows;
  const columns = reading.columns.filter((column) => !column.name.startsWith("__"));
  const labelOf = (name: string) => columns.find((column) => column.name === name)?.label ?? humanLabel(name);

  if (ONE_NUMBER.has(widget.component)) {
    const column = roleColumn(widget, "value") ?? "value";
    const value = rows[0]?.[column];
    return { visual: { kind: "number", value: value === undefined ? "—" : show(value, column), raw: numberOf(value), change: null }, facts: { now: value ?? null } };
  }

  if (OVER_TIME.has(widget.component)) {
    const time = roleColumn(widget, "time") ?? columns[0]?.name ?? "time";
    const valueColumn = roleColumn(widget, "value") ?? columns.find((column) => column.name !== time)?.name ?? "value";
    /* Several series add up per point: the report says how the whole moved. */
    const byTime = new Map<string, { label: string; value: number }>();
    for (const row of rows) {
      const key = String(row[time] ?? "");
      const value = numberOf(row[valueColumn]);
      if (!key || value === null) continue;
      const held = byTime.get(key);
      byTime.set(key, { label: show(row[time], time), value: (held?.value ?? 0) + value });
    }
    const points = [...byTime.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, point]) => point).slice(-TREND_POINTS);
    const first = points[0];
    const last = points[points.length - 1];
    const showNumber = (value: number) => show(value, valueColumn);
    return {
      visual: {
        kind: "trend",
        points,
        latest: last ? showNumber(last.value) : "—",
        change:
          first && last && points.length > 1
            ? { from: first.value, fromDay: first.label, text: changeText(last.value, first.value, first.label, showNumber), direction: last.value > first.value ? "up" : last.value < first.value ? "down" : "flat" }
            : null,
      },
      facts: { series: labelOf(valueColumn), points: points.map((point) => [point.label, point.value]) },
    };
  }

  const roles = BY_CATEGORY[widget.component] ?? (widget.component === "board" ? ([["group"], []] as const) : null);
  if (roles) {
    const label = roleColumn(widget, ...roles[0]) ?? columns[0]?.name ?? "label";
    const valueColumn = roles[1].length > 0 ? (roleColumn(widget, ...roles[1]) ?? columns.find((column) => column.name !== label)?.name ?? null) : null;
    /* No value column (a board): each row is one record, counted by its group. */
    const totals = new Map<string, number>();
    for (const row of rows) {
      const key = line(show(row[label], label), 40) || "(none)";
      const value = valueColumn ? numberOf(row[valueColumn]) : 1;
      if (value === null) continue;
      totals.set(key, (totals.get(key) ?? 0) + value);
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const shown = sorted.slice(0, BARS);
    const rest = sorted.slice(BARS);
    const showNumber = (value: number) => (valueColumn ? show(value, valueColumn) : plain(value));
    return {
      visual: {
        kind: "bars",
        bars: shown.map(([name, value]) => ({ label: name, value, text: showNumber(value) })),
        more: rest.length,
        ...(rest.length > 0 ? { moreText: showNumber(rest.reduce((total, [, value]) => total + value, 0)) } : {}),
      },
      facts: { [valueColumn ? labelOf(valueColumn) : "records"]: Object.fromEntries(sorted.slice(0, 30)) },
    };
  }

  /* Records: how many, the first few by name, and enough for the summary to answer questions about all of them. */
  const title = roleColumn(widget, "title", "label") ?? nameColumn(columns.map((column) => column.name), rows);
  const detailColumns = [roleColumn(widget, "status"), roleColumn(widget, "subtitle", "meta", "time")].filter((one): one is string => Boolean(one) && one !== title);
  const items = rows.slice(0, LIST_ITEMS).map((row) => {
    const detail = detailColumns.map((column) => line(show(row[column], column), 40)).filter((one) => one && one !== "—").join(" · ");
    return { title: title ? line(show(row[title], title)) : `Record ${rows.indexOf(row) + 1}`, ...(detail ? { detail } : {}) };
  });
  const factColumns = columns.slice(0, 8);
  return {
    visual: { kind: "list", count: rows.length, items, more: Math.max(0, rows.length - LIST_ITEMS) },
    facts: {
      count: rows.length,
      /* Every record counted by each field with few values (a status, an owner, a type): "did X come up?" and "who had the most?" are answered from all of them, not the first page. */
      countsByField: countsOf(columns.map((column) => column.name), rows, labelOf),
      columns: factColumns.map((column) => labelOf(column.name)),
      rows: rows.slice(0, FACT_ROWS).map((row) => factColumns.map((column) => line(show(row[column.name], column.name), 60))),
    },
  };
};

const idLike = (name: string): boolean => /(^|[_\s-])id$/i.test(name) || /[a-z]Id$/.test(name) || /^(uuid|guid|key)$/i.test(name);

/** The column that names a record: the first whose values read as words, not numbers or ids. */
const nameColumn = (names: readonly string[], rows: readonly Record<string, unknown>[]): string | null => {
  const sample = rows.slice(0, 20);
  const wordy = names.find(
    (name) => !idLike(name) && sample.length > 0 && sample.filter((row) => typeof row[name] === "string" && numberOf(row[name]) === null && (row[name] as string).trim() !== "").length >= sample.length / 2,
  );
  return wordy ?? names.find((name) => !idLike(name)) ?? names[0] ?? null;
};

/** For each field with at most a dozen values, how many records have each. */
const countsOf = (names: readonly string[], rows: readonly Record<string, unknown>[], labelOf: (name: string) => string): Record<string, Record<string, number>> => {
  const out: Record<string, Record<string, number>> = {};
  if (rows.length < 2) return out;
  for (const name of names.slice(0, 12)) {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = row[name];
      if (value === null || value === undefined || typeof value === "object") continue;
      const key = line(String(value), 40);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (counts.size > 12) break;
    }
    if (counts.size >= 1 && counts.size <= 12 && counts.size < rows.length) out[labelOf(name)] = Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
  }
  return out;
};

/** Each block once: the same widget picked twice, or a widget already inside a whole tab, is read once. */
const blocksOnce = (blocks: Report["blocks"]): Report["blocks"] => {
  const tabs = new Set(blocks.flatMap((block) => (block.kind === "tab" ? [block.dashboard] : [])));
  const seen = new Set<string>();
  return blocks.filter((block, index) => {
    const key =
      block.kind === "tab"
        ? `tab:${block.dashboard}`
        : block.kind === "widget"
          ? tabs.has(block.dashboard)
            ? null
            : `widget:${block.dashboard}:${block.widget}`
          : block.kind === "value"
            ? `value:${block.tracked}:${block.window}`
            : `text:${index}`;
    if (key === null || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const buildParts = async (deps: BuildDeps, report: Pick<Report, "blocks" | "lastSentAt">): Promise<ReportPart[]> => {
  const now = deps.now();
  const today = dayOf(now);
  const boards = new Map(deps.dashboards().map((one) => [one.id, one]));
  /* A number compares with the last time this report went out, or with a week ago. */
  const compareDay = dayOf(report.lastSentAt ? Math.min(Date.parse(report.lastSentAt), now - DAY_MS) : now - 7 * DAY_MS);
  const locale = deps.locale ?? "en-US";

  const widgetSection = async (dashboard: DashboardSpec, widget: WidgetSpec): Promise<ReportSection> => {
    const base = { kind: "widget" as const, title: widget.title, tab: dashboard.title, component: widget.component };
    try {
      const reading = await deps.readWidget(dashboard, widget);
      const show = (value: unknown, column: string) => formatValue(value, widget.format[column] as FormatSpec | undefined, { locale });
      const { visual, facts } = visualOf(widget, reading, show);
      if (visual.kind === "number" && visual.raw !== null) {
        const column = roleColumn(widget, "value") ?? "value";
        const points = await deps.snapshots.list(dashboard.id, widget.id).catch(() => [] as HistoryPoint[]);
        const change = changeOf(visual.raw, pointAt(points, compareDay, today), (one) => show(one, column));
        return { ...base, visual: { ...visual, change }, warnings: reading.warnings, facts: { now: visual.value, change: change?.text ?? null } };
      }
      return { ...base, visual, warnings: reading.warnings, facts };
    } catch (error) {
      return { ...base, warnings: [], error: `Could not be read: ${message(error)}` };
    }
  };

  const valueSection = async (id: string, window: ReportWindow): Promise<ReportSection> => {
    const tracked = await deps.tracked(id);
    if (!tracked) return { kind: "value", name: "A tracked value", visual: null, window, error: "This tracked value was removed." };
    const points = await deps.snapshots.list(TRACKED_DASHBOARD, tracked.id).catch(() => [] as HistoryPoint[]);
    const from = dayOf(now - REPORT_WINDOW_DAYS[window] * DAY_MS);
    const inWindow = points.filter((one) => one.day >= from);
    const latest = points[points.length - 1] ?? null;
    const show = (one: number) => (tracked.unit === "currency" ? `$${plain(one)}` : tracked.unit === "percent" ? `${plain(one)}%` : plain(one));
    const change = latest ? changeOf(latest.value, pointAt(points.filter((one) => one.day < latest.day), from, latest.day), show) : null;
    const first = points[0];
    const visual: ReportVisual | null = !latest
      ? null
      : inWindow.length > 2
        ? { kind: "trend", points: inWindow.slice(-TREND_POINTS).map((one) => ({ label: shortDay(one.day), value: one.value })), latest: show(latest.value), change }
        : { kind: "number", value: show(latest.value), raw: latest.value, change };
    return {
      kind: "value",
      name: tracked.name,
      visual,
      window,
      ...(first && first.day > from ? { since: first.day } : {}),
      ...(latest ? {} : { error: "Nothing has been recorded yet. Dash records it once a day from the day it was first tracked." }),
    };
  };

  const parts: ReportPart[] = [];
  for (const [index, block] of blocksOnce(report.blocks).entries()) {
    const key = `p${index + 1}`;
    const emphasis = "emphasis" in block && block.emphasis ? { emphasis: block.emphasis } : {};
    if (block.kind === "text") {
      parts.push({ key, summarize: false, sections: [{ kind: "text", markdown: block.markdown }] });
      continue;
    }
    if (block.kind === "value") {
      parts.push({ key, summarize: true, ...emphasis, sections: [await valueSection(block.tracked, block.window)] });
      continue;
    }
    const dashboard = boards.get(block.dashboard);
    if (!dashboard) {
      parts.push({ key, summarize: false, sections: [{ kind: "widget", title: "A tab that was removed", tab: block.dashboard, component: "", warnings: [], error: "This tab no longer exists." }] });
      continue;
    }
    if (block.kind === "tab") {
      const sections: ReportSection[] = [];
      for (const widget of widgetsInOrder(dashboard)) sections.push(await widgetSection(dashboard, widget));
      parts.push({ key, heading: dashboard.title, summarize: true, ...emphasis, sections });
      continue;
    }
    const widget = dashboard.widgets.find((one) => one.id === block.widget);
    parts.push({
      key,
      summarize: Boolean(widget),
      ...emphasis,
      sections: [
        widget
          ? await widgetSection(dashboard, widget)
          : { kind: "widget", title: "A widget that was removed", tab: dashboard.title, component: "", warnings: [], error: `This widget is no longer on ${dashboard.title}.` },
      ],
    });
  }
  return parts;
};

/** What a part's summary is written from: the numbers, and more rows than the picture shows. */
export const factsOf = (part: ReportPart): unknown => ({
  ...(part.heading ? { tab: part.heading } : {}),
  ...(part.emphasis ? { readerWantsToKnow: part.emphasis } : {}),
  sections: part.sections.flatMap((section): unknown[] => {
    switch (section.kind) {
      case "text":
        return [];
      case "value":
        return [{ trackedValue: section.name, now: section.visual && "latest" in section.visual ? section.visual.latest : section.visual?.kind === "number" ? section.visual.value : null, change: section.visual && "change" in section.visual ? (section.visual.change?.text ?? null) : null, error: section.error ?? null }];
      case "widget":
        return [{ widget: section.title, ...(section.error ? { error: section.error } : { data: section.facts ?? null }) }];
    }
  }),
});
