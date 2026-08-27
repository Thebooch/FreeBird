import { z } from "zod";

/**
 * The semantic type registry.
 *
 * A semantic type is what a number *means*, not how it is printed. Carrying
 * meaning rather than a format string is what lets the authoring agent make
 * good choices (it picks "currency", not "$#,##0.00"), lets components pick
 * sensible axes and default aggregations, and keeps formatting consistent
 * across a whole dashboard instead of per-widget.
 *
 * This registry is the single largest source of the "polish" the project is
 * selling, and it is the cleanest place for outside contributions.
 */
export const semanticTypeSchema = z.enum([
  "currency",
  "percent",
  "duration",
  "bytes",
  "count",
  "number",
  "timestamp",
  "relative_time",
  "identifier",
  "status_enum",
  "url",
  "text",
]);

export type SemanticType = z.infer<typeof semanticTypeSchema>;

/** The shape of a value, used to check a binding against a role contract. */
export const valueTypeSchema = z.enum([
  "numeric",
  "temporal",
  "categorical",
  "text",
  "boolean",
  "unknown",
]);

export type ValueType = z.infer<typeof valueTypeSchema>;

export const aggregationSchema = z.enum([
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "countDistinct",
  "first",
  "last",
]);

export type Aggregation = z.infer<typeof aggregationSchema>;

export const formatSchema = z.object({
  semantic: semanticTypeSchema,
  /** ISO 4217 code. Required in practice for `currency`. */
  currency: z.string().length(3).optional(),
  /** 12300 → "12.3K". */
  compact: z.boolean().optional(),
  decimals: z.number().int().min(0).max(6).optional(),
  unit: z.string().optional(),
  prefix: z.string().max(8).optional(),
  suffix: z.string().max(8).optional(),
});

export type FormatSpec = z.infer<typeof formatSchema>;

export interface SemanticDef {
  readonly valueType: ValueType;
  /** How a chart axis over this type should behave. */
  readonly axis: "linear" | "time" | "category";
  /** What `group` should do with this column when nothing is specified. */
  readonly defaultAggregation: Aggregation;
  /** Components this type reads well in, best first. Guides the agent. */
  readonly affinity: readonly string[];
  readonly description: string;
}

export const SEMANTICS: Readonly<Record<SemanticType, SemanticDef>> = {
  currency: {
    valueType: "numeric",
    axis: "linear",
    defaultAggregation: "sum",
    affinity: ["stat", "timeseries", "bar"],
    description: "An amount of money, already scaled to major units.",
  },
  percent: {
    valueType: "numeric",
    axis: "linear",
    defaultAggregation: "avg",
    affinity: ["stat", "gauge", "timeseries"],
    description: "A percentage expressed 0–100, not 0–1.",
  },
  duration: {
    valueType: "numeric",
    axis: "linear",
    defaultAggregation: "avg",
    affinity: ["stat", "timeseries", "distribution"],
    description: "An elapsed time in milliseconds.",
  },
  bytes: {
    valueType: "numeric",
    axis: "linear",
    defaultAggregation: "sum",
    affinity: ["stat", "bar", "timeseries"],
    description: "A size in bytes.",
  },
  count: {
    valueType: "numeric",
    axis: "linear",
    defaultAggregation: "sum",
    affinity: ["stat", "timeseries", "bar"],
    description: "A whole-number tally of things.",
  },
  number: {
    valueType: "numeric",
    axis: "linear",
    defaultAggregation: "sum",
    affinity: ["stat", "timeseries", "bar"],
    description: "A plain number with no further meaning.",
  },
  timestamp: {
    valueType: "temporal",
    axis: "time",
    defaultAggregation: "min",
    affinity: ["timeseries", "table", "list"],
    description: "A point in time, as epoch milliseconds.",
  },
  relative_time: {
    valueType: "temporal",
    axis: "time",
    defaultAggregation: "max",
    affinity: ["list", "table", "stat"],
    description: "A point in time shown as an offset from now.",
  },
  identifier: {
    valueType: "categorical",
    axis: "category",
    defaultAggregation: "countDistinct",
    affinity: ["table", "list"],
    description: "An opaque id. Never aggregate it numerically.",
  },
  status_enum: {
    valueType: "categorical",
    axis: "category",
    defaultAggregation: "count",
    affinity: ["statusGrid", "bar", "table"],
    description: "A small closed set of states.",
  },
  url: {
    valueType: "text",
    axis: "category",
    defaultAggregation: "first",
    affinity: ["list", "table"],
    description: "A link.",
  },
  text: {
    valueType: "text",
    axis: "category",
    defaultAggregation: "first",
    affinity: ["list", "table"],
    description: "Free text.",
  },
};

