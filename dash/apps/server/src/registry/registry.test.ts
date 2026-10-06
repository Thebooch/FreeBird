import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogEntrySchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CatalogStore,
  connectorHash,
  fromRegistry,
  httpRegistry,
  registryIndex,
  syncRegistry,
} from "@freebirdai/connect/host";

/* Catalog entries pulled from a read-only registry, and what is never taken from one. */

const BASE = "https://registry.example.test/dash/";

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id.toUpperCase(),
  baseUrl: `https://api.${id}.test`,
  dialect: { auth: { type: "bearer", keyRef: `${id}-key` } },
  ops: [{ id: "things", title: "Things", path: "/things", rowsPath: "$.data" }],
  version: 3,
  verified: true,
  verifiedAt: "2026-09-01T00:00:00.000Z",
  evidence: { at: "2026-09-01T00:00:00.000Z", version: 3, outcome: "ready", ops: { things: "traversed" } },
  ...extra,
});

const CODE = "async function read() { return [] }";
const withCode = entry("coded", {
  dialect: { auth: { type: "connector", credentials: [{ name: "key", keyRef: "coded-key", label: "Key" }] } },
  ops: [{ id: "things", title: "Things", path: "/things", servedBy: "connector" }],
  connector: {
    code: CODE,
    hash: connectorHash(CODE),
    hooks: ["read"],
    serves: ["things"],
    authority: { destinations: [{ host: "evil.example.test", methods: ["GET"], credentials: ["key"] }] },
    author: { by: "person", at: "2026-09-01T00:00:00.000Z" },
  },
});

const served = (files: Record<string, unknown>) => {
  const asked: string[] = [];
  const fetchDocument = async (url: string) => {
    asked.push(url);
    const name = url.slice(BASE.length);
    return url.startsWith(BASE) && name in files
      ? { status: 200, text: JSON.stringify(files[name]), url }
      : { status: 404, text: "not found", url };
  };
  return { registry: httpRegistry(BASE, fetchDocument), asked };
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-registry-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pulling a registry", () => {
  it("keeps each listed entry as the registry's word, and fetches one again only when its version moves", async () => {
    const files: Record<string, unknown> = {
      "index.json": { entries: [{ id: "acme", version: 3 }, { id: "bolt", version: 1, file: "entries/bolt.json" }] },
      "acme.json": entry("acme"),
      "entries/bolt.json": entry("bolt", { version: 1 }),
    };
    const first = served(files);
    expect(await syncRegistry(first.registry, dir)).toMatchObject({ listed: 2, pulled: ["acme", "bolt"], unchanged: 0, skipped: [] });
    const kept = catalogEntrySchema.parse(JSON.parse(readFileSync(join(dir, "acme.json"), "utf8")));
    /* Not verified here: nothing on this instance has read it. What the registry checked is kept as that. */
    expect(kept).toMatchObject({ origin: "registry", verified: false, version: 3, verifiedAt: "2026-09-01T00:00:00.000Z", evidence: { ops: { things: "traversed" } } });

    const second = served(files);
    expect(await syncRegistry(second.registry, dir)).toMatchObject({ pulled: [], unchanged: 2 });
    expect(second.asked).toEqual([`${BASE}index.json`]);

    files["index.json"] = { entries: [{ id: "acme", version: 4 }, { id: "bolt", version: 1, file: "entries/bolt.json" }] };
    files["acme.json"] = entry("acme", { version: 4 });
    expect(await syncRegistry(served(files).registry, dir)).toMatchObject({ pulled: ["acme"], unchanged: 1 });
  });

  it("never takes code, and asks for the sign-in again where code was the sign-in", async () => {
    const pulled = fromRegistry(withCode, "coded")!;
    expect(pulled.connector).toBeUndefined();
    expect(pulled.ops[0]?.servedBy).toBeUndefined();
    expect(pulled.dialect.auth).toEqual({ type: "none" });
    expect(pulled.authRequired).toBe(true);
    expect(JSON.stringify(pulled)).not.toContain("evil.example.test");
  });

  it("skips what is not an entry, an entry under another id, and a file outside the registry, and says so", async () => {
    const { registry } = served({
      "index.json": {
        entries: [{ id: "acme" }, { id: "wrong" }, { id: "broken" }, { id: "away", file: "https://elsewhere.test/away.json" }, { id: "Not An Id" }],
      },
      "acme.json": entry("acme"),
      "wrong.json": entry("other"),
      "broken.json": { id: "broken", title: "Broken" },
    });
    const result = await syncRegistry(registry, dir);
    expect(result.pulled).toEqual(["acme"]);
    expect(result.skipped.map((one) => one.id)).toEqual(["wrong", "broken", "away"]);
    expect(result.skipped.find((one) => one.id === "away")?.why).toMatch(/not under the registry's address/);
  });

  it("sits between what ships with the code and what this instance worked out", async () => {
    const seed = join(dir, "seed");
    const overlay = join(dir, "overlay");
    const pulled = join(dir, "registry");
    await syncRegistry(served({ "index.json": { entries: [{ id: "acme", version: 3 }] }, "acme.json": entry("acme") }).registry, pulled);
    const store = new CatalogStore(seed, overlay, pulled);
    expect(store.get("acme")).toMatchObject({ origin: "registry", version: 3 });
    /* A local correction wins, and is a version of its own. */
    const mine = store.put({ ...store.get("acme")!, title: "Acme, corrected" });
    expect(store.get("acme")).toMatchObject({ title: "Acme, corrected", version: mine.version });
    store.deleteOverlay("acme");
    expect(store.get("acme")).toMatchObject({ title: "ACME", origin: "registry" });
  });
});

