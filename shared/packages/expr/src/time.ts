/**
 * Time bucketing, shared by the `dateTrunc` expression function and the
 * runtime's `group` op so both agree exactly on what "a day" means.
 *
 * Everything is UTC. Weeks start Monday (ISO 8601). Timezone-aware bucketing
 * is a spec-level concern the runtime layers on top.
 */
export type Grain = "1h" | "1d" | "1w" | "1mo" | "1y";

export const GRAINS: readonly Grain[] = ["1h", "1d", "1w", "1mo", "1y"];

const GRAIN_ALIASES: Record<string, Grain> = {
  "1h": "1h",
  hour: "1h",
  hourly: "1h",
  "1d": "1d",
  day: "1d",
  daily: "1d",
  "1w": "1w",
  week: "1w",
  weekly: "1w",
  "1mo": "1mo",
  "1m": "1mo",
  month: "1mo",
  monthly: "1mo",
  "1y": "1y",
  year: "1y",
  yearly: "1y",
};

export const parseGrain = (raw: unknown): Grain | null => {
  if (typeof raw !== "string") return null;
  return GRAIN_ALIASES[raw.trim().toLowerCase()] ?? null;
};

/**
 * Coerce a value to epoch milliseconds.
 *
 * Numbers are treated as milliseconds, never seconds — the ambiguity is
 * resolved explicitly and once, by the pipeline's `coerce` op
 * (`unix_s->datetime`), so that guessing never happens here.
 */
export const toEpochMs = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

export const truncateToBucket = (epochMs: number, grain: Grain): number => {
  const d = new Date(epochMs);
  switch (grain) {
    case "1h":
      return Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        d.getUTCHours(),
      );
    case "1d":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case "1w": {
      const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      // getUTCDay(): 0 = Sunday. Shift so Monday is 0.
      const offsetDays = (d.getUTCDay() + 6) % 7;
      return dayStart - offsetDays * 86_400_000;
    }
    case "1mo":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case "1y":
      return Date.UTC(d.getUTCFullYear(), 0, 1);
  }
};

/** Step forward one grain from a bucket start — used to fill gaps in series. */
export const advanceBucket = (epochMs: number, grain: Grain): number => {
  const d = new Date(epochMs);
  switch (grain) {
    case "1h":
      return epochMs + 3_600_000;
    case "1d":
      return epochMs + 86_400_000;
    case "1w":
      return epochMs + 7 * 86_400_000;
    case "1mo":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    case "1y":
      return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  }
};
