import type { z } from "zod";

/**
 * Shallow diff: returns the union of top-level keys whose values differ
 * between `before` and `after` (using `Object.is`).
 *
 * Intentionally shallow — for nested structures hosts should provide their
 * own `readCurrent` shape that mirrors the action's argument shape, or
 * implement a custom diff in their `onActionEvent` handler.
 *
 * @example
 * diffKeys({ a: 1, b: 2 }, { a: 1, b: 3 }) // ["b"]
 * diffKeys({ a: 1 },        { a: 1, b: 2 }) // ["b"]
 */
export const diffKeys = (
  before: unknown,
  after: unknown,
): string[] => {
  if (
    !before ||
    !after ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return Object.is(before, after) ? [] : ["__root__"];
  }
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (!Object.is(a[k], b[k])) out.push(k);
  }
  return out;
};

export interface ValidateArgsResult<T = unknown> {
  ok: boolean;
  data?: T;
  /** Field paths flagged as missing or invalid. */
  missing: string[];
  /** Human-readable error message when `ok === false`. */
  error?: string;
}

/**
 * Validate action arguments against a Zod schema and return a normalized
 * shape both the harness (`missing`) and the server (`data`) can use.
 *
 * Treats Zod errors with `code: "invalid_type"` and `received: "undefined"`
 * as "missing" rather than "invalid", which is the gating signal the
 * collecting-phase prompt uses to nudge the LLM toward more questions.
 */
export const validateActionArgs = <T>(
  schema: z.ZodType<T>,
  raw: unknown,
): ValidateArgsResult<T> => {
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, data: parsed.data, missing: [] };
  }
  const missing: string[] = [];
  const others: string[] = [];
  for (const issue of parsed.error.issues) {
    if (
      issue.code === "invalid_type" &&
      "received" in issue &&
      (issue as { received?: string }).received === "undefined"
    ) {
      missing.push(issue.path.join(".") || "__root__");
    } else {
      others.push(`${issue.path.join(".") || "__root__"}: ${issue.message}`);
    }
  }
  return {
    ok: false,
    missing,
    error: others.length > 0 ? others.join("; ") : undefined,
  };
};