const DURATION_UNITS: readonly (readonly [number, string])[] = [
  [86_400_000, "d"],
  [3_600_000, "h"],
  [60_000, "m"],
  [1_000, "s"],
];

const formatDuration = (ms: number): string => {
  const abs = Math.abs(ms);
  if (abs < 1_000) return `${Math.round(ms)}ms`;
  const sign = ms < 0 ? "-" : "";
  const parts: string[] = [];
  let remainder = abs;
  for (const [size, label] of DURATION_UNITS) {
    if (remainder >= size) {
      const whole = Math.floor(remainder / size);
      parts.push(`${whole}${label}`);
      remainder -= whole * size;
    }
    if (parts.length === 2) break;
  }
  return sign + parts.join(" ");
};

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

const formatBytes = (bytes: number, decimals: number | undefined): string => {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(decimals ?? 1)} ${BYTE_UNITS[unit]}`;
};

const RELATIVE_STEPS: readonly (readonly [number, Intl.RelativeTimeFormatUnit])[] = [
  [31_536_000_000, "year"],
  [2_592_000_000, "month"],
  [604_800_000, "week"],
  [86_400_000, "day"],
  [3_600_000, "hour"],
  [60_000, "minute"],
];

const formatRelative = (epochMs: number, now: number, locale: string): string => {
  const delta = epochMs - now;
  const abs = Math.abs(delta);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [size, unit] of RELATIVE_STEPS) {
    if (abs >= size) return rtf.format(Math.round(delta / size), unit);
  }
  return rtf.format(Math.round(delta / 1000), "second");
};

export interface FormatOptions {
  /** Injected clock for `relative_time`. Defaults to Date.now(). */
  readonly now?: number;
  readonly locale?: string;
  readonly timeZone?: string;
}

/**
 * Render a value for display. Always returns a string; a null or unusable
 * value becomes an em dash rather than "null" or "NaN", because a dashboard
 * showing "NaN" reads as broken software even when the data is simply absent.
 */
/**
 * What a container looks like in a cell.
 *
 * `JSON.stringify` was the old fallback, which turned a nested address into a
 * wall of braces and quotes in the middle of a table — unreadable, and wide
 * enough to push every other column off the screen. A row is a summary; the
 * whole object belongs in the tooltip or a record view, not in a cell.
 *
 * `{…}` and `[…]` are already this codebase's mark for an elided container
 * (`inferShape`'s sampler uses them), so the two agree.
 */
const summarise = (value: unknown): string => {
  if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${value.length} items`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return "{}";
    // Name the first couple of keys: "{…}" alone tells the reader nothing
    // about whether the column is worth expanding.
    const shown = keys.slice(0, 2).join(", ");
    return keys.length > 2 ? `{${shown}, …}` : `{${shown}}`;
  }
  return String(value);
};

