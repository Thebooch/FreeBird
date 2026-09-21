import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeLlm } from "@freebirdai/dash-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionSchema } from "@freebirdai/dash-spec";
import { CatalogStore } from "../catalog.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "../vault.js";

/**
 * Describing an API's records, over HTTP, with no model and no network.
 *
 * Two properties matter more than the counts this returns, and both are
 * asserted: the route **spends no requests against anybody's API** — which is
 * what makes the result shareable at all — and a second call does not re-spend
 * the model tokens the first one paid for.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;

/** An API with two collections, each declaring real fields. */
const seedEntry = (overrides: Record<string, unknown> = {}): void => {
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(
    join(seed, "records.json"),
    JSON.stringify({
      id: "records",
      title: "Works API",
      baseUrl: "https://api.example.com",
      dialect: { auth: { type: "none" } },
      ops: [
        {
          id: "tasks",
          title: "Retrieve all jobs",
          path: "/v1/tasks",
          fields: [
            { name: "Id", kinds: ["number"], description: "Job unique identifier." },
            { name: "Title", kinds: ["string"] },
            { name: "VendorId", kinds: ["number"] },
          ],
        },
        {
          id: "task",
          title: "Retrieve a job",
          path: "/v1/tasks/{{param.taskId}}",
          fields: [{ name: "Id", kinds: ["number"] }, { name: "Notes", kinds: ["string"] }],
        },
        {
          id: "vendors",
          title: "Retrieve all suppliers",
          path: "/v1/vendors",
          fields: [
            { name: "Id", kinds: ["number"] },
            { name: "CompanyName", kinds: ["string"] },
          ],
        },
      ],
      resources: [
        { id: "task", title: "Jobs", listOp: "tasks", detailOp: "task", detailParam: "taskId" },
        { id: "vendor", title: "Suppliers", listOp: "vendors" },
      ],
      ...overrides,
    }),
    "utf8",
  );
  catalog = new CatalogStore(seed, join(dir, "overlay"));
};

/** The entity pass, then the reference pass — one call each. */
const scripted = () =>
  fakeLlm([
    {
      args: {
        entities: [
          {
            resource: "task",
            name: "Job",
            plural: "Jobs",
            description: "Something that needs doing.",
            kind: "work",
            identity: "Id",
            title: ["Title"],
            fields: [{ path: "Title", label: "Summary", description: "What the job is." }],
          },
          {
            resource: "vendor",
            name: "Supplier",
            plural: "Suppliers",
            kind: "party",
            identity: "Id",
            title: ["CompanyName"],
            fields: [],
          },
        ],
      },
    },
    {
      args: {
        links: [
          {
            entity: "task",
            path: "VendorId",
            points_at: "vendor",
            reason: "the field is named for a supplier and holds its id",
          },
        ],
      },
    },
  ]);

