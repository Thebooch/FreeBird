import {
  compileBrief,
  entitySchema,
  parseWidget,
  resourceSchema,
  type EntitySpec,
} from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { executeWidget } from "./execute.js";
import { joinRows } from "./plan.js";
import type { RunContext } from "./types.js";

const ctx = (): RunContext => ({
  now: 1_700_000_000_000,
  params: {
    range: { start: 0, end: 1_700_000_000_000, grain: "1d", preset: "30d" },
    filters: {},
  },
});

describe("joinRows", () => {
  const leases = [
    { Id: 1, Tenant: "ana" },
    { Id: 2, Tenant: "bo" },
    { Id: 3, Tenant: "cy" },
  ];
  const orders = [
    { OrderId: 10, LeaseId: 1, Cost: 50 },
    { OrderId: 11, LeaseId: 1, Cost: 70 },
    { OrderId: 12, LeaseId: 2, Cost: 90 },
  ];

  const join = (kind: "inner" | "left") =>
    joinRows(leases, orders, {
      leftField: "Id",
      rightField: "LeaseId",
      rightAs: "orders",
      kind,
      maxRows: 1000,
    });

  it("prefixes every right-hand column, unconditionally", () => {
    // A shape that depends on whether names happened to collide cannot be
    // written against with confidence, so the rule has no exceptions.
    const { rows } = join("inner");
    expect(Object.keys(rows[0]!)).toEqual(["Id", "Tenant", "orders_OrderId", "orders_LeaseId", "orders_Cost"]);
  });

  it("emits one row per match, and says when it multiplied", () => {
    const { rows, warnings } = join("inner");
    // Lease 1 has two orders; lease 2 has one; lease 3 has none.
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.Id === 1)).toHaveLength(2);
    expect(warnings.join(" ")).toMatch(/matched more than one orders record/);
  });

  it("keeps unmatched left rows on a left join, with empty right columns", () => {
    const { rows, warnings } = join("left");
    const orphan = rows.find((row) => row.Id === 3)!;
    expect(orphan.orders_OrderId).toBeNull();
    expect(warnings.join(" ")).toMatch(/1 row\(s\) had no match .* kept/);
  });

  it("drops unmatched left rows on an inner join, and says so", () => {
    const { rows, warnings } = join("inner");
    expect(rows.some((row) => row.Id === 3)).toBe(false);
    expect(warnings.join(" ")).toMatch(/1 row\(s\) had no match .* dropped/);
  });

  it("ignores null keys rather than matching them to each other", () => {
    // Two rows that are both "unknown" are not the same record.
    const { rows } = joinRows(
      [{ Id: null, a: 1 }],
      [{ LeaseId: null, b: 2 }],
      { leftField: "Id", rightField: "LeaseId", rightAs: "r", kind: "inner", maxRows: 100 },
    );
    expect(rows).toHaveLength(0);
  });

  it("stops at the row cap rather than expanding without limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ LeaseId: 1, OrderId: i }));
    const { rows, warnings } = joinRows([{ Id: 1 }], many, {
      leftField: "Id",
      rightField: "LeaseId",
      rightAs: "orders",
      kind: "inner",
      maxRows: 10,
    });
    expect(rows).toHaveLength(10);
    expect(warnings.join(" ")).toMatch(/cut short/);
  });
});

