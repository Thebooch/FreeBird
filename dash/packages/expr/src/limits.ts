import { ExprParseError } from "./errors.js";

/**
 * Hard caps. The language has no loops, no recursion and no user-defined
 * functions, so evaluation always terminates; these bounds exist to keep a
 * hostile or badly-generated expression from being expensive rather than to
 * make it safe.
 */
export const LIMITS = {
  maxSourceChars: 2_000,
  maxNodes: 500,
  maxDepth: 32,
  maxCallArgs: 8,
  maxArrayLiteral: 100,
  maxStringLength: 100_000,
  maxPathSegments: 32,
} as const;

/**
 * Keys that must never be reachable through a field reference or a quoted
 * path key. Property reads additionally go through `readProp`, which only
 * ever returns own properties — this is the belt to that suspenders.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const assertSafeKey = (key: string, position: number): void => {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new ExprParseError(`"${key}" is not a readable property`, position);
  }
};

/**
 * The only property read in the entire engine. Own properties only, so
 * nothing on a prototype chain is reachable even if a key slipped past the
 * parse-time check.
 */
export const readProp = (target: unknown, key: string): unknown => {
  if (target === null || target === undefined) return undefined;
  if (typeof target !== "object" && typeof target !== "string") return undefined;
  if (typeof target === "string") {
    // Only `length` is meaningful on a string, and `len()` covers it.
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(target, key)) return undefined;
  return (target as Record<string, unknown>)[key];
};
