import type { Grain } from "@freebirdai/dash-expr";
import { GRAINS, parseGrain } from "@freebirdai/dash-expr";
import { z } from "zod";

/**
 * Dashboard-level parameters are what separate "a dashboard" from "a page
 * with charts on it": one time range and grain that every widget cooperates
 * through, interpolated into both request params and pipeline steps.
 */
export const grainSchema = z.enum(GRAINS as unknown as [Grain, ...Grain[]]);

export const rangePresetSchema = z.enum([
  "1h",
  "24h",
  "7d",
  "30d",
  "90d",
  "12mo",
  "ytd",
  "custom",
]);

export type RangePreset = z.infer<typeof rangePresetSchema>;

export const filterDeclSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "filter keys must be [a-zA-Z_][a-zA-Z0-9_]*"),
  label: z.string().min(1),
  type: z.enum(["text", "number", "select", "boolean"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export type FilterDecl = z.infer<typeof filterDeclSchema>;

export const dashboardParamsSchema = z.object({
  defaultRange: rangePresetSchema.default("30d"),
  /** Omit to let the grain follow the range width. */
  defaultGrain: grainSchema.optional(),
  timeZone: z.string().default("UTC"),
  filters: z.array(filterDeclSchema).default([]),
});

export type DashboardParams = z.infer<typeof dashboardParamsSchema>;

export interface TimeRange {
  readonly start: number;
  readonly end: number;
  readonly grain: Grain;
  readonly preset: RangePreset;
}

export interface ResolvedParams {
  readonly range: TimeRange;
  readonly filters: Readonly<Record<string, string | number | boolean>>;
  /**
   * The row a drill-down was opened from, read by `{{row.<field>}}`.
   *
   * Deliberately a separate scope rather than more entries in `filters`.
   * `filters` is dashboard-global and declared up front — every widget sees
   * the same bag, and the dashboard schema rejects a `{{param.x}}` no filter
   * declares. A row value is neither: it exists only for one call, is not
   * declarable in advance, and must not leak into any other widget's cache
   * key. Absent for every ordinary widget.
   */
  readonly row?: Readonly<Record<string, unknown>>;
}

const PRESET_MS: Readonly<Record<Exclude<RangePreset, "custom" | "ytd">, number>> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
  "12mo": 365 * 86_400_000,
};

/**
 * Pick a grain that yields a readable number of buckets. Roughly 20–120
 * points: fewer looks empty, more turns a line chart into noise.
 */
export const defaultGrainFor = (start: number, end: number): Grain => {
  const span = Math.max(0, end - start);
  if (span <= 2 * 86_400_000) return "1h";
  if (span <= 90 * 86_400_000) return "1d";
  if (span <= 400 * 86_400_000) return "1w";
  if (span <= 5 * 365 * 86_400_000) return "1mo";
  return "1y";
};

export interface ResolveRangeInput {
  readonly preset: RangePreset;
  readonly now: number;
  readonly grain?: Grain | undefined;
  /** Required when preset is "custom". */
  readonly custom?: { readonly start: number; readonly end: number } | undefined;
}

/**
 * Quantise the end of a relative window.
 *
 * A relative preset resolved against the raw clock produces a different window
 * every millisecond, which is both meaningless and expensive: "the last 30
 * days" ending at 10:00:00.000 and ending at 10:00:07.500 are the same
 * question, but they are different cache keys, so every page load re-fetched
 * everything. Rounding the end down to a bucket makes repeated resolution
 * within that bucket produce an identical window.
 *
 * The bucket scales with the span and is clamped, so a 30-day window may end
 * up to fifteen minutes behind the clock — immaterial for a month of data —
 * while a 24-hour window stays within about three minutes of it.
 */
const MIN_BUCKET_MS = 60_000;
const MAX_BUCKET_MS = 15 * 60_000;

export const quantiseEnd = (now: number, spanMs: number): number => {
  const bucket = Math.min(Math.max(Math.round(spanMs / 500), MIN_BUCKET_MS), MAX_BUCKET_MS);
  return Math.floor(now / bucket) * bucket;
};

export const resolveRange = (input: ResolveRangeInput): TimeRange => {
  const { preset, now } = input;

  let start: number;
  let end: number;

  if (preset === "custom") {
    if (!input.custom) throw new Error('a "custom" range needs explicit start and end');
    start = input.custom.start;
    end = input.custom.end;
  } else if (preset === "ytd") {
    start = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
    end = quantiseEnd(now, now - start);
  } else {
    end = quantiseEnd(now, PRESET_MS[preset]);
    start = end - PRESET_MS[preset];
  }

  return {
    start,
    end,
    grain: input.grain ?? defaultGrainFor(start, end),
    preset,
  };
};

/**
 * `{{range.start | unix}}` — a token, optionally piped through one formatter.
 * Deliberately not a template language: no expressions, no nesting, no logic.
 */
const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(?:\|\s*([a-zA-Z_]+)\s*)?\}\}/g;

