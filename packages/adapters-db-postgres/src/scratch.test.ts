import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { AuthContext } from "@freebirdai/core";
import { requireScratch } from "@freebirdai/core";
import { Kysely } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./index.js";
import { PGliteDialect } from "./pglite.js";
import type { FreeBirdSchema } from "./schema.js";

/**
 * Scratch storage, against real Postgres.
 *
 * PGlite runs the actual migration and the actual queries, so what is asserted
 * here is the behaviour of the SQL rather than of a stand-in. That matters more
 * for this table than for any other in the adapter: scratch is keyed by a
 * string the *host* chooses, so isolation is the property that has to hold, and
 * a mock would happily agree with whatever the code did.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = ["001_init.sql", "002_tenant_id.sql", "003_scratch.sql"]
  .map((name) => readFileSync(join(here, "..", "migrations", name), "utf8"))
  .join("\n");

const client = new PGlite("memory://");
await client.waitReady;
await client.exec(migrations);

const db = new Kysely<FreeBirdSchema>({ dialect: new PGliteDialect(client) });
const adapter = new PostgresAdapter({ db });

/** Four identities that must never see each other's rows. */
const nobody: AuthContext = {};
const alice: AuthContext = { userId: "alice" };
const bob: AuthContext = { userId: "bob" };
const aliceAtAcme: AuthContext = { userId: "alice", orgId: "acme" };

beforeEach(async () => {
  await db.deleteFrom("freebird_scratch").execute();
});

afterAll(async () => {
  await db.destroy();
  await client.close();
});

