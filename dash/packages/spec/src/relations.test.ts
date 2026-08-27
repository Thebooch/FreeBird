import { describe, expect, it } from "vitest";
import { relationGraph } from "./relations.js";
import type { RelationGraphInput } from "./relations.js";
import { resourceSchema } from "./resource.js";

/**
 * Every case here is one the real Buildium map produced, reduced to the shape
 * that caused it. None of them needs to know what a property or a unit is —
 * each is a statement about a field's kind, a path's parameters, or two ends of
 * one fact being recorded twice.
 */

const resources = (input: unknown[]) => input.map((item) => resourceSchema.parse(item));

const graphOf = (input: RelationGraphInput) => relationGraph(input);

describe("children through a declared path", () => {
  const graph = graphOf({
    ops: [
      { id: "list_leases", path: "/v1/leases" },
      { id: "list_lease_notes", path: "/v1/leases/{{param.leaseId}}/notes" },
    ],
    resources: resources([
      {
        id: "lease",
        title: "Lease",
        listOp: "list_leases",
        idField: "Id",
        relations: [
          {
            id: "lease-notes",
            title: "Notes",
            resource: "lease-note",
            cardinality: "many",
            via: "path",
            op: "list_lease_notes",
            param: "leaseId",
            confidence: "declared",
          },
        ],
      },
      { id: "lease-note", title: "Note", listOp: "list_lease_notes" },
    ]),
  });

  it("feeds the parent's id into the URL", () => {
    expect(graph.childrenOf("list_leases")).toEqual([
      expect.objectContaining({
        op: "list_lease_notes",
        parentIdField: "Id",
        fetch: { mode: "path", param: "leaseId" },
        confidence: "declared",
      }),
    ]);
  });

  it("is not offered as a peer join, because it cannot be fetched whole", () => {
    expect(graph.joinablePeers("list_leases")).toEqual([]);
  });
});

describe("children through a relation recorded on the child", () => {
  /**
   * The property-and-units case. Units are a top-level collection, so no URL
   * says a property has any; what says so is a `PropertyId` on the unit rows,
   * recorded on the unit pointing at the property — backwards from the
   * direction a record needs.
   */
  const base = {
    ops: [
      { id: "list_rentals", path: "/v1/rentals", params: [{ name: "rentalids", in: "query" }] },
      {
        id: "list_units",
        path: "/v1/rentals/units",
        params: [{ name: "propertyids", in: "query" }],
      },
    ],
    resources: resources([
      { id: "rental", title: "Property", listOp: "list_rentals", idField: "Id" },
      {
        id: "unit",
        title: "Unit",
        listOp: "list_units",
        idField: "Id",
        relations: [
          {
            id: "unit-rental",
            title: "A unit belongs to a property.",
            notes: "Unit rows carry PropertyId; properties are listed at /v1/rentals.",
            resource: "rental",
            cardinality: "one",
            localField: "PropertyId",
            foreignField: "Id",
            filterParam: "rentalids",
            confidence: "inferred",
          },
        ],
      },
    ]),
  };

  it("turns it around so the property is the parent", () => {
    const graph = graphOf({
      ...base,
      fields: {
        list_units: [
          { name: "Id", kinds: ["number"] },
          { name: "PropertyId", kinds: ["number"] },
        ],
        list_rentals: [{ name: "Id", kinds: ["number"] }],
      },
    });

    expect(graph.childrenOf("list_rentals")).toEqual([
      expect.objectContaining({
        op: "list_units",
        resource: "unit",
        parentIdField: "Id",
        notes: "Unit rows carry PropertyId; properties are listed at /v1/rentals.",
      }),
    ]);
  });

  it("narrows with the child endpoint's own parameter, never the parent's", () => {
    const graph = graphOf({
      ...base,
      fields: { list_units: [{ name: "PropertyId", kinds: ["number"] }] },
    });

    // `rentalids` is declared on /v1/rentals. Sent to /v1/rentals/units it is
    // ignored, and an ignored filter returns every unit in the account under
    // every property while answering 200.
    expect(graph.childrenOf("list_rentals")[0]?.fetch).toEqual({
      mode: "filter",
      param: "propertyids",
    });
  });

  it("falls back to matching rows when the endpoint declares no filter", () => {
    const graph = graphOf({
      ...base,
      ops: [
        { id: "list_rentals", path: "/v1/rentals" },
        { id: "list_units", path: "/v1/rentals/units" },
      ],
      fields: { list_units: [{ name: "PropertyId", kinds: ["number"] }] },
    });

    expect(graph.childrenOf("list_rentals")[0]?.fetch).toEqual({
      mode: "match",
      field: "PropertyId",
      kind: "scalar",
    });
  });

  it("also reads as a peer join, since both collections are callable bare", () => {
    const graph = graphOf({
      ...base,
      fields: {
        list_units: [{ name: "PropertyId", kinds: ["number"] }],
        list_rentals: [{ name: "Id", kinds: ["number"] }],
      },
    });

    expect(graph.joinablePeers("list_units")).toEqual([
      expect.objectContaining({
        fromOp: "list_units",
        toOp: "list_rentals",
        leftField: "PropertyId",
        rightField: "Id",
      }),
    ]);
  });
});

