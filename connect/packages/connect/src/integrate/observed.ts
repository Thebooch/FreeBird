import { inferShape } from "../agent/index.js";
import { pathSegments, singularNoun, type CatalogEntry, type ConnectionSpec } from "@freebirdai/connect-spec";

/**
 * What a real read showed about an endpoint's records: where they are, and the
 * name and kind of each field.
 *
 * For an endpoint whose documentation declared no fields — one documented in
 * prose, or answering in CSV or one JSON object per line — this is the only
 * account of its records there is, and without it nothing can describe them,
 * so no request can ever reach them (measurement 1). Names and kinds only:
 * the values one account holds are that account's, and this is written to the
 * shared catalog entry.
 */
export interface ObservedShape {
  readonly rowsPath: string;
  readonly rows: number;
  readonly fields: readonly NonNullable<CatalogEntry["ops"][number]["fields"]>[number][];
}

const KINDS = new Set(["string", "number", "boolean", "object", "array", "null"]);

export const observedShape = (body: unknown, rowsPath: string | undefined): ObservedShape | null => {
  const shape = inferShape(body, rowsPath ? { rowsPath } : {});
  if (shape.fields.length === 0) return null;
  return {
    rowsPath: shape.rowsPath,
    rows: shape.rowCount,
    fields: shape.fields.slice(0, 300).map((field) => ({
      name: field.name.slice(0, 200),
      kinds: field.kinds.filter((kind) => KINDS.has(kind)) as ("string" | "number" | "boolean" | "object" | "array" | "null")[],
      nullable: field.nullable,
      ...(field.format ? { format: field.format } : {}),
    })),
  };
};

/**
 * Declared fields the records read hold none of: they describe something
 * else. Connector code that reads a manifest, then the files it lists, returns
 * the shipments in the files; the specification describes the manifest — its
 * `files` and `columns` — and a record type described from that had no weight
 * to add up, so "kilograms delivered" had nothing to reach.
 */
const describesOther = (
  declared: readonly { readonly name: string }[],
  observed: readonly { readonly name: string }[],
): boolean => {
  if (declared.length === 0 || observed.length === 0) return false;
  const top = (name: string) => name.split(".")[0]!.split("[")[0]!;
  const held = new Set(observed.map((field) => top(field.name)));
  return !declared.some((field) => held.has(top(field.name)));
};

/**
 * Observed fields beneath a declared field the declaration leaves open — an
 * object it says nothing inside of (`additionalProperties: true`). Only a read
 * can say what the records hold there. An issue's `fields` held its type,
 * status and project, and a record type described from the declaration alone
 * had none of them, so open bugs could not be told from closed tasks (seen
 * with the trackwell mock API).
 */
const beneathOpen = (
  declared: readonly { readonly name: string }[],
  observed: readonly NonNullable<CatalogEntry["ops"][number]["fields"]>[number][],
): NonNullable<CatalogEntry["ops"][number]["fields"]>[number][] => {
  const named = new Set(declared.map((field) => field.name));
  const open = declared.filter(
    (field) => !declared.some((other) => other.name.startsWith(`${field.name}.`) || other.name.startsWith(`${field.name}[`)),
  );
  return observed.filter(
    (field) => !named.has(field.name) && open.some((parent) => field.name.startsWith(`${parent.name}.`)),
  );
};

/**
 * The entry with observed fields on every endpoint that declared none, or
 * declared only fields its records were read not to hold. Null when nothing
 * changed: an endpoint the specification described, and whose records hold
 * what it described, keeps its own account of itself.
 */
export const withObservedFields = (
  entry: CatalogEntry,
  observed: Readonly<Record<string, ObservedShape>>,
): CatalogEntry | null => {
  let changed = false;
  const ops = entry.ops.map((op) => {
    const shape = observed[op.id];
    if (!shape) return op;
    if (op.fields && op.fields.length > 0 && op.fieldsFrom !== "observed" && !describesOther(op.fields, shape.fields)) {
      /* The declaration stands; what it leaves open inside an object is what the records were read to hold there. */
      const inside = beneathOpen(op.fields, shape.fields);
      if (inside.length === 0) return op;
      changed = true;
      return { ...op, fields: [...op.fields, ...inside] };
    }
    if (op.fieldsFrom === "observed" && JSON.stringify(op.fields) === JSON.stringify(shape.fields)) return op;
    changed = true;
    return { ...op, fields: [...shape.fields], fieldsFrom: "observed" as const };
  });

  /*
   * An endpoint a read showed answering with many records is a collection,
   * whatever its path suggests. `/exports/{id}` read through connector code
   * answered with 640 transactions, but belonged to no resource — so nothing
   * could be described, and no request could reach them (measurement 1).
   */
  const resources = [...entry.resources];
  const taken = new Set(resources.map((one) => one.id));
  for (const op of ops) {
    const shape = observed[op.id];
    if (!shape || shape.rows < 2) continue;
    if (resources.some((one) => one.listOp === op.id || one.detailOp === op.id)) continue;
    const noun = singularNoun(pathSegments(op.path).filter((part) => !part.includes("{")).pop() ?? "record");
    let id = noun.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "record";
    for (let suffix = 2; taken.has(id); suffix++) id = `${noun.slice(0, 56)}-${suffix}`;
    taken.add(id);
    resources.push({ id, title: op.title, listOp: op.id, relations: [], verified: false });
    changed = true;
  }
  return changed ? { ...entry, ops, resources } : null;
};

/**
 * The entry with the reads a check wrote from a GraphQL schema the API
 * answered with, in place of the endpoint each replaced — so every connection
 * made from it reads the same way, and its record types can be described.
 * Null when there were none.
 */
export const withAddedReads = (
  entry: CatalogEntry,
  added: { readonly ops: readonly CatalogEntry["ops"][number][]; readonly resources: readonly CatalogEntry["resources"][number][]; readonly replaced: readonly string[] } | undefined,
): CatalogEntry | null => {
  if (!added || added.ops.length === 0) return null;
  const replaced = new Set(added.replaced);
  const kept = entry.ops.filter((op) => !replaced.has(op.id));
  const taken = new Set(kept.map((op) => op.id));
  const ops = added.ops.filter((op) => !taken.has(op.id));
  const remaining = entry.resources.filter((one) => !one.listOp || !replaced.has(one.listOp));
  const listed = new Set(remaining.map((one) => one.id));
  return {
    ...entry,
    ops: [...kept, ...ops],
    resources: [...remaining, ...added.resources.filter((one) => !listed.has(one.id) && ops.some((op) => op.id === one.listOp))],
  };
};

/**
 * A connection with the resources its catalog entry has and it lacks — where
 * a read showed a collection the documentation did not present as one.
 * Only resources whose endpoint the connection carries.
 */
export const withEntryResources = (connection: ConnectionSpec, entry: CatalogEntry): ConnectionSpec => {
  const missing = entry.resources.filter(
    (resource) =>
      !connection.resources.some((one) => one.id === resource.id) &&
      !!resource.listOp &&
      connection.ops.some((op) => op.id === resource.listOp),
  );
  return missing.length > 0 ? { ...connection, resources: [...connection.resources, ...missing] } : connection;
};
