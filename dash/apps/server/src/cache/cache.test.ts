import { AdapterError, emptyMeta, type FetchResult } from "@freebirdai/dash-adapters";
import { quantiseEnd, queryKey, resolveRange } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { RequestAccounting, savedShare } from "./accounting.js";
import { ConnectionCooldown, parseRetryAfter, waitPhrase } from "./cooldown.js";
import { ConnectionGate } from "./gate.js";
import { MemoryCacheStore } from "./memory.js";
import { QueryCache, clampMaxAge } from "./queryCache.js";
import { estimateBytes } from "./store.js";

const result = (body: unknown): FetchResult => ({ body, meta: emptyMeta("https://x/y", 0) });

/** A clock the test moves by hand. */
const clock = (start = 1_000_000) => {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
};

describe("query identity", () => {
  /*
   * The parity check — that the browser's `queryKey` really is this one — lives
   * in the react package, which is the only place both are importable. The
   * server deliberately has no React dependency.
   */
  it("covers the resolved range, not just the params", () => {
    const params = { page: 1 };
    const resolved = (start: number) => ({
      range: { start, end: start + 1000, grain: "1d" as const, preset: "30d" as const },
      filters: {},
    });
    expect(queryKey("c", "o", params, resolved(1))).not.toBe(queryKey("c", "o", params, resolved(2)));
  });

  it("is stable regardless of param order", () => {
    expect(queryKey("c", "o", { a: 1, b: 2 })).toBe(queryKey("c", "o", { b: 2, a: 1 }));
  });

  /*
   * The reason a reload used to cost a full set of upstream calls. A relative
   * window resolved against the raw clock differs every millisecond, so "the
   * last 30 days" was a new key on every page load even though it is the same
   * question.
   */
  it("gives the same window for two reads moments apart", () => {
    const at = Date.parse("2026-08-19T10:00:00Z");
    const a = resolveRange({ preset: "30d", now: at });
    const b = resolveRange({ preset: "30d", now: at + 7_500 });
    expect(queryKey("c", "o", {}, { range: a, filters: {} })).toBe(
      queryKey("c", "o", {}, { range: b, filters: {} }),
    );
  });

  it("still moves the window once the bucket has passed", () => {
    const at = Date.parse("2026-08-19T10:00:00Z");
    const a = resolveRange({ preset: "30d", now: at });
    const b = resolveRange({ preset: "30d", now: at + 20 * 60_000 });
    expect(a.end).not.toBe(b.end);
  });

  it("keeps the span exactly, only the end is rounded", () => {
    const range = resolveRange({ preset: "7d", now: Date.parse("2026-08-19T10:03:27Z") });
    expect(range.end - range.start).toBe(7 * 24 * 60 * 60_000);
  });

  /*
   * A short window cannot tolerate a coarse bucket — an hour of data ending
   * fifteen minutes ago would be visibly wrong — so the bucket scales.
   */
  it("scales the bucket with the span, within bounds", () => {
    const now = 1_000_000_000_000;
    const hour = quantiseEnd(now, 60 * 60_000);
    const month = quantiseEnd(now, 30 * 24 * 60 * 60_000);
    expect(now - hour).toBeLessThanOrEqual(60_000);
    expect(now - month).toBeLessThanOrEqual(15 * 60_000);
  });

  it("leaves an explicit custom window exactly alone", () => {
    const range = resolveRange({
      preset: "custom",
      now: Date.now(),
      custom: { start: 111, end: 222 },
    });
    expect([range.start, range.end]).toEqual([111, 222]);
  });
});

