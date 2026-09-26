import type { WriteField } from "@freebirdai/dash-spec";

/**
 * The fields a request body takes, read out of its schema.
 *
 * A separate walk from `fieldsFromSchema`, and it has to be. That one reads a
 * *response* for a map of what a record shows, and its readings are right
 * for that and wrong for a form: it folds "not required" into "nullable"
 * (both mean "may be absent" to a widget, and are different promises to an
 * API), calls every date a timestamp and every integer a number, keeps fifty
 * values of an enum, and never looks inside an array. A body needs each of
 * those told apart — a missing required field is a 422 — so it gets its own
 * reader, and the response reader stays byte-for-byte what it was. A change
 * to that output would mark every mapped entry as moved.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** Objects inside objects: `Address.PostalCode`, and one more for `Units[].Address`. */
const MAX_DEPTH = 2;
const MAX_FIELDS = 300;
const MAX_ENUM = 300;

type FieldType = WriteField["type"];

const typeOf = (schema: Json): { type: FieldType; nullable: boolean } => {
  const declared = schema.type;
  const list = Array.isArray(declared)
    ? declared.filter((entry): entry is string => typeof entry === "string")
    : typeof declared === "string"
      ? [declared]
      : [];
  const nullable = list.includes("null") || schema.nullable === true;
  const real = list.find((entry) => entry !== "null");
  if (real === "integer" || real === "number" || real === "boolean" || real === "string") {
    return { type: real, nullable };
  }
  if (real === "array" || schema.items !== undefined) return { type: "array", nullable };
  if (real === "object" || isObject(schema.properties)) return { type: "object", nullable };
  return { type: "string", nullable };
};

const enumOf = (schema: Json): string[] | undefined => {
  const raw = Array.isArray(schema.enum) ? schema.enum : schema.const !== undefined ? [schema.const] : [];
  const values = raw
    .filter((value) => value !== null && typeof value !== "object")
    .map((value) => String(value))
    .filter((value) => value !== "" && value.length <= 200);
  return values.length > 0 ? [...new Set(values)].slice(0, MAX_ENUM) : undefined;
};

const numberOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export interface BodyReading {
  readonly fields: WriteField[];
  /** Set when the body is not something a form can build. */
  readonly unsupported?: string;
  /** Fields or values dropped at the caps, so the importer can say so. */
  readonly truncated: boolean;
}

/**
 * Read a request body's schema. `resolve` is the importer's own `$ref` and
 * `allOf` resolution, so there is one implementation of both.
 */
export const bodyFieldsFromSchema = (
  schema: unknown,
  resolve: (node: unknown) => unknown,
): BodyReading => {
  const root = resolve(schema);
  if (!isObject(root)) return { fields: [], truncated: false };
  if (str(root.type) === "array" || root.items !== undefined) {
    return { fields: [], unsupported: "the body is a list rather than one record", truncated: false };
  }

  const out: WriteField[] = [];
  let truncated = false;

  const walk = (current: Json, prefix: string, depth: number, parentRequired: boolean): void => {
    const properties = isObject(current.properties) ? current.properties : null;
    if (!properties) return;
    const required = new Set(
      Array.isArray(current.required)
        ? current.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );

    for (const [name, raw] of Object.entries(properties)) {
      if (out.length >= MAX_FIELDS) {
        truncated = true;
        return;
      }
      const child = resolve(raw);
      if (!isObject(child)) continue;
      // Written by the API, never by the caller: `Id`, `CreatedDateTime`.
      if (child.readOnly === true) continue;

      const path = prefix ? `${prefix}.${name}` : name;
      const { type, nullable } = typeOf(child);
      const values = enumOf(child);
      if (Array.isArray(child.enum) && child.enum.length > MAX_ENUM) truncated = true;
      const description = str(child.description);
      const format = str(child.format);
      // Required only if its container is: an optional address with a required street is optional.
      const isRequired = parentRequired && required.has(name);

      let items: WriteField["items"];
      let itemObject: Json | undefined;
      if (type === "array") {
        const item = resolve(child.items);
        if (isObject(item)) {
          const itemType = typeOf(item).type;
          if (itemType === "object") itemObject = item;
          else if (itemType !== "array") items = itemType;
        }
      }

      out.push({
        path,
        type,
        required: isRequired,
        ...(nullable ? { nullable: true } : {}),
        ...(format ? { format: format.slice(0, 40) } : {}),
        ...(values ? { enum: values } : {}),
        ...(description ? { description: description.slice(0, 300) } : {}),
        ...(numberOf(child.minimum) !== undefined ? { minimum: numberOf(child.minimum)! } : {}),
        ...(numberOf(child.maximum) !== undefined ? { maximum: numberOf(child.maximum)! } : {}),
        ...(numberOf(child.maxLength) !== undefined ? { maxLength: Math.trunc(numberOf(child.maxLength)!) } : {}),
        ...(items ? { items } : {}),
      });

      if (depth >= MAX_DEPTH) continue;
      if (type === "object") walk(child, path, depth + 1, isRequired);
      // One level into a list of records: `Units[].UnitNumber`.
      else if (itemObject && !prefix.includes("[]")) walk(itemObject, `${path}[]`, depth + 1, true);
    }
  };

  walk(root, "", 0, true);
  return { fields: out, truncated };
};

/** Content types a form can produce. */
export const isJsonBody = (contentType: string): boolean =>
  /^application\/(?:[\w.+-]*\+)?json\b/i.test(contentType) && !/json-patch/i.test(contentType);
