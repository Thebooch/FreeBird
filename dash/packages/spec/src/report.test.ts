import { describe, expect, it } from "vitest";
import {
  capabilityReportSchema,
  diffReports,
  fingerprintOps,
  isStale,
  parseCapabilityReport,
  toAllowlist,
  type CapabilityReport,
} from "./report.js";
import { connectionSchema, type ConnectionSpec } from "./connection.js";

/**
 * Overrides are deliberately untyped: everything goes through `.parse()`, and
 * insisting on a fully-defaulted `OpDef` here would mean writing out `query`,
 * `headers` and `method` on every fixture op purely to satisfy the compiler.
 */
const connection = (overrides: Record<string, unknown> = {}): ConnectionSpec =>
  connectionSchema.parse({
    id: "acme",
    title: "Acme",
    kind: "rest",
    baseUrl: "https://api.acme.test",
    auth: { type: "none" },
    ops: [
      {
        id: "list_leases",
        title: "Retrieve all leases",
        path: "/leases",
        archetype: "list",
        params: [
          { name: "status", in: "query" },
          { name: "limit", in: "query", required: true, default: 50 },
        ],
      },
      {
        id: "get_lease",
        title: "Retrieve a lease",
        path: "/leases/{{param.leaseId}}",
        archetype: "summary",
        params: [{ name: "leaseId", in: "path", required: true }],
      },
    ],
    ...overrides,
  });

const report = (overrides: Partial<CapabilityReport> = {}): CapabilityReport =>
  capabilityReportSchema.parse({
    connection: "acme",
    generatedAt: new Date("2026-08-14T10:00:00.000Z").toISOString(),
    opsFingerprint: fingerprintOps(connection().ops),
    resources: [
      {
        id: "lease",
        title: "Leases",
        idField: "Id",
        labelField: "Name",
        listOp: "list_leases",
        detailOp: "get_lease",
        detailParam: "leaseId",
        relations: [],
      },
    ],
    shapes: {
      lease: {
        rowsPath: "$.Data",
        rowCount: 12,
        schemaHash: "fnv1a:deadbeef",
        fields: [
          { name: "Id", kinds: ["number"], distinct: 12 },
          { name: "Name", kinds: ["string"], distinct: 12 },
          { name: "Status", kinds: ["string"], distinct: 3 },
        ],
      },
    },
    ...overrides,
  });

