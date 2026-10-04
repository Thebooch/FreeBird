import { boardInputs, getOp, readField, type ConnectionSpec } from "@freebirdai/dash-spec";

/**
 * Where an input nobody gives can come from.
 *
 * An endpoint that needs an organisation's id is not unreadable: the
 * organisations list gives one. Such endpoints were left out of checks and
 * offered to no board, so a whole kind of record could never be counted. Here
 * each missing input is matched to a list that can supply it — a relation the
 * documentation declared (`/organisations/{id}/projects`), or a list named for
 * the input (`organisation_id` and the organisations) — and the check reads
 * that list to settle it:
 *
 * - one record: its value, always;
 * - a request that names one ("the Marketing workspace"): that one;
 * - otherwise every one of them, the endpoint read once for each and the
 *   answers put together — a question about the account is about all of it.
 *
 * Nothing is installed from a name alone: the list is read, and its records
 * must hold the field.
 */

export interface InputSource {
  /** The input it supplies. */
  readonly param: string;
  /** The list that supplies it. */
  readonly op: string;
  /** The field of the list's records that holds the value. */
  readonly field: string;
}

/** `account_id`, `accountId`, `organization` → the noun: `account`, `account`, `organization`. */
const stemOf = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[_-]?(id|ids|key|uuid|slug)$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

const singular = (word: string): string =>
  word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("ses") ? word.slice(0, -2) : word.endsWith("s") ? word.slice(0, -1) : word;

/** Whether a record type is the one an input is named for: `org` and organisations, `workspace` and workspaces. */
const namedFor = (stem: string, words: readonly string[]): boolean =>
  stem.length >= 2 &&
  words.some((word) => {
    const one = singular(word.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
    return one === stem || (stem.length >= 3 && (one.startsWith(stem) || stem.startsWith(one)) && Math.min(one.length, stem.length) >= 3);
  });

/**
 * A source for every input the endpoint needs and no board supplies, or null
 * where one has none. Declared relations first; then a list named for the
 * input that can itself be read with nothing given.
 */
export const inputSources = (connection: ConnectionSpec, opId: string): InputSource[] | null => {
  const op = getOp(connection, opId);
  if (!op) return null;
  const missing = boardInputs(op, {});
  if (missing.length === 0) return [];
  const sources: InputSource[] = [];
  for (const name of missing) {
    /* A relation the documentation declared: this endpoint is another record's own list. */
    const related = connection.resources.find(
      (resource) =>
        resource.listOp &&
        resource.listOp !== opId &&
        resource.relations.some((relation) => relation.op === opId && relation.param === name && relation.via !== "fanOut"),
    );
    const stem = stemOf(name);
    const named =
      related ??
      connection.resources.find((resource) => {
        if (!resource.listOp || resource.listOp === opId) return false;
        const list = getOp(connection, resource.listOp);
        return !!list && boardInputs(list, {}).length === 0 && namedFor(stem, [resource.id, resource.title, list.title]);
      });
    if (!named?.listOp) return null;
    const relation = named.relations.find((one) => one.op === opId && one.param === name);
    sources.push({ param: name, op: named.listOp, field: relation?.localField ?? named.idField ?? "id" });
  }
  return sources;
};

/** The field a list's records hold the value in: the one expected, else the usual names for an id. */
export const valueField = (rows: readonly unknown[], expected: string, param: string): string | null => {
  const stem = stemOf(param);
  const candidates = [expected, "id", "uuid", "key", `${stem}_id`, `${stem}Id`, "slug"];
  return candidates.find((field) => rows.some((row) => { const value = readField(row, field); return typeof value === "string" || typeof value === "number"; })) ?? null;
};

const LABEL_FIELDS = ["name", "title", "label", "display_name", "displayName", "slug"];

/**
 * The record a request names, by a word of its own: "the Marketing workspace"
 * names the workspace called Marketing. Only a name of three letters or more,
 * matched whole, and only where exactly one record is named.
 */
export const namedInRequest = (
  rows: readonly unknown[],
  request: string | undefined,
  labelField?: string,
): unknown | null => {
  if (!request) return null;
  const text = request.toLowerCase();
  const named = rows.filter((row) =>
    [labelField, ...LABEL_FIELDS].some((field) => {
      if (!field) return false;
      const value = readField(row, field);
      if (typeof value !== "string" || value.trim().length < 3) return false;
      const escaped = value.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
    }),
  );
  return named.length === 1 ? named[0]! : null;
};
