import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import { connectionSchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../catalog.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "../vault.js";

/**
 * Checking a description against a live account, over HTTP.
 *
 * The deciding is unit-tested next door; what only shows up here is the part
 * that touches the rest of the server — that the evidence is written back onto
 * the shared catalog entry where every later user of this API will find it,
 * that a rate limit leaves the entry exactly as it was, and that a caller
 * cannot ask for an unbounded number of requests against somebody's account.
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
      ops: [
        { id: "tasks", title: "Retrieve all jobs", path: "/v1/tasks", rowsPath: "$.data" },
        { id: "vendors", title: "Retrieve all suppliers", path: "/v1/vendors", rowsPath: "$.data" },
        { id: "vendor", title: "Retrieve a supplier", path: "/v1/vendors/{{param.vendorId}}" },
      ],
      resources: [
        { id: "task", title: "Jobs", listOp: "tasks" },
        {
          id: "vendor",
          title: "Suppliers",
          listOp: "vendors",
          detailOp: "vendor",
          detailParam: "vendorId",
        },
      ],
      entities: [
        {
          id: "task",
          resource: "task",
          name: { one: "Job", many: "Jobs" },
          kind: "work",
          // Neither claim has been checked: that is what this route settles.
          identity: { field: "Id" },
          display: { title: ["Title"] },
          fields: [
            { path: "Id" },
            { path: "Title" },
            { path: "VendorId", reference: { entity: "vendor" } },
          ],
        },
        {
          id: "vendor",
          resource: "vendor",
          name: { one: "Supplier", many: "Suppliers" },
          kind: "party",
          identity: { field: "Id" },
          display: { title: ["CompanyName"] },
          fields: [{ path: "Id" }, { path: "CompanyName" }],
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

/** An account with one job pointing at one supplier. */
const account: HttpFetch = async (url) => {
  const body = url.includes("/v1/tasks")
    ? { data: [{ Id: 7, VendorId: 41 }] }
    : url.includes("/v1/vendors/")
      ? { Id: 41, CompanyName: "Acme" }
      : { data: [{ Id: 41, CompanyName: "Acme" }] };
  return { status: 200, text: JSON.stringify(body), url, header: () => null };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-verify-route-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  seedEntry();
  connect();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const verify = async (http: HttpFetch, payload: Record<string, unknown> = {}) => {
  const app = buildServer({ store, keys, catalog, http });
  return app.inject({ method: "POST", url: "/api/connections/works/verify", payload });
};

describe("POST /api/connections/:id/verify", () => {
  it("settles both claims and says what it cost", async () => {
    const response = await verify(account);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      identitiesConfirmed: 2,
      referencesResolved: 1,
      stopped: null,
    });
    // Two collections and one by-id lookup: nothing is checked twice.
    expect(response.json().requests).toBe(3);
  });

  it("writes the evidence onto the entry every later user reads", async () => {
    /*
     * The point of the whole exercise. Verification is a fact about the API,
     * not about this install, so it belongs on the shared entry — otherwise
     * the next person to connect this API pays to learn the same thing.
     */
    await verify(account);
    const task = catalog.get("records")?.entities?.find((one) => one.id === "task");

    expect(task?.verified).toBe(true);
    expect(task?.identity?.observed).toBe(true);
    expect(task?.fields.find((f) => f.path === "VendorId")?.reference?.verified).toBe(true);
    expect(catalog.get("records")?.entitiesVerifiedAt).toBeTruthy();
  });

  it("leaves the entry alone when the API refuses", async () => {
    const refusing: HttpFetch = async (url) => ({
      status: 429,
      text: "slow down",
      url,
      header: () => null,
    });
    const response = await verify(refusing);

    expect(response.json().stopped).toBe("refused");
    // Not marked wrong, and not marked right: a rate limit is not a finding.
    const task = catalog.get("records")?.entities?.find((one) => one.id === "task");
    expect(task?.verified).toBe(false);
    expect(task?.identity?.observed).toBe(false);
  });

  it("keeps the description a model wrote while taking the evidence", async () => {
    // The merge is the same one a re-description uses, from the other side:
    // this run supplies proof, the entry supplies the words.
    await verify(account);
    const task = catalog.get("records")?.entities?.find((one) => one.id === "task");

    expect(task?.name).toEqual({ one: "Job", many: "Jobs" });
    expect(task?.display?.title).toEqual(["Title"]);
  });

  it("will not be asked for an unbounded number of requests", async () => {
    let calls = 0;
    const counting: HttpFetch = async (...args) => {
      calls += 1;
      return account(...args);
    };
    const response = await verify(counting, { budget: 1 });

    expect(calls).toBe(1);
    expect(response.json()).toMatchObject({ requests: 1, stopped: "budget" });
  });

  it("refuses a budget beyond what any account should be asked for", async () => {
    expect((await verify(account, { budget: 100_000 })).statusCode).toBe(400);
  });

  it("says plainly when there is nothing described to check", async () => {
    catalog.put({ ...catalog.get("records")!, entities: [] });
    const response = await verify(account);

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("described");
  });
});
