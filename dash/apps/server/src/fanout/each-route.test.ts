import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "@freebirdai/connect/adapters";
import { connectionSchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/vault";

/*
 * `/api/query/each`: every vendor's bills, past the twenty-five a tile reads
 * itself, read by the server in the background.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;

beforeEach(() => {
  /* The job, not the connection's pacing: sixty reads 200 ms apart take twelve seconds. */
  vi.stubEnv("DASH_MIN_GAP_MS", "0");
  dir = mkdtempSync(join(tmpdir(), "dash-each-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const books = connectionSchema.parse({
  id: "books",
  title: "Books",
  kind: "rest",
  baseUrl: "https://api.books.test",
  auth: { type: "bearer", keyRef: "books-key" },
  ops: [
    {
      id: "bills",
      title: "Bills",
      path: "/vendors/{{param.vendorId}}/bills",
      rowsPath: "$.data",
      params: [{ name: "vendorId", in: "path", required: true }],
    },
  ],
});

const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("never finished");
};

describe("reading every record's related records", () => {
  it("reads each vendor's bills once, in the background, and answers with all of them", async () => {
    const asked: string[] = [];
    const http: HttpFetch = async (url) => {
      asked.push(url);
      const vendor = /vendors\/(\d+)\/bills/.exec(url)?.[1];
      if (vendor === "7")
        return { status: 404, text: JSON.stringify({ error: "no such vendor" }), url, header: () => null };
      return {
        status: 200,
        text: JSON.stringify({ data: [{ vendorId: Number(vendor), amount: 10 }] }),
        url,
        header: () => null,
      };
    };
    const app = buildServer({ store, keys, http });
    store.putConnection(books);
    keys.set("books-key", "k");
    const values = Array.from({ length: 60 }, (_, index) => index + 1);
    const ask = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/query/each",
          payload: { connection: "books", op: "bills", input: "vendorId", values },
        })
      ).json();

    const first = await ask();
    expect(first).toMatchObject({ status: "reading", of: 60 });
    await waitFor(async () => (await ask()).status === "done");
    const done = await ask();
    expect(done).toMatchObject({ status: "done", read: 59, of: 60, failed: 1, notes: [] });
    expect(done.bodies).toHaveLength(59);
    expect(done.bodies[0]).toEqual({ data: [{ vendorId: 1, amount: 10 }] });
    /* Each vendor once, however often the tile asked. */
    expect(asked).toHaveLength(60);
    await app.close();
  });

  it("refuses more records than it reads in all", async () => {
    const app = buildServer({ store, keys, http: async (url) => ({ status: 200, text: "{}", url, header: () => null }) });
    store.putConnection(books);
    const response = await app.inject({
      method: "POST",
      url: "/api/query/each",
      payload: {
        connection: "books",
        op: "bills",
        input: "vendorId",
        values: Array.from({ length: 501 }, (_, index) => index),
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
