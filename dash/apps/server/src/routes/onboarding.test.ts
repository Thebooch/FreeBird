import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogEntry, ConnectionSpec } from "@freebirdai/dash-spec";
import { CATEGORY_VERSION, catalogEntrySchema, connectionSchema } from "@freebirdai/dash-spec";
import { fakeLlm } from "@freebirdai/dash-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../catalog.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "../vault.js";
import { offersFor, categoryState } from "./onboarding.js";

/**
 * Onboarding over HTTP: what the wizard's last step actually talks to.
 *
 * Every model call here is a fake, so the two passes are exercised without
 * spending anything — and the boards that come out are built by the real
 * compiler against a real connection, which is the half most worth proving.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;

const ENTITIES = [
  {
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    kind: "work",
    identity: { field: "Id", observed: true },
    display: { title: ["Title"], status: "Status" },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      { path: "Status", label: "Status", visibility: "primary", values: ["Open", "Closed"] },
      { path: "DueDate", label: "Due date", semantic: "timestamp", visibility: "detail" },
    ],
  },
  {
    id: "lease",
    resource: "lease",
    name: { one: "Lease", many: "Leases" },
    kind: "document",
    identity: { field: "Id", observed: true },
    display: { title: ["Title"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Reference", visibility: "primary" },
      { path: "Status", label: "Status", visibility: "primary" },
    ],
  },
];

const entry = (input: Partial<CatalogEntry> = {}): CatalogEntry =>
  catalogEntrySchema.parse({
    id: "acme",
    title: "Acme",
    baseUrl: "https://api.example.com",
    dialect: { auth: { type: "none" } },
    ops: [
      { id: "tasks_list", title: "Retrieve all tasks", path: "/v1/tasks" },
      { id: "leases_list", title: "Retrieve all leases", path: "/v1/leases" },
    ],
    resources: [
      { id: "task", title: "Tasks", listOp: "tasks_list" },
      { id: "lease", title: "Leases", listOp: "leases_list" },
    ],
    entities: ENTITIES,
    ...input,
  });

const connection: ConnectionSpec = connectionSchema.parse({
  id: "acme",
  title: "Acme",
  kind: "rest",
  baseUrl: "https://api.example.com",
  catalog: "acme",
  ops: [
    { id: "tasks_list", title: "Retrieve all tasks", path: "/v1/tasks" },
    { id: "leases_list", title: "Retrieve all leases", path: "/v1/leases" },
  ],
  resources: [
    { id: "task", title: "Tasks", listOp: "tasks_list" },
    { id: "lease", title: "Leases", listOp: "leases_list" },
  ],
});

const DIVISION = {
  product: "Property management software.",
  domain: "property management",
  categories: [
    { title: "Maintenance", description: "Work on the properties.", entities: ["task"] },
    { title: "Leasing", description: "Agreements on units.", entities: ["lease"] },
  ],
};

const COMPOSITION = {
  widgets: [
    { entity: "task", intent: "measure", title: "Open work", importance: 5, size: "sm" },
    { entity: "task", intent: "compare", groupBy: "Status", importance: 4, size: "md" },
    { entity: "task", intent: "records", importance: 2, size: "lg" },
  ],
};

const LEASE_COMPOSITION = {
  widgets: [{ entity: "lease", intent: "records", title: "Leases", importance: 3 }],
};

/** A composed catalog entry, so the connection routes need no model at all. */
const composed = (): CatalogEntry =>
  entry({
    profile: { summary: "Property management software.", domain: "property management" },
    categories: [
      {
        id: "maintenance",
        title: "Maintenance",
        description: "Work on the properties.",
        entities: ["task"],
        starters: [
          { brief: { entity: "task", intent: "measure", title: "Open work" }, importance: 5, size: "sm" },
          { brief: { entity: "task", intent: "compare", groupBy: "Status" }, importance: 4 },
          { brief: { entity: "task", intent: "records" }, importance: 2, size: "lg" },
        ],
      },
      {
        id: "leasing",
        title: "Leasing",
        entities: ["lease"],
        starters: [{ brief: { entity: "lease", intent: "records" }, importance: 3 }],
      },
    ],
    categoriesAt: new Date("2026-09-01T00:00:00Z").toISOString(),
    categoryVersion: CATEGORY_VERSION,
  });