describe("capabilityReportSchema", () => {
  it("round-trips through JSON unchanged", () => {
    const original = report();
    const parsed = parseCapabilityReport(JSON.parse(JSON.stringify(original)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(original);
  });

  it("rejects a document that is not a report", () => {
    expect(parseCapabilityReport({ nope: true }).ok).toBe(false);
  });

  it("defaults a fresh report to a complete outcome that cost nothing", () => {
    const fresh = report();
    expect(fresh.outcome).toBe("complete");
    expect(fresh.requestsSpent).toBe(0);
    expect(fresh.revision).toBe(1);
  });

  /*
   * The privacy invariant. Sampling sees real business data; a report is field
   * names only. There is no schema slot for a value, so the guard is that a
   * value cannot survive a round trip even when someone tries to smuggle one.
   */
  it("strips sample values off a field that carries them", () => {
    const smuggled = capabilityReportSchema.parse({
      ...report(),
      shapes: {
        lease: {
          rowsPath: "$.Data",
          rowCount: 2,
          fields: [
            {
              name: "Email",
              kinds: ["string"],
              distinct: 2,
              // Exactly what `inferShape` hands over in memory.
              samples: ["ada@example.com", "grace@example.com"],
            },
            { name: "Phone", kinds: ["string"], distinct: 2, samples: ["(559) 617-7966"] },
          ],
        },
      },
    });

    const written = JSON.stringify(smuggled);
    expect(written).not.toContain("ada@example.com");
    expect(written).not.toContain("grace@example.com");
    expect(written).not.toContain("559");
    // The metadata survives — it is the values, and only the values, that go.
    expect(written).toContain("Email");
    expect(smuggled.shapes.lease?.fields[0]).toEqual({
      name: "Email",
      kinds: ["string"],
      nullable: false,
      distinct: 2,
    });
  });
});

describe("fingerprintOps / isStale", () => {
  it("ignores a cosmetic title change", () => {
    const before = connection();
    const after = connection({
      ops: before.ops.map((op) => ({ ...op, title: `${op.title} (renamed)` })),
    });
    expect(fingerprintOps(after.ops)).toBe(fingerprintOps(before.ops));
    expect(isStale(report(), after)).toBe(false);
  });

  it("is order-independent", () => {
    const before = connection();
    const after = connection({ ops: [...before.ops].reverse() });
    expect(fingerprintOps(after.ops)).toBe(fingerprintOps(before.ops));
  });

  it("goes stale when a path changes", () => {
    const after = connection({
      ops: connection().ops.map((op) =>
        op.id === "list_leases" ? { ...op, path: "/v2/leases" } : op,
      ),
    });
    expect(isStale(report(), after)).toBe(true);
  });

  it("goes stale when an endpoint is added", () => {
    const base = connection();
    const after = connection({
      ops: [
        ...base.ops,
        { id: "list_units", title: "Units", path: "/units", archetype: "list", params: [] },
      ],
    });
    expect(isStale(report(), after)).toBe(true);
  });
});

describe("diffReports", () => {
  it("reports no change between identical readings", () => {
    expect(diffReports(report(), report()).changed).toBe(false);
  });

  it("calls out an id field that moved", () => {
    const next = report({
      resources: [{ ...report().resources[0]!, idField: "LeaseId" }],
    });
    const diff = diffReports(report(), next);
    expect(diff.changed).toBe(true);
    expect(diff.changedIdFields).toEqual([{ resource: "lease", from: "Id", to: "LeaseId" }]);
  });

  it("tracks resources appearing and disappearing", () => {
    const next = report({
      resources: [
        ...report().resources,
        { id: "unit", title: "Units", listOp: "list_units", relations: [], verified: false },
      ],
    });
    expect(diffReports(report(), next).addedResources).toEqual(["unit"]);
    expect(diffReports(next, report()).removedResources).toEqual(["unit"]);
  });

  it("notices a relation gaining verification", () => {
    const withRelation = report({
      resources: [
        {
          ...report().resources[0]!,
          relations: [
            {
              id: "transactions",
              title: "Transactions",
              resource: "transaction",
              cardinality: "many",
              via: "path",
              confidence: "declared",
              verified: false,
            },
          ],
        },
      ],
    });
    const verified = report({
      resources: [
        {
          ...withRelation.resources[0]!,
          relations: [{ ...withRelation.resources[0]!.relations[0]!, verified: true }],
        },
      ],
    });
    expect(diffReports(withRelation, verified).verifiedGained).toEqual(["lease.transactions"]);
    expect(diffReports(verified, withRelation).verifiedLost).toEqual(["lease.transactions"]);
  });

  it("tracks unknowns being resolved", () => {
    const unknown = report({
      unknowns: [{ resource: "unit", title: "Units", reason: "empty" }],
    });
    expect(diffReports(unknown, report()).resolvedUnknowns).toEqual(["unit"]);
    expect(diffReports(report(), unknown).newUnknowns).toEqual(["unit"]);
  });
});

describe("toAllowlist", () => {
  it("lists every op with its inputs and owning resource", () => {
    const allowed = toAllowlist(report(), connection());
    expect(allowed.connection).toBe("acme");
    expect(allowed.readOnly).toBe(true);
    expect(allowed.ops.map((op) => op.id)).toEqual(["list_leases", "get_lease"]);

    const list = allowed.ops.find((op) => op.id === "list_leases")!;
    expect(list.resource).toBe("lease");
    expect(list.params).toEqual(["status", "limit"]);
    // `limit` is required but carries a default, so a caller need not supply it.
    expect(list.required).toEqual([]);

    const detail = allowed.ops.find((op) => op.id === "get_lease")!;
    expect(detail.required).toEqual(["leaseId"]);
  });

  it("omits a resource label for an op no resource claimed", () => {
    const orphan = connection({
      ops: [
        ...connection().ops,
        { id: "ping", title: "Ping", path: "/ping", archetype: "summary", params: [] },
      ],
    });
    const allowed = toAllowlist(report(), orphan);
    expect(allowed.ops.find((op) => op.id === "ping")?.resource).toBeUndefined();
  });
});
