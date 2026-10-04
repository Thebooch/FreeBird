import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterError, RestAdapter, type FetchResult, type HttpFetch } from "@freebirdai/dash-adapters";
import { connectionSchema, getOp, resolveRange, type ConnectionSpec } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDashDb } from "../platform/db.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "../vault.js";
import { LongReads, longReadId, type LongReadDeps } from "./long-reads.js";
import { DbJobStore, MemoryJobStore, type JobStore } from "./store.js";

/*
 * A read past a tile's own limits, carried on in the background from where it
 * stopped, to its end — through a restart, a rate limit and a refusal.
 */

const NOW = Date.UTC(2026, 9, 2);
const KEY = "sk_live_7781";
const PAYMENTS = Array.from({ length: 230 }, (_, index) => ({ id: `pay_${index + 1}`, amount: 10 }));

/** Ten a page, no total: twenty-three pages, past a ceiling of five. */
const payments = (refuse: (page: number) => number | null = () => null) => {
  const sent: string[] = [];
  const http: HttpFetch = async (url) => {
    sent.push(url);
    const page = Number(new URL(url).searchParams.get("page") ?? 1);
    const status = refuse(page);
    if (status !== null)
      return { status, text: JSON.stringify({ error: "no" }), url, header: (name) => (name === "retry-after" && status === 429 ? "60" : null) };
    const text = JSON.stringify({ data: PAYMENTS.slice((page - 1) * 10, page * 10) });
    return { status: 200, text, url, header: (name) => (name === "content-type" ? "application/json" : null) };
  };
  return { http, sent };
};

const connection: ConnectionSpec = connectionSchema.parse({
  id: "ledger",
  title: "Ledger",
  kind: "rest",
  baseUrl: "https://api.ledger.test",
  auth: { type: "query", param: "api_key", keyRef: "ledger-key" },
  ops: [
    {
      id: "payments",
      title: "Payments",
      path: "/payments",
      rowsPath: "$.data",
      pagination: { kind: "page", param: "page", startsAt: 1 },
      paginationChecked: true,
      maxPages: 5,
    },
  ],
});
const op = getOp(connection, "payments")!;
const resolved = { range: resolveRange({ preset: "30d", now: NOW }), filters: {} };

const harness = (http: HttpFetch, store: JobStore = new MemoryJobStore(), clock = { now: NOW }) => {
  const answers = new Map<string, FetchResult>();
  const wakes: Array<{ ms: number; run: () => void }> = [];
  const adapter = new RestAdapter(http);
  const deps: LongReadDeps = {
    store,
    getConnection: () => connection,
    read: (conn, endpoint, overrides, ctx) => adapter.fetch(conn, endpoint, overrides, { ...ctx, resolveSecret: async () => KEY }),
    answer: async (key, _connection, result) => {
      answers.set(key, result);
    },
    now: () => clock.now,
    schedule: (ms, run) => {
      wakes.push({ ms, run });
      return () => {};
    },
  };
  return { reads: new LongReads(deps), deps, answers, wakes, adapter, store };
};

const firstRead = (adapter: RestAdapter) => adapter.fetch(connection, op, {}, { params: resolved, now: NOW, resolveSecret: async () => KEY });
const ids = (result: FetchResult | undefined) => ((result?.body as { data: Array<{ id: string }> } | undefined)?.data ?? []).map((row) => row.id);