const makeApp = (llm?: ReturnType<typeof fakeLlm>) =>
  buildServer({ store, keys, catalog, ...(llm ? { llm } : { llm: null }) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-onboarding-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  catalog = new CatalogStore(join(dir, "seed"), join(dir, "overlay"));
  catalog.put(entry());
  store.putConnection(connection);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("categoryState", () => {
  it("reports an API nobody has divided", () => {
    expect(categoryState(entry())).toMatchObject({ divided: false, categories: 0, starters: 0 });
  });

  it("counts the parts that have a starting dashboard", () => {
    const state = categoryState(composed());
    expect(state).toMatchObject({ divided: true, stale: false, categories: 2, composed: 2 });
    expect(state.starters).toBe(4);
  });

  /* A partial run that produced usable parts HAS divided this API. Reading the
   * version stamp instead offers to spend money redoing finished work. */
  it("calls a division from an older pass stale without calling it absent", () => {
    const state = categoryState(entry({ ...composed(), categoryVersion: undefined }));
    expect(state).toMatchObject({ divided: true, stale: true });
  });
});

describe("GET /api/catalog/:id/categories", () => {
  it("says an API has not been divided, and that it cannot be", async () => {
    const app = makeApp();
    const result = await app.inject({ method: "GET", url: "/api/catalog/acme/categories" });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ divided: false, canRun: false, entities: 2 });
    await app.close();
  });

  it("is free — no model is called to read it", async () => {
    const llm = fakeLlm([{ args: DIVISION }]);
    const app = makeApp(llm);
    await app.inject({ method: "GET", url: "/api/catalog/acme/categories" });
    expect(llm.calls).toEqual([]);
    await app.close();
  });
});

describe("POST /api/catalog/:id/categories", () => {
  it("divides the API and composes a set for each part", async () => {
    const llm = fakeLlm([{ args: DIVISION }, { args: COMPOSITION }, { args: LEASE_COMPOSITION }]);
    const app = makeApp(llm);
    const result = await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });

    expect(result.statusCode).toBe(200);
    const body = result.json() as {
      ranPass: boolean;
      categories: number;
      composed: number;
      kept: number;
      errors: string[];
      profile?: { domain?: string };
    };
    expect(body.ranPass).toBe(true);
    expect(body.categories).toBe(2);
    expect(body.composed).toBe(2);
    expect(body.errors).toEqual([]);
    expect(body.profile?.domain).toBe("property management");

    /* One call to divide, then one per part. */
    expect(llm.calls).toHaveLength(3);

    const stored = catalog.get("acme");
    expect(stored?.categoryVersion).toBe(CATEGORY_VERSION);
    expect(stored?.categories.map((one) => one.id)).toEqual(["maintenance", "leasing"]);
    expect(stored?.categories[0]?.starters).toHaveLength(3);
    await app.close();
  });

  it("makes no request against the API it is describing", async () => {
    const llm = fakeLlm([{ args: DIVISION }, { args: COMPOSITION }, { args: LEASE_COMPOSITION }]);
    let requests = 0;
    const app = buildServer({
      store,
      keys,
      catalog,
      llm,
      http: async (url) => {
        requests += 1;
        return { status: 200, text: "{}", url, header: () => null };
      },
    });
    await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    expect(requests).toBe(0);
    await app.close();
  });

  it("declines an API whose records nobody has described", async () => {
    catalog.put(entry({ entities: [] }));
    const llm = fakeLlm([{ args: DIVISION }]);
    const app = makeApp(llm);
    const result = await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toMatch(/records have not been described/);
    await app.close();
  });

  it("says it needs an AI key rather than failing obscurely", async () => {
    const app = makeApp();
    const result = await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toMatch(/needs an AI key/);
    await app.close();
  });

  /* Re-running renames and re-ids every part, which would orphan the boards
   * somebody already has. So a finished division is left alone. */
  it("does nothing when every part already has a starting dashboard", async () => {
    catalog.put(composed());
    const llm = fakeLlm([{ args: DIVISION }]);
    const app = makeApp(llm);
    const result = await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    expect(result.json().ranPass).toBe(false);
    expect(llm.calls).toEqual([]);
    await app.close();
  });

  it("composes the missing sets without re-dividing the API", async () => {
    const half = composed();
    catalog.put({
      ...half,
      categories: [half.categories[0]!, { ...half.categories[1]!, starters: [] }],
      categoryVersion: undefined,
      categoryProgress: undefined,
    });
    const llm = fakeLlm([{ args: LEASE_COMPOSITION }]);
    const app = makeApp(llm);
    const result = await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });

    expect(result.json().composed).toBe(2);
    /* One call, for the one part that had no set — the division is reused. */
    expect(llm.calls).toHaveLength(1);
    expect(catalog.get("acme")?.categories.map((one) => one.id)).toEqual([
      "maintenance",
      "leasing",
    ]);
    await app.close();
  });
});