describe("MemoryCacheStore", () => {
  const entry = (key: string, bytes: number, storedAt = 0) => ({
    key,
    body: {},
    meta: emptyMeta("https://x", 0),
    storedAt,
    bytes,
  });

  it("evicts least recently used past the entry cap", () => {
    const store = new MemoryCacheStore(2, 1_000_000);
    store.set(entry("a", 10));
    store.set(entry("b", 10));
    // Reading "a" makes "b" the oldest, even though "a" was written first.
    store.get("a");
    store.set(entry("c", 10));

    expect(store.get("a")).toBeDefined();
    expect(store.get("b")).toBeUndefined();
    expect(store.get("c")).toBeDefined();
  });

  /*
   * An entry cap alone is not a bound: one response may be 8MB, so a hundred
   * entries is eight hundred megabytes of a process that is meant to be a thin
   * proxy.
   */
  it("evicts on the byte budget as well as the count", () => {
    const store = new MemoryCacheStore(100, 100);
    store.set(entry("a", 60));
    store.set(entry("b", 60));
    expect(store.get("a")).toBeUndefined();
    expect(store.stats().bytes).toBe(60);
  });

  it("refuses a single entry larger than the whole budget", () => {
    // Otherwise it evicts everything and then sits there alone.
    const store = new MemoryCacheStore(100, 100);
    store.set(entry("small", 40));
    store.set(entry("huge", 5_000));
    expect(store.get("huge")).toBeUndefined();
    expect(store.get("small")).toBeDefined();
  });

  it("keeps the byte count straight when an entry is replaced", () => {
    const store = new MemoryCacheStore(10, 1_000);
    store.set(entry("a", 100));
    store.set(entry("a", 20));
    expect(store.stats()).toEqual({ entries: 1, bytes: 20 });
  });

  it("sweeps only what is older than the age given", () => {
    const store = new MemoryCacheStore();
    store.set(entry("old", 10, 0));
    store.set(entry("new", 10, 5_000));
    expect(store.sweep(1_000, 5_500)).toBe(1);
    expect(store.get("old")).toBeUndefined();
    expect(store.get("new")).toBeDefined();
  });
});

describe("estimateBytes", () => {
  it("grows with the data", () => {
    const small = estimateBytes([{ a: "x" }]);
    const large = estimateBytes(Array.from({ length: 100 }, () => ({ a: "xxxxxxxxxx" })));
    expect(large).toBeGreaterThan(small);
  });

  it("extrapolates a long array rather than walking all of it", () => {
    const rows = Array.from({ length: 10_000 }, () => ({ name: "abcdefghij" }));
    const measured = estimateBytes(rows);
    // Within an order of magnitude of the honest answer is all a budget needs.
    expect(measured).toBeGreaterThan(100_000);
    expect(measured).toBeLessThan(10_000_000);
  });

  it("does not recurse forever on a deep structure", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    expect(Number.isFinite(estimateBytes(deep))).toBe(true);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds", () => {
    expect(parseRetryAfter("30", 0)).toBe(30_000);
  });

  /*
   * Both forms are legal and APIs use both. A date parsed as a number is NaN,
   * which would silently disable the back-off entirely.
   */
  it("reads an HTTP date", () => {
    const now = Date.parse("2026-08-19T10:00:00Z");
    expect(parseRetryAfter("Wed, 19 Aug 2026 10:00:30 GMT", now)).toBe(30_000);
  });

  it("is null for nonsense, so the caller uses its own default", () => {
    expect(parseRetryAfter("soon", 0)).toBeNull();
    expect(parseRetryAfter(undefined, 0)).toBeNull();
  });
});

describe("ConnectionCooldown", () => {
  it("holds a connection off until the wait has passed", () => {
    const cooldown = new ConnectionCooldown();
    cooldown.refused({ connection: "c", status: 429, retryAfter: "30", reason: "slow down", now: 0 });
    expect(cooldown.check("c", 10_000)).toBeDefined();
    expect(cooldown.check("c", 31_000)).toBeUndefined();
  });

  it("caps however long an API asks for", () => {
    const cooldown = new ConnectionCooldown();
    cooldown.refused({ connection: "c", status: 429, retryAfter: "99999", reason: "no", now: 0 });
    // Fifteen minutes, not a day.
    expect(cooldown.check("c", 15 * 60_000 + 1)).toBeUndefined();
  });

  it("cools one connection without touching another", () => {
    const cooldown = new ConnectionCooldown();
    cooldown.refused({ connection: "a", status: 429, reason: "no", now: 0 });
    expect(cooldown.check("a", 0)).toBeDefined();
    expect(cooldown.check("b", 0)).toBeUndefined();
  });

  it("clears on a success", () => {
    const cooldown = new ConnectionCooldown();
    cooldown.refused({ connection: "c", status: 429, reason: "no", now: 0 });
    cooldown.succeeded("c");
    expect(cooldown.check("c", 0)).toBeUndefined();
  });

  it("phrases the wait for a person", () => {
    expect(waitPhrase(5_000, 0)).toBe("5 seconds");
    expect(waitPhrase(1_000, 0)).toBe("1 second");
    expect(waitPhrase(120_000, 0)).toBe("2 minutes");
  });
});