describe("links the fields prove cannot match", () => {
  const build = (fields: Record<string, { name: string; kinds: string[] }[]>) =>
    graphOf({
      ops: [
        { id: "list_owners", path: "/v1/owners" },
        { id: "list_units", path: "/v1/units" },
      ],
      fields,
      resources: resources([
        { id: "unit", title: "Unit", listOp: "list_units", idField: "Id" },
        {
          id: "owner",
          title: "Owner",
          listOp: "list_owners",
          idField: "Id",
          relations: [
            {
              id: "owner-unit",
              title: "An owner owns units.",
              resource: "unit",
              cardinality: "one",
              localField: "PropertyIds",
              foreignField: "PropertyId",
              confidence: "inferred",
            },
          ],
        },
      ]),
    });

  it("reads an array of ids as one, rather than comparing the whole list", () => {
    // `PropertyIds: [42, 51]` never equals `"42"`, so the honest-looking
    // comparison is false for every row and the section renders empty.
    const graph = build({
      list_owners: [{ name: "PropertyIds", kinds: ["array"] }],
      list_units: [{ name: "PropertyId", kinds: ["number"] }],
    });

    expect(graph.childrenOf("list_units")[0]?.fetch).toEqual({
      mode: "match",
      field: "PropertyIds",
      kind: "array",
    });
  });

  it("reaches one level into an object reference for the id", () => {
    const graph = build({
      list_owners: [
        { name: "PropertyIds", kinds: ["object"] },
        { name: "PropertyIds.Id", kinds: ["number"] },
      ],
      list_units: [{ name: "PropertyId", kinds: ["number"] }],
    });

    expect(graph.childrenOf("list_units")[0]?.fetch).toEqual({
      mode: "match",
      field: "PropertyIds.Id",
      kind: "scalar",
    });
  });

  it("refuses an object with no id inside, and says why", () => {
    const graph = build({
      list_owners: [
        { name: "PropertyIds", kinds: ["object"] },
        { name: "PropertyIds.Href", kinds: ["string"] },
      ],
      list_units: [{ name: "PropertyId", kinds: ["number"] }],
    });

    expect(graph.children).toEqual([]);
    expect(graph.unusable).toEqual([
      expect.objectContaining({ field: "PropertyIds", reason: expect.stringContaining("object") }),
    ]);
  });

  it("refuses a field the rows do not carry", () => {
    const graph = build({
      list_owners: [{ name: "Id", kinds: ["number"] }],
      list_units: [{ name: "PropertyId", kinds: ["number"] }],
    });

    expect(graph.children).toEqual([]);
    expect(graph.unusable).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("do not carry") }),
    ]);
  });

  it("takes the map at its word where no fields are known", () => {
    // A freshly imported API has no samples. Refusing everything it claims
    // would leave it with no relationships at all, which is worse than
    // trusting a description that a sample can later correct.
    const graph = build({});
    expect(graph.children).toHaveLength(1);
    expect(graph.unusable).toEqual([]);
  });
});