describe("offersFor", () => {
  it("says what each part covers and what it opens with", () => {
    const offers = offersFor({ connection, entry: composed() });
    expect(offers[0]).toMatchObject({
      id: "maintenance",
      title: "Maintenance",
      recordTypes: 1,
      widgets: 3,
      available: true,
    });
    expect(offers[0]?.opensWith).toEqual(["Open work", "Tasks", "Tasks"]);
  });

  /* The catalog describes the whole API; a connection holds what somebody
   * picked. An offer that cannot be executed is worse than no offer. */
  it("marks a part unavailable when this connection lacks its endpoints", () => {
    const partial = connectionSchema.parse({
      ...connection,
      ops: [{ id: "tasks_list", title: "Retrieve all tasks", path: "/v1/tasks" }],
      resources: [{ id: "task", title: "Tasks", listOp: "tasks_list" }],
    });
    const offers = offersFor({ connection: partial, entry: composed() });
    expect(offers.find((one) => one.id === "leasing")).toMatchObject({
      available: false,
      unavailable: "This connection does not carry the endpoints behind these records.",
    });
  });

  it("marks a part unavailable when nothing has been composed for it", () => {
    const half = composed();
    const offers = offersFor({
      connection,
      entry: { ...half, categories: [{ ...half.categories[0]!, starters: [] }] },
    });
    expect(offers[0]).toMatchObject({ available: false, widgets: 0 });
    expect(offers[0]?.unavailable).toMatch(/Nothing has been composed/);
  });
});

