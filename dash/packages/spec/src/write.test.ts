import { describe, expect, it } from "vitest";
import { entitySchema, type EntitySpec } from "./entity.js";
import { entityGraph, entityPageView, writesView } from "./entity-graph.js";
import { setField } from "./field-path.js";
import { catalogEntrySchema } from "./dialect.js";
import { resourceSchema, type ResourceSpec } from "./resource.js";
import { connectionSchema } from "./connection.js";
import { pathShape, writeOpDefSchema, type WriteOpDef } from "./write.js";
import { actionCreates, pairedAction, writeRoleOf } from "./write-roles.js";
import { mapWriteFields, unmappedFields } from "./write-map.js";

/**
 * Writes, as the spec package sees them: what an endpoint does to a record
 * type, where the record's address comes from, and which of a request's
 * fields the record already shows.
 *
 * The fixture is shaped like a property-management API because that is where
 * every hard case turned up — a replace that clears what it is not sent, a
 * singleton that lives under a unit, a record with no delete but an
 * "inactivate" — and none of it is keyed to that vendor.
 */

const entity = (input: Record<string, unknown>): EntitySpec => entitySchema.parse(input);
const resource = (input: Record<string, unknown>): ResourceSpec => resourceSchema.parse(input);
const write = (input: Record<string, unknown>): WriteOpDef => writeOpDefSchema.parse(input);

const PROPERTY = entity({
  id: "rental",
  resource: "rental",
  name: { one: "Property", many: "Properties" },
  kind: "asset",
  identity: { field: "Id", observed: true },
  fields: [
    { path: "Id" },
    { path: "Name" },
    { path: "Address", kinds: ["object"] },
    { path: "Address.PostalCode" },
    { path: "YearBuilt", kinds: ["number"] },
    {
      path: "OperatingBankAccountId",
      kinds: ["number"],
      label: "Operating account",
      reference: { entity: "bankaccount", holds: "scalar" },
    },
    { path: "RentalManager", kinds: ["object"] },
    { path: "RentalManager.Id", kinds: ["number"] },
  ],
});

const UNIT = entity({
  id: "unit",
  resource: "unit",
  name: { one: "Unit", many: "Units" },
  kind: "asset",
  identity: { field: "Id", observed: true },
  fields: [{ path: "Id" }, { path: "UnitNumber" }, { path: "PropertyId", reference: { entity: "rental" } }],
});

/** Described as living under the property — the wrong parent the describe pass chose. */
const LISTING = entity({
  id: "listing",
  resource: "listing",
  name: { one: "Listing", many: "Listings" },
  kind: "event",
  scope: { parent: "rental", param: "unitId" },
  fields: [
    { path: "Rent", kinds: ["number"] },
    { path: "AvailableDate" },
    { path: "Contact", kinds: ["object"] },
    { path: "Contact.Id", kinds: ["number"], reference: { entity: "contact", holds: "objectRef" } },
  ],
});

const RESOURCES = [
  resource({ id: "rental", title: "Properties", listOp: "rentals", detailOp: "rental", detailParam: "propertyId" }),
  resource({
    id: "unit",
    title: "Units",
    listOp: "units",
    detailOp: "unit",
    detailParam: "unitId",
    relations: [
      { id: "unit-listing", title: "Listing", resource: "listing", cardinality: "one", via: "path", op: "listing", param: "unitId" },
    ],
  }),
  resource({ id: "listing", title: "Listing", listOp: "listing" }),
];

const OPS = [
  { id: "rentals", path: "/v1/rentals" },
  { id: "rental", path: "/v1/rentals/{{param.propertyId}}" },
  { id: "units", path: "/v1/rentals/units" },
  { id: "unit", path: "/v1/rentals/units/{{param.unitId}}" },
  { id: "listing", path: "/v1/rentals/units/{{param.unitId}}/listing" },
];

const BODY = {
  fields: [
    { path: "Name", type: "string", required: true },
    { path: "Address.PostalCode", type: "string", required: true },
    { path: "YearBuilt", type: "integer" },
    { path: "OperatingBankAccountId", type: "integer", required: true },
    { path: "PropertyManagerId", type: "integer" },
  ],
};