/** A transport that fails the moment anything tries to call the API. */
const noNetwork = async () => {
  throw new Error("describing records must not call the API");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-entities-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  seedEntry();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/catalog/:id/entities", () => {
  it("describes the records and links them, without calling the API", async () => {
    const llm = scripted();
    const app = buildServer({ store, keys, catalog, llm, http: noNetwork });

    const response = await app.inject({
      method: "POST",
      url: "/api/catalog/records/entities",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ranPass: true,
      described: true,
      entities: 2,
      withIdentity: 2,
      withName: 2,
      references: 1,
      linked: 1,
      errors: [],
    });
    // Every id-shaped field was asked about; one of them was a link.
    expect(response.json().considered).toBeGreaterThanOrEqual(1);
    // Two passes, one call each.
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls.map((call) => call.toolChoice)).toEqual([
      { name: "describe_records" },
      { name: "classify_links" },
    ]);
  });

  it("stores what it learned, in the API's own artifact", async () => {
    const app = buildServer({ store, keys, catalog, llm: scripted(), http: noNetwork });
    await app.inject({ method: "POST", url: "/api/catalog/records/entities" });

    const entry = (await app.inject({ method: "GET", url: "/api/catalog/records" })).json();
    const task = entry.entities.find((entity: { id: string }) => entity.id === "task");

    expect(entry.entities).toHaveLength(2);
    expect(task).toMatchObject({
      name: { one: "Job", many: "Jobs" },
      kind: "work",
      identity: { field: "Id", observed: false },
      display: { title: ["Title"] },
    });
    // The link that turns a number into something a person can follow.
    expect(
      task.fields.find((field: { path: string }) => field.path === "VendorId")?.reference,
    ).toMatchObject({ entity: "vendor", holds: "scalar", verified: false });
    // A field nobody described is still there, wearing its mechanical name.
    expect(task.fields.map((field: { path: string }) => field.path)).toContain("Notes");
    expect(entry.entityVersion).toBe(1);
  });

  it("does not re-spend on an API it has already described", async () => {
    const app = buildServer({ store, keys, catalog, llm: scripted(), http: noNetwork });
    await app.inject({ method: "POST", url: "/api/catalog/records/entities" });

    // A fresh adapter, so any call at all would show up here.
    const again = scripted();
    const second = buildServer({ store, keys, catalog, llm: again, http: noNetwork });
    const response = await second.inject({
      method: "POST",
      url: "/api/catalog/records/entities",
    });

    expect(response.json()).toMatchObject({ ranPass: false });
    expect(response.json().note).toMatch(/already described/);
    expect(again.calls).toHaveLength(0);
  });

  it("runs again when told to, because a pass can improve", async () => {
    const app = buildServer({ store, keys, catalog, llm: scripted(), http: noNetwork });
    await app.inject({ method: "POST", url: "/api/catalog/records/entities" });

    const again = scripted();
    const forced = buildServer({ store, keys, catalog, llm: again, http: noNetwork });
    const response = await forced.inject({
      method: "POST",
      url: "/api/catalog/records/entities",
      payload: { force: true },
    });

    expect(response.json().ranPass).toBe(true);
    expect(again.calls).toHaveLength(2);
  });

  it("says plainly when there is no AI key", async () => {
    const app = buildServer({ store, keys, catalog, http: noNetwork });
    const response = await app.inject({
      method: "POST",
      url: "/api/catalog/records/entities",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/needs an AI key/);
  });

  it("asks for the map first when there are no resources to describe", async () => {
    /*
     * The structure comes from the import and the descriptions are built on
     * top of it. Running this against an unmapped API would spend tokens
     * describing nothing.
     */
    seedEntry({ resources: [] });
    const llm = scripted();
    const app = buildServer({ store, keys, catalog, llm, http: noNetwork });

    const response = await app.inject({
      method: "POST",
      url: "/api/catalog/records/entities",
    });

    expect(response.json()).toMatchObject({ ranPass: false, entities: 0 });
    expect(response.json().note).toMatch(/map it first/);
    expect(llm.calls).toHaveLength(0);
  });

  it("404s for an API it has never heard of", async () => {
    const app = buildServer({ store, keys, catalog, llm: scripted(), http: noNetwork });
    const response = await app.inject({
      method: "POST",
      url: "/api/catalog/ghost/entities",
    });
    expect(response.statusCode).toBe(404);
  });

  it("reports the record counts on the map screen too", async () => {
    const app = buildServer({ store, keys, catalog, llm: scripted(), http: noNetwork });
    const before = (await app.inject({ method: "GET", url: "/api/catalog/records/map" })).json();
    expect(before.records).toMatchObject({ described: false, entities: 0 });
    expect(before.canRunRecords).toBe(true);

    await app.inject({ method: "POST", url: "/api/catalog/records/entities" });

    const after = (await app.inject({ method: "GET", url: "/api/catalog/records/map" })).json();
    expect(after.records).toMatchObject({ described: true, entities: 2, references: 1 });
    expect(after.entitiesAt).not.toBeNull();
  });
});

