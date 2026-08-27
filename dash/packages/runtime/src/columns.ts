import type { ColumnMeta, SemanticType, ValueType } from "@freebirdai/dash-spec";
import { SEMANTICS, guessSemantic } from "@freebirdai/dash-spec";
import type { Row } from "./types.js";

/** Distinct values are counted up to here; beyond it the exact number stops mattering. */
const DISTINCT_CAP = 501;

const observedType = (values: readonly unknown[], distinctCount: number): ValueType => {
  if (values.length === 0) return "unknown";

  let numbers = 0;
  let booleans = 0;
  let strings = 0;
  for (const value of values) {
    if (typeof value === "number") numbers++;
    else if (typeof value === "boolean") booleans++;
    else if (typeof value === "string") strings++;
  }

  if (numbers === values.length) return "numeric";
  if (booleans === values.length) return "boolean";
  if (strings === values.length) {
    // A short closed set of strings behaves like a category; a long tail of
    // unique strings is free text. The line matters because it decides which
    // roles the column is allowed to fill.
    const looksClosed = distinctCount <= 50 && distinctCount < Math.max(2, values.length * 0.6);
    return looksClosed ? "categorical" : "text";
  }
  return "unknown";
};

export interface InferColumnsInput {
  readonly rows: readonly Row[];
  /**
   * Semantics the spec asserted — via a coercion, an annotate step, an
   * aggregation, or an explicit format. These are authored intent and always
   * beat a guess made from the column's name.
   */
  readonly semanticHints: Readonly<Record<string, SemanticType>>;
}

/**
 * Describe every column the pipeline produced.
 *
 * This drives three things at once: role-contract validation, the formatting
 * a component applies, and the warnings the inspector shows. Getting the
 * value type right here is what lets a bad binding be rejected mechanically
 * rather than by a human noticing a chart looks wrong.
 */
export const inferColumns = (input: InferColumnsInput): ColumnMeta[] => {
  const { rows, semanticHints } = input;

  // First-seen key order, so columns read in the order the pipeline made them.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }

  return names.map((name): ColumnMeta => {
    const present: unknown[] = [];
    const distinct = new Set<unknown>();
    let nullCount = 0;

    for (const row of rows) {
      const value = row[name];
      if (value === null || value === undefined) {
        nullCount++;
        continue;
      }
      present.push(value);
      if (distinct.size < DISTINCT_CAP) {
        distinct.add(typeof value === "object" ? JSON.stringify(value) : value);
      }
    }

    const distinctCount = distinct.size;
    const observed = observedType(present, distinctCount);
    const hinted = semanticHints[name];
    const semantic = hinted ?? guessSemantic(name, present[0]);

    // Authored intent decides the value type; a name-based guess does not get
    // to overrule what the data actually is.
    const valueType = hinted ? SEMANTICS[hinted].valueType : observed;

    return {
      name,
      valueType,
      semantic,
      nullCount,
      distinctCount,
    };
  });
};
