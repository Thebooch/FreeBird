import type { ColumnReference } from "./contracts.js";

/**
 * Reading the ids out of a cell, and deciding what they point at.
 *
 * Two rules, shared by the two sides of the same feature: the component that
 * draws a reference and the hook that fetches the names behind one. A second
 * copy of either would drift on the cases that fail silently — a list compared
 * as a single value matches nothing, and a polymorphic row resolved to the
 * wrong record type is labelled confidently and wrongly.
 *
 * Lives in `spec` because that is the package both sides already depend on.
 * The component library cannot import the React one, and the React one must
 * not fork the rule to work around that.
 */

/** A row as a renderer sees it: flat column names to values. */
export type ReferenceRow = Readonly<Record<string, unknown>>;

/**
 * The ids held in one cell — one value, or several.
 *
 * An `array` reference holds a list, and comparing the list itself against an
 * id is false for every row on every API. Anything that is not a string or a
 * number is dropped rather than stringified: `[object Object]` is not an id,
 * and treating it as one produces a link that resolves to nothing.
 */
export const referenceIds = (
  value: unknown,
  holds: ColumnReference["holds"],
): (string | number)[] => {
  if (value === null || value === undefined || value === "") return [];

  if (holds === "array") {
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is string | number =>
            (typeof entry === "string" && entry !== "") || typeof entry === "number",
        )
      : [];
  }

  return typeof value === "string" || typeof value === "number" ? [value] : [];
};

/**
 * Which record type one row's reference actually points at, or null.
 *
 * A polymorphic link carries a sibling column saying which kind each row
 * names. Null means that column named something this link cannot follow — its
 * lookup endpoint belongs to the *default* target, so following it would fetch
 * the wrong kind of record, and naming an association "Property 41" because
 * the link usually means a property is precisely the confident wrongness this
 * codebase refuses.
 *
 * An absent or empty type column falls back to the default rather than
 * refusing: the row simply did not say, and the link's own answer is the best
 * evidence there is.
 */
export const targetOfRow = (row: ReferenceRow, reference: ColumnReference): string | null => {
  if (!reference.typeColumn || !reference.typeMap) return reference.target;
  const raw = row[reference.typeColumn];
  if (raw === null || raw === undefined || raw === "") return reference.target;
  return reference.typeMap[String(raw)] ?? null;
};
