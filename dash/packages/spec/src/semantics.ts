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
  "boolean",
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
  boolean: {
    valueType: "boolean",
    axis: "category",
    defaultAggregation: "count",
    affinity: ["table", "list", "statusGrid"],
    description: "One of two states, shown as Active or Inactive.",
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

/**
 * A flag's state, however the API sends it.
 *
 * `true`/`false`, `1`/`0`, and the same as text. Null for anything else,
 * so a field somebody called a flag that holds a 3 prints the 3 rather than a
 * state it does not have.
 */
export const flagValue = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true" || text === "1") return true;
    if (text === "false" || text === "0") return false;
  }
  return null;
};

/** How a flag reads on screen. */
export const flagLabel = (on: boolean): string => (on ? "Active" : "Inactive");

export const formatValue = (
  value: unknown,
  format: FormatSpec | undefined,
  options: FormatOptions = {},
): string => {
  if (value === null || value === undefined || value === "") return "—";

  const locale = options.locale ?? "en-US";
  const semantic = format?.semantic ?? "text";

  /*
   * A flag, said as a state. Rentvine sends its flags as 1 and 0; a field
   * known to be a flag reads "Active" either way.
   */
  if (semantic === "boolean") {
    const on = flagValue(value);
    if (on !== null) return `${format?.prefix ?? ""}${flagLabel(on)}${format?.suffix ?? ""}`;
  }

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

  /*
   * A flag, said the way a person says it rather than "true" or "false".
   */
  const text =
    typeof value === "string"
      ? value
      : typeof value === "boolean"
        ? flagLabel(value)
        : summarise(value);
  return `${format?.prefix ?? ""}${text}${format?.suffix ?? ""}`;
};

/**
 * `PropertyId`, `unit_id`, `id` — a reference, not a measure or a category.
 *
 * Lives here because three unrelated callers need the same reading and a
 * second copy would drift: ranking a field for a numeric role (summing a
 * column of ids gives a number that is wrong in a way nobody notices), and
 * deciding whether a field can carry a filter strip (an identifier tiles once
 * per row, which is not a filter).
 *
 * The guard list is the point. Plenty of ordinary words end in the same three
 * letters — a bid, a grid, an amount that was paid — and reading those as
 * references would hide real columns.
 */
export const looksLikeIdentifier = (name: string): boolean =>
  /(^|[a-z0-9_-])(Id|id|ID)$/.test(name) && !/(bid|paid|valid|grid|rapid|solid)$/i.test(name);

/**
 * A field name with its convention removed, for comparing one to another.
 *
 * `first_name`, `firstName`, `First-Name` and `FIRSTNAME` are one name spelled
 * four ways, and which spelling an API chose says nothing about what the field
 * means. Every rule that matches a name against a *known* name has to go
 * through this or it silently only works on APIs that happen to share the
 * fixture's convention — which is how a snake_case API came to lose the
 * embedded names sitting right there on its rows.
 *
 * Deliberately not for matching a name against a *pattern*: a suffix test like
 * `looksLikeIdentifier` reads the raw name, because stripping separators first
 * would make `is_paid` end in `id`.
 */
export const normaliseName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The last segment of a dotted path, which is where the meaning sits. */
const leafOf = (name: string): string => name.split(".").pop() ?? name;

/**
 * A link the API publishes to itself — `Href`, `Url`, `Uri`.
 *
 * Deliberately only those exact words. `RentalApplicationUrl` is a link
 * somebody follows and belongs on screen; `Href` is how the API refers to its
 * own resource and means nothing to a reader. Matching every name containing
 * "url" would hide the first to remove the second.
 */
export const looksLikeApiLink = (name: string): boolean => /^(href|url|uri)$/i.test(leafOf(name));

/**
 * A field that exists for the API rather than for the person reading it.
 *
 * Used for the *fallbacks* — the columns nobody picked and the record view
 * nobody arranged — where the alternative is showing everything an endpoint
 * returns. On a real API that means ids of other records and links back to
 * itself, which is how a record comes to open on `VendorId: 4711` beside forty
 * of its neighbours.
 *
 * The record's own bare `Id` is kept, and that exception is the useful half of
 * the rule: it is the one identifier a reader does use — to quote in a ticket,
 * or to hand to somebody else — and on an endpoint with no name field it is
 * the only thing telling two rows apart. Every *other* id points at a record
 * this one is not.
 *
 * Never applied to a field somebody chose. A deliberate pick outranks this.
 */
export const isFieldNoise = (name: string): boolean => {
  if (looksLikeApiLink(name)) return true;
  if (!name.includes(".") && /^id$/i.test(name)) return false;
  return looksLikeIdentifier(leafOf(name));
};

/**
 * A name's words, whatever convention spelled it.
 *
 * `workOrderNumber`, `work_order_number`, `WorkOrderNumber` and
 * `WORK-ORDER-NUMBER` are all `work order number`. A run of capitals is one
 * word up to the capital that starts the next, so `GLAccountId` is
 * `gl account id` rather than `g l account id`.
 */