export const formatValue = (
  value: unknown,
  format: FormatSpec | undefined,
  options: FormatOptions = {},
): string => {
  if (value === null || value === undefined || value === "") return "—";

  const locale = options.locale ?? "en-US";
  const semantic = format?.semantic ?? "text";

  if (semantic === "timestamp" || semantic === "relative_time") {
    const ms = typeof value === "number" ? value : Date.parse(String(value));
    if (!Number.isFinite(ms)) return "—";
    if (semantic === "relative_time") {
      return formatRelative(ms, options.now ?? Date.now(), locale);
    }
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(new Date(ms));
  }

  if (SEMANTICS[semantic].valueType === "numeric") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "—";

    let body: string;
    if (semantic === "duration") {
      body = formatDuration(n);
    } else if (semantic === "bytes") {
      body = formatBytes(n, format?.decimals);
    } else if (semantic === "currency") {
      body = new Intl.NumberFormat(locale, {
        style: "currency",
        currency: format?.currency ?? "USD",
        notation: format?.compact ? "compact" : "standard",
        ...(format?.decimals !== undefined
          ? { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals }
          : {}),
      }).format(n);
    } else {
      // Compact notation needs a fraction digit to be worth anything: a count
      // forced to 0 decimals renders 1234 as "1K" rather than "1.2K".
      const fraction =
        format?.decimals !== undefined
          ? { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals }
          : format?.compact
            ? { maximumFractionDigits: 1 }
            : { maximumFractionDigits: semantic === "count" ? 0 : 2 };
      body = new Intl.NumberFormat(locale, {
        notation: format?.compact ? "compact" : "standard",
        ...fraction,
      }).format(n);
      if (semantic === "percent") body += "%";
    }

    if (format?.unit) body += ` ${format.unit}`;
    return `${format?.prefix ?? ""}${body}${format?.suffix ?? ""}`;
  }

  const text = typeof value === "string" ? value : summarise(value);
  return `${format?.prefix ?? ""}${text}${format?.suffix ?? ""}`;
};

/**
 * Best-effort semantic guess from a column name and a sample value. Used to
 * pre-fill the agent's proposal and to give hand-written specs a sane
 * default — never to override anything a user confirmed.
 */
export const guessSemantic = (name: string, sample: unknown): SemanticType => {
  const lower = name.toLowerCase();
  if (/(^|_)(id|uuid|guid)$/.test(lower) || lower.endsWith("_id")) return "identifier";
  if (/(url|link|href)/.test(lower)) return "url";
  if (/(status|state|stage|kind|type)$/.test(lower)) return "status_enum";
  if (/(_at|_on|date|time|timestamp|created|updated)/.test(lower)) return "timestamp";
  if (/(amount|price|cost|revenue|total|balance|fee|mrr|arr)/.test(lower)) return "currency";
  if (/(percent|pct|rate|ratio)/.test(lower)) return "percent";
  if (/(bytes|size)/.test(lower)) return "bytes";
  if (/(duration|elapsed|latency|ms$)/.test(lower)) return "duration";
  if (/(count|total|qty|quantity|num|number_of)/.test(lower)) return "count";
  if (typeof sample === "number") return "number";
  return "text";
};

/* ── status vocabulary ───────────────────────────────────────────────────
 *
 * Which English words mean "fine", "look at this" and "this is broken".
 *
 * Lives here rather than with the components because it is a judgement about
 * a *value*, not about how one is drawn — and three callers now need it: the
 * status-bearing widgets, the highlight suggestions, and anything that has to
 * pick a tone without importing React.
 *
 * The colours and glyphs that go with each tone stay in the component library,
 * which is where rendering belongs.
 */

export type StatusTone = "good" | "warning" | "serious" | "critical" | "neutral";

const GOOD =
  /^(succeed|success|active|ok|healthy|pass|complete|done|paid|live|up|open|available|running|resolved|approved|merged)/;
const WARNING =
  /^(pending|warn|queued|waiting|degraded|partial|draft|stale|throttl|retry|in.?progress|review)/;
const SERIOUS = /^(overdue|late|blocked|at.?risk|expiring|deprecat|paused|suspend)/;
const CRITICAL =
  /^(fail|error|critical|down|cancel|denied|rejected|expired|dead|unavailable|closed|refund|dispute|churn)/;

/**
 * Map a value onto a reserved tone.
 *
 * Deliberately conservative: anything unrecognised stays neutral rather than
 * being guessed into a colour that would tell the reader something untrue.
 * That conservatism makes it a good *ranker* and a poor *gate* — a suggestion
 * engine should offer an unrecognised value and ask, not suppress it.
 */
export const statusTone = (value: unknown): StatusTone => {
  if (value === null || value === undefined) return "neutral";
  if (typeof value === "boolean") return value ? "good" : "critical";
  const text = String(value).trim().toLowerCase();
  if (CRITICAL.test(text)) return "critical";
  if (SERIOUS.test(text)) return "serious";
  if (WARNING.test(text)) return "warning";
  if (GOOD.test(text)) return "good";
  return "neutral";
};
