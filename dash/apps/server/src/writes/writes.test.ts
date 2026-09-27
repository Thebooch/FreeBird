import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import { connectionSchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../catalog.js";
import type { Policy } from "../identity/policy.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "../vault.js";
import { MemoryJournal } from "./journal.js";
import { WriteService } from "./service.js";
import { AdapterRegistry, RestAdapter } from "@freebirdai/dash-adapters";
import { QueryCache } from "../cache/queryCache.js";
import { LastSeen } from "../keeper/keeper.js";
import { ownerPolicy } from "../identity/policy.js";

/**
 * A change to a connected account, end to end over HTTP, against a fake API
 * that keeps its records in memory.
 *
 * What is pinned is what makes writing safe: nothing is sent without a
 * review, nothing is sent twice, a record changed by somebody else in the
 * meantime is not overwritten, a replace keeps what it did not change, and
 * every attempt leaves an event with enough in it to undo it.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;

/* ── a small property API ─────────────────────────────────────────── */

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

class FakeApi {
  readonly sent: Sent[] = [];
  rentals = new Map<string, Record<string, unknown>>([
    [
      "42",
      {
        Id: 42,
        Name: "Maple Court",
        IsActive: true,
        YearBuilt: 1990,
        Address: { AddressLine1: "1 Maple St", PostalCode: "12345" },
        RentalManager: { Id: 7, FirstName: "Ann" },
      },
    ],
  ]);
  listings = new Map<string, Record<string, unknown>>();
  failNext: Error | null = null;
  nextId = 99;

  http: HttpFetch = async (url, init) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    this.sent.push({ method, path, body });
    if (method !== "GET" && this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const json = (status: number, value?: unknown) => ({
      status,
      text: value === undefined ? "" : JSON.stringify(value),
      url,
      header: (name: string) => (name === "location" && status === 201 && value && typeof value === "object" ? `${url}/${(value as { Id?: number }).Id}` : null),
    });

    let match: RegExpExecArray | null;
    if ((match = /^\/rentals\/(\w+)\/(inactivation|reactivation)request$/.exec(path)) && method === "POST") {
      const record = this.rentals.get(match[1]!);
      if (!record) return json(404, { message: "no" });
      record.IsActive = match[2] === "reactivation";
      return json(204);
    }
    if ((match = /^\/rentals\/units\/(\w+)\/listing$/.exec(path))) {
      const unit = match[1]!;
      if (method === "GET") return this.listings.has(unit) ? json(200, this.listings.get(unit)) : json(404, { message: "none" });
      if (method === "PUT") {
        const existed = this.listings.has(unit);
        this.listings.set(unit, { ...(body as object), Unit: { Id: Number(unit) } });
        return json(existed ? 200 : 201, this.listings.get(unit));
      }
      if (method === "DELETE") {
        this.listings.delete(unit);
        return json(204);
      }
    }
    if ((match = /^\/rentals\/(\w+)$/.exec(path)) && match[1] !== "units") {
      const record = this.rentals.get(match[1]!);
      if (!record) return json(404, { message: "no" });
      if (method === "GET") return json(200, record);
      if (method === "PUT") {
        const next = { ...(body as object), Id: record.Id, IsActive: record.IsActive };
        if (!(next as { Name?: string }).Name) return json(422, { errors: [{ key: "Name", message: "is required" }] });
        this.rentals.set(match[1]!, next);
        return json(200, next);
      }
    }
    if (path === "/rentals" && method === "POST") {
      const id = this.nextId++;
      const record = { ...(body as object), Id: id, IsActive: true };
      this.rentals.set(String(id), record);
      return json(201, record);
    }
    if (path === "/rentals" && method === "GET") return json(200, [...this.rentals.values()]);
    return json(404, { message: `no route ${method} ${path}` });
  };

  count(method?: string): number {
    return this.sent.filter((one) => method === undefined || one.method === method).length;
  }
}

const PROPERTY_BODY = {
  fields: [
    { path: "Name", type: "string", required: true },
    { path: "Address", type: "object", required: true },
    { path: "Address.AddressLine1", type: "string", required: true },
    { path: "Address.PostalCode", type: "string", required: true },
    { path: "YearBuilt", type: "integer", nullable: true },
    { path: "PropertyManagerId", type: "integer", nullable: true },
  ],
};

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
          fields: [
            { path: "Id" },
            { path: "Name" },
            { path: "IsActive", kinds: ["boolean"] },
            { path: "YearBuilt", kinds: ["number"] },
            { path: "Address", kinds: ["object"] },
            { path: "Address.AddressLine1" },
            { path: "Address.PostalCode" },
            { path: "RentalManager", kinds: ["object"] },
            { path: "RentalManager.Id", kinds: ["number"] },
          ],
        },
        {
          id: "unit",
          resource: "unit",
          name: { one: "Unit", many: "Units" },
          kind: "asset",
          identity: { field: "Id", observed: true },
          display: { title: ["UnitNumber"] },
          fields: [{ path: "Id" }, { path: "UnitNumber" }],
        },
        {
          id: "listing",
          resource: "listing",
          name: { one: "Listing", many: "Listings" },
          kind: "event",
          scope: { parent: "rental", param: "unitId" },
          fields: [{ path: "Rent", kinds: ["number"] }, { path: "AvailableDate" }],
        },
        {
          id: "lease",
          resource: "lease",
          name: { one: "Lease", many: "Leases" },
          kind: "work",
          identity: { field: "Id" },
          fields: [{ path: "Id" }],
        },
      ],
      writes: [
        { id: "create_rental", title: "Create a property", method: "POST", path: "/rentals", body: PROPERTY_BODY, returns: "record" },
        { id: "update_rental", title: "Update a property", method: "PUT", path: "/rentals/{{param.propertyId}}", body: PROPERTY_BODY },
        { id: "inactivate", title: "Inactivate a property", method: "POST", path: "/rentals/{{param.propertyId}}/inactivationrequest" },
        { id: "reactivate", title: "Reactivate a property", method: "POST", path: "/rentals/{{param.propertyId}}/reactivationrequest" },
        {
          id: "upsert_listing",
          title: "Create/Update a listing",
          method: "PUT",
          path: "/rentals/units/{{param.unitId}}/listing",
          body: {
            fields: [
              { path: "Rent", type: "number", required: true },
              { path: "AvailableDate", type: "string", format: "date", required: true },
            ],
          },
        },
        { id: "delete_listing", title: "Delete a listing", method: "DELETE", path: "/rentals/units/{{param.unitId}}/listing" },
        { id: "create_lease", title: "Create a lease", method: "POST", path: "/leases" },
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
    { id: "units", title: "Units", path: "/rentals/units" },
    { id: "unit", title: "Unit", path: "/rentals/units/{{param.unitId}}", archetype: "summary" },
    { id: "listing", title: "Listing", path: "/rentals/units/{{param.unitId}}/listing", archetype: "summary", rowsPath: "$" },
    { id: "leases", title: "Leases", path: "/leases" },
  ],
  resources: [
    { id: "rental", title: "Properties", listOp: "rentals", detailOp: "rental", detailParam: "propertyId" },
    {
      id: "unit",
      title: "Units",
      listOp: "units",
      detailOp: "unit",
      detailParam: "unitId",
      relations: [{ id: "unit-listing", title: "Listing", resource: "listing", cardinality: "one", via: "path", op: "listing", param: "unitId" }],
    },
    { id: "listing", title: "Listing", listOp: "listing" },
    { id: "lease", title: "Leases", listOp: "leases" },
  ],
});