const WRITES = [
  write({ id: "post_rentals", title: "Create a property", method: "POST", path: "/v1/rentals", body: BODY }),
  write({ id: "put_rental", title: "Update a property", method: "PUT", path: "/v1/rentals/{{param.propertyId}}", body: BODY }),
  write({ id: "inactivate", title: "Inactivate a property", method: "POST", path: "/v1/rentals/{{param.propertyId}}/inactivationrequest" }),
  write({ id: "reactivate", title: "Reactivate a property", method: "POST", path: "/v1/rentals/{{param.propertyId}}/reactivationrequest" }),
  write({
    id: "put_listing",
    title: "Create/Update a listing",
    method: "PUT",
    path: "/v1/rentals/units/{{param.unitId}}/listing",
    body: {
      fields: [
        { path: "Rent", type: "number", required: true },
        { path: "AvailableDate", type: "string", format: "date", required: true },
        { path: "ContactId", type: "integer" },
      ],
    },
  }),
  write({ id: "delete_listing", title: "Delete a listing", method: "DELETE", path: "/v1/rentals/units/{{param.unitId}}/listing" }),
  write({
    id: "upload_image",
    title: "Upload an image",
    method: "POST",
    path: "/v1/rentals/{{param.propertyId}}/images",
    body: { contentType: "multipart/form-data", unsupported: "multipart/form-data" },
  }),
];

const graph = () =>
  entityGraph({ entities: [PROPERTY, UNIT, LISTING], resources: RESOURCES, ops: OPS, writes: WRITES });

describe("write schemas", () => {
  it("keeps the good endpoints when one in the list is malformed", () => {
    const entry = catalogEntrySchema.parse({
      id: "api",
      title: "API",
      baseUrl: "https://api.example.com",
      dialect: {},
      writes: [
        { id: "ok", title: "Create", method: "POST", path: "/things" },
        { id: "bad", title: "Nope", method: "GET", path: "/things" },
        "not even an object",
      ],
    });
    expect(entry.writes.map((one) => one.id)).toEqual(["ok"]);
  });

  it("defaults to no writes", () => {
    const entry = catalogEntrySchema.parse({ id: "api", title: "API", baseUrl: "https://api.example.com", dialect: {} });
    expect(entry.writes).toEqual([]);
  });

  it("drops an old connection's write-access setting rather than failing on it", () => {
    const connection = connectionSchema.parse({
      id: "c",
      title: "C",
      kind: "rest",
      writeAccess: { enabled: false, entities: [] },
    });
    expect(connection).not.toHaveProperty("writeAccess");
  });

  it("compares paths by shape, whatever the parameters are called", () => {
    expect(pathShape("/v1/units/{{param.unitId}}/listing")).toBe(pathShape("/v1/units/{{param.id}}/listing"));
  });
});

