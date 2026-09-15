import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionSchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../catalog.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "../vault.js";

/**
 * One record type's page, over HTTP, from stored knowledge alone.
 *
 * Fetched when a page opens rather than carried on every connection read, so
 * the properties worth pinning are the ones that make that trade safe: it
 * **spends no requests against anybody's API**, it leaves out the fields the
 * describing pass called noise, and it plans its sections against the
 * endpoints *this connection* actually carries rather than everything the
 * catalog knows about.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;

/** An API whose records are already described, as a shared catalog entry. */
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
      ops: [
        { id: "tasks", title: "Retrieve all jobs", path: "/v1/tasks", params: [{ name: "vendorid", in: "query" }] },
        { id: "vendors", title: "Retrieve all suppliers", path: "/v1/vendors", params: [] },
        { id: "vendor", title: "Retrieve a supplier", path: "/v1/vendors/{{param.vendorId}}", params: [] },
      ],
      resources: [
        { id: "task", title: "Jobs", listOp: "tasks" },
        { id: "vendor", title: "Suppliers", listOp: "vendors", detailOp: "vendor", detailParam: "vendorId" },
      ],
      entities: [
        {
          id: "task",
          resource: "task",
          name: { one: "Job", many: "Jobs" },
          kind: "work",
          identity: { field: "Id", observed: true },
          display: { title: ["Title"] },
          fields: [
            { path: "Id", visibility: "hidden" },
            { path: "Title", label: "Summary", visibility: "primary" },
            { path: "VendorId", reference: { entity: "vendor" } },
          ],
        },
        {
          id: "vendor",
          resource: "vendor",
          name: { one: "Supplier", many: "Suppliers" },
          kind: "party",
          identity: { field: "Id", observed: true },
          display: { title: ["CompanyName"] },
          fields: [
            { path: "Id", visibility: "hidden" },
            { path: "Href", visibility: "hidden" },
            { path: "CompanyName", label: "Company name", visibility: "primary" },
            { path: "Phone", label: "Phone", group: "Contact" },
          ],
        },
      ],
      entityVersion: 1,
    }),
    "utf8",
  );
  catalog = new CatalogStore(seed, join(dir, "overlay"));
};

/** A connection onto that entry, carrying the endpoints named below. */
const connect = (ops: readonly string[]): void => {
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
      ops: entry.ops.filter((op) => ops.includes(op.id)),
    }),
  );
};

/** A transport that fails the moment anything tries to call the API. */
const noNetwork = async () => {
  throw new Error("reading a record type must not call the API");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-entity-page-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  seedEntry();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const get = async (url: string) => {
  const app = buildServer({ store, keys, catalog, http: noNetwork });
  return app.inject({ method: "GET", url });
};

/** Deliberately built with no `llm` at all: none of this needs one. */
const post = async (url: string, payload: Record<string, unknown>) => {
  const app = buildServer({ store, keys, catalog, http: noNetwork });
  return app.inject({ method: "POST", url, payload });
};

const put = async (url: string, payload: Record<string, unknown>) => {
  const app = buildServer({ store, keys, catalog, http: noNetwork });
  return app.inject({ method: "PUT", url, payload });
};

describe("GET /api/connections/:id/entities/:entity", () => {
  it("returns the page without calling the API", async () => {
    connect(["tasks", "vendors", "vendor"]);
    const response = await get("/api/connections/works/entities/vendor");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      entity: "vendor",
      name: { one: "Supplier", many: "Suppliers" },
      kind: "party",
      identity: "Id",
      title: ["CompanyName"],
      // The endpoint that returns one, which is what a page is built on.
      detail: { op: "vendor", param: "vendorId" },
    });
  });

  it("leaves out the fields the describing pass called noise", async () => {
    connect(["tasks", "vendors", "vendor"]);
    const page = (await get("/api/connections/works/entities/vendor")).json();

    expect(page.fields.map((field: { path: string }) => field.path)).toEqual([
      "CompanyName",
      "Phone",
    ]);
    // The label a person reads, not the name the API uses.
    expect(page.fields[0]).toMatchObject({ label: "Company name", visibility: "primary" });
  });

  it("sections the page from the grouping the dictionary already carries", async () => {
    connect(["tasks", "vendors", "vendor"]);
    const page = (await get("/api/connections/works/entities/vendor")).json();
    expect(page.groups).toEqual([{ title: "Contact", fields: ["Phone"] }]);
  });

  it("turns the link on another record into a section here", async () => {
    connect(["tasks", "vendors", "vendor"]);
    const page = (await get("/api/connections/works/entities/vendor")).json();

    expect(page.sections).toHaveLength(1);
    expect(page.sections[0]).toMatchObject({
      entity: "task",
      title: "Jobs",
      field: "VendorId",
      // The endpoint declares `vendorid`, so this is one request and complete.
      reach: { mode: "filter", op: "tasks", param: "vendorid" },
      cost: "cheap",
    });
    expect(page.sectionsTotal).toBe(1);
  });

  it("plans against the endpoints this connection carries, not the catalog's", async () => {
    /*
     * A connection may carry a subset of what the API offers. A section whose
     * endpoint is missing here is one nothing could fetch, so it must not be
     * offered — and the catalog knowing about it is beside the point.
     */
    connect(["vendors", "vendor"]);
    const page = (await get("/api/connections/works/entities/vendor")).json();
    expect(page.sections).toEqual([]);
  });

  it("lists the record types to choose between", async () => {
    /*
     * A hundred plain nouns with a sentence each, which is what the manual
     * builder offers instead of two hundred endpoints titled "Retrieve all X".
     */
    connect(["tasks", "vendors", "vendor"]);
    const body = (await get("/api/connections/works/entities")).json();

    expect(body.map((one: { entity: string }) => one.entity)).toEqual(["task", "vendor"]);
    expect(body.find((one: { entity: string }) => one.entity === "vendor")).toMatchObject({
      name: { one: "Supplier", many: "Suppliers" },
      kind: "party",
      starting: true,
      listable: true,
    });
  });

  it("says which record types nothing lists, rather than offering a dead end", async () => {
    // A record type with no collection endpoint cannot be a widget, however
    // well described it is.
    connect(["vendor"]);
    const body = (await get("/api/connections/works/entities")).json();
    expect(body.every((one: { listable: boolean }) => one.listable === false)).toBe(true);
  });

  it("tells a missing connection apart from a missing record type", async () => {
    // "This API has no such thing" and "this thing has nothing on it" are
    // different answers to different questions.
    connect(["tasks", "vendors", "vendor"]);
    expect((await get("/api/connections/nope/entities/vendor")).statusCode).toBe(404);
    expect((await get("/api/connections/works/entities/nope")).statusCode).toBe(404);
    expect((await get("/api/connections/works/entities/nope")).json()).toMatchObject({
      error: "no such record type",
    });
  });
});

