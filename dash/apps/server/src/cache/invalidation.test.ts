import { describe, expect, it } from "vitest";
import type { FetchResult } from "@freebirdai/dash-adapters";
import { QueryCache } from "./queryCache.js";

describe("connection changes during a read", () => {
  it("does not restore old credentials' data after invalidation", async () => {
    const cache = new QueryCache();
    let finish!: (result: FetchResult) => void;
    const pending = cache.read({
      key: "same-query",
      connection: "api",
      maxAgeMs: 0,
      fetcher: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
    cache.invalidate();
    finish({
      body: [{ account: "old" }],
      meta: {
        url: "https://example.com",
        status: 200,
        fetchedAt: 0,
        durationMs: 0,
        pages: 1,
        truncated: false,
        warnings: [],
      },
    });
    await rejected;
    expect(cache.store.get("same-query")).toBeUndefined();
  });
});

describe("invalidation is scoped to one connection", () => {
  const meta = {
    url: "https://example.com",
    status: 200,
    fetchedAt: 0,
    durationMs: 0,
    pages: 1,
    truncated: false,
    warnings: [],
  };

  it("drops the named connection's data and leaves the rest alone", async () => {
    const cache = new QueryCache();
    await cache.read({
      key: "api.list|{}",
      connection: "api",
      maxAgeMs: 0,
      fetcher: async () => ({ body: [{ id: 1 }], meta }),
    });
    await cache.read({
      key: "other.list|{}",
      connection: "other",
      maxAgeMs: 0,
      fetcher: async () => ({ body: [{ id: 2 }], meta }),
    });

    cache.invalidate("api");

    expect(cache.store.get("api.list|{}")).toBeUndefined();
    expect(cache.store.get("other.list|{}")).toBeDefined();
  });

  /*
   * The security property, which is the whole reason invalidation exists: a
   * credential change must not let the old account's rows come back. Scoping
   * must not weaken it for the connection actually named.
   */
  it("still rejects an in-flight read for the connection it names", async () => {
    const cache = new QueryCache();
    let finish!: (result: { body: unknown; meta: typeof meta }) => void;
    const pending = cache.read({
      key: "api.list|{}",
      connection: "api",
      maxAgeMs: 0,
      fetcher: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
    cache.invalidate("api");
    finish({ body: [{ account: "old" }], meta });
    await rejected;
    expect(cache.store.get("api.list|{}")).toBeUndefined();
  });

  it("does not disturb an in-flight read for a different connection", async () => {
    const cache = new QueryCache();
    let finish!: (result: { body: unknown; meta: typeof meta }) => void;
    const pending = cache.read({
      key: "other.list|{}",
      connection: "other",
      maxAgeMs: 0,
      fetcher: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    cache.invalidate("api");
    finish({ body: [{ id: 2 }], meta });
    await expect(pending).resolves.toMatchObject({ outcome: "miss" });
    expect(cache.store.get("other.list|{}")).toBeDefined();
  });

  /* A prefix must not reach a connection whose id merely starts the same. */
  it("does not match a connection whose id shares a prefix", async () => {
    const cache = new QueryCache();
    await cache.read({
      key: "api2.list|{}",
      connection: "api2",
      maxAgeMs: 0,
      fetcher: async () => ({ body: [{ id: 3 }], meta }),
    });
    cache.invalidate("api");
    expect(cache.store.get("api2.list|{}")).toBeDefined();
  });
});

describe("a change drops only what it made stale", () => {
  const meta = {
    url: "https://example.com",
    status: 200,
    fetchedAt: 0,
    durationMs: 0,
    pages: 1,
    truncated: false,
    warnings: [],
  };

  it("clears the endpoints named and leaves the connection's others", async () => {
    const cache = new QueryCache();
    for (const key of ["api.rental|-:{}", "api.rentals|-:{}", "api.leases|-:{}"]) {
      await cache.read({ key, connection: "api", maxAgeMs: 0, fetcher: async () => ({ body: [key], meta }) });
    }
    cache.invalidateOps("api", ["rental", "rentals"]);
    expect(cache.store.get("api.rental|-:{}")).toBeUndefined();
    expect(cache.store.get("api.rentals|-:{}")).toBeUndefined();
    expect(cache.store.get("api.leases|-:{}")).toBeDefined();
  });

  /*
   * The two halves of the per-endpoint generation: an answer already on its
   * way for a changed endpoint must not land and put the old record back,
   * and an answer on its way for any other endpoint must land as normal —
   * a connection-wide bump would reject it and leave its failure stuck.
   */
  it("rejects a read of a changed endpoint that was already on its way, and only that one", async () => {
    const cache = new QueryCache();
    let finishRental!: (result: { body: unknown; meta: typeof meta }) => void;
    let finishLeases!: (result: { body: unknown; meta: typeof meta }) => void;
    const rental = cache.read({
      key: "api.rental|-:{}",
      connection: "api",
      maxAgeMs: 0,
      fetcher: () => new Promise((resolve) => (finishRental = resolve)),
    });
    const leases = cache.read({
      key: "api.leases|-:{}",
      connection: "api",
      maxAgeMs: 0,
      fetcher: () => new Promise((resolve) => (finishLeases = resolve)),
    });
    const rejected = expect(rental).rejects.toMatchObject({ status: 409 });
    cache.invalidateOps("api", ["rental"]);
    finishRental({ body: [{ Name: "old" }], meta });
    finishLeases({ body: [{ Id: 1 }], meta });
    await rejected;
    await expect(leases).resolves.toMatchObject({ body: [{ Id: 1 }] });
    expect(cache.store.get("api.rental|-:{}")).toBeUndefined();
    expect(cache.store.get("api.leases|-:{}")).toBeDefined();

    // And the next read of the changed endpoint goes out again rather than finding a stuck failure.
    await expect(
      cache.read({ key: "api.rental|-:{}", connection: "api", maxAgeMs: 0, fetcher: async () => ({ body: [{ Name: "new" }], meta }) }),
    ).resolves.toMatchObject({ body: [{ Name: "new" }] });
  });

  it("does not tell the keeper the credentials changed", () => {
    const cache = new QueryCache();
    let told = 0;
    cache.onInvalidate(() => told++);
    cache.invalidateOps("api", ["rental"]);
    expect(told).toBe(0);
  });
});
