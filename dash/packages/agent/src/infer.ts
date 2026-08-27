import { evalPath, parsePath } from "@freebirdai/dash-expr";
import { fnv1a } from "@freebirdai/dash-spec";

/**
 * Deterministic shape inference.
 *
 * This is stage one of three, and it is where most of the work happens: the
 * LLM never guesses at structure it could have been shown. It gets an inferred
 * schema and a handful of redacted example values, and its only job is to say
 * what the fields *mean*.
 */

export type JsonKind = "string" | "number" | "boolean" | "object" | "array" | "null";

export type FieldFormat =
  | "iso8601"
  | "unix_seconds"
  | "unix_millis"
  | "email"
  | "url"
  | "minor_units";

export interface FieldInfo {
  /** Dotted name relative to a row, e.g. `user.login`. */
  readonly name: string;
  readonly kinds: readonly JsonKind[];
  readonly nullable: boolean;
  readonly format?: FieldFormat;
  readonly distinct: number;
  /** At most three, truncated. Never the whole payload. */
  readonly samples: readonly unknown[];
}

export interface InferredShape {
  /** Best guess at the row array, as a path. */
  readonly rowsPath: string;
  readonly rowCount: number;
  readonly fields: readonly FieldInfo[];
  /** Fingerprint of the field/type set, for drift detection. */
  readonly schemaHash: string;
}

const ROW_KEYS = [
  "data",
  "items",
  "results",
  "records",
  "rows",
  "entries",
  "list",
  "values",
  "objects",
  "edges",
  "nodes",
];

const kindOf = (value: unknown): JsonKind => {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : (typeof value as JsonKind);
};

const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\//i;

const detectFormat = (name: string, values: readonly unknown[]): FieldFormat | undefined => {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return undefined;

  if (present.every((value) => typeof value === "string")) {
    const strings = present as string[];
    if (strings.every((value) => ISO.test(value))) return "iso8601";
    if (strings.every((value) => EMAIL.test(value))) return "email";
    if (strings.every((value) => URL_RE.test(value))) return "url";
    return undefined;
  }

  if (present.every((value) => typeof value === "number")) {
    const numbers = present as number[];
    const lower = name.toLowerCase();
    const timeish = /(_at|_on|date|time|stamp|created|updated|expires)/.test(lower);
    // A timestamp column is the difference between "August" and "1970".
    if (timeish && numbers.every((n) => n > 1e8 && n < 4e9)) return "unix_seconds";
    if (timeish && numbers.every((n) => n > 1e11 && n < 4e12)) return "unix_millis";
    // Whole numbers in a money-shaped column are very likely minor units —
    // proposed, never assumed, because being wrong here is a 100× error.
    const moneyish = /(amount|price|cost|total|fee|revenue|balance|subtotal)/.test(lower);
    if (moneyish && numbers.every((n) => Number.isInteger(n))) return "minor_units";
  }
  return undefined;
};

const truncate = (value: unknown): unknown => {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  if (value !== null && typeof value === "object") return Array.isArray(value) ? "[…]" : "{…}";
  return value;
};

/** Depth-first walk for the largest array of objects in the payload. */
const findRows = (body: unknown): { path: string; rows: unknown[] } => {
  if (Array.isArray(body)) return { path: "$", rows: body };

  let best: { path: string; rows: unknown[]; score: number } | null = null;

  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 4 || node === null || typeof node !== "object") return;

    if (Array.isArray(node)) {
      const objects = node.filter((item) => item !== null && typeof item === "object").length;
      // Prefer arrays of objects, then conventional key names, then size.
      const key = path.split(".").pop() ?? "";
      const score = objects * 10 + (ROW_KEYS.includes(key) ? 1000 : 0) + node.length;
      if (objects > 0 && (!best || score > best.score)) best = { path, rows: node, score };
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      visit(value, `${path}.${key}`, depth + 1);
    }
  };

  visit(body, "$", 0);
  if (best) return { path: (best as { path: string }).path, rows: (best as { rows: unknown[] }).rows };
  // A single object is one row — a summary endpoint, and a perfectly good source.
  return { path: "$", rows: [body] };
};

const MAX_ROWS_SCANNED = 200;
/**
 * Raised with the walk. The largest endpoint on a real 230-endpoint API sat at
 * 52 fields at one level of nesting, so 60 was a cap the deeper walk would
 * clip — silently, by dropping whichever fields happened to come last.
 */
const MAX_FIELDS = 120;

export const inferShape = (body: unknown, options: { rowsPath?: string } = {}): InferredShape => {
  let rowsPath: string;
  let rows: unknown[];

  if (options.rowsPath) {
    rowsPath = options.rowsPath;
    const matches = evalPath(parsePath(rowsPath), body);
    rows = matches.length === 1 && Array.isArray(matches[0]) ? matches[0] : matches;
  } else {
    const found = findRows(body);
    rowsPath = found.path;
    rows = found.rows;
  }

  const scanned = rows.slice(0, MAX_ROWS_SCANNED);
  const collected = new Map<string, { kinds: Set<JsonKind>; values: unknown[]; distinct: Set<string> }>();

  const record = (name: string, value: unknown): void => {
    let entry = collected.get(name);
    if (!entry) {
      if (collected.size >= MAX_FIELDS) return;
      entry = { kinds: new Set(), values: [], distinct: new Set() };
      collected.set(name, entry);
    }
    entry.kinds.add(kindOf(value));
    if (entry.values.length < 3 && value !== null && value !== undefined) entry.values.push(value);
    if (entry.distinct.size < 200) entry.distinct.add(JSON.stringify(value ?? null));
  };

  for (const row of scanned) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      record("value", row);
      continue;
    }
    for (const [key, value] of Object.entries(row)) {
      record(key, value);
      /*
       * Two levels of nesting.
       *
       * One was the obvious depth — `user.login` and `customer.email` are one
       * hop down — and it stopped exactly short of the everyday case where a
       * record carries a container that carries the thing worth reading. An
       * address is the example: one level records that a property *has* an
       * address and nothing about what it says.
       *
       * The container itself is still recorded at each level, so a widget can
       * see that it exists and the field pool can decline to offer it.
       */
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [innerKey, innerValue] of Object.entries(value)) {
          record(`${key}.${innerKey}`, innerValue);
          if (innerValue === null || typeof innerValue !== "object" || Array.isArray(innerValue)) {
            continue;
          }
          for (const [deepKey, deepValue] of Object.entries(innerValue)) {
            if (deepValue === null || typeof deepValue !== "object") {
              record(`${key}.${innerKey}.${deepKey}`, deepValue);
            }
          }
        }
      }
    }
  }

  const fields: FieldInfo[] = [...collected.entries()].map(([name, entry]) => {
    const kinds = [...entry.kinds].filter((kind) => kind !== "null");
    const format = detectFormat(name, entry.values);
    return {
      name,
      kinds: kinds.length > 0 ? kinds : ["null"],
      nullable: entry.kinds.has("null") || entry.kinds.size === 0,
      distinct: entry.distinct.size,
      samples: entry.values.map(truncate),
      ...(format ? { format } : {}),
    };
  });

  const signature = fields
    .map((field) => `${field.name}:${[...field.kinds].sort().join("|")}`)
    .sort()
    .join(",");

  return { rowsPath, rowCount: rows.length, fields, schemaHash: `fnv1a:${fnv1a(signature)}` };
};

/** Has the response changed shape since this binding was built? */
export const schemaDrifted = (previous: string | undefined, current: string): boolean =>
  previous !== undefined && previous !== current;