describe("an entry's version", () => {
  it("moves when what the entry says about the API changes, and not when only a check is recorded", () => {
    const store = new CatalogStore(join(dir, "seed"), join(dir, "overlay"));
    const base = catalogEntrySchema.parse(entry("acme", { version: undefined, verified: false, verifiedAt: undefined, evidence: undefined }));
    const first = store.put(base);
    expect(first.version).toBe(1);
    const checked = store.put({ ...first, verified: true, verifiedAt: "2026-09-30T00:00:00.000Z" });
    expect(checked.version).toBe(1);
    const changed = store.put({ ...checked, ops: [{ ...checked.ops[0]!, rowsPath: "$.items" }] });
    expect(changed.version).toBe(2);
  });

  it("is what a registry lists, for entries a request here has verified", () => {
    const verified = catalogEntrySchema.parse(entry("acme"));
    const guessed = catalogEntrySchema.parse(entry("bolt", { verified: false }));
    expect(registryIndex([verified, guessed])).toEqual({
      entries: [{ id: "acme", title: "ACME", version: 3, verifiedAt: "2026-09-01T00:00:00.000Z" }],
    });
  });
});

describe("an instance serving its entries", () => {
  it("serves its verified entries, without their code, in the form another instance pulls", async () => {
    const { buildServer } = await import("../server.js");
    const { SpecStore } = await import("../store.js");
    const { KeyStore, LocalAesVault } = await import("@freebirdai/connect/host");
    const catalog = new CatalogStore(join(dir, "seed"), join(dir, "overlay"));
    catalog.put(catalogEntrySchema.parse({ ...withCode, id: "coded", verified: true }));
    catalog.put(catalogEntrySchema.parse(entry("guessed", { verified: false })));
    const app = buildServer({
      store: new SpecStore(join(dir, "d"), join(dir, "c"), join(dir, "r")),
      keys: new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, "vault.json")),
      catalog,
      serveRegistry: true,
    });
    const base = "https://hosted.example.test/api/registry/";
    const registry = httpRegistry(base, async (url) => {
      const response = await app.inject({ method: "GET", url: url.replace("https://hosted.example.test", "") });
      return { status: response.statusCode, text: response.body, url };
    });
    expect((await registry.index()).map((one) => one.id)).toEqual(["coded"]);
    const served = (await registry.entry({ id: "coded" })) as Record<string, unknown>;
    expect(served.connector).toBeUndefined();
    const pulled = await syncRegistry(registry, join(dir, "pulled"));
    expect(pulled.pulled).toEqual(["coded"]);
    await app.close();
  });
});
