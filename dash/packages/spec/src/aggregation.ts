import type { Aggregation } from "./semantics.js";

export interface ParsedAggregation {
  readonly fn: Aggregation;
  /** `count()` takes no argument; every other aggregation takes exactly one. */
  readonly field: string | null;
}

const AGGREGATION_RE = /^([a-zA-Z][a-zA-Z0-9]*)\(\s*([a-zA-Z_][a-zA-Z0-9_.]*)?\s*\)$/;

const KNOWN: ReadonlySet<string> = new Set<Aggregation>([
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "countDistinct",
  "first",
  "last",
]);

/**
 * Parse `sum(net)` / `count()` / `countDistinct(customer_id)`.
 *
 * Returns null on anything unrecognised so callers can turn it into a proper
 * spec validation error with the offending text attached.
 */
export const parseAggregation = (source: string): ParsedAggregation | null => {
  const match = AGGREGATION_RE.exec(source.trim());
  if (!match) return null;
  const [, fn, field] = match;
  if (!fn || !KNOWN.has(fn)) return null;
  if (fn === "count") return { fn: "count", field: field ?? null };
  if (!field) return null;
  return { fn: fn as Aggregation, field };
};

export const isAggregation = (source: string): boolean => parseAggregation(source) !== null;
