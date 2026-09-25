import { readField } from "./field-path.js";
import { normaliseName } from "./semantics.js";

/**
 * Where one record is, when its own id is not enough to find it.
 *
 * Most records are fetched by their id alone: `/vendors/{vendorId}`. A record
 * that lives under another one is not — a Rentvine unit is
 * `/properties/{propertyID}/units/{unitID}`, a Buildium lease note is
 * `/leases/{leaseId}/notes/{noteId}` — and on Buildium that is 43 of 109
 * record types. Everything that carried a record used to carry one id, so none
 * of those could ever be opened, looked up or named.
 *
 * `parents` holds the other ids the address needs, by the path parameter each
 * one fills. Two records with the same id under different parents are two
 * records — unit 222 of one property is not unit 222 of the next — so the key
 * is the whole address, never the id alone.
 */
export interface RecordKey {
  readonly id: string;
  readonly parents?: Readonly<Record<string, string>> | undefined;
}

/**
 * One string for a whole address, for indexing and comparing.
 *
 * Parents are sorted, so the same address spelled in a different order is the
 * same key. A record with no parents keys on its id exactly as it always did,
 * so nothing indexed before this changes.
 */
export const recordKeyString = (
  id: string | number,
  parents?: Readonly<Record<string, string>> | undefined,
): string => {
  const entries = Object.entries(parents ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return String(id);
  // NUL-separated, because an id and a parameter value are both arbitrary text.
  return [String(id), ...entries.map(([param, value]) => `${param}=${value}`)].join("\u0000");
};

/**
 * A value for one path parameter, from values known under any spelling.
 *
 * One endpoint says `propertyID` and the next `propertyId` for the same id, so
 * a page's own address is matched to a child's parameter by name with the
 * convention removed, never by exact spelling.
 */
export const valueForParam = (
  known: Readonly<Record<string, unknown>> | undefined,
  param: string,
): string | undefined => {
  if (!known) return undefined;
  const exact = known[param];
  if (present(exact)) return String(exact);
  const wanted = normaliseName(param);
  for (const [name, value] of Object.entries(known)) {
    if (normaliseName(name) === wanted && present(value)) return String(value);
  }
  return undefined;
};

const present = (value: unknown): value is string | number =>
  (typeof value === "string" && value !== "" && !value.includes("{{")) ||
  (typeof value === "number" && Number.isFinite(value));

/**
 * The parent ids an address needs, read off a row and whatever else is known.
 *
 * Each part is looked for on the row first — a unit carries its property's id
 * — and then among `known`: the address of the page it was opened from, or
 * the parameters the list it came from was fetched with. Null when any part is
 * missing, because an address with a hole in it fetches nothing and a request
 * sent anyway comes back as an error that reads like a bad key.
 */
export const parentsFrom = (
  parts: readonly { readonly param: string; readonly field?: string | undefined }[],
  row: unknown,
  known?: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> | null => {
  const parents: Record<string, string> = {};
  for (const part of parts) {
    const onRow = part.field ? readField(row, part.field) : undefined;
    const value = present(onRow) ? String(onRow) : valueForParam(known, part.param);
    if (value === undefined) return null;
    parents[part.param] = value;
  }
  return parents;
};