/**
 * Correcting where a field points.
 *
 * The links that decide what a widget is built from live on the record types,
 * and they were the only ones nobody could change: the editor that existed
 * edits `resource.relations`, an endpoint-level model that a described API no
 * longer consults — so correcting a wrong link there changed nothing anybody
 * could see. A link you can watch being wrong and cannot fix is worse than one
 * that is merely missing.
 */
describe("the links between record types, and correcting one", () => {
  const connect = (): void => {
    const entry = catalog.get("records")!;
    store.putConnection(
      connectionSchema.parse({
        id: "works",
        title: "Works",
        kind: "rest",
        baseUrl: "https://api.example.com",
        catalog: "records",
        dialect: { auth: { type: "none" } },
        resources: entry.resources,
        ops: entry.ops,
      }),
    );
  };

  /** An API whose records have been described, with one link between them. */
  const described = async () => {
    const app = buildServer({ store, keys, catalog, llm: scripted(), http: noNetwork });
    await app.inject({ method: "POST", url: "/api/catalog/records/entities" });
    connect();
    return buildServer({ store, keys, catalog, llm: scripted(), http: noNetwork });
  };

  const links = async (app: ReturnType<typeof buildServer>) =>
    (await app.inject({ method: "GET", url: "/api/connections/works/references" })).json();

  it("reports what each link points at and whether anything can open it", async () => {
    const body = await links(await described());
    expect(body.described).toBe(true);
    expect(body.links).toEqual([
      expect.objectContaining({ entity: "task", field: "VendorId", target: "vendor", to: "Suppliers" }),
    ]);
  });

  it("points a field at a different record type", async () => {
    const app = await described();
    const response = await app.inject({
      method: "PUT",
      url: "/api/connections/works/entities/task/reference",
      payload: { field: "VendorId", target: "task" },
    });

    expect(response.statusCode).toBe(200);
    expect((await links(app)).links[0]).toMatchObject({ target: "task" });
  });

  it("forgets that a link was followed, because a new target inherits no proof", async () => {
    /*
     * Somebody saying where a field points is not the same as a request having
     * resolved there. Carrying the old confirmation over would mark a guess as
     * checked and take it out of the queue the check pass works through.
     */
    const app = await described();
    await app.inject({
      method: "PUT",
      url: "/api/connections/works/entities/task/reference",
      payload: { field: "VendorId", target: "task" },
    });
    expect((await links(app)).links[0]?.verified).toBe(false);
  });

  it("accepts that a field is not a link at all, and keeps offering it back", async () => {
    // A field that resembles a link and is not one is worth saying so about —
    // and a field corrected that way has to stay on the one screen that could
    // put it back, or the correction is one-way.
    const app = await described();
    await app.inject({
      method: "PUT",
      url: "/api/connections/works/entities/task/reference",
      payload: { field: "VendorId", target: null },
    });

    const body = await links(app);
    expect(body.links).toEqual([]);
    expect(body.candidates).toEqual([
      expect.objectContaining({ entity: "task", field: "VendorId" }),
    ]);
  });

  it("refuses a record type that is not on this API", async () => {
    // A reference naming a record type nothing describes resolves to nothing,
    // and every reader of it reports a link that simply never opens.
    const app = await described();
    const response = await app.inject({
      method: "PUT",
      url: "/api/connections/works/entities/task/reference",
      payload: { field: "VendorId", target: "invented" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("invented");
  });

  it("refuses a field the record type does not have", async () => {
    const app = await described();
    const response = await app.inject({
      method: "PUT",
      url: "/api/connections/works/entities/task/reference",
      payload: { field: "NotAField", target: "vendor" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("says plainly that nothing has been described rather than showing an empty list", async () => {
    connect();
    const app = buildServer({ store, keys, catalog, llm: scripted(), http: noNetwork });
    expect((await links(app)).described).toBe(false);
  });
});