let api: FakeApi;
let journal: MemoryJournal;

const makeApp = (policy?: Policy) =>
  buildServer({ store, keys, catalog, http: api.http, journal, ...(policy ? { policy } : {}) });

const prepare = async (app: ReturnType<typeof makeApp>, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/connections/rentals/writes/prepare", payload });

const commit = async (app: ReturnType<typeof makeApp>, review: { pendingId: string; digest: string }) =>
  app.inject({ method: "POST", url: `/api/writes/${review.pendingId}/commit`, payload: { digest: review.digest } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-writes-"));
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

describe("who is asking", () => {
  it("is always the local owner in the open-source build", async () => {
    const response = await makeApp().inject({ method: "GET", url: "/api/me" });
    expect(response.json()).toEqual({
      principal: { userId: "local", workspaceId: "local", role: "owner", kind: "local-owner" },
      mode: "local",
    });
  });
});

describe("what can be changed", () => {
  it("is open on every connection, with nothing to switch on", async () => {
    const app = makeApp();
    const response = await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "X" } });
    expect(response.statusCode).toBe(200);
    expect(api.count("PUT")).toBe(0);
  });

  it("is refused by a policy that says no, before anything is read", async () => {
    const denyAll: Policy = { can: () => ({ ok: false, reason: "Viewers cannot change records." }) };
    const app = makeApp(denyAll);
    const response = await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "X" } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "forbidden", error: "Viewers cannot change records." });
    expect(api.sent).toHaveLength(0);
    expect(journal.events.at(-1)).toMatchObject({ status: "refused", entity: "rental" });
    const off = await app.inject({ method: "PUT", url: "/api/connections/rentals/writes/update_rental/offered", payload: { offered: false } });
    expect(off.statusCode).toBe(403);
  });

  it("offers an endpoint read from documentation, and stops offering one switched off", async () => {
    const entry = catalog.get("rentals")!;
    catalog.put({
      ...entry,
      writes: entry.writes.map((op) => (op.id === "update_rental" ? { ...op, confidence: "inferred" as const } : op)),
    });
    const app = makeApp();
    const inferred = await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "X" } });
    expect(inferred.statusCode).toBe(200);

    const off = await app.inject({ method: "PUT", url: "/api/connections/rentals/writes/update_rental/offered", payload: { offered: false } });
    expect(off.statusCode).toBe(200);
    const refused = await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "Y" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("switched-off");
    const listed = (await app.inject({ method: "GET", url: "/api/connections/rentals/writes" })).json();
    expect(listed.entities.find((one: { id: string }) => one.id === "rental").allowed.update).toBeUndefined();

    await app.inject({ method: "PUT", url: "/api/connections/rentals/writes/update_rental/offered", payload: { offered: true } });
    expect(catalog.get("rentals")!.writes.find((op) => op.id === "update_rental")).not.toHaveProperty("confirmed");
    expect((await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "Y" } })).statusCode).toBe(200);
  });

  it("ignores a write-access setting left in an old connection file", async () => {
    store.putConnection({ ...CONNECTION, writeAccess: { enabled: false, entities: [] } } as typeof CONNECTION);
    expect(store.getConnection("rentals")).not.toHaveProperty("writeAccess");
    const response = await prepare(makeApp(), { entity: "rental", kind: "update", id: "42", values: { Name: "X" } });
    expect(response.statusCode).toBe(200);
  });

  it("lists what each record type can have done to it, and what an update cannot read", async () => {
    const app = makeApp();
    const body = (await app.inject({ method: "GET", url: "/api/connections/rentals/writes" })).json();
    const rental = body.entities.find((entity: { id: string }) => entity.id === "rental");
    expect(rental.allowed.update).toBeDefined();
    expect(rental.writes.update.mode).toBe("replace");
    expect(rental.writes.actions.map((action: { id: string }) => action.id)).toEqual(["inactivationrequest", "reactivationrequest"]);
    expect(rental.unmatched.map((field: { field: string }) => field.field)).toEqual(["PropertyManagerId"]);
    expect(body.entities.find((entity: { id: string }) => entity.id === "lease").allowed.create).toBeDefined();
    expect(body).not.toHaveProperty("enabled");
  });
});