describe("GET /api/connections/:id/onboarding", () => {
  beforeEach(() => catalog.put(composed()));

  it("offers the parts, with what each opens with", async () => {
    const app = makeApp();
    const result = await app.inject({ method: "GET", url: "/api/connections/acme/onboarding" });
    const body = result.json() as {
      categories: Array<{ id: string; widgets: number }>;
      profile?: { summary: string };
      already?: unknown;
    };
    expect(body.categories.map((one) => one.id)).toEqual(["maintenance", "leasing"]);
    expect(body.profile?.summary).toBe("Property management software.");
    expect(body.already).toBeUndefined();
    await app.close();
  });

  it("404s a connection that does not exist", async () => {
    const app = makeApp();
    const result = await app.inject({ method: "GET", url: "/api/connections/ghost/onboarding" });
    expect(result.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/connections/:id/onboarding", () => {
  beforeEach(() => catalog.put(composed()));

  it("builds a board per part and records the choice", async () => {
    const app = makeApp();
    const result = await app.inject({
      method: "POST",
      url: "/api/connections/acme/onboarding",
      payload: { categories: ["maintenance", "leasing"], layout: "per-category" },
    });

    expect(result.statusCode).toBe(200);
    const body = result.json() as { boards: Array<{ dashboard: string; widgets: number }> };
    expect(body.boards).toHaveLength(2);
    expect(body.boards[0]).toMatchObject({ dashboard: "maintenance", widgets: 3 });

    const board = store.getDashboard("maintenance");
    expect(board?.widgets.map((widget) => widget.component)).toEqual(["stat", "bar", "table"]);
    expect(board?.layout.cells).toHaveLength(3);

    const saved = store.getConnection("acme");
    expect(saved?.onboarding).toMatchObject({
      chose: ["maintenance", "leasing"],
      layout: "per-category",
    });
    expect(saved?.onboarding?.at).toBeTruthy();
    await app.close();
  });

  it("builds one board for everything when asked", async () => {
    const app = makeApp();
    const result = await app.inject({
      method: "POST",
      url: "/api/connections/acme/onboarding",
      payload: { categories: ["maintenance", "leasing"], layout: "single" },
    });
    const body = result.json() as { boards: Array<{ title: string; widgets: number }> };
    expect(body.boards).toHaveLength(1);
    expect(body.boards[0]).toMatchObject({ title: "Acme", widgets: 4 });
    await app.close();
  });

  it("needs no model at all", async () => {
    const llm = fakeLlm([{ args: DIVISION }]);
    const app = makeApp(llm);
    await app.inject({
      method: "POST",
      url: "/api/connections/acme/onboarding",
      payload: { categories: ["maintenance"] },
    });
    expect(llm.calls).toEqual([]);
    await app.close();
  });

  it("reports what was already set up, and where it went", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/connections/acme/onboarding",
      payload: { categories: ["maintenance"] },
    });
    const result = await app.inject({ method: "GET", url: "/api/connections/acme/onboarding" });
    const body = result.json() as {
      already: { chose: string[]; boards: Array<{ dashboard: string; title: string }> };
    };
    expect(body.already.chose).toEqual(["maintenance"]);
    expect(body.already.boards[0]).toMatchObject({ dashboard: "maintenance", title: "Maintenance" });
    await app.close();
  });

  /* A board deleted since is not a board. "Already set up" must never point at
   * nothing. */
  it("leaves out a board that has been deleted", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/connections/acme/onboarding",
      payload: { categories: ["maintenance"] },
    });
    store.deleteDashboard("maintenance");
    const result = await app.inject({ method: "GET", url: "/api/connections/acme/onboarding" });
    expect((result.json() as { already: { boards: unknown[] } }).already.boards).toEqual([]);
    await app.close();
  });

  /* Somebody setting up again has changed their mind about what they want, not
   * about the board they have been arranging since. */
  it("makes new boards rather than rewriting the ones that exist", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/connections/acme/onboarding",
      payload: { categories: ["maintenance"] },
    });
    const first = store.getDashboard("maintenance");
    store.putDashboard({ ...first!, title: "My board" });

    await app.inject({
      method: "POST",
      url: "/api/connections/acme/onboarding",
      payload: { categories: ["maintenance"] },
    });
    expect(store.getDashboard("maintenance")?.title).toBe("My board");
    expect(store.getDashboard("maintenance-2")?.widgets).toHaveLength(3);
    await app.close();
  });

  it("refuses a part that is not on this API", async () => {
    const app = makeApp();
    const result = await app.inject({
      method: "POST",
      url: "/api/connections/acme/onboarding",
      payload: { categories: ["accounting"] },
    });
    expect(result.statusCode).toBe(409);
    expect((result.json() as { notes: string[] }).notes.join(" ")).toMatch(/not a part of this API/);
    await app.close();
  });

  it("refuses an empty choice", async () => {
    const app = makeApp();
    const result = await app.inject({
      method: "POST",
      url: "/api/connections/acme/onboarding",
      payload: { categories: [] },
    });
    expect(result.statusCode).toBe(400);
    await app.close();
  });

  it("declines a connection with no integration behind it", async () => {
    store.putConnection(connectionSchema.parse({ ...connection, id: "bare", catalog: undefined }));
    const app = makeApp();
    const result = await app.inject({
      method: "POST",
      url: "/api/connections/bare/onboarding",
      payload: { categories: ["maintenance"] },
    });
    expect(result.statusCode).toBe(409);
    await app.close();
  });
});
