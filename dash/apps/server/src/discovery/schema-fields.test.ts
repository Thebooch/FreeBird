import { describe, expect, it } from "vitest";
import { fieldsFromSchema } from "./schema-fields.js";

/**
 * Reading an endpoint's fields out of its declared response.
 *
 * This is the half of API mapping that costs nothing: the importer already
 * resolves each response schema to find the rows, so the field list comes free
 * — and it is the only route to the shape of an endpoint that cannot be called
 * without an id, which on a real API is most of them.
 */

type Json = Record<string, unknown>;

/** The importer's `$ref` resolution, in miniature. */
const resolverFor = (doc: Json) => {
  const resolve = (node: unknown, depth = 0): unknown => {
    if (depth > 8 || node === null || typeof node !== "object" || Array.isArray(node)) return node;
    const ref = (node as Json).$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
    let cursor: unknown = doc;
    for (const part of ref.slice(2).split("/")) {
      if (cursor === null || typeof cursor !== "object") return {};
      cursor = (cursor as Json)[part];
    }
    return resolve(cursor, depth + 1);
  };
  return (node: unknown) => resolve(node);
};

const doc: Json = {
  components: {
    schemas: {
      Lease: {
        type: "object",
        required: ["Id", "LeaseStatus"],
        properties: {
          Id: { type: "integer", description: "The lease's unique identifier." },
          LeaseStatus: { type: "string" },
          LeaseToDate: { type: "string", format: "date" },
          SignedAt: { type: "string", format: "date-time" },
          Contact: { $ref: "#/components/schemas/Contact" },
          Notes: { type: "string", nullable: true },
          Tags: { type: "array" },
        },
      },
      Contact: {
        type: "object",
        required: ["Email"],
        properties: {
          Email: { type: "string", format: "email" },
          Homepage: { type: "string", format: "uri" },
          // One level deeper than the runtime can flatten.
          Address: {
            type: "object",
            properties: { City: { type: "string" } },
          },
        },
      },
      // A schema that refers to itself. Following it must terminate.
      Node: {
        type: "object",
        properties: {
          Name: { type: "string" },
          Parent: { $ref: "#/components/schemas/Node" },
        },
      },
    },
  },
};

const envelope: Json = {
  type: "object",
  properties: { data: { type: "array", items: { $ref: "#/components/schemas/Lease" } } },
};

describe("fields from a declared response", () => {
  const fields = fieldsFromSchema(envelope, resolverFor(doc), "$.data");
  const byName = new Map(fields.map((field) => [field.name, field]));

  it("descends through the envelope to the row", () => {
    // A widget binds to a row, not to the wrapper around it — and the names
    // have to match what the pipeline produces after its extract step.
    expect(byName.has("Id")).toBe(true);
    expect(byName.has("data")).toBe(false);
  });

  it("maps JSON Schema types onto this product's vocabulary", () => {
    expect(byName.get("Id")?.kinds).toEqual(["number"]);
    expect(byName.get("LeaseStatus")?.kinds).toEqual(["string"]);
    expect(byName.get("Tags")?.kinds).toEqual(["array"]);
  });

  it("recognises the formats a spec states outright", () => {
    expect(byName.get("LeaseToDate")?.format).toBe("iso8601");
    expect(byName.get("SignedAt")?.format).toBe("iso8601");
    expect(byName.get("Contact.Email")?.format).toBe("email");
    expect(byName.get("Contact.Homepage")?.format).toBe("url");
  });

  it("guesses no format it was not told", () => {
    // A bare integer could be a count, an id or money. Calling it minor_units
    // would put a currency symbol in front of somebody's unit number.
    expect(byName.get("Id")?.format).toBeUndefined();
    expect(byName.get("LeaseStatus")?.format).toBeUndefined();
  });

  it("treats anything not required as nullable", () => {
    expect(byName.get("Id")?.nullable).toBe(false);
    expect(byName.get("LeaseStatus")?.nullable).toBe(false);
    expect(byName.get("LeaseToDate")?.nullable).toBe(true);
    expect(byName.get("Notes")?.nullable).toBe(true);
  });

  it("keeps the spec author's own words about a field", () => {
    expect(byName.get("Id")?.description).toContain("unique identifier");
  });

  it("follows a $ref and flattens two levels", () => {
    /*
     * Two, matching `inferShape`. One stopped exactly short of the everyday
     * case: a record carries a container, and the thing worth reading is
     * inside that. An address is the example — one level recorded that a
     * contact *has* an address and nothing about what it said.
     */
    expect(byName.has("Contact.Email")).toBe(true);
    expect(byName.has("Contact.Address.City")).toBe(true);
  });

  it("carries no cardinality, because nothing has been seen", () => {
    // The whole point of a separate shape from the report: a spec is a
    // description, and there is nowhere here to record a count of values.
    for (const field of fields) {
      expect(field).not.toHaveProperty("distinct");
      expect(field).not.toHaveProperty("samples");
    }
  });
});