describe("changing a record", () => {
  it("reviews a replace against the record as it is, and keeps what it did not change", async () => {
    const app = makeApp();
    const response = await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "Maple Court East" } });
    expect(response.statusCode).toBe(200);
    const review = response.json();
    expect(review.summary).toBe("Change 1 value on property “Maple Court” on Rentals.");
    expect(review.rows.filter((row: { changed: boolean }) => row.changed)).toEqual([
      { field: "Name", label: "Name", before: "Maple Court", after: "Maple Court East", changed: true },
    ]);
    expect(review.warnings.join(" ")).toMatch(/Not sent: Property Manager Id/i);
    expect(api.count("GET")).toBe(1);
    expect(api.count("PUT")).toBe(0);

    const done = await commit(app, review);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "succeeded", key: { id: "42" }, changed: ["Name"] });
    const put = api.sent.find((one) => one.method === "PUT")!;
    expect(put.path).toBe("/rentals/42");
    // Everything it knew, sent back unchanged; the one it could not read, left out.
    expect(put.body).toEqual({
      Name: "Maple Court East",
      Address: { AddressLine1: "1 Maple St", PostalCode: "12345" },
      YearBuilt: 1990,
    });
    expect(api.rentals.get("42")?.YearBuilt).toBe(1990);
  });

  it("leaves an event with what was there before and how to put it back", async () => {
    const app = makeApp();
    await commit(app, (await prepare(app, { entity: "rental", kind: "update", id: "42", values: { YearBuilt: "2001" } })).json());
    const event = journal.events.at(-1)!;
    expect(event).toMatchObject({
      status: "succeeded",
      actor: { userId: "local", workspaceId: "local" },
      via: "form",
      kind: "update",
      method: "PUT",
      path: "/rentals/42",
      changed: ["Year built"],
      reversal: { kind: "update", values: { YearBuilt: 1990 } },
    });
    expect((event.before as { Name: string }).Name).toBe("Maple Court");
    expect((event.sent as { YearBuilt: number }).YearBuilt).toBe(2001);
    const cost = (await app.inject({ method: "GET", url: "/api/cost" })).json();
    expect(JSON.stringify(cost)).toContain('"writes":1');
  });

  it("reads a field named the way a person says it, and lists what it takes when it cannot", async () => {
    const app = makeApp();
    const said = await prepare(app, { entity: "rental", kind: "update", id: "42", values: { "year built": "2005" } });
    expect(said.statusCode).toBe(200);
    expect(said.json().rows.find((row: { changed: boolean }) => row.changed)).toMatchObject({ field: "YearBuilt", after: "2005" });
    const unknown = await prepare(app, { entity: "rental", kind: "update", id: "42", values: { colour: "blue" } });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().fields[0].message).toContain("YearBuilt (Year built)");
  });

  it("refuses a change that changes nothing, and values the request does not take", async () => {
    const app = makeApp();
    const same = await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "Maple Court" } });
    expect(same.statusCode).toBe(422);
    const extra = await prepare(app, { entity: "rental", kind: "update", id: "42", values: { IsActive: false } });
    expect(extra.statusCode).toBe(422);
    expect(extra.json().fields[0]).toMatchObject({ field: "IsActive" });
  });

  it("sends a review once, and only the one that was approved", async () => {
    const app = makeApp();
    const review = (await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "A" } })).json();
    const wrong = await commit(app, { ...review, digest: "not-it" });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().code).toBe("digest-mismatch");
    expect((await commit(app, review)).statusCode).toBe(200);
    const again = await commit(app, review);
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
    expect(api.count("PUT")).toBe(1);
  });

  it("will not overwrite a record somebody else changed after the review", async () => {
    const app = makeApp();
    const review = (await prepare(app, { entity: "rental", kind: "update", id: "42", values: { YearBuilt: 2001 } })).json();
    api.rentals.set("42", { ...api.rentals.get("42")!, Name: "Renamed elsewhere" });
    const response = await commit(app, review);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("stale");
    // A new review against what is there now, ready to look at.
    expect(response.json().review.record).toBe("Renamed elsewhere");
    expect(api.count("PUT")).toBe(0);
    expect(journal.events.at(-1)?.status).toBe("refused");
  });

  it("carries the API's own reason when it refuses", async () => {
    const app = makeApp();
    api.rentals.set("42", { ...api.rentals.get("42")!, Name: "" });
    const review = await prepare(app, { entity: "rental", kind: "update", id: "42", values: { YearBuilt: 2001 } });
    // Name is required and empty on the record: the review asks for it rather than sending a 422.
    expect(review.statusCode).toBe(422);
    expect(review.json().fields[0]).toMatchObject({ field: "Name", message: "is required" });
  });
});

