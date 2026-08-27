import { z } from "zod";

/**
 * Coercions are the answer to "is `amount: 4200` forty-two dollars or
 * forty-two hundred?" — asked once, confirmed by a human, then frozen into
 * the spec. Getting this wrong produces a dashboard that renders beautifully
 * and is off by 100×, which is the single most damaging failure mode in the
 * whole product, so the token set is small, explicit, and never inferred at
 * run time.
 */
export const coercionSchema = z.enum([
  // → epoch milliseconds
  "unix_s->datetime",
  "unix_ms->datetime",
  "iso->datetime",
  "auto->datetime",
  // → number
  "->number",
  "money:cents->major",
  "money:major",
  "percent:fraction->percent",
  "percent",
  // → string
  "->string",
  "trim",
  "lower",
  "upper",
  // → boolean
  "->boolean",
]);

export type Coercion = z.infer<typeof coercionSchema>;

export const COERCION_DESCRIPTIONS: Readonly<Record<Coercion, string>> = {
  "unix_s->datetime": "Unix seconds to a timestamp.",
  "unix_ms->datetime": "Unix milliseconds to a timestamp.",
  "iso->datetime": "An ISO 8601 string to a timestamp.",
  "auto->datetime": "Best-effort date parse. Prefer an explicit token.",
  "->number": "Parse a numeric string.",
  "money:cents->major": "Minor units to major units — 4200 becomes 42.",
  "money:major": "Already in major units — pass through.",
  "percent:fraction->percent": "A 0–1 fraction to 0–100.",
  percent: "Already 0–100 — pass through.",
  "->string": "Stringify.",
  trim: "Strip surrounding whitespace.",
  lower: "Lowercase.",
  upper: "Uppercase.",
  "->boolean": 'Parse true/false, "true"/"false", 1/0, "yes"/"no".',
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // Tolerate the thousands separators and currency symbols real APIs emit.
    const cleaned = trimmed.replace(/[,\s$€£¥]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const TRUE_VALUES = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "n", "off"]);

/**
 * Apply a coercion. A value that cannot be coerced becomes `null` rather
 * than throwing — one ragged row must never take down a widget. The runtime
 * counts nulls produced here and surfaces them in the inspector, so silent
 * data loss is visible rather than invisible.
 */
export const applyCoercion = (value: unknown, coercion: Coercion): unknown => {
  if (value === null || value === undefined) return null;

  switch (coercion) {
    case "unix_s->datetime": {
      const n = toFiniteNumber(value);
      return n === null ? null : n * 1000;
    }
    case "unix_ms->datetime": {
      const n = toFiniteNumber(value);
      return n === null ? null : n;
    }
    case "iso->datetime":
    case "auto->datetime": {
      if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : null;
      }
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      const parsed = Date.parse(String(value));
      return Number.isNaN(parsed) ? null : parsed;
    }
    case "->number":
    case "money:major":
    case "percent":
      return toFiniteNumber(value);
    case "money:cents->major": {
      const n = toFiniteNumber(value);
      return n === null ? null : n / 100;
    }
    case "percent:fraction->percent": {
      const n = toFiniteNumber(value);
      return n === null ? null : n * 100;
    }
    case "->string":
      return typeof value === "string" ? value : JSON.stringify(value) ?? null;
    case "trim":
      return typeof value === "string" ? value.trim() : value;
    case "lower":
      return typeof value === "string" ? value.toLowerCase() : value;
    case "upper":
      return typeof value === "string" ? value.toUpperCase() : value;
    case "->boolean": {
      if (typeof value === "boolean") return value;
      const text = String(value).trim().toLowerCase();
      if (TRUE_VALUES.has(text)) return true;
      if (FALSE_VALUES.has(text)) return false;
      return null;
    }
  }
};