describe("clampMaxAge", () => {
  /*
   * It arrives from the browser. It is a ceiling on age, never a floor, so a
   * hostile value can only force more upstream calls — hence the clamp at the
   * bottom as well as the top.
   */
  it("refuses negatives and nonsense", () => {
    expect(clampMaxAge(-5)).toBe(0);
    expect(clampMaxAge("forever")).toBe(0);
    expect(clampMaxAge(undefined)).toBe(0);
    expect(clampMaxAge(Number.NaN)).toBe(0);
  });

  it("caps how long anything may be held", () => {
    expect(clampMaxAge(999_999_999)).toBe(60 * 60_000);
  });
});

describe("QueryCache", () => {
  const build = (start = 1_000_000) => {
    const time = clock(start);
    return { time, cache: new QueryCache({ now: time.now }) };
  };

  describe("a view never fetches", () => {
    /*
     * Age is not a reason to call somebody's API while they are reading it; it
     * is a reason to say how old this is. Opening a board, switching a tab and
     * reloading a page are all views, and none of them should cost a request.
     */
    it("serves what it holds at any age, without calling upstream", async () => {
      const { cache, time } = build();
      let calls = 0;
      const fetcher = async () => {
        calls++;
        return result({ rows: calls });
      };

      await cache.read({ key: "k", connection: "c", maxAgeMs: 60_000, fetcher });
      expect(calls).toBe(1);

      time.advance(48 * 60 * 60_000);
      const view = await cache.read({
        key: "k",
        connection: "c",
        maxAgeMs: 60_000,
        mode: "view",
        fetcher,
      });

      expect(calls).toBe(1);
      expect(view.body).toEqual({ rows: 1 });
      expect(view.outcome).toBe("stale");
      expect(view.staleReason).toMatch(/nothing was asked of the API/);
      expect(view.ageMs).toBe(48 * 60 * 60_000);
    });

    it("reports a hit rather than a stale when it is still fresh", async () => {
      const { cache, time } = build();
      const fetcher = async () => result({ rows: 1 });
      await cache.read({ key: "k", connection: "c", maxAgeMs: 60_000, fetcher });

      time.advance(30_000);
      const view = await cache.read({
        key: "k",
        connection: "c",
        maxAgeMs: 60_000,
        mode: "view",
        fetcher,
      });
      expect(view.outcome).toBe("hit");
      expect(view.staleReason).toBeUndefined();
    });

    /* A copy the keeper refreshes daily is not stale at noon. Labelling every
     * such tile would teach people to ignore the label. */
    it("measures old against how often the endpoint is refreshed, when told", async () => {
      const { cache, time } = build();
      const fetcher = async () => result({ rows: 1 });
      await cache.read({ key: "k", connection: "c", maxAgeMs: 60_000, fetcher });

      time.advance(6 * 60 * 60_000);
      const read = (freshForMs?: number) =>
        cache.read({
          key: "k",
          connection: "c",
          maxAgeMs: 60_000,
          mode: "view",
          fetcher,
          ...(freshForMs !== undefined ? { freshForMs } : {}),
        });
      expect((await read()).outcome).toBe("stale");
      expect((await read(36 * 60 * 60_000)).outcome).toBe("hit");
    });
  });

  describe("an old copy handed back in place of a refusal", () => {
    /* A reader should get the rows either way. The keeper has to know which
     * refusal it was, or a 403 reads as a successful refresh. */
    it("says what refused it", async () => {
      const { cache, time } = build();
      let refuse = false;
      const fetcher = async () => {
        if (refuse) throw new AdapterError("forbidden", { status: 403 });
        return result({ rows: 1 });
      };
      await cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher });

      refuse = true;
      time.advance(1000);
      const outcome = await cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher });
      expect(outcome.outcome).toBe("stale");
      expect(outcome.body).toEqual({ rows: 1 });
      expect(outcome.error?.status).toBe(403);
    });

    it("tells a listener when a connection's data is dropped", () => {
      const { cache } = build();
      const heard: (string | undefined)[] = [];
      const stop = cache.onInvalidate((connection) => heard.push(connection));
      cache.invalidate("c");
      cache.invalidate();
      stop();
      cache.invalidate("c");
      expect(heard).toEqual(["c", undefined]);
    });

    /* The first sight of a widget the keeper has not reached yet. An empty
     * tile is the one outcome worse than an old one. */
    it("fetches once when there is nothing at all to show", async () => {
      const { cache } = build();
      let calls = 0;
      const fetcher = async () => {
        calls++;
        return result({ rows: calls });
      };

      const first = await cache.read({
        key: "k",
        connection: "c",
        maxAgeMs: 60_000,
        mode: "view",
        fetcher,
      });
      expect(calls).toBe(1);
      expect(first.outcome).toBe("miss");
    });

    /* A cooling connection with a copy takes the view path too, and gets there
     * without the cooldown's message — because nothing was refused, nothing
     * was asked. */
    it("answers during a cooldown without mentioning it", async () => {
      const { cache } = build();
      let calls = 0;
      const fetcher = async () => {
        calls++;
        if (calls === 1) return result({ rows: 1 });
        throw new AdapterError("slow down", { status: 429, retryAfter: "60" });
      };

      await cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher });
      await cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher }).catch(() => null);
      expect(cache.cooldown.check("c", 1_000_000)).not.toBeNull();

      const view = await cache.read({
        key: "k",
        connection: "c",
        maxAgeMs: 60_000,
        mode: "view",
        fetcher,
      });
      expect(view.body).toEqual({ rows: 1 });
      expect(view.staleReason ?? "").not.toMatch(/rate limit/i);
    });

    /* Reporting the rate limit here is true and useless: a view asks for
     * nothing, so nothing was refused. What is happening is that the keeper
     * has not reached this query yet. */
    it("says a cold query is not warmed yet rather than blaming the limit", async () => {
      const { cache } = build();
      let calls = 0;
      const fetcher = async () => {
        calls++;
        if (calls === 1) return result({ rows: 1 });
        throw new AdapterError("slow down", { status: 429, retryAfter: "60" });
      };

      await cache.read({ key: "warm", connection: "c", maxAgeMs: 0, fetcher });
      await cache.read({ key: "warm", connection: "c", maxAgeMs: 0, fetcher }).catch(() => null);

      const cold = await cache
        .read({ key: "cold", connection: "c", maxAgeMs: 60_000, mode: "view", fetcher })
        .catch((error: unknown) => error as AdapterError);

      expect(cold).toBeInstanceOf(AdapterError);
      expect((cold as AdapterError).userMessage).toMatch(/has not been loaded yet/);
      expect((cold as AdapterError).userMessage).not.toMatch(/rate limiting/i);
      /* And it asked for nothing: the keeper will. */
      expect(calls).toBe(2);
    });

    it("leaves a refresh exactly as it was", async () => {
      const { cache, time } = build();
      let calls = 0;
      const fetcher = async () => {
        calls++;
        return result({ rows: calls });
      };

      await cache.read({ key: "k", connection: "c", maxAgeMs: 60_000, fetcher });
      time.advance(120_000);
      const refreshed = await cache.read({
        key: "k",
        connection: "c",
        maxAgeMs: 0,
        mode: "refresh",
        fetcher,
      });
      expect(calls).toBe(2);
      expect(refreshed.body).toEqual({ rows: 2 });
    });
  });

  it("serves a fresh entry without calling upstream", async () => {
    const { cache } = build();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return result({ rows: calls });
    };

    const first = await cache.read({ key: "k", connection: "c", maxAgeMs: 60_000, fetcher });
    const second = await cache.read({ key: "k", connection: "c", maxAgeMs: 60_000, fetcher });

    expect(first.outcome).toBe("miss");
    expect(second.outcome).toBe("hit");
    expect(calls).toBe(1);
    expect(cache.accounting.get("c")).toMatchObject({ upstreamCalls: 1, cacheHits: 1 });
  });

  /*
   * What an explicit Refresh sends. Somebody who asked for fresh data waits
   * for fresh data rather than being handed the same rows with a promise.
   */
  it("maxAgeMs of zero always calls upstream and blocks", async () => {
    const { cache } = build();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return result({ rows: calls });
    };

    await cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher });
    const forced = await cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher });

    expect(calls).toBe(2);
    expect(forced.outcome).toBe("miss");
    expect(forced.body).toEqual({ rows: 2 });
  });

  it("serves stale and refreshes behind it once the age is exceeded", async () => {
    const { cache, time } = build();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return result({ rows: calls });
    };

    await cache.read({ key: "k", connection: "c", maxAgeMs: 1_000, fetcher });
    time.advance(5_000);

    const stale = await cache.read({ key: "k", connection: "c", maxAgeMs: 1_000, fetcher });
    expect(stale.outcome).toBe("revalidating");
    // The old rows came back immediately.
    expect(stale.body).toEqual({ rows: 1 });

    // The refresh behind it has landed by the next read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = await cache.read({ key: "k", connection: "c", maxAgeMs: 60_000, fetcher });
    expect(after.body).toEqual({ rows: 2 });
  });

  it("collapses concurrent reads of the same key into one call", async () => {
    const { cache } = build();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return result({ rows: calls });
    };

    const [a, b, c] = await Promise.all([
      cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher }),
      cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher }),
      cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher }),
    ]);

    expect(calls).toBe(1);
    expect(a.body).toEqual(b.body);
    expect(b.body).toEqual(c.body);
  });

  /*
   * A refresh that fails should leave the previous rows on screen, labelled —
   * not blank the widget.
   */
  it("serves the last copy when a refresh fails, and says why", async () => {
    const { cache, time } = build();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (calls > 1) {
        throw new AdapterError("rate limited", {
          status: 429,
          userMessage: "Buildium is rate limiting us.",
          retryAfter: "30",
        });
      }
      return result({ rows: 1 });
    };

    await cache.read({ key: "k", connection: "c", maxAgeMs: 1_000, fetcher });
    time.advance(5_000);

    const stale = await cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher });
    expect(stale.outcome).toBe("stale");
    expect(stale.body).toEqual({ rows: 1 });
    expect(stale.staleReason).toMatch(/rate limiting/);
    expect(stale.ageMs).toBe(5_000);
  });

  it("does not evict the entry a failed refresh was refreshing", async () => {
    const { cache, time } = build();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (calls > 1) throw new AdapterError("down", { status: 502 });
      return result({ rows: 1 });
    };

    await cache.read({ key: "k", connection: "c", maxAgeMs: 1_000, fetcher });
    time.advance(5_000);
    await cache.read({ key: "k", connection: "c", maxAgeMs: 1_000, fetcher });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cache.store.get("k")?.body).toEqual({ rows: 1 });
  });

  /*
   * One rate-limited endpoint used to become eleven refused ones, because
   * every widget went on to make its own request.
   */
  it("stops calling a connection that has just refused us", async () => {
    const { cache } = build();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      throw new AdapterError("rate limited", {
        status: 429,
        userMessage: "Slow down.",
        retryAfter: "60",
      });
    };

    await expect(
      cache.read({ key: "a", connection: "c", maxAgeMs: 0, fetcher }),
    ).rejects.toThrow();
    // A different widget on the same connection must not spend another call.
    // The wait is in `userMessage` — the half a reader sees — rather than in
    // the technical message.
    const refused = await cache
      .read({ key: "b", connection: "c", maxAgeMs: 0, fetcher })
      .then(() => null)
      .catch((error: AdapterError) => error);
    expect(refused?.userMessage).toMatch(/Waiting/);

    expect(calls).toBe(1);
    expect(cache.accounting.get("c").rateLimited).toBe(1);
  });

  it("serves cache rather than failing while a connection is cooling", async () => {
    const { cache, time } = build();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (calls === 1) return result({ rows: 1 });
      throw new AdapterError("rate limited", { status: 429, userMessage: "Slow down.", retryAfter: "60" });
    };

    await cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher });
    time.advance(1_000);
    await cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher }).catch(() => undefined);
    time.advance(1_000);

    const cooled = await cache.read({ key: "k", connection: "c", maxAgeMs: 0, fetcher });
    expect(cooled.outcome).toBe("stale");
    expect(cooled.staleReason).toMatch(/Waiting/);
    // Two calls: the first success and the one that got refused.
    expect(calls).toBe(2);
  });

  it("keeps different keys apart", async () => {
    const { cache } = build();
    const fetcher = (rows: number) => async () => result({ rows });

    const a = await cache.read({ key: "a", connection: "c", maxAgeMs: 60_000, fetcher: fetcher(1) });
    const b = await cache.read({ key: "b", connection: "c", maxAgeMs: 60_000, fetcher: fetcher(2) });

    expect(a.body).toEqual({ rows: 1 });
    expect(b.body).toEqual({ rows: 2 });
  });
});