describe("making, removing and acting", () => {
  it("creates a record, says what is missing first, and returns the new record's id", async () => {
    const app = makeApp();
    const missing = await prepare(app, { entity: "rental", kind: "create", values: { Name: "New Place" } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().fields.map((field: { field: string }) => field.field)).toEqual([
      "Address.AddressLine1",
      "Address.PostalCode",
    ]);
    expect(api.sent).toHaveLength(0);

    const review = (
      await prepare(app, {
        entity: "rental",
        kind: "create",
        values: { Name: "New Place", "Address.AddressLine1": "9 Oak", "Address.PostalCode": "54321" },
      })
    ).json();
    expect(review.summary).toBe("Create a new property on Rentals.");
    const done = (await commit(app, review)).json();
    expect(done).toMatchObject({ status: "succeeded", key: { id: "99" } });
    expect(journal.events.at(-1)?.reversal).toBeUndefined();
    expect(api.sent.map((one) => one.method)).toEqual(["POST"]);
  });

  it("adds a listing that is not there yet, then changes it, through one endpoint", async () => {
    const app = makeApp();
    const add = (
      await prepare(app, { entity: "listing", kind: "update", parents: { unitId: "5" }, values: { Rent: "1200", AvailableDate: "2026-10-01" } })
    ).json();
    expect(add.mode).toBe("upsert:create");
    expect((await commit(app, add)).statusCode).toBe(200);
    expect(api.listings.get("5")).toMatchObject({ Rent: 1200, AvailableDate: "2026-10-01" });

    const change = (await prepare(app, { entity: "listing", kind: "update", parents: { unitId: "5" }, values: { Rent: 1250 } })).json();
    expect(change.mode).toBe("upsert:update");
    expect(change.rows.find((row: { field: string }) => row.field === "Rent")).toMatchObject({ before: "1200", after: "1250" });
    expect((await commit(app, change)).statusCode).toBe(200);
    expect(api.listings.get("5")).toMatchObject({ Rent: 1250, AvailableDate: "2026-10-01" });
  });

  it("says a delete cannot be undone, and sends no body", async () => {
    api.listings.set("5", { Rent: 900, AvailableDate: "2026-11-01" });
    const app = makeApp();
    const review = (await prepare(app, { entity: "listing", kind: "delete", parents: { unitId: "5" } })).json();
    expect(review.danger).toBe(true);
    expect(review.summary).toMatch(/cannot be undone/);
    expect((await commit(app, review)).statusCode).toBe(200);
    const sent = api.sent.find((one) => one.method === "DELETE")!;
    expect(sent).toMatchObject({ path: "/rentals/units/5/listing", body: undefined });
    expect(api.listings.has("5")).toBe(false);
  });

  it("runs a record action and names the one that undoes it", async () => {
    const app = makeApp();
    const review = (await prepare(app, { entity: "rental", kind: "action", action: "inactivationrequest", id: "42" })).json();
    // Reactivate undoes it, so it is not presented as irreversible.
    expect(review.danger).toBe(false);
    expect((await commit(app, review)).statusCode).toBe(200);
    expect(api.rentals.get("42")?.IsActive).toBe(false);
    expect(journal.events.at(-1)?.reversal).toEqual({ kind: "action", action: "reactivationrequest" });
  });

  it("understands a record type by its name, and a singleton by its parent's id", async () => {
    const app = makeApp();
    // "Listing" is the record type's name; 5 is the unit it belongs to.
    const review = await prepare(app, { entity: "Listing", kind: "update", id: "5", values: { Rent: "900", AvailableDate: "2026-11-01" } });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ entity: "listing", mode: "upsert:create" });
    const unknown = await prepare(app, { entity: "widget", kind: "update", id: "5", values: {} });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toContain("rental (Property), listing (Listing)");
  });

  it("refuses an address with a hole in it", async () => {
    const app = makeApp();
    const response = await prepare(app, { entity: "listing", kind: "delete" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Unit it belongs to/);
    expect(api.sent).toHaveLength(0);
  });
});