export const TOKEN_FILTERS = ["unix", "unix_ms", "iso", "date"] as const;
export type TokenFilter = (typeof TOKEN_FILTERS)[number];

export interface ParsedToken {
  readonly raw: string;
  readonly key: string;
  readonly filter: TokenFilter | null;
}

export const parseTokens = (source: string): ParsedToken[] => {
  const tokens: ParsedToken[] = [];
  for (const match of source.matchAll(TOKEN_RE)) {
    const [raw, key, filter] = match;
    tokens.push({
      raw,
      key: key ?? "",
      filter: (TOKEN_FILTERS as readonly string[]).includes(filter ?? "")
        ? (filter as TokenFilter)
        : null,
    });
  }
  return tokens;
};

export const hasTokens = (source: string): boolean => {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(source);
};

const applyFilter = (value: unknown, filter: TokenFilter | null): string => {
  if (value === null || value === undefined) return "";
  if (filter === null) return String(value);
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return String(value);
  switch (filter) {
    case "unix":
      return String(Math.floor(ms / 1000));
    case "unix_ms":
      return String(Math.round(ms));
    case "iso":
      return new Date(ms).toISOString();
    case "date":
      return new Date(ms).toISOString().slice(0, 10);
  }
};

const lookup = (key: string, params: ResolvedParams): unknown => {
  if (key === "range.start") return params.range.start;
  if (key === "range.end") return params.range.end;
  if (key === "range.grain") return params.range.grain;
  if (key === "range.preset") return params.range.preset;
  if (key.startsWith("param.")) return params.filters[key.slice("param.".length)];
  // Row scope: only populated for a drill-down, so an ordinary widget that
  // writes `{{row.x}}` by mistake resolves to nothing rather than silently
  // borrowing a value from somewhere else.
  if (key.startsWith("row.")) return params.row?.[key.slice("row.".length)];
  return undefined;
};

/**
 * Replace every token in a string. Unknown tokens resolve to an empty string
 * rather than being left as literal `{{…}}` in an outgoing request — a
 * dangling brace in a query param is a confusing bug to chase down.
 */
export const interpolate = (source: string, params: ResolvedParams): string =>
  source.replace(TOKEN_RE, (_raw, key: string, filter: string | undefined) =>
    applyFilter(
      lookup(key, params),
      (TOKEN_FILTERS as readonly string[]).includes(filter ?? "")
        ? (filter as TokenFilter)
        : null,
    ),
  );

/** Interpolate a value that may or may not be a string. */
export const interpolateValue = (
  value: string | number | boolean,
  params: ResolvedParams,
): string | number | boolean =>
  typeof value === "string" ? interpolate(value, params) : value;

/**
 * Resolve a bucket grain that may itself be a token — `{{range.grain}}` in a
 * group step is the common case.
 */
export const resolveGrain = (raw: string, params: ResolvedParams): Grain | null =>
  parseGrain(hasTokens(raw) ? interpolate(raw, params) : raw);

/* ── query identity ──────────────────────────────────────────────────── */

export type QueryParams = Readonly<Record<string, string | number | boolean>>;

/** Stable regardless of key insertion order, so two callers really do share a key. */
const stableStringify = (params: QueryParams): string =>
  JSON.stringify(
    Object.keys(params)
      .sort()
      .map((key) => [key, params[key]]),
  );

/**
 * What identifies one request, for deduplication and for caching.
 *
 * The key must cover everything the response can depend on. Interpolated
 * request params are the obvious half. The resolved range and filters are the
 * other half: they are handed to the adapter, so an op can legitimately read
 * them (a list endpoint filtering server-side by date does exactly this).
 * Leaving them out means changing the time range silently serves the old
 * window's numbers under the new window's label — a dashboard that is
 * confidently wrong, which is the worst thing this can be.
 *
 * This lives in `spec` rather than beside the browser cache because the server
 * caches on the same identity, and two implementations that disagree would
 * serve one widget's rows to another — silently, and only for some parameter
 * shapes. One function is the guard.
 */
export const queryKey = (
  connection: string,
  op: string,
  params: QueryParams,
  resolved?: ResolvedParams,
): string => {
  const scope = resolved
    ? `|${resolved.range.start}:${resolved.range.end}:${resolved.range.grain}:${stableStringify(
        resolved.filters,
      )}`
    : "";
  return `${connection}.${op}|${stableStringify(params)}${scope}`;
};
