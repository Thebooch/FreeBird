import type { FieldInfo } from "@freebirdai/dash-agent";
import { connectionSchema, isStale } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import {
  type SampleFn,
  PACE_MAX_GAP_MS,
  analyseConnection,
  deriveResourcesFromOps,
  estimateEnumeration,
  findFilterParam,
  findForeignKeys,
  fromReport,
  inputAffordances,
  paceGapMs,
  pickIdField,
  pickLabelField,
  toReport,
} from "./capabilities.js";

/**
 * Enumeration paces itself across five seconds on purpose. A test asserting
 * logic should not also wait for it, so the clock is injected everywhere here.
 */
const instant = { sleep: async () => {} };

/**
 * Every fixture here is invented. That is deliberate: the capabilities layer
 * exists to work on an API nobody has described to us, so testing it against a
 * real vendor's shapes would only prove it works on that vendor.
 */

const field = (name: string, ...kinds: string[]): FieldInfo =>
  ({
    name,
    kinds: kinds.length > 0 ? kinds : ["string"],
    nullable: false,
    distinct: 1,
    samples: [],
  }) as unknown as FieldInfo;

/** Two collections, two by-id endpoints, one sub-collection, one summary. */
const connection = connectionSchema.parse({
  id: "widgets",
  title: "Widget Co",
  kind: "rest",
  baseUrl: "https://api.example.com",
  auth: { type: "bearer", keyRef: "k" },
  ops: [
    {
      id: "gadgets",
      title: "Gadgets",
      path: "/v2/gadgets",
      params: [
        { name: "q", in: "query", role: "search" },
        { name: "createdFrom", in: "query", type: "date", role: "rangeStart" },
        { name: "createdTo", in: "query", type: "date", role: "rangeEnd" },
      ],
    },
    {
      id: "gadget",
      title: "Gadget",
      path: "/v2/gadgets/{{param.gadgetId}}",
      params: [{ name: "gadgetId", in: "path", required: true, role: "id" }],
    },
    {
      id: "orders",
      title: "Orders",
      path: "/v2/orders",
      params: [{ name: "gadgetId", in: "query" }],
    },
    { id: "order", title: "Order", path: "/v2/orders/{{param.orderId}}" },
    // A sub-collection: two path parameters, so not a detail endpoint.
    { id: "parts", title: "Parts", path: "/v2/gadgets/{{param.gadgetId}}/parts/{{param.partId}}" },
    { id: "totals", title: "Totals", path: "/v2/totals", archetype: "summary" },
  ],
  validateOpId: "gadgets",
});

describe("deriveResourcesFromOps", () => {
  const resources = deriveResourcesFromOps(connection.ops);

  it("pairs a collection with its by-id endpoint", () => {
    expect(resources.map((resource) => resource.id).sort()).toEqual(["gadget", "order"]);
    const gadget = resources.find((resource) => resource.id === "gadget");
    expect(gadget).toMatchObject({ listOp: "gadgets", detailOp: "gadget", detailParam: "gadgetId" });
  });

  it("does not treat a nested path as a detail endpoint", () => {
    expect(resources.some((resource) => resource.detailOp === "parts")).toBe(false);
  });

  it("leaves everything unverified until a request proves it", () => {
    expect(resources.every((resource) => resource.verified === false)).toBe(true);
    expect(resources.every((resource) => resource.idField === undefined)).toBe(true);
  });

  it("finds nothing in a connection of unrelated endpoints", () => {
    expect(deriveResourcesFromOps([connection.ops[5]!])).toEqual([]);
  });

  it("disambiguates two collections that singularise to the same noun", () => {
    const collide = connectionSchema.parse({
      ...connection,
      ops: [
        { id: "a", title: "A", path: "/v1/boxes" },
        { id: "a1", title: "A1", path: "/v1/boxes/{{param.id}}" },
        { id: "b", title: "B", path: "/v2/boxes" },
        { id: "b1", title: "B1", path: "/v2/boxes/{{param.id}}" },
      ],
      validateOpId: "a",
    });
    expect(deriveResourcesFromOps(collide.ops).map((resource) => resource.id)).toEqual([
      "box",
      "box-2",
    ]);
  });
});

