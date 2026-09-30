import { AdapterError } from "@freebirdai/dash-adapters";
import { describe, expect, it } from "vitest";
import { EachReads, eachKey } from "./each.js";

/*
 * Every record's related records, past the twenty-five a tile reads itself
 * (plan, track D): read in the background, handed over whole, and what was not
 * read is said.
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

  it("stops when the API refuses the account or asks to wait, and says why", async () => {
    const reads = new EachReads();
    let calls = 0;
    const read = async (index: number) => {
      calls += 1;
      if (index >= 4)
        throw new AdapterError("rate limited", { status: 429, userMessage: "Wait a minute." });
      return { body: index };
    };
    reads.ask({ key: "k", connection: "shop", count: 200, read });
    await settle();
    const answer = reads.ask({ key: "k", connection: "shop", count: 200, read });
    expect(answer).toMatchObject({ status: "done", read: 4, of: 200, stopped: "Wait a minute." });
    /* Not two hundred refusals: the reads in flight when it stopped, and no more. */
    expect(calls).toBeLessThan(8);
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
    reads.ask({ key: "a", connection: "shop", count: 1, read });
    expect(calls).toBe(4);
    expect(eachKey("shop", ["x", "y"])).not.toBe(eachKey("shop", ["x"]));
  });
});
