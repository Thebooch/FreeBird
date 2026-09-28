import { inferShape } from "@freebirdai/dash-agent";
import { pathSegments, singularNoun, type CatalogEntry, type ConnectionSpec } from "@freebirdai/dash-spec";

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
 * The entry with observed fields on every endpoint that declared none. Null
 * when nothing changed: an endpoint the specification described keeps its own
 * account of itself, whatever a read showed.
 */
export const withObservedFields = (
  entry: CatalogEntry,
  observed: Readonly<Record<string, ObservedShape>>,
): CatalogEntry | null => {
  let changed = false;
  const ops = entry.ops.map((op) => {
    const shape = observed[op.id];
    if (!shape || (op.fields && op.fields.length > 0 && op.fieldsFrom !== "observed")) return op;
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
