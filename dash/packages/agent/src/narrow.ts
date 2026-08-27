import { evalPath, parsePath } from "@freebirdai/dash-expr";

/**
 * Finding out what values a field actually holds, so a person can pick one.
 *
 * The problem this solves is not technical. Somebody asks for "maintenance
 * tasks" on an API whose tasks carry a `Category.Name` of "General Inquiry",
 * "Plumbing", "Turnover" — words chosen by whoever set that account up, which
 * no model can guess and no schema declares. The only way to know is to look.
 *
 * Deliberately split: this half is deterministic and never guesses. It reads
 * rows, pulls one field out of each, and counts what it finds. A model chooses
 * *which* field to look at and *which* of the values a request meant, because
 * both are questions about meaning — but neither model call is trusted with
 * what the data says, and the user confirms the answer before it is used.
 */

/** One value a field was seen to hold, and how often. */
export interface FieldValue {
  /** The value as it will be compared and filtered — a string or a number. */
  readonly value: string | number;
  /** How it should read to a person, when that differs from the value. */
  readonly label: string;
  readonly count: number;
}

export interface DistinctValuesResult {
  readonly field: string;
  readonly values: readonly FieldValue[];
  /** Rows examined. The denominator for every count. */
  readonly rowsScanned: number;
  /** Rows where the field was absent or null — often the real answer. */
  readonly missing: number;
  /**
   * Whether the cap was reached, so the list may be incomplete.
   *
   * Reported rather than hidden: a list of forty categories that stops at
   * forty is a different thing from one that stops because there are forty,
   * and offering the first as if it were the second invites a filter that
   * silently excludes records.
   */
  readonly truncated: boolean;
}

/** Beyond this a value list is unreadable and probably the wrong field. */
const MAX_VALUES = 60;

/** Nested one level, matching `inferShape` — `Category.Name` is the case. */
const readField = (row: unknown, field: string): unknown => {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  const record = row as Record<string, unknown>;
  const dot = field.indexOf(".");
  if (dot === -1) return record[field];

  const outer = record[field.slice(0, dot)];
  if (outer === null || typeof outer !== "object" || Array.isArray(outer)) return undefined;
  return (outer as Record<string, unknown>)[field.slice(dot + 1)];
};

/**
 * Every distinct value of one field across a set of rows, with counts.
 *
 * Only scalars. A field holding objects or arrays cannot be what a person
 * picks from — "is it this one or that one" needs values you can show in a
 * list and compare with `=`, and an object is neither.
 */
export const distinctValues = (
  body: unknown,
  field: string,
  options: { rowsPath?: string | undefined; max?: number | undefined } = {},
): DistinctValuesResult => {
  const max = options.max ?? MAX_VALUES;

  let rows: unknown[];
  if (options.rowsPath) {
    const matches = evalPath(parsePath(options.rowsPath), body);
    rows = matches.length === 1 && Array.isArray(matches[0]) ? matches[0] : matches;
  } else {
    rows = Array.isArray(body) ? body : [];
  }

  const counts = new Map<string | number, { label: string; count: number }>();
  let missing = 0;
  let truncated = false;

  for (const row of rows) {
    const raw = readField(row, field);
    if (raw === null || raw === undefined || raw === "") {
      missing++;
      continue;
    }
    if (typeof raw === "object") {
      // A nested object is not a value somebody can choose between.
      missing++;
      continue;
    }

    const value = typeof raw === "number" ? raw : String(raw);
    const existing = counts.get(value);
    if (existing) {
      existing.count++;
      continue;
    }
    if (counts.size >= max) {
      truncated = true;
      continue;
    }
    counts.set(value, { label: typeof raw === "boolean" ? String(raw) : String(value), count: 1 });
  }

  const values = [...counts.entries()]
    .map(([value, entry]) => ({ value, label: entry.label, count: entry.count }))
    // Commonest first: the value somebody means is far more often the one
    // most of their records carry than the one that appeared twice.
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));

  return { field, values, rowsScanned: rows.length, missing, truncated };
};

/**
 * Whether a field looks like something worth offering a choice from.
 *
 * A guard against the obvious failure: proposing to narrow by an id, a
 * timestamp, or a free-text description, each of which produces a list as long
 * as the data and helps nobody. What makes a field choosable is that it repeats
 * — a handful of values across many rows — which is exactly what a category is
 * and exactly what an identifier is not.
 */
export const looksChoosable = (result: DistinctValuesResult): boolean => {
  // Nothing to choose between.
  if (result.values.length < 2) return false;

  /*
   * More values than fit in a list. On a real sample this is the identifier
   * signature — ids, timestamps and free text all run past the cap — and it
   * is a better test than any ratio, because it holds on five rows and on
   * five hundred. A ratio calibrated for one is wrong on the other.
   */
  if (result.truncated) return false;

  // At least one value has to repeat. A field where every record carries
  // something different is an identifier however few records there are.
  const usable = result.rowsScanned - result.missing;
  return usable >= 2 && result.values.length < usable;
};