describe("pickIdField", () => {
  it("prefers a bare id", () => {
    expect(pickIdField([field("gadgetId"), field("id"), field("name")], "gadget")).toBe("id");
  });

  it("falls back to the resource's own id", () => {
    expect(pickIdField([field("name"), field("gadgetID")], "gadget")).toBe("gadgetID");
  });

  it("accepts a uuid when there is no id at all", () => {
    expect(pickIdField([field("uuid"), field("name")], "gadget")).toBe("uuid");
  });

  it("takes any trailing-id field as a last resort", () => {
    expect(pickIdField([field("name"), field("record_id")], "gadget")).toBe("record_id");
  });

  it("ignores nested fields, which cannot address a row", () => {
    expect(pickIdField([field("owner.id"), field("name")], "gadget")).toBeUndefined();
  });
});

describe("pickLabelField", () => {
  it("prefers a conventional name", () => {
    expect(pickLabelField([field("id"), field("status"), field("Name")])).toBe("Name");
  });

  it("skips identifiers when falling back", () => {
    expect(pickLabelField([field("record_id"), field("status")])).toBe("status");
  });

  it("ignores non-string fields", () => {
    expect(pickLabelField([field("total", "number")])).toBeUndefined();
  });
});

describe("findForeignKeys", () => {
  const targets = [
    { id: "gadget", idField: "Id" },
    { id: "order", idField: "Id" },
  ];

  it("matches a field named for the target resource", () => {
    expect(findForeignKeys([field("Id"), field("GadgetId"), field("total")], targets)).toEqual([
      { resource: "gadget", foreignField: "GadgetId", targetField: "Id" },
    ]);
  });

  it("does not mistake a row's own id for a foreign key", () => {
    expect(findForeignKeys([field("Id")], [{ id: "", idField: "Id" }])).toEqual([]);
  });

  /*
   * Two collections can answer to the same noun. Buildium has two endpoints
   * titled "Retrieve all units", under /v1/rentals and /v1/associations, and
   * they hold different records.
   */
  const assocUnits = { id: "unit", idField: "Id", noun: "unit", path: "/v1/associations/units" };
  const rentalUnits = { id: "unit-2", idField: "Id", noun: "unit", path: "/v1/rentals/units" };
  const units = [assocUnits, rentalUnits];

  it("matches on the noun, not on the id the graph had to disambiguate", () => {
    /*
     * Ids are unique so the second units collection is called `unit-2`, which
     * normalises to `unit2` — meaning it could never match a `UnitId` field
     * and was silently unreachable by every foreign key in the API. The
     * suffix is bookkeeping and must not reach the matching.
     */
    const found = findForeignKeys([field("Id"), field("UnitId")], [rentalUnits], {
      sourcePath: "/v1/rentals/leases",
    });
    expect(found).toEqual([{ resource: "unit-2", foreignField: "UnitId", targetField: "Id" }]);
  });

  it("picks the collection in the same section as the source", () => {
    expect(
      findForeignKeys([field("UnitId")], units, {
        sourcePath: "/v1/associations/ownershipaccounts",
      }),
    ).toEqual([{ resource: "unit", foreignField: "UnitId", targetField: "Id" }]);
  });

  it("records no link when the source is equidistant, and says why", () => {
    const notes: string[] = [];
    // The shipped bug: a lease is one segment from both, and the arbitrary
    // winner was the HOA units — wrong for every lease in the account.
    expect(findForeignKeys([field("UnitId")], units, { sourcePath: "/v1/leases", notes })).toEqual(
      [],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("UnitId");
    expect(notes[0]).toContain("/v1/rentals/units");
  });

  it("explains one ambiguity once, however many rivals there are", () => {
    const notes: string[] = [];
    findForeignKeys(
      [field("UnitId")],
      [...units, { id: "unit-3", idField: "Id", noun: "unit", path: "/v1/commercial/units" }],
      { sourcePath: "/v1/leases", notes },
    );
    expect(notes).toHaveLength(1);
  });

  it("refuses rather than guessing when there is no source path", () => {
    expect(findForeignKeys([field("UnitId")], units)).toEqual([]);
  });

  it("ignores a collection that cannot be listed without another id", () => {
    // `/v1/rentals/{propertyId}/vendors` is not "all vendors" and a bare
    // VendorId cannot mean it, so this link is not contested at all.
    const vendors = { id: "vendor", idField: "Id", noun: "vendor", path: "/v1/vendors" };
    const scoped = {
      id: "rental-vendor",
      idField: "Id",
      noun: "vendor",
      path: "/v1/rentals/{{param.propertyId}}/vendors",
    };
    expect(
      findForeignKeys([field("VendorId")], [vendors, scoped], { sourcePath: "/v1/bills" }),
    ).toEqual([{ resource: "vendor", foreignField: "VendorId", targetField: "Id" }]);
  });
});

describe("findFilterParam", () => {
  const orders = connection.ops.find((op) => op.id === "orders");

  it("finds the query parameter that filters by a foreign key", () => {
    expect(findFilterParam(orders, "GadgetId")).toBe("gadgetId");
  });

  it("reports nothing when the endpoint cannot be filtered", () => {
    expect(findFilterParam(orders, "CustomerId")).toBeUndefined();
  });

  it("never offers a path parameter as a filter", () => {
    const gadget = connection.ops.find((op) => op.id === "gadget");
    expect(findFilterParam(gadget, "gadgetId")).toBeUndefined();
  });
});

describe("inputAffordances", () => {
  it("reports search and range endpoints by role, not by parameter name", () => {
    expect(inputAffordances(connection.ops)).toEqual({
      searchable: [{ op: "gadgets", param: "q" }],
      rangeFilterable: [{ op: "gadgets", start: "createdFrom", end: "createdTo" }],
    });
  });
});

describe("analyseConnection", () => {
  const samples: Record<string, readonly FieldInfo[]> = {
    gadgets: [field("Id", "number"), field("Name"), field("Status")],
    orders: [field("Id", "number"), field("GadgetId", "number"), field("Note")],
  };

  const sample: SampleFn = async (opId) => {
    const fields = samples[opId];
    return fields ? { kind: "rows", fields, rowCount: fields.length } : { kind: "empty" };
  };

  it("offers a drill-down once identity is known", async () => {
    const result = await analyseConnection(connection, sample, instant);
    expect(result.drillDowns).toEqual([
      {
        resource: "gadget",
        title: "Gadgets",
        listOp: "gadgets",
        detailOp: "gadget",
        idField: "Id",
        detailParam: "gadgetId",
        labelField: "Name",
        sampled: true,
      },
      {
        resource: "order",
        title: "Orders",
        listOp: "orders",
        detailOp: "order",
        idField: "Id",
        detailParam: "orderId",
        labelField: "Note",
        sampled: true,
      },
    ]);
  });

  it("offers the join and says it needs no fan-out when the target can be filtered", async () => {
    const result = await analyseConnection(connection, sample, instant);
    expect(result.joins).toEqual([
      {
        from: "order",
        to: "gadget",
        title: "Orders → Gadgets",
        foreignField: "GadgetId",
        targetField: "Id",
        filterParam: "gadgetId",
        needsFanOut: false,
      },
    ]);
  });

  it("flags fan-out when the endpoint has no matching filter", async () => {
    const unfilterable = connectionSchema.parse({
      ...connection,
      ops: connection.ops.map((op) => (op.id === "orders" ? { ...op, params: [] } : op)),
    });
    const result = await analyseConnection(unfilterable, sample, instant);
    expect(result.joins[0]).toMatchObject({ needsFanOut: true });
    expect(result.joins[0]).not.toHaveProperty("filterParam");
  });

  /*
   * These used to be the same silence. An account that has not used a feature
   * yet and a credential that stopped working both produced "returned nothing
   * to learn from", which is true of both and useful for neither.
   */
  it("separates an endpoint with no records from one that would not answer", async () => {
    const empty = await analyseConnection(connection, async () => ({ kind: "empty" }), instant);
    expect(empty.drillDowns).toEqual([]);
    expect(empty.unknowns.map((unknown) => unknown.reason)).toEqual(["empty", "empty"]);
    // Actionable: the UI can offer this exact endpoint as a "check again".
    expect(empty.unknowns[0]?.recheckOp).toBe("gadgets");

    const broken = await analyseConnection(connection, async () => ({
      kind: "failed",
      message: "401 from upstream",
    }), instant);
    expect(broken.unknowns.every((unknown) => unknown.reason === "requestFailed")).toBe(true);
    expect(broken.unknowns[0]?.detail).toContain("401");
  });

  it("does not spend a request on an endpoint that cannot succeed", async () => {
    const scoped = connectionSchema.parse({
      ...connection,
      ops: [
        { id: "crates", title: "Crates", path: "/v1/crates" },
        { id: "crate", title: "Crate", path: "/v1/crates/{{param.crateId}}" },
        {
          id: "items",
          title: "Items",
          path: "/v1/items",
          params: [{ name: "crateId", in: "query", required: true }],
        },
        { id: "item", title: "Item", path: "/v1/items/{{param.itemId}}" },
      ],
      validateOpId: "crates",
    });

    const called: string[] = [];
    await analyseConnection(scoped, async (opId) => {
      called.push(opId);
      return { kind: "empty" };
    }, instant);

    // `items` declares an input nobody supplied, so calling it would only
    // rediscover that at the cost of a request.
    expect(called).toContain("crates");
    expect(called).not.toContain("items");
  });

  it("reports a connection with no pairs rather than failing", async () => {
    const flat = connectionSchema.parse({
      ...connection,
      ops: [{ id: "totals", title: "Totals", path: "/v2/totals" }],
      validateOpId: "totals",
    });
    const result = await analyseConnection(flat, sample, instant);
    expect(result.resources).toEqual([]);
    // The note has to name the actual dead end, because the drawer shows it
    // verbatim when there is nothing to suggest.
    expect(result.notes.join(" ")).toContain("nothing to build a widget from");
  });

  describe("collections that only exist inside a record", () => {
    const crateCo = connectionSchema.parse({
      ...connection,
      ops: [
        { id: "crates", title: "Crates", path: "/v1/crates" },
        { id: "crate", title: "Crate", path: "/v1/crates/{{param.crateId}}" },
        { id: "crateItems", title: "Items in a crate", path: "/v1/crates/{{param.crateId}}/items" },
      ],
      validateOpId: "crates",
    });

    /** A field carrying an example value, which is what opens a child. */
    const withSample = (name: string, value: unknown, ...kinds: string[]): FieldInfo =>
      ({
        name,
        kinds: kinds.length > 0 ? kinds : ["string"],
        nullable: false,
        distinct: 1,
        samples: [value],
      }) as unknown as FieldInfo;

    const crateSample: SampleFn = async (opId, inputs) => {
      if (opId === "crates") {
        return {
          kind: "rows",
          fields: [withSample("Id", 4821, "number"), withSample("Name", "Blue crate")],
          rowCount: 1,
        };
      }
      // The child only answers when it is given a parent, which is the point.
      if (opId === "crateItems" && inputs?.crateId === 4821) {
        return {
          kind: "rows",
          fields: [withSample("Id", 9, "number"), withSample("CrateId", 4821, "number")],
          rowCount: 1,
        };
      }
      return { kind: "empty" };
    };

    it("opens a scoped collection using a real id from its parent", async () => {
      const result = await analyseConnection(crateCo, crateSample, instant);
      const items = result.resources.find((resource) => resource.id === "crate-item");
      // There is no parameter-free "all items" to call, so this is the only
      // route to the child's fields — and therefore to its identity.
      expect(items?.idField).toBe("Id");
    });

    it("stops calling it unknown once the parent has opened it", async () => {
      const result = await analyseConnection(crateCo, crateSample, instant);
      /*
       * The first pass rightly gives up on a scoped collection — it cannot be
       * called without a parent. The second pass then reaches it. Reporting
       * the first verdict would ask someone to supply an id we already used.
       */
      expect(result.unknowns.map((unknown) => unknown.resource)).not.toContain("crate-item");
    });

    it("still reports a child the parent could not open", async () => {
      const result = await analyseConnection(crateCo, async (opId, inputs) =>
        opId === "crateItems" ? { kind: "empty" } : crateSample(opId, inputs),
      instant);
      expect(result.unknowns.find((unknown) => unknown.resource === "crate-item")).toMatchObject({
        reason: "empty",
        needs: ["crateId"],
      });
    });

    it("marks the relation verified once a request has proved it", async () => {
      const result = await analyseConnection(crateCo, crateSample, instant);
      const crate = result.resources.find((resource) => resource.id === "crate")!;
      const relation = crate.relations.find((item) => item.resource === "crate-item");
      expect(relation).toMatchObject({ confidence: "declared", verified: true });
    });

    it("writes the upward link only after seeing a row carry it", async () => {
      const result = await analyseConnection(crateCo, crateSample, instant);
      const items = result.resources.find((resource) => resource.id === "crate-item")!;
      // The child's rows really do have a CrateId, so the link is a fact.
      expect(items.relations).toContainEqual(
        expect.objectContaining({ resource: "crate", cardinality: "one", localField: "CrateId" }),
      );
    });

    it("leaves the link one-way when the child carries no back-pointer", async () => {
      const noBackPointer: SampleFn = async (opId, inputs) =>
        opId === "crateItems" && inputs
          ? { kind: "rows", fields: [withSample("Id", 9, "number")], rowCount: 1 }
          : crateSample(opId, inputs);

      const result = await analyseConnection(crateCo, noBackPointer, instant);
      const items = result.resources.find((resource) => resource.id === "crate-item")!;
      /*
       * Plenty of APIs omit the back-pointer because the parent was already in
       * the URL. Writing the link anyway would name a field no row has, and
       * `{{row.CrateId}}` would interpolate to nothing — a 404 that reads like
       * a bad credential.
       */
      expect(items.relations).toEqual([]);
    });
  });

  it("survives a sampling failure without losing the resource", async () => {
    const result = await analyseConnection(connection, async (opId) => {
      if (opId === "orders") throw new Error("upstream 500");
      return sample(opId);
    }, instant);
    expect(result.resources.map((resource) => resource.id)).toEqual(["gadget", "order"]);
    expect(result.drillDowns.map((offer) => offer.resource)).toEqual(["gadget"]);
  });
});

describe("pacing and budget", () => {
  const samples: Record<string, readonly FieldInfo[]> = {
    gadgets: [field("Id", "number"), field("Name")],
    orders: [field("Id", "number"), field("GadgetId", "number")],
  };
  const sample: SampleFn = async (opId) => {
    const fields = samples[opId];
    return fields ? { kind: "rows", fields, rowCount: fields.length } : { kind: "empty" };
  };

  /** A sample fn that fails every call with a given upstream status. */
  const failsWith = (status: number, retryAfter?: string): SampleFn =>
    async () => ({
      kind: "failed",
      message: `upstream ${status}`,
      status,
      ...(retryAfter ? { retryAfter } : {}),
    });

  it("spreads requests instead of firing them back to back", async () => {
    const waits: number[] = [];
    await analyseConnection(connection, sample, {
      sleep: async (ms) => void waits.push(ms),
    });
    // One fewer gap than requests — nothing is waited on before the first.
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((ms) => ms > 0)).toBe(true);
  });

  it("targets the wall-clock budget rather than a fixed delay", () => {
    // 41 requests across 5s is a trickle, not a burst.
    expect(paceGapMs(41)).toBe(125);
    // A handful of endpoints is not padded out to the full five seconds.
    expect(paceGapMs(3)).toBe(PACE_MAX_GAP_MS);
    expect(paceGapMs(1)).toBe(0);
    expect(paceGapMs(0)).toBe(0);
  });

  it("reports what a pass will cost before making a request", () => {
    // Pure by construction: it is handed no sample fn, so it cannot call one.
    const plan = estimateEnumeration(connection);
    expect(plan.collections).toBe(2);
    expect(plan.estimatedRequests).toBeGreaterThanOrEqual(2);
    expect(plan.estimatedMs).toBeGreaterThan(0);
  });

  it("prices a deeper look higher than the default", () => {
    const shallow = estimateEnumeration(connection, { maxSamples: 1 });
    const deep = estimateEnumeration(connection, { maxSamples: 60, maxChildSamples: 40 });
    expect(deep.estimatedRequests).toBeGreaterThanOrEqual(shallow.estimatedRequests);
  });

  it("honours a smaller budget", async () => {
    const result = await analyseConnection(connection, sample, {
      ...instant,
      maxSamples: 1,
    });
    expect(result.requestsSpent).toBeLessThanOrEqual(2);
    expect(result.outcome).toBe("budget");
  });

  it("stops the whole pass when the API starts rate limiting", async () => {
    const result = await analyseConnection(connection, failsWith(429, "30"), instant);

    // One request proved the point; the rest were never sent.
    expect(result.requestsSpent).toBe(1);
    expect(result.outcome).toBe("rateLimited");
    expect(result.retryAfter).toBe("30");
    expect(result.unknowns.some((unknown) => unknown.reason === "aborted")).toBe(true);
    expect(result.notes.join(" ")).toContain("rate limiting");
  });

  it("stops on an unaccepted credential rather than proving it 40 more times", async () => {
    const result = await analyseConnection(connection, failsWith(401), instant);
    expect(result.requestsSpent).toBe(1);
    expect(result.outcome).toBe("authRejected");
  });

  /*
   * 403 is not 401.
   *
   * Treating them alike meant one endpoint the key was not scoped to killed
   * the whole pass — a real connection with 10 readable resources reported
   * zero, as a rejected credential. Many APIs scope a key per resource, so a
   * forbidden endpoint says nothing about the next one.
   */
  it("keeps going past an endpoint the key is not permitted on", async () => {
    const result = await analyseConnection(
      connection,
      async (opId) =>
        opId === "gadgets"
          ? { kind: "failed", message: "forbidden", status: 403 }
          : sample(opId),
      instant,
    );

    expect(result.requestsSpent).toBeGreaterThan(1);
    expect(result.outcome).not.toBe("authRejected");
    // The endpoints behind the forbidden one were still read.
    expect(Object.keys(result.fieldsByResource).length).toBeGreaterThan(0);
    expect(result.notes.join(" ")).toContain("not permitted");
  });

  it("calls it out when the key is accepted everywhere and permitted nowhere", async () => {
    const result = await analyseConnection(connection, failsWith(403), instant);
    // Every endpoint was tried, not just the first.
    expect(result.requestsSpent).toBeGreaterThan(1);
    expect(result.outcome).toBe("authRejected");
    expect(result.notes.join(" ")).toMatch(/valid; it is not permitted/i);
  });

  it("keeps going for a failure that is only about one endpoint", async () => {
    const result = await analyseConnection(
      connection,
      async (opId) => (opId === "gadgets" ? { kind: "failed", message: "not found", status: 404 } : sample(opId)),
      instant,
    );
    // A 404 on one collection says nothing about the next one.
    expect(result.requestsSpent).toBeGreaterThan(1);
    expect(result.outcome).not.toBe("rateLimited");
    expect(result.unknowns.some((unknown) => unknown.reason === "aborted")).toBe(false);
  });

  it("reports progress as it goes, for an honest bar", async () => {
    const seen: Array<{ spent: number; planned: number }> = [];
    await analyseConnection(connection, sample, {
      ...instant,
      onProgress: (progress) => void seen.push(progress),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.spent).toBe(1);
    expect(seen.at(-1)?.spent).toBe(seen.length);
    expect(seen.every((p) => p.planned > 0)).toBe(true);
  });

  /*
   * The distinction the drawer needs.
   *
   * A rejected credential leaves the structure fully understood and nothing
   * sampled — which looked identical to "this API has nothing to offer" and
   * was reported as such. The counts are what tell them apart.
   */
  it("reports structure understood but nothing sampled when the key is rejected", async () => {
    const result = await analyseConnection(connection, failsWith(401), instant);
    expect(result.outcome).toBe("authRejected");
    expect(result.resources.length).toBeGreaterThan(0);
    expect(Object.keys(result.fieldsByResource)).toHaveLength(0);
    expect(result.notes.join(" ")).toContain("did not accept the credential");
  });

  it("carries the stop reason onto the written report", async () => {
    const capabilities = await analyseConnection(connection, failsWith(429, "60"), instant);
    const report = toReport(connection, capabilities, {});
    expect(report.outcome).toBe("rateLimited");
    expect(report.retryAfter).toBe("60");
    expect(report.requestsSpent).toBe(1);
  });
});

describe("report round trip", () => {
  const rows: Record<string, readonly FieldInfo[]> = {
    gadgets: [field("Id", "number"), field("Name"), field("Status")],
    orders: [field("Id", "number"), field("GadgetId", "number"), field("Note")],
  };
  const sample: SampleFn = async (opId) => {
    const fields = rows[opId];
    return fields ? { kind: "rows", fields, rowCount: fields.length } : { kind: "empty" };
  };

  const shapes = {
    gadget: {
      rowsPath: "$.data",
      rowCount: 3,
      schemaHash: "fnv1a:abcd1234",
      fields: [
        { name: "Id", kinds: ["number"], nullable: false, distinct: 3, samples: [1, 2, 3] },
        {
          name: "Email",
          kinds: ["string"],
          nullable: false,
          format: "email",
          distinct: 3,
          samples: ["ada@example.com"],
        },
      ],
    },
  } as unknown as Record<string, import("@freebirdai/dash-agent").InferredShape>;

  it("writes field metadata but never a value", async () => {
    const capabilities = await analyseConnection(connection, sample, instant);
    const report = toReport(connection, capabilities, shapes);

    const written = JSON.stringify(report);
    expect(written).not.toContain("ada@example.com");
    expect(written).toContain("Email");
    expect(report.shapes.gadget?.fields).toEqual([
      { name: "Id", kinds: ["number"], nullable: false, distinct: 3 },
      { name: "Email", kinds: ["string"], nullable: false, format: "email", distinct: 3 },
    ]);
  });

  it("restores a usable pass with empty samples rather than invented ones", async () => {
    const capabilities = await analyseConnection(connection, sample, instant);
    const restored = fromReport(toReport(connection, capabilities, shapes));

    expect(restored.value.resources.map((resource) => resource.id)).toEqual(
      capabilities.resources.map((resource) => resource.id),
    );
    expect(restored.value.drillDowns).toEqual(capabilities.drillDowns);
    expect(restored.shapes.gadget?.rowsPath).toBe("$.data");
    expect(restored.shapes.gadget?.fields.map((f) => f.name)).toEqual(["Id", "Email"]);
    // The values are gone, and nothing pretends otherwise.
    expect(restored.shapes.gadget?.fields.every((f) => f.samples.length === 0)).toBe(true);
    expect(restored.value.fieldsByResource.gadget).toEqual(["Id", "Email"]);
  });

  it("fingerprints the endpoints it was built from", async () => {
    const capabilities = await analyseConnection(connection, sample, instant);
    const report = toReport(connection, capabilities, shapes);
    expect(isStale(report, connection)).toBe(false);

    const moved = connectionSchema.parse({
      ...connection,
      ops: connection.ops.map((op) => (op.id === "gadgets" ? { ...op, path: "/v3/gadgets" } : op)),
    });
    expect(isStale(report, moved)).toBe(true);
  });
});
