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
 * in memory, through the real engine and the real write service: an API
 * trigger seeds silently, fires on a new record, puts it on the calendar and
 * proposes a change; the proposal is reviewed and applied with a journal
 * entry. An agent's tool set to approve asks the team instead of running; set
 * to auto, it runs, and the change it makes is journalled in the agent's name.
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

describe("workflows over HTTP", () => {
  it("seeds an API trigger, fires on a new record, and applies its proposal with a journal entry", async () => {
    const app = makeApp();
    const saved = await app.inject({
      method: "PUT",
      url: "/api/workflows/new",
      payload: {
        name: "New property check",
        enabled: true,
        trigger: { kind: "record_created", connection: "rentals", record: "rental", every: "5m" },
        steps: [
          { id: "check", kind: "calendar", title: "Check {{ Name }}", at: "2026-10-09", deadline: true },
          { id: "pause", kind: "propose_change", mode: "approve", entity: "rental", change: "action", action: "inactivationrequest", recordId: "{{ Id }}" },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    const id = saved.json().id as string;
    expect(saved.json()).toMatchObject({ enabled: true, enabledBy: { userId: "local" } });

    const seeded = (await app.inject({ method: "POST", url: `/api/workflows/${id}/run` })).json();
    expect(seeded).toMatchObject({ status: "seeded", read: 2 });
    expect((await app.inject({ method: "GET", url: "/api/calendar/events" })).json()).toEqual([]);

    api.rentals.set("44", { Id: 44, Name: "Birch Hall", IsActive: true });
    const preview = (await app.inject({ method: "POST", url: `/api/workflows/${id}/preview` })).json();
    expect(preview).toMatchObject({ seeding: false, matched: 1, rows: [{ key: "44" }] });
    expect((await app.inject({ method: "GET", url: "/api/calendar/events" })).json()).toEqual([]);

    const run = (await app.inject({ method: "POST", url: `/api/workflows/${id}/run` })).json();
    expect(run).toMatchObject({ status: "succeeded", matched: 1 });
    const events = (await app.inject({ method: "GET", url: "/api/calendar/events" })).json();
    expect(events).toEqual([expect.objectContaining({ title: "Check Birch Hall", deadline: true, allDay: true })]);
    expect(api.writes()).toBe(0);

    const [waiting] = (await app.inject({ method: "GET", url: "/api/proposals?status=waiting" })).json();
    expect(waiting).toMatchObject({ kind: "change", workflow: id, intent: { id: "44", action: "inactivationrequest" } });
    const opened = (await app.inject({ method: "POST", url: `/api/proposals/${waiting.id}/review` })).json();
    expect(opened.review).toMatchObject({ entity: "rental", kind: "action" });
    expect(api.writes()).toBe(0);
    const applied = await app.inject({
      method: "POST",
      url: `/api/proposals/${waiting.id}/apply`,
      payload: { pendingId: opened.review.pendingId, digest: opened.review.digest },
    });
    expect(applied.json().proposal).toMatchObject({ status: "applied", decidedBy: "local" });
    expect(api.rentals.get("44")?.IsActive).toBe(false);
    expect(journal.events.at(-1)).toMatchObject({ status: "succeeded", via: "workflow", entity: "rental", key: { id: "44" } });
  });

  it("lets an agent's tool ask the team, or run the workflow in the agent's name", async () => {
    const app = makeApp();
    const workflow = (
      await app.inject({
        method: "PUT",
        url: "/api/workflows/new",
        payload: {
          name: "Pause a property",
          enabled: true,
          description: "Takes a property off the market.",
          trigger: { kind: "agent", inputs: [{ name: "property", description: "Which property", required: true }] },
          source: { connection: "rentals", record: "rental" },
          criteria: "string(Id) == input.property",
          once: "per-run",
          steps: [{ id: "pause", kind: "propose_change", mode: "auto", entity: "rental", change: "action", action: "inactivationrequest", recordId: "{{ Id }}" }],
        },
      })
    ).json();
    expect(workflow.id).toBe("pause-a-property");
    const listed = (await app.inject({ method: "GET", url: "/api/workflows?startableBy=agent" })).json();
    expect(listed.map((one: { id: string }) => one.id)).toEqual(["pause-a-property"]);

    const agent = (
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
          tools: [{ id: "pause", kind: "run_workflow", workflow: "pause-a-property", mode: "approve" }],
        },
      })
    ).json();
    expect(agent.id).toBe("leasing");
    const missing = await app.inject({ method: "PUT", url: "/api/agents/leasing", payload: { name: "Leasing", color: 3, tools: [{ id: "x", kind: "run_workflow", workflow: "ghost" }] } });
    expect(missing.statusCode).toBe(400);

    const asked = (await app.inject({ method: "POST", url: "/api/agents/leasing/tools/pause/use", payload: { inputs: { property: "42" } } })).json();
    expect(asked).toMatchObject({ outcome: "approval", proposal: { kind: "workflow_start", agent: "leasing" } });
    expect(api.writes()).toBe(0);

    await app.inject({
      method: "PUT",
      url: "/api/agents/leasing",
      payload: { name: "Leasing", color: 3, tools: [{ id: "pause", kind: "run_workflow", workflow: "pause-a-property", mode: "auto" }] },
    });
    const done = (await app.inject({ method: "POST", url: "/api/agents/leasing/tools/pause/use", payload: { inputs: { property: "42" } } })).json();
    expect(done).toMatchObject({ outcome: "started", run: { status: "succeeded", matched: 1, agent: "leasing" } });
    expect(api.rentals.get("42")?.IsActive).toBe(false);
    expect(api.rentals.get("43")?.IsActive).toBe(true);
    expect(journal.events.at(-1)).toMatchObject({ via: "workflow", onBehalfOf: { kind: "agent", id: "leasing" }, actor: { userId: "local" } });

    const runs = (await app.inject({ method: "GET", url: `/api/workflows/${workflow.id}/runs` })).json();
    expect(runs[0]).toMatchObject({ start: { kind: "agent", agentId: "leasing" } });
    const removal = await app.inject({ method: "DELETE", url: `/api/workflows/${workflow.id}` });
    expect(removal.statusCode).toBe(409);
  });
});