describe("a widget that reads two endpoints", () => {
  /** The motivating question: how many work orders per tenant. */
  const spec = parseWidget({
    id: "orders_per_tenant",
    title: "Work orders per tenant",
    component: "bar",
    sources: [
      {
        as: "leases",
        connection: "pm",
        op: "leases_list",
        pipeline: [{ op: "extract", path: "$[*]" }],
      },
      {
        as: "orders",
        connection: "pm",
        op: "orders_list",
        pipeline: [{ op: "extract", path: "$[*]" }],
      },
    ],
    combine: {
      op: "join",
      left: "leases",
      right: "orders",
      on: { left: "Id", right: "LeaseId" },
      kind: "inner",
    },
    pipeline: [{ op: "group", by: [{ field: "Tenant" }], agg: { orders: "count()" } }],
    roles: { category: "Tenant", value: "orders" },
  });

  it("parses, which single-source validation would have rejected", () => {
    expect(spec.ok).toBe(true);
  });

  it("joins two responses and aggregates across them", () => {
    const result = executeWidget(
      spec.value!,
      {
        leases: [
          { Id: 1, Tenant: "ana" },
          { Id: 2, Tenant: "bo" },
        ],
        orders: [
          { LeaseId: 1, Cost: 50 },
          { LeaseId: 1, Cost: 70 },
          { LeaseId: 2, Cost: 90 },
        ],
      },
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([
      { Tenant: "ana", orders: 2 },
      { Tenant: "bo", orders: 1 },
    ]);
  });

  it("traces every source and the join, so the total can be audited", () => {
    const result = executeWidget(
      spec.value!,
      { leases: [{ Id: 1, Tenant: "ana" }], orders: [{ LeaseId: 1 }] },
      ctx(),
    );
    const ops = result.meta!.steps.map((step) => step.op);
    expect(ops).toContain("leases.extract");
    expect(ops).toContain("orders.extract");
    expect(ops).toContain("join");
  });

  it("degrades to empty rather than blanking when one endpoint returns nothing", () => {
    const result = executeWidget(spec.value!, { leases: [{ Id: 1, Tenant: "ana" }] }, ctx());
    expect(result.meta!.warnings.join(" ")).toMatch(/"orders" returned nothing/);
  });
});

describe("plan validation", () => {
  const base = {
    id: "w",
    title: "W",
    component: "table",
    roles: { columns: ["a"] },
  };

  it("rejects a widget declaring both source and sources", () => {
    const result = parseWidget({
      ...base,
      source: { connection: "c", op: "o" },
      sources: [{ as: "x", connection: "c", op: "o" }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/either `source` or `sources`/);
  });

  it("rejects a widget declaring neither", () => {
    expect(parseWidget(base).ok).toBe(false);
  });

  it("requires a combine once there are two sources", () => {
    const result = parseWidget({
      ...base,
      sources: [
        { as: "a", connection: "c", op: "o" },
        { as: "b", connection: "c", op: "o" },
      ],
    });
    expect(result.errors.join(" ")).toMatch(/need a `combine`/);
  });

  it("rejects a combine naming a source that does not exist", () => {
    const result = parseWidget({
      ...base,
      sources: [
        { as: "a", connection: "c", op: "o" },
        { as: "b", connection: "c", op: "o" },
      ],
      combine: { op: "join", left: "a", right: "ghost", on: { left: "x", right: "y" } },
    });
    expect(result.errors.join(" ")).toMatch(/"ghost", which is not a source/);
  });

  it("rejects a fan-out that reads from itself", () => {
    const result = parseWidget({
      ...base,
      sources: [{ as: "a", connection: "c", op: "o", fanOut: { from: "a", field: "Id" } }],
    });
    expect(result.errors.join(" ")).toMatch(/cannot fan out from itself/);
  });
});

describe("an open component id", () => {
  it("fails with a message naming the component, not a crash", () => {
    /*
     * The trade for open ids: a spec can reference a renderer this build does
     * not supply. The data still loads and shapes correctly — only the drawing
     * is missing — so the failure names the id rather than throwing on an
     * undefined contract.
     */
    const spec = parseWidget({
      id: "w",
      title: "W",
      component: "piechart",
      source: { connection: "c", op: "o" },
      pipeline: [{ op: "extract", path: "$[*]" }],
      roles: {},
    });
    expect(spec.ok).toBe(true);

    const result = executeWidget(spec.value!, [{ a: 1 }], ctx());
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/no component named "piechart" is available/);
    // The rows survived — this is a rendering gap, not a data failure.
    expect(result.rows).toHaveLength(1);
  });
});

/**
 * The same two endpoints, written as a sentence instead of a plan.
 *
 * `compileBrief` is the only thing above this that emits a multi-source
 * widget, and a spec that parses is not the same as one that runs: the join
 * prefixes the far side's *top-level* keys, so a source that flattens its
 * nested fields too late produces one prefixed column holding a record and a
 * table of blanks. Executing it here is what catches that, and it is the same
 * check the live pass does with real rows.
 */
describe("a join compiled from a brief", () => {
  const task: EntitySpec = entitySchema.parse({
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    kind: "work",
    identity: { field: "Id", observed: true },
    display: { title: ["Title"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      { path: "VendorId", label: "Vendor", visibility: "detail", reference: { entity: "vendor" } },
    ],
  });

  const vendor: EntitySpec = entitySchema.parse({
    id: "vendor",
    resource: "vendor",
    name: { one: "Vendor", many: "Vendors" },
    kind: "party",
    identity: { field: "Id", observed: true },
    display: { title: ["Name"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Name", label: "Name", visibility: "primary" },
      { path: "Phone", label: "Phone", visibility: "primary" },
    ],
  });

  const resources = [
    resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list" }),
    resourceSchema.parse({ id: "vendor", title: "Vendors", listOp: "vendors_list" }),
  ];

  const compiled = compileBrief({
    brief: { entity: "task", intent: "records", alongside: { entity: "vendor" } },
    entity: task,
    resource: resources[0]!,
    connection: "pm",
    id: "tasks_with_vendor",
    related: {
      entities: [task, vendor],
      resources,
      ops: [
        { id: "tasks_list", path: "/tasks" },
        { id: "vendors_list", path: "/vendors" },
      ],
    },
  });

  it("runs, and puts the far record's fields on the row", () => {
    const result = executeWidget(
      compiled.widget!,
      {
        task: [
          { Id: 1, Title: "Fix the boiler", VendorId: 9 },
          { Id: 2, Title: "Repaint 2B", VendorId: 7 },
        ],
        vendor: [
          { Id: 9, Name: "Acme Plumbing", Phone: "555-0101" },
          { Id: 7, Name: "Bright Painters", Phone: "555-0102" },
        ],
      },
      ctx(),
    );

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        Id: 1,
        Title: "Fix the boiler",
        VendorId: 9,
        vendor_Id: 9,
        vendor_Name: "Acme Plumbing",
        vendor_Phone: "555-0101",
      },
      {
        Id: 2,
        Title: "Repaint 2B",
        VendorId: 7,
        vendor_Id: 7,
        vendor_Name: "Bright Painters",
        vendor_Phone: "555-0102",
      },
    ]);
  });

  it("binds every column it named, so the widget renders rather than warning", () => {
    const result = executeWidget(
      compiled.widget!,
      {
        task: [{ Id: 1, Title: "Fix the boiler", VendorId: 9 }],
        vendor: [{ Id: 9, Name: "Acme Plumbing", Phone: "555-0101" }],
      },
      ctx(),
    );
    expect(result.binding?.errors ?? []).toEqual([]);
    expect(result.binding?.warnings ?? []).toEqual([]);
  });

  it("keeps a row whose match is missing, rather than quietly dropping it", () => {
    // A left join, deliberately: an inner one deletes the rows that matched
    // nothing, and a widget quietly short of half its records says nothing
    // about why.
    const result = executeWidget(
      compiled.widget!,
      {
        task: [{ Id: 3, Title: "Clear the gutters", VendorId: null }],
        vendor: [{ Id: 9, Name: "Acme Plumbing", Phone: "555-0101" }],
      },
      ctx(),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ Title: "Clear the gutters", vendor_Name: null });
  });
});
