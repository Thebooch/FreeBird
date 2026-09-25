import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import {
  catalogEntrySchema,
  compileBrief,
  dashboardSchema,
  entitySchema,
  resourceSchema,
} from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "./catalog.js";
import { buildServer } from "./server.js";
import { SpecStore } from "./store.js";
import { KeyStore, LocalAesVault } from "./vault.js";

/**
 * Reading the account teaches the record types what their fields hold.
 *
 * Rentvine as it really answers: flags its docs declare boolean arrive as 0
 * and 1, and a work order number its docs call text arrives as a number. Once
 * the account has been read, the record type says so — and a board built
 * before anybody knew is rebuilt to read the flag as a flag.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;

const WORK_ORDER = entitySchema.parse({
  id: "work-order",
  resource: "work-order",
  name: { one: "Work order", many: "Work orders" },
  kind: "work",
  identity: { field: "workOrder.workOrderID" },
  display: { title: ["workOrder.workOrderNumber"] },
  fields: [
    { path: "workOrder.workOrderID", kinds: ["string"], visibility: "hidden" },
    { path: "workOrder.workOrderNumber", kinds: ["string"], visibility: "primary" },
    { path: "workOrder.isVacant", kinds: ["boolean"], visibility: "primary" },
  ],
});

const RESOURCE = resourceSchema.parse({
  id: "work-order",
  title: "Work orders",
  listOp: "work_orders",
  detailOp: "work_order",
  detailParam: "workOrderID",
});

/* Declared flat by the docs; sent wrapped, as Rentvine sends a unit. */
const VENDOR = entitySchema.parse({
  id: "vendor",
  resource: "vendor",
  name: { one: "Vendor", many: "Vendors" },
  kind: "party",
  identity: { field: "vendorID" },
  display: { title: ["name"] },
  fields: [
    { path: "vendorID", kinds: ["number"], visibility: "hidden" },
    { path: "name", kinds: ["string"], visibility: "primary" },
    { path: "isActive", kinds: ["boolean"], visibility: "primary" },
  ],
});

const VENDOR_RESOURCE = resourceSchema.parse({
  id: "vendor",
  title: "Vendors",
  listOp: "vendors",
  detailOp: "vendor",
  detailParam: "vendorID",
});

const ENTRY = catalogEntrySchema.parse({
  id: "rentvine",
  title: "Rentvine",
  baseUrl: "https://acme.rentvine.com/api/manager",
  dialect: { auth: { type: "none" } },
  ops: [
    { id: "work_orders", title: "Work orders", path: "/maintenance/work-orders", rowsPath: "$" },
    { id: "work_order", title: "Work order", path: "/maintenance/work-orders/{{param.workOrderID}}" },
    { id: "vendors", title: "Vendors", path: "/vendors", rowsPath: "$" },
    { id: "vendor", title: "Vendor", path: "/vendors/{{param.vendorID}}" },
  ],
  resources: [RESOURCE, VENDOR_RESOURCE],
  entities: [WORK_ORDER, VENDOR],
  validateOpId: "work_orders",
});

const ROWS = [
  { workOrder: { workOrderID: "4930", workOrderNumber: 104868, isVacant: 0 } },
  { workOrder: { workOrderID: "4904", workOrderNumber: 104842, isVacant: 1 } },
];

const VENDOR_ROWS = [
  { vendor: { vendorID: 7, name: "Acme Plumbing", isActive: 1 } },
  { vendor: { vendorID: 8, name: "Birch Electric", isActive: 0 } },
];

const http: HttpFetch = async (url) => ({
  status: 200,
  text: JSON.stringify(url.includes("/vendors") ? VENDOR_ROWS : ROWS),
  url,
  header: () => null,
});

const makeApp = () => buildServer({ store, keys, catalog, llm: null, http });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-observe-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  catalog = new CatalogStore(join(dir, "seed"), join(dir, "overlay"));
  catalog.put(ENTRY);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("reading the account", () => {
  it("moves a record the docs put one level up to where it arrives", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "rentvine", id: "rv" },
    });
    const built = compileBrief({
      brief: { entity: "vendor", intent: "records", columns: ["name", "isActive"] },
      entity: VENDOR,
      resource: VENDOR_RESOURCE,
      connection: "rv",
      id: "vendors",
    });
    expect(built.widget).toBeDefined();
    store.putDashboard(dashboardSchema.parse({ id: "people", title: "People", widgets: [built.widget!] }));

    await app.inject({
      method: "POST",
      url: "/api/connections/rv/capabilities",
      payload: { refresh: true },
    });

    const vendor = catalog.get("rentvine")?.entities?.find((one) => one.id === "vendor");
    expect(vendor?.identity?.field).toBe("vendor.vendorID");
    expect(vendor?.display?.title).toEqual(["vendor.name"]);
    expect(vendor?.fields.find((field) => field.path === "vendor.isActive")?.observed?.coercion).toBe(
      "->boolean",
    );
    // Nothing internal to the check is written down.
    expect(vendor).not.toHaveProperty("wrapped");

    // The board built on the old paths now reads the new ones.
    const widget = store.getDashboard("people")?.widgets[0];
    expect(widget?.brief?.columns).toEqual(["vendor.name", "vendor.isActive"]);
    expect(widget?.roles.columns).toEqual(["vendor_name", "vendor_isActive"]);
  });

  it("records what the fields hold, and rebuilds the widgets that read them", async () => {
    const app = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "rentvine", id: "rv" },
    });
    expect(created.statusCode).toBeLessThan(300);

    /* A board built from a request before anybody knew how the flag arrives. */
    const compiled = compileBrief({
      brief: {
        entity: "work-order",
        intent: "records",
        columns: ["workOrder.workOrderNumber", "workOrder.isVacant"],
      },
      entity: WORK_ORDER,
      resource: RESOURCE,
      connection: "rv",
      id: "work_orders",
    });
    expect(compiled.widget).toBeDefined();
    const before = compiled.widget!;
    expect(JSON.stringify(before.pipeline)).not.toContain("->boolean");
    store.putDashboard(dashboardSchema.parse({ id: "ops", title: "Ops", widgets: [before] }));

    const read = await app.inject({
      method: "POST",
      url: "/api/connections/rv/capabilities",
      payload: { refresh: true },
    });
    expect(read.statusCode).toBe(200);

    const fields = catalog.get("rentvine")?.entities?.[0]?.fields ?? [];
    const byPath = new Map(fields.map((field) => [field.path, field]));
    expect(byPath.get("workOrder.isVacant")?.observed).toEqual({
      kinds: ["number"],
      coercion: "->boolean",
    });
    expect(byPath.get("workOrder.workOrderNumber")?.observed).toEqual({
      kinds: ["number"],
      semantic: "identifier",
    });
    // The declaration is left as the docs gave it: evidence sits beside it.
    expect(byPath.get("workOrder.isVacant")?.kinds).toEqual(["boolean"]);
    expect(catalog.get("rentvine")?.entities?.[0]?.readAt).toBeDefined();

    const rebuilt = store.getDashboard("ops")?.widgets[0];
    expect(rebuilt?.id).toBe("work_orders");
    expect(rebuilt?.pipeline).toContainEqual({
      op: "coerce",
      fields: { workOrder_isVacant: "->boolean" },
    });
    expect(rebuilt?.format).toMatchObject({ workOrder_workOrderNumber: { semantic: "identifier" } });
  });
});