describe("when the answer does not come back", () => {
  it("does not claim to know, and does not let the same review be sent again", async () => {
    const app = makeApp();
    const review = (await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "B" } })).json();
    api.failNext = new Error("socket hang up");
    const response = await commit(app, review);
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ outcome: "unknown" });
    expect(journal.events.at(-1)?.status).toBe("unknown");
    const again = await commit(app, review);
    expect(again.statusCode).toBe(409);
  });

  it("lets the same review be sent again when nothing left this machine", async () => {
    const app = makeApp();
    const review = (await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "C" } })).json();
    api.failNext = Object.assign(new Error("connect ECONNREFUSED"), { notSent: true });
    const first = await commit(app, review);
    expect(first.json()).toMatchObject({ outcome: "not-sent" });
    const second = await commit(app, review);
    expect(second.statusCode).toBe(200);
    expect(api.rentals.get("42")?.Name).toBe("C");
  });
});

describe("forms", () => {
  it("open with the record as it is now, and say whether a singleton exists yet", async () => {
    const app = makeApp();
    const edit = (
      await app.inject({ method: "POST", url: "/api/connections/rentals/entities/rental/writes/form", payload: { kind: "update", id: "42" } })
    ).json();
    expect(edit).toMatchObject({ mode: "replace", exists: true, values: { Name: "Maple Court", "Address.PostalCode": "12345", YearBuilt: 1990 } });
    expect(edit.fields.find((field: { field: string }) => field.field === "PropertyManagerId")).toMatchObject({ readFrom: null });

    const listing = (
      await app.inject({ method: "POST", url: "/api/connections/rentals/entities/listing/writes/form", payload: { kind: "update", parents: { unitId: "5" } } })
    ).json();
    expect(listing).toMatchObject({ mode: "upsert", exists: false, values: {} });

    const create = (
      await app.inject({ method: "POST", url: "/api/connections/rentals/entities/rental/writes/form", payload: { kind: "create" } })
    ).json();
    expect(create).toMatchObject({ mode: "create", exists: false, values: {} });
    expect(api.count("GET")).toBe(2);
  });

  it("are refused by a policy that says no, before anything is read", async () => {
    const denyAll: Policy = { can: () => ({ ok: false, reason: "Viewers cannot change records." }) };
    const response = await makeApp(denyAll).inject({
      method: "POST",
      url: "/api/connections/rentals/entities/rental/writes/form",
      payload: { kind: "update", id: "42" },
    });
    expect(response.statusCode).toBe(403);
    expect(api.sent).toHaveLength(0);
  });
});

