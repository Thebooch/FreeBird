import { sha256Hex } from "./sha256.js";

/**
 * A content digest for approval decisions.
 *
 * The question a grant answers is "is this the same thing I approved?", and
 * `JSON.stringify` cannot answer it: key order follows insertion, so a spec
 * rewritten by a different code path serializes differently while meaning
 * exactly the same. That would revoke approvals for no reason, and an
 * authorization check that cries wolf gets switched off.
 *
 * So the value is canonicalized first — keys sorted, `undefined` dropped the
 * way JSON drops it — and the digest is taken over that. Arrays keep their
 * order, because in a pipeline or a declaration the order is the meaning.
 */

/** Deeper than any real spec or argument object; a cycle would never return. */
const MAX_DEPTH = 100;

const encode = (value: unknown, depth: number): string => {
  if (depth > MAX_DEPTH) {
    throw new Error("canonicalize: value nested deeper than 100 levels");
  }
  if (value === null) return "null";

  const type = typeof value;
  if (type === "boolean" || type === "string") return JSON.stringify(value);
  if (type === "number") {
    // NaN and Infinity have no JSON form; JSON.stringify emits null for both.
    return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  }
  // undefined, function, symbol: only reachable inside an array, where JSON
  // also collapses them to null. In an object they are dropped below.
  if (type !== "object") return "null";

  // Dates and anything else with toJSON serialize as JSON would serialize them.
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    return encode(withToJson.toJSON(), depth + 1);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => encode(entry, depth + 1)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`)
    .join(",");
  return `{${body}}`;
};

/** Stable, key-sorted JSON. Same meaning always produces the same string. */
export const canonicalize = (value: unknown): string => encode(value, 0);

/** Lowercase hex SHA-256 over the canonical form of `value`. */
export const digest = (value: unknown): string => sha256Hex(canonicalize(value));