describe("POST /api/connections/:id/compile", () => {
  it("compiles a brief assembled by hand, with no model and no requests", async () => {
    /*
     * The same compiler the described path uses. A widget built by picking
     * fields and one built by describing it cannot disagree about what the
     * same request means, because only one thing turns a brief into a widget.
     *
     * The server here is built with no `llm` at all, and the transport throws
     * on any call — so needing either would fail this outright.
     */
    connect(["tasks", "vendors", "vendor"]);
    const response = await post("/api/connections/works/compile", {
      brief: { entity: "task", intent: "records" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().errors).toEqual([]);
    expect(response.json().widget).toMatchObject({ component: "table", entity: "task" });
  });

  it("carries a hand-picked filter through to a strip", async () => {
    connect(["tasks", "vendors", "vendor"]);
    const response = await post("/api/connections/works/compile", {
      brief: {
        entity: "task",
        intent: "records",
        filters: [{ field: "VendorId", values: ["41"] }],
      },
    });
    const facets = response.json().widget.facets as { field: string; default: string[] }[];
    expect(facets[0]).toMatchObject({ field: "VendorId", default: ["41"] });
  });

  it("refuses something that is not a brief", async () => {
    connect(["tasks", "vendors", "vendor"]);
    expect((await post("/api/connections/works/compile", { brief: {} })).statusCode).toBe(400);
  });

  it("refuses a record type this connection does not carry", async () => {
    connect(["tasks", "vendors", "vendor"]);
    const response = await post("/api/connections/works/compile", {
      brief: { entity: "invented", intent: "records" },
    });
    expect(response.statusCode).toBe(409);
  });
});

/**
 * Changing a record type's page for everybody who opens one.
 *
 * The layer between what the code guesses and what one widget wants privately.
 * It is written to the catalog's local tier, so it overrides what shipped
 * rather than editing it — and it is checked against the record type's real
 * fields, because a layout naming a field that does not exist renders as "this
 * view no longer matches its data", which blames the reader's data for a bad
 * write here.
 */
describe("PUT /api/connections/:id/entities/:entity/layout", () => {
  it("changes the page every route into a record arrives at", async () => {
    connect(["tasks", "vendors", "vendor"]);
    const saved = await put("/api/connections/works/entities/vendor/layout", {
      facts: ["Phone"],
      groups: [{ title: "Reaching them", fields: ["Phone"] }],
    });

    expect(saved.statusCode).toBe(200);
    const page = (await get("/api/connections/works/entities/vendor")).json();
    expect(page.facts).toEqual(["Phone"]);
    expect(page.groups).toEqual([{ title: "Reaching them", fields: ["Phone"] }]);
  });

  it("refuses a field the record type does not show", async () => {
    connect(["tasks", "vendors", "vendor"]);
    // `Href` exists on the record and the describing pass called it noise, so
    // a page cannot show it and a layout must not claim to.
    const response = await put("/api/connections/works/entities/vendor/layout", {
      facts: ["Href"],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Href");
  });

  it("leaves the rest of the record type's view alone", async () => {
    connect(["tasks", "vendors", "vendor"]);
    await put("/api/connections/works/entities/vendor/layout", { facts: ["Phone"] });

    // A write about the layout of a record must not clear the strips, columns
    // or sort a different screen owns.
    const entity = catalog.get("records")?.entities?.find((one) => one.id === "vendor");
    expect(entity?.views.columns).toEqual([]);
    expect(entity?.views.record.facts).toEqual(["Phone"]);
  });

  it("keeps grouping derived when none is stored", async () => {
    /*
     * The guarantee the editor leans on to avoid freezing a page.
     *
     * Storing the grouping a page currently *shows* would pin it as it is
     * today, and a field added by a later re-description would sit outside
     * every group forever. Sending none means "keep working it out", which is
     * what leaving the headings alone has to mean.
     */
    connect(["tasks", "vendors", "vendor"]);
    await put("/api/connections/works/entities/vendor/layout", { facts: ["Phone"], groups: [] });

    const page = (await get("/api/connections/works/entities/vendor")).json();
    expect(page.facts).toEqual(["Phone"]);
    // Still the grouping the describing pass implies, not a stored copy.
    expect(page.groups).toEqual([{ title: "Contact", fields: ["Phone"] }]);
    expect(catalog.get("records")?.entities?.find((one) => one.id === "vendor")?.views.record.groups)
      .toEqual([]);
  });

  it("says plainly when there is no such record type", async () => {
    connect(["tasks", "vendors", "vendor"]);
    expect(
      (await put("/api/connections/works/entities/nothing/layout", { facts: [] })).statusCode,
    ).toBe(404);
  });
});
