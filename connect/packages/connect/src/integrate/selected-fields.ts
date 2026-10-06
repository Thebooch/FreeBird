import type { OpSpec } from "@freebirdai/connect-spec";

/**
 * Records that come back as ids alone, unless their fields are asked for
 * (seen with the trackwell mock API).
 *
 * Some search endpoints answer with only what identifies each record — an id,
 * a key, a link — and return the record's fields only when a parameter names
 * them. Read as they come, nothing about the records can be counted by kind:
 * a bug and a task are both an id. The documentation says so, and says which
 * value asks for every field (`*all`, `*`, `all`); the check sends it, and
 * keeps it only when the records come back with their fields.
 */

/** Keys that identify or locate a record, and say nothing else about it. */
const IDENTIFYING = /^(_?id|key|uuid|guid|self|href|url|uri|_?links?|expand|object|kind|@?type)$/i;

/** Whether a record holds nothing but what identifies it. */
export const holdsOnlyIds = (row: unknown): boolean => {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  const entries = Object.entries(row as Record<string, unknown>);
  return entries.length > 0 && entries.every(([key, value]) => IDENTIFYING.test(key) || value === null || (typeof value === "object" && value !== null && Object.keys(value).length === 0));
};

/** A parameter whose name says it chooses the fields returned. */
const SELECTOR_NAME = /^(\$?select|fields|field_?list|include_?fields|properties|attributes|columns)$/i;
/** Or whose documentation does. */
const SELECTOR_SAYS = /\b(fields|properties|attributes|columns)\b[^.]{0,40}\b(return|returned|include|included)\b/i;
/** The documented value that asks for every field: "`*all` returns every field", "use * for all fields". */
const EVERY_VALUE = /(^|[\s"'`(])(\*[A-Za-z]*|all)["'`)]?\s+(?:returns?|gives?|includes?|selects?|for)\s+(?:every|all)\b/i;
const EVERY_ENUM = ["*all", "*", "all", "*navigable"];

/**
 * The parameter that asks for a record's fields, and the value that asks for
 * all of them — both from the documentation. Null where it names neither.
 */
export const fieldSelector = (op: OpSpec): { readonly name: string; readonly all: string } | null => {
  for (const param of op.params) {
    if (param.in !== "query" || param.required) continue;
    const description = param.description ?? "";
    if (!SELECTOR_NAME.test(param.name) && !SELECTOR_SAYS.test(description)) continue;
    const listed = (param.enum ?? []).map(String).find((value) => EVERY_ENUM.includes(value.toLowerCase()));
    const said = EVERY_VALUE.exec(description)?.[2];
    const all = listed ?? said;
    if (all) return { name: param.name, all };
  }
  return null;
};
