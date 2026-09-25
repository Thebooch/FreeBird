import { entitySchema, resourceSchema, type EntitySpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { verifyRecords, type VerifyRead } from "./verify.js";

/**
 * Checking a description against a real account.
 *
 * This is the only part of the whole layer that spends somebody's API quota,
 * so what it *refuses* to conclude matters as much as what it confirms: a rate
 * limit must never look like a discovery, and an account that simply has none
 * of a kind of record is not evidence that the description is wrong.
 */

const entities: EntitySpec[] = [
  entitySchema.parse({
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    identity: { field: "Id" },
    fields: [
      { path: "Id" },
      { path: "VendorId", label: "Vendor", reference: { entity: "vendor" } },
    ],
  }),
  entitySchema.parse({
    id: "vendor",
    resource: "vendor",
    name: { one: "Vendor", many: "Vendors" },
    identity: { field: "Id" },
    fields: [{ path: "Id" }],
  }),
];

const resources = [
  resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks" }),
  resourceSchema.parse({
    id: "vendor",
    title: "Vendors",
    listOp: "vendors",
    detailOp: "vendor",
    detailParam: "vendorId",
  }),
];

const carried = new Set(["tasks", "vendors", "vendor"]);

const run = (read: VerifyRead, budget = 20) =>
  verifyRecords({
    entities,
    resources,
    carried,
    rowsPathOf: (op) => (op === "tasks" || op === "vendors" ? "$.data" : undefined),
    read,
    budget,
  });

/** Answers every list with one row and every by-id with one record. */
const answering: VerifyRead = async (op) =>
  op === "vendor"
    ? { ok: true, body: { Id: 41, CompanyName: "Acme" } }
    : { ok: true, body: { data: [{ Id: 7, VendorId: 41 }] } };

describe("verifyRecords", () => {
  it("confirms an identity a real response actually carries", async () => {
    /*
     * A path says `{taskId}` and the body says `Id`, and no specification
     * states the correspondence — so until a response carries it, what
     * identifies a record is a convention rather than a fact.
     */
    const result = await run(answering);
    const task = result.entities.find((one) => one.id === "task");

    expect(task?.verified).toBe(true);
    expect(task?.identity?.observed).toBe(true);
    expect(result.identitiesConfirmed).toBeGreaterThanOrEqual(1);
  });

  it("resolves a link against the record type it claims to point at", async () => {
    // A name ending in "Id" is a guess; one that resolves is not.
    const result = await run(answering);
    const task = result.entities.find((one) => one.id === "task");

    expect(task?.fields.find((f) => f.path === "VendorId")?.reference?.verified).toBe(true);
    expect(result.referencesResolved).toBe(1);
  });

  it("stops the moment the API refuses, and says so", async () => {
    const refusing: VerifyRead = async () => ({ ok: false, body: null, status: 429 });
    const result = await run(refusing);

    expect(result.stopped).toBe("refused");
    expect(result.notes.join(" ")).toContain("stopped answering");
    // Nothing was learned, and nothing is claimed.
    expect(result.identitiesConfirmed).toBe(0);
  });

  it("stops on a rejected key rather than collecting failures", async () => {
    /*
     * A key the API will not accept is a fact about the connection, not about
     * any record type. Carrying on would spend the whole budget gathering 401s
     * and then report "nothing confirmed" — which reads exactly like a
     * description that is wrong, and is the one conclusion this must never
     * invite.
     */
    let calls = 0;
    const rejecting: VerifyRead = async () => {
      calls += 1;
      return { ok: false, body: null, status: 401 };
    };
    const result = await run(rejecting);

    expect(result.stopped).toBe("rejected");
    expect(calls).toBe(1);
    expect(result.notes.join(" ")).toContain("would not accept");
    expect(result.entities.every((one) => one.verified === false)).toBe(true);
  });

  it("skips an endpoint that fails on its own account, and keeps going", async () => {
    // A single endpoint erroring says nothing about the next record type.
    const patchy: VerifyRead = async (op) =>
      op === "tasks" ? { ok: false, body: null, status: 500 } : answering(op, {});
    const result = await run(patchy);

    expect(result.stopped).toBeNull();
    expect(result.entities.find((one) => one.id === "vendor")?.verified).toBe(true);
  });

  it("never downgrades what it could not reach", async () => {
    /*
     * The rule that keeps a rate limit from looking like a discovery: a record
     * type this run never got to keeps whatever it already had.
     */
    const proven = entitySchema.parse({
      ...entities[1]!,
      verified: true,
      identity: { field: "Id", observed: true },
    });
    const result = await verifyRecords({
      entities: [entities[0]!, proven],
      resources,
      carried,
      rowsPathOf: () => "$.data",
      read: async () => ({ ok: false, body: null, status: 429 }),
      budget: 20,
    });

    expect(result.entities.find((one) => one.id === "vendor")?.verified).toBe(true);
  });

  it("treats an account with none of them as no evidence either way", async () => {
    const empty: VerifyRead = async () => ({ ok: true, body: { data: [] } });
    const result = await run(empty);

    expect(result.entities.every((one) => one.verified === false)).toBe(true);
    expect(result.notes.join(" ")).toContain("to check against");
    expect(result.stopped).toBeNull();
  });

  it("says plainly when real rows do not carry the identity it expected", async () => {
    const different: VerifyRead = async () => ({ ok: true, body: { data: [{ Reference: "T-1" }] } });
    const result = await run(different);

    expect(result.entities.find((one) => one.id === "task")?.verified).toBe(false);
    expect(result.notes.join(" ")).toContain("still a guess");
  });

  it("separates not finding the records from there being none", async () => {
    /*
     * A response came back and this could not locate the records in it. That
     * is a fact about the reading, not about the account, and reporting an
     * empty account would be inventing one.
     */
    const unlocatable = await verifyRecords({
      entities,
      resources,
      carried,
      // Nothing states where rows live, and the body is an envelope.
      rowsPathOf: () => undefined,
      read: async () => ({ ok: true, body: { data: [{ Id: 7 }] } }),
      budget: 20,
    });

    expect(unlocatable.notes.join(" ")).toContain("Could not tell where");
    expect(unlocatable.notes.join(" ")).not.toContain("to check against");
    expect(unlocatable.identitiesConfirmed).toBe(0);
    // Nothing was learned, so nothing is claimed either way.
    expect(unlocatable.entities.every((one) => one.verified === false)).toBe(true);
  });

  it("reads a bare array as the rows, since nothing else could be meant", async () => {
    const bare = await verifyRecords({
      entities,
      resources,
      carried,
      rowsPathOf: () => undefined,
      read: async (op) =>
        op === "vendor" ? { ok: true, body: { Id: 41 } } : { ok: true, body: [{ Id: 7, VendorId: 41 }] },
      budget: 20,
    });

    expect(bare.identitiesConfirmed).toBe(2);
    expect(bare.referencesResolved).toBe(1);
  });

  it("spends no more than the budget it was given", async () => {
    let calls = 0;
    const counting: VerifyRead = async (op) => {
      calls += 1;
      return answering(op, {});
    };
    const result = await run(counting, 1);

    expect(calls).toBe(1);
    expect(result.spent).toBe(1);
    expect(result.stopped).toBe("budget");
  });
});

/*
 * A budget smaller than the API — sixty requests against Buildium's 108 record
 * types — used to be spent on the same first sixty every run. Each run now
 * starts with what has never been read and stamps what it read.
 */
describe("verifyRecords, resuming", () => {
  it("reads the never-read first and stamps what it read", async () => {
    const asked: string[] = [];
    const read: VerifyRead = async (op) => {
      asked.push(op);
      return answering(op, {});
    };
    const older = entities.map((entity) =>
      entity.id === "task" ? { ...entity, readAt: "2026-09-01T00:00:00Z" } : entity,
    );
    const result = await verifyRecords({
      entities: older,
      resources,
      carried,
      rowsPathOf: (op) => (op === "tasks" || op === "vendors" ? "$.data" : undefined),
      read,
      budget: 1,
      now: "2026-09-25T00:00:00Z",
    });
    // One request, spent on the vendor list nobody had read.
    expect(asked).toEqual(["vendors"]);
    expect(result.entities.find((one) => one.id === "vendor")?.readAt).toBe("2026-09-25T00:00:00Z");
    expect(result.entities.find((one) => one.id === "task")?.readAt).toBe("2026-09-01T00:00:00Z");
  });
});

/*
 * A unit is `/properties/{propertyID}/units/{unitID}`: a work order's link to
 * its unit is checked with the work order's own property id.
 */
describe("verifyRecords, links to records under a parent", () => {
  it("follows the link with the parent's id off the same row", async () => {
    const nested: EntitySpec[] = [
      entitySchema.parse({
        id: "work-order",
        resource: "work-order",
        name: { one: "Work order", many: "Work orders" },
        identity: { field: "workOrderID" },
        fields: [
          { path: "workOrderID" },
          { path: "unitID", reference: { entity: "unit" } },
          { path: "propertyID", reference: { entity: "property" } },
        ],
      }),
      entitySchema.parse({
        id: "unit",
        resource: "unit",
        name: { one: "Unit", many: "Units" },
        scope: { parent: "property", param: "propertyID" },
        identity: { field: "unitID" },
        fields: [{ path: "unitID" }],
      }),
      entitySchema.parse({
        id: "property",
        resource: "property",
        name: { one: "Property", many: "Properties" },
        identity: { field: "propertyID" },
        fields: [{ path: "propertyID" }],
      }),
    ];
    const asked: Array<[string, Readonly<Record<string, unknown>>]> = [];
    await verifyRecords({
      entities: nested,
      resources: [
        resourceSchema.parse({ id: "work-order", title: "Work orders", listOp: "work_orders" }),
        resourceSchema.parse({ id: "unit", title: "Units", detailOp: "unit", detailParam: "unitID" }),
        resourceSchema.parse({
          id: "property",
          title: "Properties",
          detailOp: "property",
          detailParam: "propertyID",
        }),
      ],
      carried: new Set(["work_orders", "unit", "property"]),
      rowsPathOf: () => "$",
      ops: [
        { id: "work_orders", path: "/work-orders", params: [] },
        { id: "unit", path: "/properties/{{param.propertyID}}/units/{{param.unitID}}", params: [] },
        { id: "property", path: "/properties/{{param.propertyID}}", params: [] },
      ],
      read: async (op, params) => {
        asked.push([op, params]);
        return op === "work_orders"
          ? { ok: true, body: [{ workOrderID: 1, unitID: 222, propertyID: 210 }] }
          : { ok: true, body: { id: 1 } };
      },
      budget: 10,
    });
    expect(asked).toContainEqual(["unit", { propertyID: "210", unitID: 222 }]);
  });
});