describe("savedShare", () => {
  it("is null before anything has been read", () => {
    // "No requests" and "every request went upstream" are different facts, and
    // 0% for both tells somebody the cache is broken.
    expect(savedShare(new RequestAccounting().get("c"))).toBeNull();
  });

  it("counts hits and stale answers as saved", () => {
    const accounting = new RequestAccounting();
    accounting.upstream("c", 100, 0);
    accounting.hit("c");
    accounting.hit("c");
    accounting.stale("c");
    expect(savedShare(accounting.get("c"))).toBe(0.75);
  });
});

/**
 * The behaviour this whole area exists for: one API refusing us must cost one
 * refusal, not a board full of empty tiles.
 */
describe("a rate limit costs one request, not a boardful", () => {
  const meta = emptyMeta("https://x/y", 0);

  const refusal = () =>
    new AdapterError("rate limited by demo", {
      status: 429,
      userMessage: "The API asked for fewer requests.",
      retryAfter: "120",
    });

  it("tells the browser how long to wait when it has nothing to show", async () => {
    const cache = new QueryCache({ now: () => 1_000 });
    await expect(
      cache.read({
        key: "demo.rows|{}",
        connection: "demo",
        maxAgeMs: 0,
        fetcher: () => Promise.reject(refusal()),
      }),
    ).rejects.toMatchObject({ status: 429 });

    // Second read: the cooldown is in force and there is still nothing cached.
    const second = cache
      .read({
        key: "demo.other|{}",
        connection: "demo",
        maxAgeMs: 0,
        fetcher: () => Promise.reject(new Error("must not be called")),
      })
      .catch((error: unknown) => error);

    const error = (await second) as AdapterError;
    expect(error.status).toBe(429);
    // The sentence a person reads, and the number the tile counts down with.
    expect(error.userMessage).toContain("Waiting");
    expect(error.retryAfter).toBeDefined();
    expect(Number(error.retryAfter)).toBeGreaterThan(0);
  });

  it("serves the cached copy, labelled, once a connection is cooling", async () => {
    let clock = 1_000;
    const cache = new QueryCache({ now: () => clock });

    await cache.read({
      key: "demo.rows|{}",
      connection: "demo",
      maxAgeMs: 0,
      fetcher: async () => ({ body: [{ id: 1 }], meta }),
    });

    clock += 10;
    await expect(
      cache.read({
        key: "demo.other|{}",
        connection: "demo",
        maxAgeMs: 0,
        fetcher: () => Promise.reject(refusal()),
      }),
    ).rejects.toMatchObject({ status: 429 });

    clock += 10;
    const outcome = await cache.read({
      key: "demo.rows|{}",
      connection: "demo",
      maxAgeMs: 0,
      fetcher: () => Promise.reject(new Error("must not be called")),
    });

    // Old rows with a banner beat an empty tile — that is the whole contract.
    expect(outcome.outcome).toBe("stale");
    expect(outcome.body).toEqual([{ id: 1 }]);
    expect(outcome.staleReason).toContain("Waiting");
  });

  /*
   * The point of re-checking the cooldown *after* the queue slot rather than
   * only before the queue. Without it, everything already queued when the
   * first 429 lands goes on to collect a refusal of its own.
   */
  it("stops queued reads the moment one of them is refused", async () => {
    let clock = 1_000;
    let upstreamCalls = 0;
    const cache = new QueryCache({
      now: () => clock,
      gate: new ConnectionGate({ maxConcurrent: 1 }),
    });

    // Warm each key, so every one of them has something to fall back on.
    for (const key of ["a", "b", "c", "d"]) {
      await cache.read({
        key: `demo.${key}|{}`,
        connection: "demo",
        maxAgeMs: 0,
        fetcher: async () => ({ body: [{ key }], meta }),
      });
    }

    clock += 10;
    const reads = ["a", "b", "c", "d"].map((key) =>
      cache.read({
        key: `demo.${key}|{}`,
        connection: "demo",
        maxAgeMs: 0,
        fetcher: () => {
          upstreamCalls++;
          return Promise.reject(refusal());
        },
      }),
    );

    const outcomes = await Promise.all(reads);

    // One request was refused; the other three found the cooldown at the front
    // of the queue and never went upstream at all.
    expect(upstreamCalls).toBe(1);
    // And every tile still has rows, each saying why they are old.
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe("stale");
      expect(outcome.staleReason).toBeDefined();
    }
  });
});
