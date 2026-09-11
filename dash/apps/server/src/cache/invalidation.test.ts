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
