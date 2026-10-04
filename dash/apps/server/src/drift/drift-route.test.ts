import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import { connectionSchema, dashboardSchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "../vault.js";

/*
 * An API that renames a field after a board was built on it:
 * the tile reading it says so, the connection lists the change, and nothing
 * rewrites the saved widget.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;

beforeEach(() => {
  vi.stubEnv("DASH_MIN_GAP_MS", "0");
  dir = mkdtempSync(join(tmpdir(), "dash-drift-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const billing = connectionSchema.parse({
  id: "billing",
  title: "Billing",
  kind: "rest",
  baseUrl: "https://api.billing.test",
  auth: { type: "bearer", keyRef: "billing-key" },
  ops: [{ id: "invoices", title: "List invoices", path: "/invoices", rowsPath: "$.data" }],
});

const board = dashboardSchema.parse({
  id: "main",
  title: "Main",
  widgets: [
    {
      id: "total",
      title: "Invoiced",
      component: "stat",
      source: { connection: "billing", op: "invoices" },
      pipeline: [
        { op: "extract", path: "$.data[*]" },
        { op: "derive", fields: { _all: "1" } },
        { op: "group", by: [{ field: "_all" }], agg: { value: "sum(amount)" } },
      ],
      roles: { value: "value" },
    },
  ],
});

const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("never happened");
};

describe("an API whose answers change after a board was built on them", () => {
  it("says so on the tile and on the connection, and stops when the answers are back in shape", async () => {
    let version: "first" | "renamed" = "first";
    const http: HttpFetch = async (url) => ({
      status: 200,
      text: JSON.stringify({
        data: Array.from({ length: 6 }, (_, index) =>
          version === "first" ? { id: index, amount: 10 * index, status: "open" } : { id: index, amount_cents: 1000 * index, status: "open" },
        ),
      }),
      url,
      header: () => null,
    });
    const app = buildServer({ store, keys, http });
    store.putConnection(billing);
    store.putDashboard(board);
    keys.set("billing-key", "k");
    const read = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/query",
          payload: { connection: "billing", op: "invoices", params: {}, range: { preset: "30d" }, filters: {}, mode: "refresh", maxAgeMs: 0 },
        })
      ).json();
    const changes = async () => (await app.inject({ method: "GET", url: "/api/connections/billing/drift" })).json().changes as unknown[];

    /* The first fresh answer is the shape later ones are held against. */
    expect((await read()).meta.warnings).toEqual([]);
    expect(await changes()).toEqual([]);

    version = "renamed";
    await read();
    await waitFor(async () => (await changes()).length === 1);
    const said = (await read()).meta.warnings as string[];
    expect(said).toEqual([
      "List invoices has changed since it was checked: its records no longer hold “amount” (“amount_cents” is new, and may be what “amount” became). What is shown may be wrong until it is rebuilt.",
    ]);
    expect(await changes()).toEqual([expect.objectContaining({ op: "invoices", title: "List invoices", note: said[0] })]);
    /* The saved widget is exactly as it was. */
    expect(store.getDashboard("main")?.widgets).toEqual(board.widgets);

    version = "first";
    await read();
    await waitFor(async () => (await changes()).length === 0);
    expect((await read()).meta.warnings).toEqual([]);
    await app.close();
  });
});