describe("a read carried on past a tile's limits", () => {
  it("reads on from where the tile stopped to the end, hands the whole answer over, and keeps no records after", async () => {
    const { http, sent } = payments();
    const { reads, answers, adapter, store } = harness(http);
    const first = await firstRead(adapter);
    expect(first.meta).toMatchObject({ pages: 5, completion: { reason: "page-cap" } });

    await reads.carryOn({ key: "k1", connection, op, overrides: {}, resolved, first });
    await reads.idle();

    expect(ids(answers.get("k1"))).toEqual(PAYMENTS.map((one) => one.id));
    expect(answers.get("k1")!.meta).toMatchObject({ truncated: false, pages: 24, completion: { state: "traversed" } });
    expect(answers.get("k1")!.meta.continuation).toBeUndefined();
    /* Each page asked once: the tile's five, then the rest from page six. */
    expect(sent.map((url) => new URL(url).searchParams.get("page"))).toEqual(Array.from({ length: 24 }, (_, index) => String(index + 1)));
    expect(await store.rows(longReadId("k1"))).toEqual([]);
    expect(await reads.status("k1")).toBeNull();
    /* Read this way from now on: refreshed through the job, never by a capped read. */
    expect(await reads.owns("k1")).toBe(true);
  });

  it("carries on after a restart from where it got to, its records and its place sealed at rest", async () => {
    const db = await openDashDb({ inMemory: true });
    try {
      const vault = new LocalAesVault(Buffer.alloc(32, 3));
      const { http, sent } = payments();
      /* The first server reads one stretch, then stops. */
      const before = harness(http, new DbJobStore(db, vault));
      const read = before.deps.read;
      const stopping = new LongReads({
        ...before.deps,
        stepPages: 5,
        read: async (...args) => {
          stopping.stop();
          return read(...args);
        },
      });
      const first = await firstRead(before.adapter);
      await stopping.carryOn({ key: "k2", connection, op, overrides: {}, resolved, first });
      await stopping.idle();
      expect(before.answers.size).toBe(0);

      /* Nothing readable at rest: no record, no address, no key. */
      const raw = JSON.stringify([
        (await sql`SELECT record FROM dash_jobs`.execute(db.kysely)).rows,
        (await sql`SELECT rows FROM dash_job_rows`.execute(db.kysely)).rows,
      ]);
      expect(raw).not.toContain("pay_");
      expect(raw).not.toContain("api.ledger.test");
      expect(raw).not.toContain(KEY);

      /* The next server takes it up where it was, rather than from the first page. */
      const asked = sent.length;
      const after = harness(http, new DbJobStore(db, vault));
      await after.reads.resume();
      await after.reads.idle();
      expect(ids(after.answers.get("k2"))).toEqual(PAYMENTS.map((one) => one.id));
      expect(sent.slice(asked).map((url) => new URL(url).searchParams.get("page"))[0]).toBe("11");
      expect((await sql`SELECT rows FROM dash_job_rows`.execute(db.kysely)).rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("waits out a rate limit and carries on, and stops for a refused key until the key changes", async () => {
    let limited = true;
    const { http } = payments((page) => (page === 9 && limited ? 429 : null));
    const clock = { now: NOW };
    const { reads, answers, adapter, wakes } = harness(http, new MemoryJobStore(), clock);
    const first = await firstRead(adapter);
    await reads.carryOn({ key: "k3", connection, op, overrides: {}, resolved, first });
    await reads.idle();
    expect(await reads.status("k3")).toMatchObject({ state: "waiting", read: 50 });
    expect(wakes.at(-1)!.ms).toBeGreaterThanOrEqual(60_000);

    limited = false;
    clock.now += 60_000;
    wakes.at(-1)!.run();
    await reads.idle();
    expect(ids(answers.get("k3"))).toHaveLength(230);

    const refused = payments((page) => (page > 5 ? 403 : null));
    const second = harness(refused.http);
    await second.reads.carryOn({ key: "k4", connection, op, overrides: {}, resolved, first: await firstRead(second.adapter) });
    await second.reads.idle();
    expect(await second.reads.status("k4")).toMatchObject({ state: "blocked" });
    await second.reads.forget("ledger");
    expect(await second.reads.owns("k4")).toBe(false);
  });

  it("is never answered once forgotten part-way through", async () => {
    const { http } = payments();
    const { reads, deps, answers, adapter } = harness(http);
    const forgetting = new LongReads({
      ...deps,
      read: async (...args) => {
        await forgetting.forget("ledger");
        return deps.read(...args);
      },
    });
    await forgetting.carryOn({ key: "k5", connection, op, overrides: {}, resolved, first: await firstRead(adapter) });
    await forgetting.idle();
    expect(answers.size).toBe(0);
    expect(await reads.owns("k5")).toBe(false);
  });

  it("refuses to carry on a read that changed: it is read again from the start", async () => {
    const { http } = payments();
    const { reads, store, adapter } = harness(http);
    await reads.carryOn({ key: "k6", connection, op, overrides: {}, resolved, first: await firstRead(adapter) });
    await reads.idle();
    const narrowed = await adapter
      .fetch(connection, op, { status: "open" }, { params: resolved, now: NOW, resolveSecret: async () => KEY, continueFrom: (await firstRead(adapter)).meta.continuation! })
      .catch((error: unknown) => error);
    expect(narrowed).toBeInstanceOf(AdapterError);
    expect((narrowed as AdapterError).status).toBe(409);
    expect(await store.get(longReadId("k6"))).toMatchObject({ state: "done" });
  });
});

describe("a tile whose read is carried on", () => {
  let dir: string;
  let specs: SpecStore;
  let keys: KeyStore;

  beforeEach(() => {
    vi.stubEnv("DASH_MIN_GAP_MS", "0");
    dir = mkdtempSync(join(tmpdir(), "dash-long-"));
    specs = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is told how far the rest has got, then is answered whole, from the server's own copy", async () => {
    const { http } = payments();
    const app = buildServer({ store: specs, keys, http });
    specs.putConnection(connection);
    keys.set("ledger-key", KEY);
    const ask = async (mode: "view" | "refresh") =>
      (await app.inject({ method: "POST", url: "/api/query", payload: { connection: "ledger", op: "payments", mode, maxAgeMs: 60_000 } })).json() as {
        body: { data: unknown[] };
        meta: { readingOn?: { read: number }; warnings: string[]; continuation?: unknown };
      };

    const first = await ask("refresh");
    expect(first.body.data).toHaveLength(50);
    expect(first.meta.continuation).toBeUndefined();
    expect(first.meta.readingOn).toBeDefined();
    expect(first.meta.warnings.join(" ")).toMatch(/being read in the background/);
    expect(first.meta.warnings.join(" ")).not.toMatch(/Only the first 5 page/);

    for (let tries = 0; tries < 200 && (await ask("view")).meta.readingOn; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    const whole = await ask("view");
    expect(whole.body.data).toHaveLength(230);
    expect(whole.meta.readingOn).toBeUndefined();
    expect(whole.meta.warnings).toEqual([]);
    await app.close();
  });
});
