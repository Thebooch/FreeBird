import type { MappedField } from "@freebirdai/dash-spec";

/**
 * The fields an endpoint declares it returns, read out of its response schema.
 *
 * This is the cheap half of mapping an API. The importer already resolves each
 * response schema to work out where the rows live — it just threw the rest
 * away. On a real API that resolution covers most endpoints for **zero**
 * requests, and it covers the ones that cannot be called at all without an id
 * first, which is the majority.
 *
 * What comes out is a *declaration*, never an observation. Nothing here has
 * seen a value, so nothing here reports a cardinality or an example — the
 * shape it produces has no room to. A spec is a description, and the first
 * real render remains the oracle.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * Two levels of nesting, matching what `inferShape` flattens to.
 *
 * One level was not enough, and the gap was specific rather than general: a
 * record's own container sits one hop down and the thing worth reading sits
 * inside *that*. An address is the everyday case — a listing carries a
 * property, the property carries an address, and the street is two dots deep —
 * so at one level the map recorded `Property.Address` as an object with
 * nothing under it and the address existed nowhere in the system.
 *
 * Cheap, because it is narrow: across a 230-endpoint API only eleven distinct
 * fields are containers at the second level, almost all of them addresses.
 * Deeper than this is where a schema starts describing its own plumbing.
 */
const MAX_DEPTH = 2;

/** A ceiling on breadth, so a pathological spec cannot produce a huge entry. */
const MAX_FIELDS = 300;

/**
 * A JSON Schema type plus format, mapped onto this product's vocabulary.
 *
 * The format half is deliberately conservative. `date-time` really does mean a
 * timestamp, so it earns `iso8601`; a bare `integer` could be a count, an id or
 * money, and calling it `minor_units` on a guess would put a currency symbol in
 * front of somebody's unit number.
 */
const kindsAndFormat = (
  schema: Json,
): { kinds: MappedField["kinds"]; format?: MappedField["format"]; nullable: boolean } => {
  const declared = schema.type;
  const list = Array.isArray(declared)
    ? declared.filter((entry): entry is string => typeof entry === "string")
    : typeof declared === "string"
      ? [declared]
      : [];

  const nullable = list.includes("null") || schema.nullable === true;
  const kinds: MappedField["kinds"] = [];
  for (const entry of list) {
    if (entry === "integer" || entry === "number") kinds.push("number");
    else if (entry === "string") kinds.push("string");
    else if (entry === "boolean") kinds.push("boolean");
    else if (entry === "object") kinds.push("object");
    else if (entry === "array") kinds.push("array");
    else if (entry === "null") kinds.push("null");
  }

  const format = str(schema.format);
  const mapped: MappedField["format"] | undefined =
    format === "date-time" || format === "date"
      ? "iso8601"
      : format === "email"
        ? "email"
        : format === "uri" || format === "url"
          ? "url"
          : undefined;

  /*
   * A schema that never says what it is, read from what it has.
   *
   * `type` is optional in OpenAPI and object definitions routinely omit it —
   * a `$ref` to something carrying only `properties` is the normal way to
   * model a nested record. Falling back to "string" for those was quietly
   * expensive: `Category: { Id, Name }` became a string, so the walk never
   * descended into it and `Category.Name` never reached the map at all.
   *
   * That is the field somebody means by "maintenance tasks", and its absence
   * is why a drill-down could only reach for whatever flat field was nearest.
   * Structure is the better evidence anyway: a thing with properties is an
   * object whatever it declares.
   */
  const inferred: MappedField["kinds"] =
    kinds.length > 0
      ? kinds
      : isObject(schema.properties)
        ? ["object"]
        : schema.items !== undefined
          ? ["array"]
          : ["string"];

  return {
    kinds: inferred,
    ...(mapped ? { format: mapped } : {}),
    nullable,
  };
};

/**
 * Walk a response schema into a flat field list.
 *
 * `resolve` is injected rather than imported so this stays testable without a
 * whole document, and so the importer's own `$ref` handling — with its cycle
 * guard and depth limit — remains the single implementation.
 */
export const fieldsFromSchema = (
  schema: unknown,
  resolve: (node: unknown) => unknown,
  rowsPath?: string,
): MappedField[] => {
  const root = resolve(schema);
  if (!isObject(root)) return [];

  /*
   * Descend to the rows before reading fields.
   *
   * A widget binds to a *row*, not to the envelope around it. `rowsPath` is
   * already worked out by the same pass that hands the schema over, so
   * following it here means the field names line up with what the pipeline
   * will actually produce after its extract step.
   */
  let node: Json = root;
  if (rowsPath && rowsPath !== "$") {
    const key = rowsPath.replace(/^\$\./, "");
    const properties = isObject(node.properties) ? node.properties : null;
    const target = properties ? resolve(properties[key]) : null;
    if (isObject(target)) node = target;
  }

  // A collection's rows are its `items`; a detail response is the row itself.
  if (str(node.type) === "array") {
    const items = resolve(node.items);
    if (isObject(items)) node = items;
  }

  const out: MappedField[] = [];

  const walk = (current: Json, prefix: string, depth: number): void => {
    const properties = isObject(current.properties) ? current.properties : null;
    if (!properties) return;
    const required = new Set(
      Array.isArray(current.required)
        ? current.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );

    for (const [name, raw] of Object.entries(properties)) {
      if (out.length >= MAX_FIELDS) return;
      const child = resolve(raw);
      if (!isObject(child)) continue;

      const full = prefix ? `${prefix}.${name}` : name;
      const { kinds, format, nullable } = kindsAndFormat(child);
      const description = str(child.description);

      out.push({
        name: full,
        kinds,
        ...(format ? { format } : {}),
        // Absent from `required` is the spec's way of saying "may not be here",
        // which is the same thing a null is for a widget binding.
        nullable: nullable || !required.has(name),
        ...(description ? { description: description.slice(0, 300) } : {}),
      });

      /*
       * One level down, and only for objects.
       *
       * `inferShape` flattens exactly one level, so `Address.City` is bindable
       * and `Address.Geo.Lat` is not. Going deeper here would offer fields the
       * runtime cannot produce.
       */
      if (depth < MAX_DEPTH && kinds.includes("object")) walk(child, full, depth + 1);
    }
  };

  walk(node, "", 0);
  return out;
};
