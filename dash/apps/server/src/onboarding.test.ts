import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError, emptyMeta } from "@freebirdai/dash-adapters";
import { fakeLlm } from "@freebirdai/dash-agent";
import { catalogEntrySchema, connectionSchema, widgetSchema } from "@freebirdai/dash-spec";
import type { CatalogEntry } from "@freebirdai/dash-spec";
import type { IntegrationStore } from "./catalog.js";
import { SpecStore } from "./store.js";
import { OnboardingService } from "./onboarding.js";
import { CatalogStore } from "./catalog.js";
import { buildServer } from "./server.js";
import { KeyStore, LocalAesVault } from "./vault.js";

let dir: string;
let store: SpecStore;
let entry: CatalogEntry;
let catalog: IntegrationStore;
const categoryAnswer = {
  purpose: "Property management software",
  categoryQuestion: "Choose your areas",
  organizationQuestion: "Together or separate?",
  categories: [
    { id: "leasing", title: "Leasing", description: "Lease activity", opIds: ["leases"] },
    { id: "maintenance", title: "Maintenance", description: "Repair activity", opIds: ["tasks"] },
  ],
};
const design = (entity: string) => ({
  args: { widgets: [{ entity, title: entity, intent: "records" }] },
});
const invalidLayout = { args: { cells: [] } };
const model = () =>
  fakeLlm([
    { args: categoryAnswer },
    design("leases"),
    invalidLayout,
    invalidLayout,
    design("tasks"),
    invalidLayout,
    invalidLayout,
  ]);
const read = vi.fn(async () => ({
  body: [{ Id: 1, Title: "Example", Status: "Open" }],
  meta: emptyMeta("https://example.com", 0),
}));
const service = (llm = model()) => new OnboardingService({ store, catalog, llm: () => llm, read });
async function prepared() {
  const llm = model(),
    setup = service(llm);
  await setup.prepare("account");
  await setup.prepare("account");
  return { llm, setup };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-onboarding-"));
  store = new SpecStore(join(dir, "boards"), join(dir, "connections"));
  entry = catalogEntrySchema.parse({
    id: "buildium",
    title: "Buildium",
    baseUrl: "https://example.com",
    dialect: {},
    ops: ["leases", "tasks"].map((id) => ({
      id,
      title: id,
      path: `/${id}`,
      description: id,
      rowsPath: "$",
      fields: [{ name: "Title", kinds: ["string"] }],
    })),
    resources: ["leases", "tasks"].map((id) => ({ id, title: id, listOp: id })),
    entities: ["leases", "tasks"].map((id) => ({
      id,
      resource: id,
      name: { one: id, many: id },
      kind: "work",
      identity: { field: "Id" },
      display: { title: ["Title"] },
      fields: [
        { path: "Id", kinds: ["number"], visibility: "hidden" },
        { path: "Title", kinds: ["string"], visibility: "primary" },
        { path: "Status", kinds: ["string"], visibility: "primary" },
      ],
    })),
  });
  catalog = {
    get: () => structuredClone(entry),
    list: () => [structuredClone(entry)],
    put: (next) => {
      entry = structuredClone(next);
      return entry;
    },
    deleteOverlay: () => {},
  };
  store.putConnection(
    connectionSchema.parse({
      id: "account",
      title: "My Buildium",
      kind: "rest",
      baseUrl: entry.baseUrl,
      catalog: entry.id,
      ops: entry.ops,
      resources: entry.resources,
    }),
  );
  read.mockReset();
  read.mockImplementation(async () => ({
    body: [{ Id: 1, Title: "Example", Status: "Open" }],
    meta: emptyMeta("https://example.com", 0),
  }));
});
afterEach(() => {
  // Generated temp directory only; never remove a computed path outside its parent.
  if (
    resolve(dir).startsWith(resolve(tmpdir()) + "\\") ||
    resolve(dir).startsWith(resolve(tmpdir()) + "/")
  )
    rmSync(dir, { recursive: true, force: true });
});