describe("the same fact recorded from both ends", () => {
  /**
   * The mapping pass records `vendor → workorder on Id=VendorId` alongside
   * `workorder → vendor on VendorId=Id`. Both are true and both describe one
   * relationship; read forwards and backwards without collapsing them, one
   * relationship becomes four sections.
   */
  const graph = graphOf({
    ops: [
      { id: "list_vendors", path: "/v1/vendors" },
      { id: "list_workorders", path: "/v1/workorders" },
    ],
    fields: {
      list_vendors: [{ name: "Id", kinds: ["number"] }],
      list_workorders: [{ name: "VendorId", kinds: ["number"] }],
    },
    resources: resources([
      {
        id: "vendor",
        title: "Vendor",
        listOp: "list_vendors",
        idField: "Id",
        relations: [
          {
            id: "vendor-workorder",
            title: "A vendor has work orders.",
            resource: "workorder",
            cardinality: "many",
            foreignField: "VendorId",
            confidence: "inferred",
          },
        ],
      },
      {
        id: "workorder",
        title: "Work order",
        listOp: "list_workorders",
        idField: "Id",
        relations: [
          {
            id: "workorder-vendor",
            title: "A work order is assigned to a vendor.",
            resource: "vendor",
            cardinality: "one",
            localField: "VendorId",
            foreignField: "Id",
            confidence: "declared",
          },
        ],
      },
    ]),
  });

  it("offers work orders under a vendor exactly once", () => {
    expect(graph.childrenOf("list_vendors")).toHaveLength(1);
  });

  it("keeps the stronger record of the two", () => {
    expect(graph.childrenOf("list_vendors")[0]?.confidence).toBe("declared");
  });

  it("offers the join once, from either side", () => {
    expect(graph.peers).toHaveLength(1);
    expect(graph.joinablePeers("list_workorders")[0]).toMatchObject({
      fromOp: "list_workorders",
      leftField: "VendorId",
      toOp: "list_vendors",
      rightField: "Id",
    });
  });
});

describe("opening one record", () => {
  const graph = graphOf({
    ops: [
      { id: "list_leases", path: "/v1/leases" },
      { id: "lease_by_id", path: "/v1/leases/{{param.leaseId}}" },
    ],
    resources: resources([
      {
        id: "lease",
        title: "Lease",
        listOp: "list_leases",
        detailOp: "lease_by_id",
        detailParam: "leaseId",
        idField: "Id",
        labelField: "UnitNumber",
      },
      { id: "other", title: "Other", listOp: "list_other" },
    ]),
  });

  it("names the endpoint, the parameter and the field that feeds it", () => {
    expect(graph.recordOf("list_leases")).toEqual({
      resource: "lease",
      op: "lease_by_id",
      param: "leaseId",
      idField: "Id",
      labelField: "UnitNumber",
      idFieldObserved: true,
    });
  });

  it("says nothing where there is neither a sample nor a name to read", () => {
    // No detail endpoint and no fields, so neither route to an id field is
    // open. A record that cannot be fetched is not offered.
    expect(graph.recordOf("list_other")).toBeUndefined();
  });
});

describe("two routes to the same rows", () => {
  /**
   * `/v1/leases/{leaseId}/transactions` is the API's own scoped endpoint, and
   * a transaction row also carries a `LeaseId`. Both are true, both reach the
   * same rows, and offering both puts two identical tabs under a lease — one
   * of which reads every transaction in the account to build.
   */
  const graph = relationGraph({
    ops: [
      { id: "list_leases", path: "/v1/leases" },
      { id: "lease_transactions", path: "/v1/leases/{{param.leaseId}}/transactions" },
    ],
    fields: { lease_transactions: [{ name: "LeaseId", kinds: ["number"] }] },
    resources: resources([
      {
        id: "lease",
        title: "Lease",
        listOp: "list_leases",
        idField: "Id",
        relations: [
          {
            id: "lease-transactions",
            title: "Transactions",
            resource: "lease-transaction",
            cardinality: "many",
            via: "path",
            op: "lease_transactions",
            param: "leaseId",
            confidence: "declared",
          },
        ],
      },
      {
        id: "lease-transaction",
        title: "Transaction",
        listOp: "lease_transactions",
        relations: [
          {
            id: "transaction-lease",
            title: "Belongs to a lease",
            resource: "lease",
            cardinality: "one",
            localField: "LeaseId",
            foreignField: "Id",
            confidence: "inferred",
          },
        ],
      },
    ]),
  });

  it("offers the scoped endpoint and not the scan", () => {
    expect(graph.childrenOf("list_leases")).toEqual([
      expect.objectContaining({ fetch: { mode: "path", param: "leaseId" } }),
    ]);
  });
});

