import { AdapterError } from "@freebirdai/dash-adapters";
import { describe, expect, it } from "vitest";
import { resolveRange } from "@freebirdai/dash-spec";
import { MemoryJobStore } from "../jobs/store.js";
import { EachReads, eachKey, type EachRequest } from "./each.js";

/*
 * Every record's related records, past the twenty-five a tile reads itself:
 * read in the background, handed over whole, and what was not read is said.
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reading every record's related records", () => {
  it("answers 'reading' at once, then every answer in the order asked", async () => {
    const reads = new EachReads();
    const ask = () =>
      reads.ask({
        key: "k",
        connection: "shop",
        count: 60,
        read: async (index) => ({
          body: { charges: [index] },
          ...(index === 7 || index === 9 ? { notes: ["Only the first page was read."] } : {}),
        }),
      });
    expect(ask()).toMatchObject({ status: "reading", of: 60 });
    await settle();
    const done = ask();
    expect(done).toMatchObject({ status: "done", read: 60, of: 60, failed: 0 });
    /* What the records' own reads left out, said once. */
    expect(done.notes).toEqual(["Only the first page was read."]);
    expect(done.bodies).toHaveLength(60);
    expect(done.bodies?.[59]).toEqual({ charges: [59] });
  });

  it("asks each record once, however many times the tile asks", async () => {
    const reads = new EachReads();
    let calls = 0;
    const read = async (index: number) => {
      calls += 1;
      return { body: index };
    };
    reads.ask({ key: "k", connection: "shop", count: 30, read });
    reads.ask({ key: "k", connection: "shop", count: 30, read });
    await settle();
    reads.ask({ key: "k", connection: "shop", count: 30, read });
    expect(calls).toBe(30);
  });

  it("counts one record's failure and reads on", async () => {
    const reads = new EachReads();
    const read = async (index: number) => {
      if (index === 3) throw new AdapterError("not found", { status: 404, userMessage: "gone" });
      return { body: index };
    };
    reads.ask({ key: "k", connection: "shop", count: 10, read });
    await settle();
    expect(reads.ask({ key: "k", connection: "shop", count: 10, read })).toMatchObject({
      status: "done",
      read: 9,
      failed: 1,
    });
  });

  /* A rate limit is waited out, not the end of the read. */
  it("waits out a rate limit and reads the same record again", async () => {
    const waits: number[] = [];
    const reads = new EachReads({ sleep: async (ms) => void waits.push(ms) });
    let limited = 2;
    const read = async (index: number) => {
      if (index === 4 && limited-- > 0)
        throw new AdapterError("rate limited", { status: 429, userMessage: "Wait a minute.", retryAfter: "60" });
      return { body: index };
    };
    reads.ask({ key: "k", connection: "shop", count: 20, read });
    await settle();
    await settle();
    const answer = reads.ask({ key: "k", connection: "shop", count: 20, read });
    expect(answer).toMatchObject({ status: "done", read: 20, of: 20, failed: 0 });
    expect(answer.stopped).toBeUndefined();
    expect(waits).toEqual([60_000, 60_000]);
  });

  it("counts a record it may not read and reads on; stops for a refused key, or when every record is refused", async () => {
    const forbidden = (status: number, which: (index: number) => boolean) => async (index: number) => {
      if (which(index)) throw new AdapterError("no", { status, userMessage: status === 401 ? "The key was refused." : "Not this one." });
      return { body: index };
    };
    const reads = new EachReads();
    reads.ask({ key: "one", connection: "shop", count: 30, read: forbidden(403, (index) => index === 12) });
    reads.ask({ key: "key", connection: "shop", count: 200, read: forbidden(401, (index) => index >= 4) });
    reads.ask({ key: "all", connection: "shop", count: 200, read: forbidden(403, () => true) });
    await settle();
    const ask = (key: string, count: number) => reads.ask({ key, connection: "shop", count, read: async () => ({ body: 0 }) });
    expect(ask("one", 30)).toMatchObject({ status: "done", read: 29, denied: 1, failed: 0 });
    expect(ask("one", 30).stopped).toBeUndefined();
    expect(ask("key", 200)).toMatchObject({ status: "done", read: 4, stopped: "The key was refused." });
    const all = ask("all", 200);
    expect(all).toMatchObject({ status: "done", read: 0, stopped: "Not this one." });
    /* Not two hundred refusals: three, and the one in flight beside them. */
    expect(all.denied).toBeLessThanOrEqual(4);
  });

  it("stops its reads when it is forgotten", async () => {
    const reads = new EachReads();
    let calls = 0;
    let aborted = 0;
    const read = (_index: number, signal: AbortSignal) =>
      new Promise<{ body: unknown }>((resolve) => {
        calls += 1;
        signal.addEventListener("abort", () => {
          aborted += 1;
          resolve({ body: null });
        });
      });
    reads.ask({ key: "k", connection: "shop", count: 50, read });
    await settle();
    reads.forget("shop");
    await settle();
    expect(calls).toBe(2);
    expect(aborted).toBe(2);
  });

  it("carries a read on after a restart, from the records it had not read", async () => {
    const store = new MemoryJobStore();
    const request: EachRequest = {
      connection: "shop",
      op: "charges",
      params: {},
      input: "lease",
      values: Array.from({ length: 10 }, (_, index) => `l${index}`),
      window: { range: resolveRange({ preset: "30d", now: 0 }), filters: {} },
      configVersion: "v1",
    };
    const asked: number[] = [];
    /* The first server reads four, then stops. */
    const before = new EachReads({ store });
    let gate: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      gate = resolve;
    });
    before.ask({
      key: "k",
      connection: "shop",
      count: 10,
      request,
      read: async (index) => {
        if (index >= 4) await held;
        asked.push(index);
        return { body: { lease: request.values[index] } };
      },
    });
    for (let tries = 0; tries < 50 && asked.length < 4; tries++) await settle();
    expect((await store.list({ kind: "each" }))[0]?.progress).toMatchObject({ done: [0, 1, 2, 3] });

    const after = new EachReads({
      store,
      reader: (kept) => (kept.configVersion === "v1" ? async (index) => ({ body: { lease: kept.values[index], again: true } }) : null),
    });
    await after.resume();
    for (let tries = 0; tries < 50 && after.ask({ key: "k", connection: "shop", count: 10, read: async () => ({ body: null }) }).status !== "done"; tries++)
      await settle();
    const whole = after.ask({ key: "k", connection: "shop", count: 10, read: async () => ({ body: null }) });
    expect(whole).toMatchObject({ status: "done", read: 10 });
    /* The four read before the restart, as they were read; the rest read after it. */
    expect(whole.bodies?.slice(0, 5)).toEqual([{ lease: "l0" }, { lease: "l1" }, { lease: "l2" }, { lease: "l3" }, { lease: "l4", again: true }]);
    expect(await store.list({ kind: "each" })).toEqual([]);
    gate();
  });

  it("reads again once the answer is old, and forgets a connection's reads", async () => {
    let now = 0;
    const reads = new EachReads({ keepMs: 1000, now: () => now });
    let calls = 0;
    const read = async () => {
      calls += 1;
      return { body: 1 };
    };
    reads.ask({ key: "k", connection: "shop", count: 2, read });
    await settle();
    now = 500;
    reads.ask({ key: "k", connection: "shop", count: 2, read });
    expect(calls).toBe(2);
    now = 5000;
    expect(reads.ask({ key: "k", connection: "shop", count: 2, read }).status).toBe("reading");
    await settle();
    expect(calls).toBe(4);
    reads.forget("shop");
    expect(reads.ask({ key: "k", connection: "shop", count: 2, read }).status).toBe("reading");
  });

  it("holds a bounded number of reads", async () => {
    const reads = new EachReads({ max: 2 });
    let calls = 0;
    const read = async () => {
      calls += 1;
      return { body: 1 };
    };
    for (const key of ["a", "b", "c"]) reads.ask({ key, connection: "shop", count: 1, read });
    await settle();
    /* The oldest out, and stopped before it read anything; read again when asked again. */
    expect(calls).toBe(2);
    reads.ask({ key: "a", connection: "shop", count: 1, read });
    await settle();
    expect(calls).toBe(3);
    expect(eachKey("shop", ["x", "y"])).not.toBe(eachKey("shop", ["x"]));
  });
});
