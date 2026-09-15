import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeLlm } from "@freebirdai/dash-agent";
import { connectionSchema, dashboardSchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../catalog.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "../vault.js";

/**
 * A request for a widget, over HTTP, answered from the record types.
 *
 * The request this whole path was built for is the first test: asked to *see*
 * records narrowed by something, it must produce a list with a filter strip
 * and not a chart that counts them. The rest guard what makes that safe — no
 * API requests are spent working it out, a record type the connection does not
 * carry is refused rather than approximated, and nothing is stored until
 * somebody accepts it.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;

const seedEntry = (): void => {
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(
    join(seed, "records.json"),
    JSON.stringify({
      id: "records",
      title: "Works API",
      baseUrl: "https://api.example.com",
      dialect: { auth: { type: "none" } },
      ops: [{ id: "tasks", title: "Retrieve all jobs", path: "/v1/tasks", params: [] }],
      resources: [{ id: "task", title: "Jobs", listOp: "tasks" }],
      entities: [
        {
          id: "task",
          resource: "task",
          name: { one: "Job", many: "Jobs" },
          kind: "work",
          description: "Something that needs doing.",
          identity: { field: "Id", observed: true },
          display: { title: ["Title"] },
          fields: [
            { path: "Id", visibility: "hidden" },
            { path: "Title", label: "Summary", visibility: "primary" },
            { path: "Status", label: "Status", visibility: "primary" },
            { path: "Category.Name", label: "Category", visibility: "detail" },
          ],
        },
      ],
      entityVersion: 1,
    }),
    "utf8",
  );
  catalog = new CatalogStore(seed, join(dir, "overlay"));
};

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

/** A transport that fails the moment anything tries to call the API. */
const noNetwork = async () => {
  throw new Error("building a widget must not call the API");
};

/** The brief a model would write for "jobs with a filter by category". */
const scripted = () =>
  fakeLlm([
    {
      args: {
        entity: "task",
        intent: "records",
        filters: [{ field: "Category.Name" }],
        reason: "Your jobs, with a filter for category.",
      },
    },
  ]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-brief-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  seedEntry();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ask = async (body: Record<string, unknown>, llm = scripted()) => {
  const app = buildServer({ store, keys, catalog, llm, http: noNetwork });
  return app.inject({ method: "POST", url: "/api/connections/works/brief", payload: body });
};

describe("POST /api/connections/:id/brief", () => {
  it("answers a request to see records with a list and a filter strip", async () => {
    /*
     * The failure this path replaces: asked for records "with a filter by
     * category", the endpoint-first flow built a bar chart of counts, because
     * a grouping was the only way it could express "by category".
     */
    connect();
    const response = await ask({ intent: "jobs with a filter by category" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.errors).toEqual([]);
    expect(body.widget.component).toBe("table");
    expect(body.widget.facets.map((facet: { field: string }) => facet.field)).toEqual([
      "Category_Name",
    ]);
    // The records stay records.
    expect(body.widget.pipeline.some((step: { op: string }) => step.op === "group")).toBe(false);
    // And it names its record type, so a cell holding an id can resolve it.
    expect(body.widget.entity).toBe("task");
    expect(body.reason).toBe("Your jobs, with a filter for category.");
  });

  it("spends no API requests working it out", async () => {
    // The transport throws on any call at all, so reaching the API would fail
    // this outright rather than merely being slow.
    connect();
    expect((await ask({ intent: "jobs" })).statusCode).toBe(200);
  });

  it("stores nothing: a proposal nobody accepted changes no board", async () => {
    connect();
    store.putDashboard(dashboardSchema.parse({ id: "ops", title: "Ops", widgets: [], layout: { cells: [] } }));
    await ask({ intent: "jobs with a filter by category", dashboardId: "ops" });
    expect(store.getDashboard("ops")?.widgets).toEqual([]);
  });

  it("gives the widget an id that cannot collide on the board it is for", async () => {
    connect();
    store.putDashboard(
      dashboardSchema.parse({
        id: "ops",
        title: "Ops",
        widgets: [
          {
            id: "jobs",
            title: "Jobs",
            component: "table",
            source: { connection: "works", op: "tasks" },
            pipeline: [{ op: "extract", path: "$" }],
            roles: { columns: ["Title"] },
          },
        ],
        layout: { cells: [] },
      }),
    );
    const body = (await ask({ intent: "jobs", dashboardId: "ops" })).json();
    expect(body.widget.id).not.toBe("jobs");
  });

  it("returns the other reading already built, not a question", async () => {
    /*
     * Both readings come from one model call, so swapping costs no second call
     * and no second wait — which is what lets the question go unasked without
     * the other reading becoming unreachable.
     */
    connect();
    const body = (
      await ask(
        { intent: "jobs by category" },
        fakeLlm([
          {
            args: {
              entity: "task",
              intent: "records",
              filters: [{ field: "Category.Name" }],
              reason: "Your jobs, with a filter for category.",
              alternative: {
                label: "how many per category",
                intent: "compare",
                groupBy: "Category.Name",
              },
            },
          },
        ]),
      )
    ).json();

    expect(body.widget.component).toBe("table");
    expect(body.alternative.label).toBe("how many per category");
    expect(body.alternative.widget.component).toBe("bar");
    // Its own id, so either can be added without colliding with the other.
    expect(body.alternative.widget.id).not.toBe(body.widget.id);
  });

  it("says so when this API's records have not been described", async () => {
    const bare = catalog.get("records")!;
    catalog.put({ ...bare, entities: [] });
    connect();
    const response = await ask({ intent: "jobs" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("not been described");
  });

  it("refuses a record type this connection does not carry", async () => {
    // The catalog describes the whole API; a connection may hold a subset, and
    // a widget over an endpoint it does not have is one nothing could fetch.
    connect();
    const response = await ask(
      { intent: "anything" },
      fakeLlm([{ args: { entity: "invented", intent: "records", reason: "here" } }]),
    );
    expect(response.statusCode).toBe(502);
  });

  it("needs a request in the user's own words", async () => {
    connect();
    expect((await ask({})).statusCode).toBe(400);
  });

  it("says there is no such connection rather than guessing at one", async () => {
    const app = buildServer({ store, keys, catalog, llm: scripted(), http: noNetwork });
    const response = await app.inject({
      method: "POST",
      url: "/api/connections/nope/brief",
      payload: { intent: "jobs" },
    });
    expect(response.statusCode).toBe(404);
  });
});