describe("a child endpoint that needs an id nothing supplies", () => {
  /**
   * `/announcements/{announcementId}/properties` has a slot in its URL. Read
   * backwards it looks like a collection under a property, but nothing here
   * knows an announcement id — the request would go out with the placeholder
   * still in the path.
   */
  const graph = relationGraph({
    ops: [
      { id: "list_rentals", path: "/v1/rentals" },
      {
        id: "announcement_properties",
        path: "/v1/announcements/{{param.announcementId}}/properties",
      },
    ],
    fields: { announcement_properties: [{ name: "Id", kinds: ["number"] }] },
    resources: resources([
      { id: "rental", title: "Property", listOp: "list_rentals", idField: "Id" },
      {
        id: "announcement-property",
        title: "Announcement property",
        listOp: "announcement_properties",
        relations: [
          {
            id: "ap-rental",
            title: "Is a property",
            resource: "rental",
            cardinality: "one",
            localField: "Id",
            foreignField: "Id",
            confidence: "inferred",
          },
        ],
      },
    ]),
  });

  it("is refused rather than offered as an unfetchable section", () => {
    expect(graph.childrenOf("list_rentals")).toEqual([]);
    expect(graph.unusable).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("needs an id in its URL") }),
    ]);
  });
});

describe("the field that holds a row's own identity", () => {
  /**
   * A path says `{unitId}` and the response says `Id`, and no specification
   * states the correspondence — so a map alone could open no records at all
   * until somebody had paid for a read. Across the real 109-collection API
   * that was every one of them.
   */
  const graph = (fields: { name: string; kinds: string[] }[], detailParam = "unitId") =>
    relationGraph({
      ops: [
        { id: "list_units", path: "/v1/units" },
        { id: "unit_by_id", path: `/v1/units/{{param.${detailParam}}}` },
      ],
      fields: { list_units: fields },
      resources: resources([
        {
          id: "unit",
          title: "Unit",
          listOp: "list_units",
          detailOp: "unit_by_id",
          detailParam,
        },
      ]),
    });

  it("reads a bare Id from the naming when nothing has been sampled", () => {
    const record = graph([{ name: "Id", kinds: ["number"] }]).recordOf("list_units");
    expect(record).toMatchObject({ op: "unit_by_id", param: "unitId", idField: "Id" });
  });

  it("says plainly that it was inferred rather than seen", () => {
    // A caller about to write something shared should be able to tell.
    expect(graph([{ name: "Id", kinds: ["number"] }]).recordOf("list_units")?.idFieldObserved).toBe(
      false,
    );
  });

  it("accepts the noun-prefixed spelling the parameter names", () => {
    const record = graph([{ name: "UnitId", kinds: ["number"] }]).recordOf("list_units");
    expect(record?.idField).toBe("UnitId");
  });

  it("refuses identifiers that are also business values", () => {
    // A check number identifies a payment to a bank, not a record to an API.
    // Pairing a record view to one opens the wrong thing, or nothing.
    const record = graph([
      { name: "CheckNumber", kinds: ["string"] },
      { name: "Code", kinds: ["string"] },
      { name: "Uuid", kinds: ["string"] },
    ]).recordOf("list_units");
    expect(record).toBeUndefined();
  });

  it("refuses an object or a list, which cannot be an identity", () => {
    const record = graph([{ name: "Id", kinds: ["object"] }]).recordOf("list_units");
    expect(record).toBeUndefined();
  });

  it("prefers what a real response settled over what a name suggests", () => {
    const sampled = relationGraph({
      ops: [
        { id: "list_units", path: "/v1/units" },
        { id: "unit_by_id", path: "/v1/units/{{param.unitId}}" },
      ],
      fields: { list_units: [{ name: "Id", kinds: ["number"] }] },
      resources: resources([
        {
          id: "unit",
          title: "Unit",
          listOp: "list_units",
          detailOp: "unit_by_id",
          detailParam: "unitId",
          // Seen in a response. No convention outranks having looked.
          idField: "UnitKey",
        },
      ]),
    });

    expect(sampled.recordOf("list_units")).toMatchObject({
      idField: "UnitKey",
      idFieldObserved: true,
    });
  });
});