describe("connection onboarding", () => {
  it("does not create a placeholder tab for a new guided connection", async () => {
    const diskCatalog = new CatalogStore(join(dir, "seed"), join(dir, "catalog"));
    diskCatalog.put(entry);
    const app = buildServer({
      store,
      catalog: diskCatalog,
      keys: new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, "keys.json")),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/connections/from-catalog",
        payload: { catalogId: entry.id, id: "new-account", onboarding: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().onboarding.status).toBe("pending");
      expect(store.getDashboard("new-account")).toBeNull();
    } finally {
      await app.close();
    }
  });
  it("keeps locally prepared connections usable by the normal widget editor", async () => {
    await prepared();
    const local = connectionSchema.parse({
      ...store.getConnection("account"),
      id: "local",
      title: entry.title,
      catalog: undefined,
      onboarding: {
        status: "pending",
        localEntities: entry.entities,
        template: entry.onboarding,
        dashboardIds: [],
      },
    });
    store.putConnection(local);
    const setup = new OnboardingService({ store, llm: () => null, read });
    expect((await setup.prepare("local")).stale).toBe(false);
    setup.choose("local", { categoryIds: ["leasing"], organization: "combined" });
    const preview = await setup.preview("local");
    const ids = await setup.commit("local", preview.id);
    const app = buildServer({
      store,
      keys: new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, "keys.json")),
    });
    try {
      const entities = await app.inject({ method: "GET", url: "/api/connections/local/entities" });
      expect(entities.json()).toHaveLength(2);
      const widget = store.getDashboard(ids[0]!)!.widgets[0]!;
      const settings = await app.inject({
        method: "GET",
        url: `/api/dashboards/${ids[0]}/widgets/${widget.id}/settings`,
      });
      expect(settings.statusCode).toBe(200);
      expect(settings.json().brief.entity).toBe("leases");
    } finally {
      await app.close();
    }
  });
  it("checkpoints every category and reuses templates for another connection without model calls", async () => {
    const { llm, setup } = await prepared();
    expect(setup.status("account").template?.categories.map((one) => one.status)).toEqual([
      "ready",
      "ready",
    ]);
    const calls = llm.calls.length;
    store.putConnection({
      ...store.getConnection("account")!,
      id: "second",
      onboarding: undefined,
    });
    await setup.prepare("second");
    expect(llm.calls).toHaveLength(calls);
    setup.choose("second", { categoryIds: ["leasing"], organization: "combined" });
    const preview = await setup.preview("second");
    expect(preview.dashboards[0]?.widgets[0]?.source?.connection).toBe("second");
    expect(JSON.stringify(entry.onboarding)).not.toContain("Example");
    expect(entry.onboarding).not.toHaveProperty("choices");
  });
  it.each(["combined", "separate"])(
    "creates %s editable tabs and idempotently resumes from disk",
    async (organization) => {
      const { setup } = await prepared();
      setup.choose("account", { categoryIds: ["leasing", "maintenance"], organization });
      const preview = await setup.preview("account");
      expect(preview.dashboards).toHaveLength(organization === "combined" ? 1 : 2);
      expect(preview.dashboards[0]?.layout.cells.every((cell) => !cell.locked)).toBe(true);
      const ids = await setup.commit("account", preview.id);
      const board = store.getDashboard(ids[0]!)!;
      store.putDashboard({ ...board, title: "My edited dashboard" });
      expect(await service().commit("account", preview.id)).toEqual(ids);
      expect(store.listDashboards()).toHaveLength(ids.length);
      expect(store.getDashboard(ids[0]!)?.title).toBe("My edited dashboard");
      expect(() => setup.choose("account", { categoryIds: ["leasing"], organization })).toThrow(
        "explicitly",
      );
    },
  );
  it("continues an interrupted multi-dashboard write without replacing the first board", async () => {
    const { setup } = await prepared();
    setup.choose("account", { categoryIds: ["leasing", "maintenance"], organization: "separate" });
    const preview = await setup.preview("account");
    const write = store.putDashboard.bind(store);
    const spy = vi
      .spyOn(store, "putDashboard")
      .mockImplementationOnce(write)
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });
    await expect(setup.commit("account", preview.id)).rejects.toThrow("disk full");
    expect(store.getConnection("account")?.onboarding?.status).toBe("creating");
    spy.mockRestore();
    const first = store.listDashboards()[0]!;
    store.putDashboard({ ...first, title: "Preserve this edit" });
    await service().commit("account", preview.id);
    expect(store.listDashboards()).toHaveLength(2);
    expect(store.getDashboard(first.id)?.title).toBe("Preserve this edit");
  });
  it("treats empty successful collections as accessible", async () => {
    const { setup } = await prepared();
    read.mockResolvedValue({ body: [], meta: emptyMeta("https://example.com", 0) });
    setup.choose("account", { categoryIds: ["leasing"], organization: "combined" });
    expect((await setup.preview("account")).verification[0]?.status).toBe("ready");
  });
  it("can explicitly restart an outdated interrupted creation without removing saved tabs", async () => {
    const { setup } = await prepared();
    setup.choose("account", { categoryIds: ["leasing", "maintenance"], organization: "separate" });
    const preview = await setup.preview("account");
    const write = store.putDashboard.bind(store);
    const spy = vi
      .spyOn(store, "putDashboard")
      .mockImplementationOnce(write)
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });
    await expect(setup.commit("account", preview.id)).rejects.toThrow();
    spy.mockRestore();
    store.putConnection({ ...store.getConnection("account")!, credentialsRevision: 3 });
    await expect(setup.commit("account", preview.id)).rejects.toThrow("outdated");
    setup.restart("account");
    expect(store.listDashboards()).toHaveLength(1);
    expect(setup.status("account").state?.status).toBe("choosing");
  });
  it.each([
    [401, "credentials"],
    [403, "denied"],
    [429, "transient"],
    [503, "transient"],
  ] as const)("reports HTTP %s as %s without saving upstream data", async (status, outcome) => {
    const { setup } = await prepared();
    read.mockRejectedValue(
      new AdapterError("PRIVATE PAYLOAD", { status, userMessage: "PRIVATE PAYLOAD" }),
    );
    setup.choose("account", { categoryIds: ["leasing"], organization: "combined" });
    const preview = await setup.preview("account");
    expect(preview.verification[0]?.status).toBe(outcome);
    expect(preview.dashboards).toEqual([]);
    expect(JSON.stringify(store.getConnection("account"))).not.toContain("PRIVATE PAYLOAD");
  });
  it("excludes disabled endpoints and allows the verified remainder", async () => {
    const { setup } = await prepared();
    const connection = store.getConnection("account")!;
    store.putConnection({ ...connection, ops: connection.ops.filter((op) => op.id === "leases") });
    setup.choose("account", { categoryIds: ["leasing", "maintenance"], organization: "separate" });
    const preview = await setup.preview("account");
    expect(preview.dashboards).toHaveLength(1);
    expect(preview.verification[1]?.status).toBe("unavailable");
  });
  it("rejects stale previews after credentials or integration metadata change", async () => {
    const { setup } = await prepared();
    setup.choose("account", { categoryIds: ["leasing"], organization: "combined" });
    const preview = await setup.preview("account");
    store.putConnection({ ...store.getConnection("account")!, credentialsRevision: 2 });
    await expect(setup.commit("account", preview.id)).rejects.toThrow("outdated");
    entry.ops[0]!.description = "New endpoint meaning";
    expect(setup.status("account").stale).toBe(true);
  });
  it("preserves choices when skipped and resumed", async () => {
    const { setup } = await prepared();
    setup.choose("account", { categoryIds: ["leasing"], organization: "separate" });
    setup.skip("account");
    expect(service().status("account").state?.choices).toEqual({
      categoryIds: ["leasing"],
      organization: "separate",
    });
  });
  it("runs verification and creation through the real HTTP routes with no model configured", async () => {
    await prepared();
    const diskCatalog = new CatalogStore(join(dir, "seed"), join(dir, "catalog"));
    diskCatalog.put(entry);
    const app = buildServer({
      store,
      catalog: diskCatalog,
      keys: new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, "keys.json")),
      http: async (url) => ({
        status: 200,
        url,
        text: JSON.stringify([{ Id: 1, Title: "Lease", Status: "Open" }]),
        header: () => null,
      }),
    });
    try {
      const base = "/api/connections/account/onboarding";
      expect((await app.inject({ method: "GET", url: base })).json().canPrepare).toBe(false);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${base}/choices`,
            payload: { categoryIds: ["leasing"], organization: "combined" },
          })
        ).statusCode,
      ).toBe(200);
      const response = await app.inject({ method: "POST", url: `${base}/preview` });
      expect(response.statusCode).toBe(200);
      const preview = response.json();
      expect(preview.verification[0].status).toBe("ready");
      const created = await app.inject({
        method: "POST",
        url: `${base}/commit`,
        payload: { previewId: preview.id },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().dashboardIds).toHaveLength(1);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base}/commit`,
            payload: { previewId: "wrong" },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("reports mismatched response fields instead of creating blank widgets", async () => {
    const { setup } = await prepared();
    read.mockResolvedValue({
      body: [{ Id: 1, Different: "missing title" }] as unknown as Awaited<
        ReturnType<typeof read>
      >["body"],
      meta: emptyMeta("https://example.com", 0),
    });
    setup.choose("account", { categoryIds: ["leasing"], organization: "combined" });
    const preview = await setup.preview("account");
    expect(preview.verification[0]?.status).toBe("schema");
    expect(preview.dashboards).toEqual([]);
  });
  it("keeps successful categories when another category fails and resumes the failed one", async () => {
    const llm = fakeLlm([
      { args: categoryAnswer },
      design("leases"),
      invalidLayout,
      invalidLayout,
      { args: { widgets: [] } },
    ]);
    const setup = service(llm);
    await setup.prepare("account");
    await setup.prepare("account");
    const saved = JSON.stringify(entry.onboarding?.categories[0]);
    expect(entry.onboarding?.categories[1]?.status).toBe("failed");
    const retry = fakeLlm([design("tasks"), invalidLayout, invalidLayout]);
    await service(retry).prepare("account");
    expect(entry.onboarding?.categories[1]?.status).toBe("ready");
    expect(JSON.stringify(entry.onboarding?.categories[0])).toBe(saved);
    expect(retry.calls).toHaveLength(3);
  });
  it("checks every source of a multi-source widget", async () => {
    const { setup } = await prepared();
    const category = entry.onboarding!.categories[0]!;
    category.widgets[0] = widgetSchema.parse({
      ...category.widgets[0],
      source: undefined,
      sources: [
        { as: "leases", connection: "onboarding-source", op: "leases", label: "Leases" },
        { as: "tasks", connection: "onboarding-source", op: "tasks", label: "Tasks" },
      ],
      combine: { op: "union", as: "category" },
    });
    read
      .mockResolvedValueOnce({
        body: [{ Id: 1, Title: "Lease", Status: "Open" }],
        meta: emptyMeta("https://example.com", 0),
      })
      .mockRejectedValueOnce(
        new AdapterError("Forbidden", { status: 403, userMessage: "Forbidden" }),
      );
    setup.choose("account", { categoryIds: ["leasing"], organization: "combined" });
    const preview = await setup.preview("account");
    expect(read).toHaveBeenCalledTimes(2);
    expect(preview.verification[0]?.status).toBe("denied");
    expect(preview.dashboards).toEqual([]);
  });
  it("checks a fan-out dependency using a real parent and refuses to guess a missing parent", async () => {
    const { setup } = await prepared();
    const category = entry.onboarding!.categories[0]!;
    category.widgets[0] = widgetSchema.parse({
      ...category.widgets[0],
      source: undefined,
      sources: [
        {
          as: "leases",
          connection: "onboarding-source",
          op: "leases",
          label: "Leases",
          pipeline: [{ op: "extract", path: "$" }],
        },
        {
          as: "tasks",
          connection: "onboarding-source",
          op: "tasks",
          label: "Tasks",
          fanOut: { from: "leases", field: "Id", as: "leaseId", maxRows: 10 },
          pipeline: [{ op: "extract", path: "$" }],
        },
      ],
      combine: { op: "union", as: "category" },
    });
    setup.choose("account", { categoryIds: ["leasing"], organization: "combined" });
    await setup.preview("account");
    expect(read.mock.calls[1]).toEqual(expect.arrayContaining(["tasks", { leaseId: 1 }]));
    read.mockClear();
    read.mockResolvedValue({ body: [], meta: emptyMeta("https://example.com", 0) });
    const preview = await setup.preview("account");
    expect(preview.verification[0]?.status).toBe("missingInput");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("refuses an endpoint that needs a parent or required query input", async () => {
    const { setup } = await prepared();
    const connection = store.getConnection("account")!;
    connection.ops[0]!.params = [{ name: "parent", in: "query", type: "string", required: true }];
    store.putConnection(connection);
    setup.choose("account", { categoryIds: ["leasing"], organization: "combined" });
    expect((await setup.preview("account")).verification[0]?.status).toBe("missingInput");
    expect(read).not.toHaveBeenCalled();
  });
});
