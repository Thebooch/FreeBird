import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "@freebirdai/connect/adapters";
import { CatalogStore, KeyStore, LocalAesVault, MemoryJournal } from "@freebirdai/connect/host";
import { connectionSchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";

/**
 * Workflows end to end, over HTTP, against a fake API that keeps its records
 * in memory, through the real engine and the real write service.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;
let journal: MemoryJournal;

class FakeApi {
  readonly sent: Array<{ method: string; path: string }> = [];
  rentals = new Map<string, Record<string, unknown>>([
    ["42", { Id: 42, Name: "Maple Court", IsActive: true }],
    ["43", { Id: 43, Name: "Oak Row", IsActive: true }],
  ]);

  http: HttpFetch = async (url, init) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    this.sent.push({ method, path });
    const json = (status: number, value?: unknown) => ({ status, text: value === undefined ? "" : JSON.stringify(value), url, header: () => null });
    let match: RegExpExecArray | null;
    if ((match = /^\/rentals\/(\w+)\/(inactivation|reactivation)request$/.exec(path)) && method === "POST") {
      const record = this.rentals.get(match[1]!);
      if (!record) return json(404, { message: "no" });
      record.IsActive = match[2] === "reactivation";
      return json(204);
    }
    if ((match = /^\/rentals\/(\w+)$/.exec(path)) && method === "GET") {
      const record = this.rentals.get(match[1]!);
      return record ? json(200, record) : json(404, { message: "no" });
    }
    if (path === "/rentals" && method === "GET") return json(200, [...this.rentals.values()]);
    return json(404, { message: `no route ${method} ${path}` });
  };

  writes(): number {
    return this.sent.filter((one) => one.method !== "GET").length;
  }
}

let api: FakeApi;

const seedCatalog = (): void => {
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(
    join(seed, "rentals.json"),
    JSON.stringify({
      id: "rentals",
      title: "Rentals API",
      baseUrl: "https://api.example.com/v1",
      origin: "openapi",
      specUrl: "https://api.example.com/openapi.json",
      dialect: { auth: { type: "bearer", keyRef: "placeholder" } },
      ops: [],
      entities: [
        {
          id: "rental",
          resource: "rental",
          name: { one: "Property", many: "Properties" },
          kind: "asset",
          identity: { field: "Id", observed: true },
          display: { title: ["Name"], status: "IsActive" },
          fields: [{ path: "Id" }, { path: "Name" }, { path: "IsActive", kinds: ["boolean"] }],
        },
      ],
      writes: [
        { id: "inactivate", title: "Inactivate a property", method: "POST", path: "/rentals/{{param.propertyId}}/inactivationrequest" },
        { id: "reactivate", title: "Reactivate a property", method: "POST", path: "/rentals/{{param.propertyId}}/reactivationrequest" },
      ],
    }),
    "utf8",
  );
  catalog = new CatalogStore(seed, join(dir, ".dash", "catalog"));
};

const CONNECTION = connectionSchema.parse({
  id: "rentals",
  title: "Rentals",
  kind: "rest",
  catalog: "rentals",
  baseUrl: "https://api.example.com/v1",
  auth: { type: "bearer", keyRef: "rentals-key" },
  ops: [
    { id: "rentals", title: "Properties", path: "/rentals", rowsPath: "$" },
    { id: "rental", title: "Property", path: "/rentals/{{param.propertyId}}", archetype: "summary", rowsPath: "$" },
  ],
  resources: [{ id: "rental", title: "Properties", listOp: "rentals", detailOp: "rental", detailParam: "propertyId" }],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-workflows-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  keys.set("rentals-key", "sk_test");
  seedCatalog();
  store.putConnection(CONNECTION);
  api = new FakeApi();
  journal = new MemoryJournal();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const makeApp = () => buildServer({ store, keys, catalog, http: api.http, journal });
const step = (id: string, action: string, settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, action, settings, ...extra });

describe("workflows over HTTP", () => {
  it("seeds an API trigger, fires on a new record, applies an approved change, and reverses it", async () => {
    const app = makeApp();
    const nodes = [
      step("check", "create.calendar", { title: "Check {{ Name }}", at: "2026-10-09", deadline: true }),
      step("pause", "update.action", { entity: "rental", recordId: "{{ Id }}", action: "inactivationrequest" }, { mode: "approve" }),
    ];
    const saved = await app.inject({
      method: "PUT",
      url: "/api/workflows/new",
      payload: {
        name: "New property check",
        enabled: true,
        trigger: { kind: "record_created", connection: "rentals", record: "rental", every: "5m" },
        nodes,
        edges: [
          { id: "a", from: "trigger", to: "check" },
          { id: "b", from: "check", to: "pause" },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    const id = saved.json().id as string;

    expect((await app.inject({ method: "POST", url: `/api/workflows/${id}/run` })).json()).toMatchObject({ status: "seeded", read: 2 });
    api.rentals.set("44", { Id: 44, Name: "Birch Hall", IsActive: true });
    const preview = (await app.inject({ method: "POST", url: `/api/workflows/${id}/preview` })).json();
    expect(preview).toMatchObject({ seeding: false, matched: 1, rows: [{ key: "44", path: [{ node: "check" }, { node: "pause", mode: "approve" }] }] });

    const run = (await app.inject({ method: "POST", url: `/api/workflows/${id}/run` })).json();
    expect(run).toMatchObject({ status: "succeeded", matched: 1 });
    expect((await app.inject({ method: "GET", url: "/api/calendar/events" })).json()).toEqual([expect.objectContaining({ title: "Check Birch Hall", deadline: true })]);
    expect(api.writes()).toBe(0);

    const [waiting] = (await app.inject({ method: "GET", url: "/api/tasks?status=waiting_approval" })).json();
    expect(waiting).toMatchObject({ action: "update.action", pending: { recordId: 44, action: "inactivationrequest" } });
    const opened = (await app.inject({ method: "POST", url: `/api/tasks/${waiting.id}/review` })).json();
    expect(opened.review).toMatchObject({ entity: "rental", kind: "action" });
    const applied = await app.inject({ method: "POST", url: `/api/tasks/${waiting.id}/approve`, payload: { pendingId: opened.review.pendingId, digest: opened.review.digest } });
    expect(applied.json().task).toMatchObject({ status: "done", approvedBy: "local", reversal: { available: true, intent: { action: "reactivationrequest" } } });
    expect(api.rentals.get("44")?.IsActive).toBe(false);
    expect(journal.events.at(-1)).toMatchObject({ status: "succeeded", via: "workflow", key: { id: "44" } });

    /* Reverse: the paired action, through its own review. */
    const back = (await app.inject({ method: "POST", url: `/api/tasks/${waiting.id}/reverse-review` })).json();
    const reversed = await app.inject({ method: "POST", url: `/api/tasks/${waiting.id}/reverse`, payload: { pendingId: back.review.pendingId, digest: back.review.digest } });
    expect(reversed.json().task.status).toBe("reversed");
    expect(api.rentals.get("44")?.IsActive).toBe(true);

    const overview = (await app.inject({ method: "GET", url: "/api/overview" })).json();
    expect(overview.completed.map((one: { action: string }) => one.action)).toEqual(expect.arrayContaining(["create.calendar", "update.action"]));
  });

  it("lets an agent's tool start a workflow in the agent's name, and wakes a case from its webhook", async () => {
    const app = makeApp();
    const workflow = (
      await app.inject({
        method: "PUT",
        url: "/api/workflows/new",
        payload: {
          name: "Pause a property",
          enabled: true,
          trigger: { kind: "agent", inputs: [{ name: "property", description: "Which property", required: true }] },
          nodes: [
            step("hook", "wait.for", { event: "webhook", timeout: "1d" }),
            step("pause", "update.action", { connection: "rentals", entity: "rental", recordId: "{{ input.property }}", action: "inactivationrequest" }, { mode: "auto" }),
          ],
          edges: [
            { id: "a", from: "trigger", to: "hook" },
            { id: "b", from: "hook", outcome: "happened", to: "pause" },
          ],
        },
      })
    ).json();
    expect(workflow.id).toBe("pause-a-property");

    await app.inject({
      method: "PUT",
      url: "/api/agents/new",
      payload: {
        name: "Leasing",
        color: 3,
        reach: [
          { permission: "records.read", scope: { connection: "rentals" } },
          { permission: "records.act", scope: { connection: "rentals" } },
        ],
        tools: [{ id: "pause", kind: "run_workflow", workflow: "pause-a-property", mode: "auto" }],
      },
    });
    const started = (await app.inject({ method: "POST", url: "/api/agents/leasing/tools/pause/use", payload: { inputs: { property: "42" } } })).json();
    expect(started).toMatchObject({ outcome: "started", run: { status: "succeeded" } });
    const caseId = started.run.cases[0] as string;
    const waiting = (await app.inject({ method: "GET", url: `/api/cases/${caseId}` })).json();
    expect(waiting).toMatchObject({ status: "waiting", agent: "leasing", waiting: { kind: "webhook" } });
    const hook = String(waiting.data.steps.hook.hook);
    const token = hook.split("/").pop()!;

    expect((await app.inject({ method: "POST", url: "/api/workflow-hooks/notarealtokenatall0000" })).statusCode).toBe(404);
    const woke = await app.inject({ method: "POST", url: `/api/workflow-hooks/${token}`, payload: { paid: true } });
    expect(woke.json()).toEqual({ woken: 1 });
    expect(api.rentals.get("42")?.IsActive).toBe(false);
    expect(journal.events.at(-1)).toMatchObject({ via: "workflow", onBehalfOf: { kind: "agent", id: "leasing" } });
    expect((await app.inject({ method: "GET", url: `/api/cases/${caseId}` })).json()).toMatchObject({ status: "done" });
  });

  it("checks a draft: what is missing, what to ask, and the one-sentence summary", async () => {
    const app = makeApp();
    const checked = await app.inject({
      method: "POST",
      url: "/api/workflows/new/check",
      payload: { workflow: { name: "Draft", trigger: { kind: "manual" }, nodes: [step("wait", "wait.for", { event: "reply" })], edges: [{ id: "a", from: "trigger", to: "wait" }] } },
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json().sentence).toBe("When someone runs it, waits up to 2 days for a reply.");
  });
});