export const nameWords = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);

/** A name that asks a yes/no question starts with one of these: `isVacant`, `hasPets`. */
const FLAG_FIRST_WORDS = new Set([
  "is",
  "has",
  "have",
  "can",
  "should",
  "allow",
  "allows",
  "was",
  "were",
  "will",
  "does",
  "did",
  "needs",
  "requires",
  "must",
]);
/** …or is a state on its own: `active`, `enabled`. */
const FLAG_NAMES = new Set(["active", "enabled", "disabled", "deleted", "archived", "visible"]);

/**
 * Whether a field's name reads as a yes/no question.
 *
 * Whole words, so \`isVacant\` and \`has_pets\` are and \`issueDate\` and \`isoCode\`
 * are not. Used only beside the values themselves: a flag-shaped name holding
 * a 3 still prints the 3.
 */
export const looksLikeFlag = (name: string): boolean => {
  const leaf = name.split(".").pop() ?? name;
  const words = nameWords(leaf);
  if (words.length === 0) return false;
  if (words.length === 1) return FLAG_NAMES.has(words[0]!);
  return FLAG_FIRST_WORDS.has(words[0]!);
};

const IDENTIFIER_WORDS = new Set(["id", "ids", "uuid", "guid"]);
/** `invoiceNumber`, `phone_number`, `order_num`: a reference, not a quantity. */
const REFERENCE_NUMBER_WORDS = new Set(["number", "num"]);
const STATUS_WORDS = new Set(["status", "state", "stage", "kind", "type"]);
const TIME_WORDS = new Set(["date", "time", "datetime", "timestamp"]);
/** Only as the last word: `createdAt`, `DateCreated` — but not `CreatedByUser`. */
const TIME_LAST_WORDS = new Set(["at", "on", "created", "updated", "modified"]);
const CURRENCY_WORDS = new Set([
  "amount",
  "price",
  "cost",
  "revenue",
  "total",
  "balance",
  "fee",
  "fees",
  "mrr",
  "arr",
]);
const PERCENT_WORDS = new Set(["percent", "percentage", "pct", "rate", "ratio"]);
const BYTES_WORDS = new Set(["bytes", "size"]);
const DURATION_WORDS = new Set(["duration", "elapsed", "latency"]);
const COUNT_WORDS = new Set(["count", "total", "qty", "quantity"]);

/**
 * Whether a guess can stand for the value it will print.
 *
 * The guess formats every column nothing else describes, and a number format
 * over text prints "—": a phone number, or an account's name, vanished from
 * the cell because of a word in its column name. A guess the sample
 * contradicts is dropped rather than trusted — the value is the evidence and
 * the name is only a hint. No sample (a name judged on its own) keeps it.
 */
const fitsSample = (semantic: SemanticType, sample: unknown): boolean => {
  if (sample === null || sample === undefined) return true;
  const valueType = SEMANTICS[semantic].valueType;
  if (valueType === "numeric") {
    if (typeof sample === "number") return true;
    return typeof sample === "string" && sample.trim() !== "" && Number.isFinite(Number(sample));
  }
  if (valueType === "temporal") {
    if (typeof sample === "number") return true;
    return typeof sample === "string" && Number.isFinite(Date.parse(sample));
  }
  return true;
};

/**
 * Best-effort semantic guess from a column name and a sample value. Used to
 * pre-fill the agent's proposal and to give hand-written specs a sane
 * default — never to override anything a user confirmed.
 *
 * Matched on words, not on letters inside a lowercased name. Substrings read
 * `count` in "account", `rate` in "corporate", `date` in "candidate", `arr`
 * in "carrier" and `ms` at the end of "items" — and lowercasing first lost
 * the camelCase boundary, so `workOrderID` was never an id. Every rule held
 * only for snake_case, which is the one convention the fixtures used.
 */
export const guessSemantic = (name: string, sample: unknown): SemanticType => {
  const words = nameWords(name);
  const last = words[words.length - 1] ?? "";
  const has = (set: ReadonlySet<string>): boolean => words.some((word) => set.has(word));

  const guessed = ((): SemanticType | null => {
    if (IDENTIFIER_WORDS.has(last)) return "identifier";
    if (REFERENCE_NUMBER_WORDS.has(last)) return "identifier";
    if (words.some((word) => /(url|link|href)s?$/.test(word))) return "url";
    if (STATUS_WORDS.has(last)) return "status_enum";
    if (has(TIME_WORDS) || TIME_LAST_WORDS.has(last)) return "timestamp";
    if (has(CURRENCY_WORDS)) return "currency";
    if (has(PERCENT_WORDS)) return "percent";
    if (has(BYTES_WORDS)) return "bytes";
    if (has(DURATION_WORDS) || last === "ms") return "duration";
    // `num_items`, `numberOfUnits`: a count when the number comes first.
    if (has(COUNT_WORDS) || words[0] === "num" || words[0] === "number") return "count";
    return null;
  })();

  if (guessed && fitsSample(guessed, sample)) return guessed;
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
