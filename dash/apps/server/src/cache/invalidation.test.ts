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