describe("a record that is not there yet", () => {
  it("reads a missing singleton as none, and any other 404 as the failure it is", async () => {
    const app = makeApp();
    const listing = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: { connection: "rentals", op: "listing", params: { unitId: "5" } },
    });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({ body: [], meta: { absent: true } });

    const property = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: { connection: "rentals", op: "rental", params: { propertyId: "404" } },
    });
    expect(property.statusCode).toBe(502);
    expect(property.json()).toMatchObject({ upstreamStatus: 404 });
  });
});

describe("pages and the catalog", () => {
  it("offers controls on every record page, and none a policy refuses", async () => {
    const denyAll: Policy = { can: () => ({ ok: false, reason: "no" }) };
    const off = (await makeApp(denyAll).inject({ method: "GET", url: "/api/connections/rentals/entities/rental" })).json();
    expect(off.writes).toBeUndefined();
    const app = makeApp();
    const on = (await app.inject({ method: "GET", url: "/api/connections/rentals/entities/rental" })).json();
    expect(on.writes.update.mode).toBe("replace");
    const unit = (await app.inject({ method: "GET", url: "/api/connections/rentals/entities/unit" })).json();
    const listing = unit.sections.find((section: { entity: string }) => section.entity === "listing");
    expect(listing).toMatchObject({ singleton: true });
    expect(listing.writes.update.mode).toBe("upsert");
    expect(listing.writes.remove.op).toBe("delete_listing");
  });

  it("never hands the browser an entry's writes, and keeps them when the entry is saved back", async () => {
    const app = makeApp();
    const listed = (await app.inject({ method: "GET", url: "/api/catalog/rentals" })).json();
    expect(listed.writes).toEqual([]);
    expect(listed.writeOpCount).toBe(7);
    await app.inject({ method: "PUT", url: "/api/catalog/rentals", payload: { ...listed, title: "Rentals API (edited)" } });
    expect(catalog.get("rentals")?.writes).toHaveLength(7);
    expect(catalog.get("rentals")?.title).toBe("Rentals API (edited)");
  });

  it("marks an endpoint verified by its first success, and no sooner", async () => {
    const app = makeApp();
    const before = catalog.get("rentals")!.writes.find((op) => op.id === "update_rental")!;
    expect(before.verified).toBe(false);
    await commit(app, (await prepare(app, { entity: "rental", kind: "update", id: "42", values: { Name: "D" } })).json());
    expect(catalog.get("rentals")!.writes.find((op) => op.id === "update_rental")!.verified).toBe(true);
  });
});

