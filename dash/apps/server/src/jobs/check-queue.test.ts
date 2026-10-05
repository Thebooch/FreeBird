import { connectionSchema, type ConnectionSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { ledgerly } from "../bench/providers/ledgerly.js";
import { json } from "../bench/seed.js";
import { benchTransport } from "../bench/transport.js";
import type { MockProvider } from "../bench/types.js";
import { MemoryEvidenceStore } from "@freebirdai/connect/evidence/store";
import { createIntegrationRunner } from "@freebirdai/connect/integrate/runner";
import { LocalAesVault } from "@freebirdai/connect/vault";
import { CheckQueue } from "@freebirdai/connect/jobs/check-queue";
import { MemoryJobStore } from "@freebirdai/connect/jobs/store";
import { openDashDb } from "../platform/db.js";
import { DbJobStore } from "@freebirdai/connect-postgres";

/*
 * Which endpoints a check reads next, kept in the job store: settled only
 * once a check recorded evidence, the most pressing
 * first, and none left out however many there are.
 */

const NOW = Date.UTC(2026, 9, 2);
const NAMES = Array.from({ length: 12 }, (_, index) => `list${index + 1}`);

const connectionOf = (names: readonly string[] = NAMES, path = (name: string) => `/${name}`): ConnectionSpec =>
  connectionSchema.parse({
    id: "many",
    title: "Many",
    kind: "rest",
    baseUrl: "https://api.many.bench.test",
    ops: names.map((name) => ({ id: name, title: name, path: path(name), rowsPath: "$.results" })),
    resources: names.map((name) => ({ id: name, title: name, listOp: name })),
  });

describe("the queue of endpoint checks", () => {
  it("takes the most pressing first, and settles only what a check settled", async () => {
    const clock = { now: NOW };
    const queue = new CheckQueue({ store: new MemoryJobStore(), now: () => clock.now });
    const connection = connectionOf();
    await queue.enqueue(connection, NAMES.slice(0, 10), "unsettled");
    await queue.enqueue(connection, ["list11", "list12"], "used");
    const first = await queue.take(connection, 8);
    /* What boards read, before what nobody has settled. */
    expect(first.slice(0, 2)).toEqual(["list11", "list12"]);
    /* Taken is not settled: a check that never ends settles nothing. */
    expect(await queue.settled(connection, "list11")).toBe(false);
    await queue.settle(connection, first.slice(0, 7));
    await queue.block(connection, first[7]!, "failed", "The read failed.");
    expect(await queue.settled(connection, first[7]!)).toBe(false);
    expect(await queue.take(connection, 8)).toEqual(["list7", "list8", "list9", "list10"]);

    /* A change seen on a settled endpoint goes first. */
    await queue.enqueue(connection, ["list11"], "drift");
    await queue.enqueue(connection, ["list1"], "used");
    expect(await queue.take(connection, 1)).toEqual(["list11"]);

    /* The failed one is due again after its wait, and not before. */
    expect(await queue.remaining(connection)).toBe(0);
    clock.now += 31 * 60_000;
    expect(await queue.take(connection, 8)).toEqual([first[7]]);
  });

  it("is due again when the endpoint's own configuration changes, not when another's does", async () => {
    const queue = new CheckQueue({ store: new MemoryJobStore(), now: () => NOW });
    const before = connectionOf(["alpha", "beta"]);
    await queue.enqueue(before, ["alpha", "beta"], "unsettled");
    await queue.settle(before, await queue.take(before, 8));
    const moved = connectionOf(["alpha", "beta"], (name) => (name === "beta" ? "/v2/beta" : `/${name}`));
    expect(await queue.settled(moved, "alpha")).toBe(true);
    expect(await queue.settled(moved, "beta")).toBe(false);
    expect(await queue.take(moved, 8)).toEqual(["beta"]);
  });

  it("survives a restart: what was being checked is due again, what was settled stays settled", async () => {
    const db = await openDashDb({ inMemory: true });
    try {
      const vault = new LocalAesVault(Buffer.alloc(32, 5));
      const connection = connectionOf(["alpha", "beta", "gamma"]);
      /* A tick each time: endpoints queued one after another, in order. */
      let tick = NOW;
      const before = new CheckQueue({ store: new DbJobStore(db, vault), now: () => tick++ });
      for (const name of ["alpha", "beta", "gamma"]) await before.enqueue(connection, [name], "unsettled");
      await before.settle(connection, await before.take(connection, 1));
      expect(await before.take(connection, 8)).toEqual(["beta", "gamma"]);

      const after = new CheckQueue({ store: new DbJobStore(db, vault), now: () => tick++ });
      expect(await after.remaining(connection)).toBe(0);
      await after.resume();
      expect(await after.settled(connection, "alpha")).toBe(true);
      expect(await after.take(connection, 8)).toEqual(["beta", "gamma"]);
    } finally {
      await db.close();
    }
  });
});

describe("checks run from the queue", () => {
  const many: MockProvider = {
    ...ledgerly,
    id: "many",
    hosts: ["api.many.bench.test"],
    handle: (request) => {
      if (request.url.pathname === "/list5") return json({ error: "broken" }, 500);
      return json({ results: [{ id: 1, name: request.url.pathname.slice(1) }, { id: 2, name: "b" }] });
    },
  };

  const runnerOf = (connection: ConnectionSpec, used: readonly string[]) => {
    const transport = benchTransport([many]);
    let current = connection;
    const queue = new CheckQueue({ store: new MemoryJobStore(), now: () => NOW });
    const runner = createIntegrationRunner({
      getConnection: () => current,
      saveConnection: (next) => {
        current = next;
      },
      catalogEntry: () => null,
      hasSecret: () => true,
      resolveSecret: async () => null,
      http: transport.http,
      fetchDocument: transport.fetchDocument,
      llm: () => null,
      evidence: new MemoryEvidenceStore(),
      around: () => (run) => run(),
      auto: true,
      usedOps: () => used,
      now: () => NOW,
      queue,
    });
    return { runner, queue, current: () => current };
  };

  const settle = async (runner: { running: (id: string) => boolean }) => {
    for (let tries = 0; tries < 400; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!runner.running("many")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (!runner.running("many")) return;
      }
    }
    throw new Error("checks never finished");
  };

  it("settles every endpoint boards read, eight at a time, and never one whose check failed", async () => {
    const { runner, queue, current } = runnerOf(connectionOf(), NAMES);
    runner.whenUsed(current(), NAMES);
    await settle(runner);
    const settled = await Promise.all(NAMES.map((name) => queue.settled(current(), name)));
    expect(NAMES.filter((_, index) => settled[index])).toEqual(NAMES.filter((name) => name !== "list5"));
    expect(await queue.list("many")).toContainEqual(expect.objectContaining({ op: "list5", state: "blocked" }));
  });

  it("checks a changed endpoint again, by itself", async () => {
    const { runner, queue, current } = runnerOf(connectionOf(["alpha", "beta"]), ["alpha", "beta"]);
    runner.whenUsed(current(), ["alpha", "beta"]);
    await settle(runner);
    expect(await queue.settled(current(), "beta")).toBe(true);
    runner.recheck(current(), ["beta"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await queue.list("many")).toContainEqual(expect.objectContaining({ op: "beta", reason: "drift" }));
    await settle(runner);
    expect(await queue.list("many")).toContainEqual(expect.objectContaining({ op: "beta", state: "done", reason: "drift" }));
  });
});