describe("scratch storage", () => {
  it("hands back what it was given", async () => {
    await adapter.putScratch(
      { scope: "board-1", namespace: "wizard", data: { step: 3, picked: ["a", "b"] } },
      alice,
    );
    const found = await adapter.getScratch<{ step: number; picked: string[] }>(
      "board-1",
      "wizard",
      alice,
    );
    expect(found?.data).toEqual({ step: 3, picked: ["a", "b"] });
    expect(found?.scope).toBe("board-1");
    expect(found?.namespace).toBe("wizard");
    expect(found?.expiresAt).toBeNull();
  });

  it("returns null for a key nothing was written under", async () => {
    expect(await adapter.getScratch("board-1", "wizard", alice)).toBeNull();
  });

  it("replaces rather than accumulates", async () => {
    await adapter.putScratch({ scope: "s", namespace: "n", data: { v: 1 } }, alice);
    await adapter.putScratch({ scope: "s", namespace: "n", data: { v: 2 } }, alice);

    expect((await adapter.getScratch<{ v: number }>("s", "n", alice))?.data).toEqual({ v: 2 });
    const rows = await db.selectFrom("freebird_scratch").selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it("keeps two namespaces under one scope apart", async () => {
    await adapter.putScratch({ scope: "s", namespace: "wizard", data: { a: 1 } }, alice);
    await adapter.putScratch({ scope: "s", namespace: "draft", data: { b: 2 } }, alice);

    expect((await adapter.getScratch<{ a: number }>("s", "wizard", alice))?.data).toEqual({ a: 1 });
    expect((await adapter.getScratch<{ b: number }>("s", "draft", alice))?.data).toEqual({ b: 2 });
  });

  it("stores an array or a scalar, not only an object", async () => {
    await adapter.putScratch({ scope: "s", namespace: "list", data: [1, 2, 3] }, alice);
    expect((await adapter.getScratch("s", "list", alice))?.data).toEqual([1, 2, 3]);
  });
});

/* ── the property this table exists to hold ────────────────────────────── */

describe("isolation", () => {
  /*
   * The reason scratch does not use the `.$if(!!auth.userId, …)` pattern the
   * rest of the adapter uses.
   *
   * That pattern drops the filter entirely when the identity is blank, which is
   * survivable for rows addressed by a generated id — a caller has to already
   * know the id. Scratch is addressed by a key the *host* picks, and two
   * tenants picking the same key is the ordinary case, not an edge one. So the
   * identity is part of the primary key, and these are the tests that say so.
   */

  it("keeps one user's scratch away from another's under the same key", async () => {
    await adapter.putScratch({ scope: "board-1", namespace: "wizard", data: { who: "alice" } }, alice);
    await adapter.putScratch({ scope: "board-1", namespace: "wizard", data: { who: "bob" } }, bob);

    expect((await adapter.getScratch<{ who: string }>("board-1", "wizard", alice))?.data).toEqual({
      who: "alice",
    });
    expect((await adapter.getScratch<{ who: string }>("board-1", "wizard", bob))?.data).toEqual({
      who: "bob",
    });
    // Both rows survive: neither write overwrote the other.
    expect(await db.selectFrom("freebird_scratch").selectAll().execute()).toHaveLength(2);
  });

  it("keeps one tenant's scratch away from another's for the same user id", async () => {
    await adapter.putScratch({ scope: "s", namespace: "n", data: { at: "none" } }, alice);
    await adapter.putScratch({ scope: "s", namespace: "n", data: { at: "acme" } }, aliceAtAcme);

    expect((await adapter.getScratch<{ at: string }>("s", "n", alice))?.data).toEqual({ at: "none" });
    expect((await adapter.getScratch<{ at: string }>("s", "n", aliceAtAcme))?.data).toEqual({
      at: "acme",
    });
  });

  it("does NOT fail open on a blank identity", async () => {
    // The hazard this table is shaped around: elsewhere a blank identity drops
    // the scoping filter and reads every row. Here it is its own partition.
    await adapter.putScratch({ scope: "s", namespace: "n", data: { who: "alice" } }, alice);
    expect(await adapter.getScratch("s", "n", nobody)).toBeNull();

    await adapter.putScratch({ scope: "s", namespace: "n", data: { who: "nobody" } }, nobody);
    expect((await adapter.getScratch<{ who: string }>("s", "n", alice))?.data).toEqual({
      who: "alice",
    });
    expect((await adapter.getScratch<{ who: string }>("s", "n", nobody))?.data).toEqual({
      who: "nobody",
    });
  });

  it("deletes only the caller's own row", async () => {
    await adapter.putScratch({ scope: "s", namespace: "n", data: { who: "alice" } }, alice);
    await adapter.putScratch({ scope: "s", namespace: "n", data: { who: "bob" } }, bob);

    await adapter.deleteScratch("s", "n", alice);

    expect(await adapter.getScratch("s", "n", alice)).toBeNull();
    expect((await adapter.getScratch<{ who: string }>("s", "n", bob))?.data).toEqual({ who: "bob" });
  });

  it("deleting with a blank identity does not clear anybody else", async () => {
    await adapter.putScratch({ scope: "s", namespace: "n", data: { who: "alice" } }, alice);
    await adapter.deleteScratch("s", "n", nobody);
    expect(await adapter.getScratch("s", "n", alice)).not.toBeNull();
  });
});

/* ── expiry ────────────────────────────────────────────────────────────── */

describe("expiry", () => {
  it("treats an expired row as absent rather than stale", async () => {
    await adapter.putScratch(
      { scope: "s", namespace: "n", data: { v: 1 }, expiresAt: new Date(Date.now() - 1000) },
      alice,
    );
    // Reading it and deciding afterwards would hand back data the caller had
    // already been told to forget.
    expect(await adapter.getScratch("s", "n", alice)).toBeNull();
  });

  it("keeps a row whose expiry has not arrived", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    await adapter.putScratch({ scope: "s", namespace: "n", data: { v: 1 }, expiresAt }, alice);
    const found = await adapter.getScratch("s", "n", alice);
    expect(found).not.toBeNull();
    expect(found?.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it("lets a later write clear an expiry that was set", async () => {
    await adapter.putScratch(
      { scope: "s", namespace: "n", data: { v: 1 }, expiresAt: new Date(Date.now() + 1000) },
      alice,
    );
    await adapter.putScratch({ scope: "s", namespace: "n", data: { v: 2 } }, alice);
    expect((await adapter.getScratch("s", "n", alice))?.expiresAt).toBeNull();
  });

  it("sweeps expired rows and leaves the rest", async () => {
    await adapter.putScratch(
      { scope: "old", namespace: "n", data: {}, expiresAt: new Date(Date.now() - 1000) },
      alice,
    );
    await adapter.putScratch(
      { scope: "soon", namespace: "n", data: {}, expiresAt: new Date(Date.now() + 60_000) },
      alice,
    );
    await adapter.putScratch({ scope: "forever", namespace: "n", data: {} }, alice);

    expect(await adapter.purgeExpiredScratch(new Date())).toBe(1);
    const left = await db.selectFrom("freebird_scratch").select("scope").execute();
    expect(left.map((row) => row.scope).sort()).toEqual(["forever", "soon"]);
  });
});

describe("requireScratch", () => {
  it("returns a usable store for an adapter that has one", async () => {
    const store = requireScratch(adapter);
    await store.put({ scope: "s", namespace: "n", data: { v: 9 } }, alice);
    expect((await store.get<{ v: number }>("s", "n", alice))?.data).toEqual({ v: 9 });
    await store.delete("s", "n", alice);
    expect(await store.get("s", "n", alice)).toBeNull();
  });

  it("names what is missing rather than throwing on an undefined method", () => {
    expect(() => requireScratch({} as never)).toThrow(/does not support scratch storage/);
  });
});