describe("the assistant asking twice", () => {
  const service = (policy: Policy = ownerPolicy) =>
    new WriteService({
      store,
      catalog,
      keys,
      registry: new AdapterRegistry().register(new RestAdapter(api.http)),
      rest: new RestAdapter(api.http),
      queries: new QueryCache(),
      seen: new LastSeen(),
      policy,
      journal,
      upstream: (_connection, run) => run(),
    });
  const OWNER = { userId: "local", workspaceId: "local", role: "owner", kind: "local-owner" } as const;

  it("gets the review it already has, without reading the record again", async () => {
    const writes = service();
    const intent = { connection: "rentals", entity: "rental", kind: "update" as const, id: "42", values: { Name: "E" } };
    const first = await writes.prepare(OWNER, intent, { via: "chat", sessionId: "s1" });
    const second = await writes.prepare(OWNER, intent, { via: "chat", sessionId: "s1" });
    expect(second.pendingId).toBe(first.pendingId);
    expect(api.count("GET")).toBe(1);
    // A different conversation, or a different change, is a different review.
    const elsewhere = await writes.prepare(OWNER, intent, { via: "chat", sessionId: "s2" });
    expect(elsewhere.pendingId).not.toBe(first.pendingId);
  });

  it("agrees on the record type in every gate, however it was named", async () => {
    // A policy that allows listings only: it must be asked about "listing" whatever the record type was called.
    const listingsOnly: Policy = {
      can: (_principal, _permission, scope) => (scope?.entity === "listing" ? { ok: true } : { ok: false, reason: "no" }),
    };
    const writes = service(listingsOnly);
    const connection = store.getConnection("rentals")!;
    expect(await writes.allowed(OWNER, connection, "Listing", "update")).toBe(true);
    expect(await writes.allowed(OWNER, connection, "listing", "update")).toBe(true);
    expect(await writes.allowed(OWNER, connection, "Property", "update")).toBe(false);
  });

  it("will not let somebody else approve a review", async () => {
    const writes = service();
    const review = await writes.prepare(OWNER, { connection: "rentals", entity: "rental", kind: "update", id: "42", values: { Name: "F" } });
    const other = { ...OWNER, userId: "someone-else" };
    await expect(writes.commit(other, review.pendingId, review.digest)).rejects.toMatchObject({ code: "not-yours" });
    expect(api.count("PUT")).toBe(0);
  });
});