describe("what it refuses to choke on", () => {
  it("terminates on a self-referencing schema", () => {
    const fields = fieldsFromSchema(
      { $ref: "#/components/schemas/Node" },
      resolverFor(doc),
      "$",
    );
    expect(fields.map((field) => field.name)).toContain("Name");
    expect(fields.length).toBeLessThan(20);
  });

  it("reads a bare array response as its items", () => {
    const fields = fieldsFromSchema(
      { type: "array", items: { $ref: "#/components/schemas/Lease" } },
      resolverFor(doc),
      "$",
    );
    expect(fields.map((field) => field.name)).toContain("LeaseStatus");
  });

  it("returns nothing for a response the spec never described", () => {
    expect(fieldsFromSchema(undefined, resolverFor(doc))).toEqual([]);
    expect(fieldsFromSchema({ type: "string" }, resolverFor(doc))).toEqual([]);
  });
});

describe("a schema that never says what it is", () => {
  /*
   * `type` is optional in OpenAPI and object definitions routinely omit it.
   * Treating those as strings meant the walk never descended, so a nested
   * `Category.Name` — the field somebody means by "maintenance tasks" — never
   * reached the map at all.
   */
  const taskish = {
    type: "array",
    items: {
      properties: {
        Id: { type: "integer" },
        TaskType: { type: "string" },
        Category: {
          // No `type`. Buildium's shape, and most APIs' shape.
          properties: {
            Id: { type: "integer" },
            Name: { type: "string" },
          },
        },
      },
    },
  };

  it("reads an untyped object as an object and descends into it", () => {
    const fields = fieldsFromSchema(taskish, (node) => node, "$");
    const names = fields.map((field) => field.name);

    expect(names).toContain("Category.Name");
    expect(names).toContain("Category.Id");
    expect(fields.find((field) => field.name === "Category")?.kinds).toEqual(["object"]);
  });

  it("reads an untyped array as an array", () => {
    const fields = fieldsFromSchema(
      { type: "array", items: { properties: { Tags: { items: { type: "string" } } } } },
      (node) => node,
      "$",
    );
    expect(fields.find((field) => field.name === "Tags")?.kinds).toEqual(["array"]);
  });

  it("still falls back to string when there is nothing to read", () => {
    // A bare `{}` says nothing about itself and has no structure either.
    const fields = fieldsFromSchema(
      { type: "array", items: { properties: { Mystery: {} } } },
      (node) => node,
      "$",
    );
    expect(fields.find((field) => field.name === "Mystery")?.kinds).toEqual(["string"]);
  });

  it("goes two levels down and stops", () => {
    /*
     * Two levels, matching `inferShape`, and no further: past that a schema is
     * mostly describing its own plumbing, and every extra level multiplies the
     * field list for a name nobody would put on a chart.
     */
    const deep = {
      type: "array",
      items: {
        properties: {
          A: { properties: { B: { properties: { C: { properties: { D: { type: "string" } } } } } } },
        },
      },
    };
    const names = fieldsFromSchema(deep, (node) => node, "$").map((field) => field.name);
    expect(names).toContain("A.B");
    expect(names).toContain("A.B.C");
    expect(names).not.toContain("A.B.C.D");
  });
});
