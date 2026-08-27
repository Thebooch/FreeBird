import { ExprEvalError } from "./errors.js";
import { LIMITS } from "./limits.js";
import { parseGrain, toEpochMs, truncateToBucket } from "./time.js";

export interface EvalContext {
  /** Injected clock. The engine never calls Date.now() itself. */
  readonly now: number;
}

export interface FunctionDef {
  /** [minArgs, maxArgs] */
  readonly arity: readonly [number, number];
  readonly call: (args: readonly unknown[], ctx: EvalContext) => unknown;
}

export const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export const toText = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
};

export const guardStringLength = (value: string): string => {
  if (value.length > LIMITS.maxStringLength) {
    throw new ExprEvalError("string result exceeded the maximum length");
  }
  return value;
};

/**
 * The complete function surface of the language. Adding to this table is the
 * only way to add capability — there are no user-defined functions, no
 * member calls, and no way to reach a host object.
 */
export const FUNCTIONS: Readonly<Record<string, FunctionDef>> = {
  lower: {
    arity: [1, 1],
    call: (args) => {
      const s = toText(args[0]);
      return s === null ? null : s.toLowerCase();
    },
  },
  upper: {
    arity: [1, 1],
    call: (args) => {
      const s = toText(args[0]);
      return s === null ? null : s.toUpperCase();
    },
  },
  trim: {
    arity: [1, 1],
    call: (args) => {
      const s = toText(args[0]);
      return s === null ? null : s.trim();
    },
  },
  /*
   * Compare an identifier without caring how the API typed it.
   *
   * `==` is strict, and the same id routinely arrives as a number on one
   * endpoint and a string on another — so matching a child row against the
   * record it belongs to fails on type alone, silently and with no error to
   * chase. Coercing both sides is the only way to write that comparison once
   * and have it hold for every API.
   */
  string: {
    arity: [1, 1],
    call: (args) => toText(args[0]),
  },
  abs: {
    arity: [1, 1],
    call: (args) => {
      const n = toNumber(args[0]);
      return n === null ? null : Math.abs(n);
    },
  },
  round: {
    arity: [1, 2],
    call: (args) => {
      const n = toNumber(args[0]);
      if (n === null) return null;
      const digits = args.length > 1 ? toNumber(args[1]) : 0;
      const places = Math.max(0, Math.min(10, Math.trunc(digits ?? 0)));
      const factor = 10 ** places;
      return Math.round(n * factor) / factor;
    },
  },
  floor: {
    arity: [1, 1],
    call: (args) => {
      const n = toNumber(args[0]);
      return n === null ? null : Math.floor(n);
    },
  },
  ceil: {
    arity: [1, 1],
    call: (args) => {
      const n = toNumber(args[0]);
      return n === null ? null : Math.ceil(n);
    },
  },
  coalesce: {
    arity: [1, LIMITS.maxCallArgs],
    call: (args) => {
      for (const arg of args) {
        if (arg !== null && arg !== undefined) return arg;
      }
      return null;
    },
  },
  len: {
    arity: [1, 1],
    call: (args) => {
      const value = args[0];
      if (typeof value === "string") return value.length;
      if (Array.isArray(value)) return value.length;
      if (value !== null && typeof value === "object") return Object.keys(value).length;
      return null;
    },
  },
  contains: {
    arity: [2, 2],
    call: (args) => {
      const [haystack, needle] = args;
      if (Array.isArray(haystack)) return haystack.some((item) => item === needle);
      const h = toText(haystack);
      const n = toText(needle);
      if (h === null || n === null) return false;
      return h.includes(n);
    },
  },
  /**
   * Is this id one of the ids in that list?
   *
   * The array-valued foreign key, which is as common in real APIs as the
   * scalar one — `PropertyIds`, `tag_ids`, `assignee_ids` — and which neither
   * `in` nor `contains` can answer, because both compare with `===` and the
   * two sides reliably disagree about type. An id arrives from a parent row
   * through a `{{row.Id}}` token, which is always a string; the array holds
   * whatever JSON the API sent, which is usually numbers. `1 === "1"` is
   * false, so the honest-looking expression matches nothing at all and the
   * section renders permanently empty.
   *
   * So this compares the way the scalar case already does — `string(field) ==
   * "{{row.Id}}"` — just across a list. Deliberately not a change to `in` or
   * `contains`: those mean strict membership everywhere else, and loosening
   * them to fix a join would change every expression anybody has written.
   *
   * Nothing but a scalar can equal an id, so non-scalar entries can never
   * match and are skipped rather than stringified into something that might.
   */
  includesId: {
    arity: [2, 2],
    call: (args) => {
      const [haystack, needle] = args;
      if (!Array.isArray(haystack)) return false;
      const wanted = toText(needle);
      if (wanted === null) return false;
      return haystack.some((item) => toText(item) === wanted);
    },
  },
  startsWith: {
    arity: [2, 2],
    call: (args) => {
      const h = toText(args[0]);
      const n = toText(args[1]);
      return h === null || n === null ? false : h.startsWith(n);
    },
  },
  endsWith: {
    arity: [2, 2],
    call: (args) => {
      const h = toText(args[0]);
      const n = toText(args[1]);
      return h === null || n === null ? false : h.endsWith(n);
    },
  },
  /** Truncate a timestamp to a bucket start, in UTC epoch milliseconds. */
  dateTrunc: {
    arity: [2, 2],
    call: (args) => {
      const ms = toEpochMs(args[0]);
      const grain = parseGrain(args[1]);
      if (ms === null || grain === null) return null;
      return truncateToBucket(ms, grain);
    },
  },
  /** Injected clock, in epoch milliseconds. */
  now: {
    arity: [0, 0],
    call: (_args, ctx) => ctx.now,
  },
};

export const isKnownFunction = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(FUNCTIONS, name);