describe("setField", () => {
  it("builds the nesting a request body needs, leaving the input alone", () => {
    const before = { Name: "A", Address: { City: "X" } };
    const after = setField(setField(before, "Address.PostalCode", "12345"), "Name", "B");
    expect(after).toEqual({ Name: "B", Address: { City: "X", PostalCode: "12345" } });
    expect(before).toEqual({ Name: "A", Address: { City: "X" } });
  });

  it("refuses to walk into prototype keys", () => {
    const out = setField({}, "__proto__.polluted", true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(out).toEqual({});
  });
});

describe("writeRoleOf", () => {
  const paths = {
    list: "/v1/rentals",
    detail: "/v1/rentals/{{param.propertyId}}",
    singleton: false,
    readShapes: new Set(OPS.map((op) => pathShape(op.path))),
  };

  it("reads create, replace, merge and delete off the path and method", () => {
    expect(writeRoleOf(WRITES[0]!, paths)).toEqual({ kind: "create", mode: "create" });
    expect(writeRoleOf(WRITES[1]!, paths)).toEqual({ kind: "update", mode: "replace" });
    const patch = write({ id: "p", title: "Patch", method: "PATCH", path: "/v1/rentals/{{param.id}}" });
    expect(writeRoleOf(patch, paths)).toEqual({ kind: "update", mode: "merge" });
    const del = write({ id: "d", title: "Delete", method: "DELETE", path: "/v1/rentals/{{param.propertyId}}" });
    expect(writeRoleOf(del, paths)).toEqual({ kind: "delete", mode: "delete" });
  });

  it("reads a POST to the record itself as a change, Stripe-style, only with a body", () => {
    const withBody = write({
      id: "u",
      title: "Update a customer",
      method: "POST",
      path: "/v1/rentals/{{param.propertyId}}",
      body: { fields: [{ path: "Name", type: "string" }] },
    });
    expect(writeRoleOf(withBody, paths)).toEqual({ kind: "update", mode: "merge" });
    const bare = write({ id: "b", title: "Poke", method: "POST", path: "/v1/rentals/{{param.propertyId}}" });
    expect(writeRoleOf(bare, paths)).toBeNull();
  });

  it("reads a named step under the record as an action, with its tone", () => {
    expect(writeRoleOf(WRITES[2]!, paths)).toEqual({
      kind: "action",
      mode: "action",
      id: "inactivationrequest",
      danger: true,
      creates: false,
    });
    expect(writeRoleOf(WRITES[3]!, paths)).toMatchObject({ kind: "action", danger: false });
  });

  it("tells an action that makes something new under the record from one that changes it", () => {
    const credit = write({ id: "c", title: "Create a credit", method: "POST", path: "/v1/rentals/{{param.propertyId}}/credits" });
    expect(writeRoleOf(credit, paths)).toMatchObject({ kind: "action", id: "credits", creates: true, danger: false });
    // "Cancel" would sound dangerous; making a cancellation request record is still making something.
    const logged = write({ id: "l", title: "Log a cancelled call", method: "POST", path: "/v1/rentals/{{param.propertyId}}/calllog" });
    expect(writeRoleOf(logged, paths)).toMatchObject({ creates: true, danger: false });
    expect(writeRoleOf(WRITES[2]!, paths)).toMatchObject({ creates: false });
    expect(actionCreates("Add a tenant")).toBe(true);
    expect(actionCreates("Addendum review")).toBe(false);
  });

  it("does not call a step an action when the API also lets you read it", () => {
    const withGet = { ...paths, readShapes: new Set([...paths.readShapes, pathShape("/v1/rentals/{{param.x}}/notes")]) };
    const notes = write({ id: "n", title: "Create a note", method: "POST", path: "/v1/rentals/{{param.propertyId}}/notes" });
    expect(writeRoleOf(notes, withGet)).toBeNull();
  });

  it("reads PUT on a singleton as make-or-change", () => {
    const singleton = {
      list: "/v1/rentals/units/{{param.unitId}}/listing",
      singleton: true,
      readShapes: paths.readShapes,
    };
    expect(writeRoleOf(WRITES[4]!, singleton)).toEqual({ kind: "update", mode: "upsert" });
    expect(writeRoleOf(WRITES[5]!, singleton)).toEqual({ kind: "delete", mode: "delete" });
  });

  it("pairs actions that undo each other", () => {
    expect(pairedAction("inactivationrequest", ["inactivationrequest", "reactivationrequest"])).toBe(
      "reactivationrequest",
    );
    expect(pairedAction("archive", ["archive", "unarchive"])).toBe("unarchive");
    expect(pairedAction("send", ["send", "cancel"])).toBeUndefined();
  });
});

describe("mapWriteFields", () => {
  it("finds each request field on the record, and says which it could not", () => {
    const mapped = mapWriteFields(PROPERTY, WRITES[1]!.body!.fields);
    const by = Object.fromEntries(mapped.map((field) => [field.path, field]));
    expect(by["Name"]?.readFrom).toBe("Name");
    expect(by["Address.PostalCode"]?.readFrom).toBe("Address.PostalCode");
    expect(by["OperatingBankAccountId"]).toMatchObject({
      readFrom: "OperatingBankAccountId",
      mappedBy: "name",
      label: "Operating account",
      reference: { entity: "bankaccount", holds: "scalar" },
    });
    // `PropertyManagerId` is sent; the record shows `RentalManager.Id`. Not guessed.
    expect(by["PropertyManagerId"]?.readFrom).toBeNull();
    expect(unmappedFields(mapped).map((field) => field.path)).toEqual(["PropertyManagerId"]);
  });

  it("reads `XId` in the request as `X.Id` on the record", () => {
    const [contact] = mapWriteFields(LISTING, [{ path: "ContactId", type: "integer", required: false }]);
    expect(contact).toMatchObject({ readFrom: "Contact.Id", reference: { entity: "contact", holds: "scalar" } });
  });

  it("finds fields inside a record the API wraps whole", () => {
    const wrapped = entity({
      id: "unitw",
      resource: "unitw",
      name: { one: "Unit", many: "Units" },
      kind: "asset",
      identity: { field: "unit.unitID" },
      fields: [{ path: "unit", kinds: ["object"] }, { path: "unit.unitID" }, { path: "unit.name" }],
    });
    const [name] = mapWriteFields(wrapped, [{ path: "name", type: "string", required: true }]);
    expect(name?.readFrom).toBe("unit.name");
  });

  it("keeps what a person or the model decided", () => {
    const [manager] = mapWriteFields(PROPERTY, [
      { path: "PropertyManagerId", type: "integer", required: false, readFrom: "RentalManager.Id", mappedBy: "person" },
    ]);
    expect(manager).toMatchObject({ readFrom: "RentalManager.Id", mappedBy: "person" });
  });
});

describe("writesOf", () => {
  it("offers create, update and the actions on a record type, with the safest update", () => {
    const writes = graph().writesOf("rental");
    expect(writes.create).toMatchObject({ op: "post_rentals", mode: "create", parents: [] });
    expect(writes.create?.own).toBeUndefined();
    expect(writes.update).toMatchObject({
      op: "put_rental",
      mode: "replace",
      own: { param: "propertyId", field: "Id" },
    });
    expect(writes.remove).toBeUndefined();
    // Inactivate reads as dangerous on its own; with reactivate beside it, it can be undone.
    expect(writes.actions.map((action) => action.action)).toEqual([
      { id: "inactivationrequest", danger: false, pairedWith: "reactivationrequest" },
      { id: "reactivationrequest", danger: false, pairedWith: "inactivationrequest" },
    ]);
  });

  it("keeps an action that has no undo marked as one that cannot be undone", () => {
    const lonely = entityGraph({
      entities: [PROPERTY],
      resources: RESOURCES,
      ops: OPS,
      writes: [WRITES[2]!],
    });
    expect(lonely.writesOf("rental").actions[0]?.action).toEqual({ id: "inactivationrequest", danger: true });
  });

  it("never offers an endpoint whose body no form can build", () => {
    const writes = graph().writesOf("rental");
    expect(JSON.stringify(writes)).not.toContain("upload_image");
  });

  it("addresses a singleton by its parent alone, found from the paths", () => {
    const writes = graph().writesOf("listing");
    expect(writes.create).toMatchObject({ op: "put_listing", mode: "upsert" });
    expect(writes.update).toMatchObject({ op: "put_listing", mode: "upsert" });
    expect(writes.update?.own).toBeUndefined();
    expect(writes.update?.parents).toEqual([{ param: "unitId", entity: "unit" }]);
    expect(writes.remove).toMatchObject({ op: "delete_listing", parents: [{ param: "unitId", entity: "unit" }] });
  });

  it("offers inferred writes too, and none that somebody switched off", () => {
    const inferred = entityGraph({
      entities: [PROPERTY],
      resources: RESOURCES,
      ops: OPS,
      writes: [write({ ...WRITES[0]!, confidence: "inferred" })],
    });
    expect(inferred.writesOf("rental").create).toMatchObject({ confidence: "inferred", confirmed: true });
    const off = entityGraph({
      entities: [PROPERTY],
      resources: RESOURCES,
      ops: OPS,
      writes: [write({ ...WRITES[0]!, confirmed: false })],
    });
    expect(off.writesOf("rental").create).toMatchObject({ confirmed: false });
  });

  it("is empty with no write endpoints at all", () => {
    const readOnly = entityGraph({ entities: [PROPERTY], resources: RESOURCES, ops: OPS });
    expect(readOnly.writesOf("rental")).toEqual({ actions: [] });
  });

  it("summarises for a page without the fields or the paths", () => {
    const view = writesView(graph().writesOf("rental"));
    expect(JSON.stringify(view)).not.toContain("/v1/");
    expect(view.update).toEqual({
      op: "put_rental",
      mode: "replace",
      title: "Update a property",
      confidence: "declared",
      confirmed: true,
      verified: false,
    });
    expect(view.actions.map((action) => [action.id, action.danger])).toEqual([
      ["inactivationrequest", false],
      ["reactivationrequest", false],
    ]);
  });
});

describe("scoped collections", () => {
  /*
   * The describe pass filed the listing under the property, because the
   * property's collection path begins the listing's. The property's page then
   * fetched `/rentals/units/{propertyId}/listing` — a unit id slot filled with
   * a property id — and the unit's page had no listing at all.
   */
  it("files a scoped collection under the record whose path really holds it", () => {
    const g = graph();
    expect(g.scopeParentOf("listing")).toBe("unit");
    expect(g.backrefsOf("rental").map((backref) => backref.entity)).not.toContain("listing");
    expect(g.backrefsOf("unit").map((backref) => backref.id)).toContain("listing-under-unit");
  });

  it("keeps a stated parent that the paths bear out", () => {
    const right = entity({ ...LISTING, scope: { parent: "unit", param: "unitId" } });
    const g = entityGraph({ entities: [PROPERTY, UNIT, right], resources: RESOURCES, ops: OPS });
    expect(g.scopeParentOf("listing")).toBe("unit");
  });

  it("marks the singleton section so a page adds or edits it in place", () => {
    const page = entityPageView(
      { entities: [PROPERTY, UNIT, LISTING], resources: RESOURCES, ops: OPS, writes: WRITES },
      "unit",
    );
    const section = page?.sections.find((one) => one.entity === "listing");
    expect(section).toMatchObject({ singleton: true, reach: { mode: "path", param: "unitId" } });
  });
});
