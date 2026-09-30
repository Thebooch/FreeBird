import type { ConnectionSpec, OpSpec, ResolvedParams } from "@freebirdai/dash-spec";
import { connectionSchema, getOp, resolveRange } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { INCOMPLETE } from "./incomplete.js";
import { RestAdapter, type HttpFetch } from "./rest.js";
import type { FetchContext } from "./types.js";

/*
 * A list the API will not read past a point, read whole in narrower time
 * windows (plan, track D: "time narrowing"). The API here lists at most its
 * first 300 results, newest first, a hundred to a page; a time range narrows
 * it, and every answer says how many records the range holds.
 */

const NOW = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;
const WINDOW = 300;

interface Payment {
  id: string;
  created: number;
  amount: number;
}

/** 1,000 payments over two years, several to a day, some at the very same second. */
const payments: Payment[] = Array.from({ length: 1000 }, (_, index) => ({
  id: `py_${index}`,
  created: Math.floor((NOW - 730 * DAY + Math.floor(index / 3) * 2.19 * DAY) / 1000),
  amount: 100 + index,
}));

const api = (options: { inclusive?: boolean; silent?: boolean; refuseWindows?: boolean } = {}) => {
  const asked: URL[] = [];
  const http: HttpFetch = async (raw) => {
    const url = new URL(raw);
    asked.push(url);
    const answer = (status: number, body: unknown) => ({
      status,
      text: JSON.stringify(body),
      url: raw,
      header: () => null,
    });
    const since = url.searchParams.get("created[gte]");
    const before = url.searchParams.get("created[lt]");
    if (options.refuseWindows && since !== null && Number(since) > 0) return answer(400, { error: "created[gte] is not available on this plan." });
    const matching = payments
      .filter(
        (one) =>
          (since === null || one.created >= Number(since)) &&
          (before === null || (options.inclusive ? one.created <= Number(before) : one.created < Number(before))),
      )
      .sort((a, b) => b.created - a.created);
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (page * limit > WINDOW) return answer(400, { error: `page × limit must be at most ${WINDOW}.` });
    return answer(200, {
      data: matching.slice((page - 1) * limit, page * limit),
      ...(options.silent ? {} : { total_count: matching.length }),
    });
  };
  return { http, asked };
};

const connection = (): ConnectionSpec =>
  connectionSchema.parse({
    id: "pay",
    title: "Pay",
    kind: "rest",
    baseUrl: "https://api.pay.example/v1",
    ops: [
      {
        id: "payments",
        title: "Payments",
        path: "/payments",
        rowsPath: "$.data",
        query: { "created[gte]": "{{range.start | unix}}", "created[lt]": "{{range.end | unix}}" },
        pagination: { kind: "page", param: "page", startsAt: 1, limitParam: "limit", pageSize: 100 },
        paginationChecked: true,
        maxPages: 50,
      },
    ],
  });

const op = (conn: ConnectionSpec): OpSpec => getOp(conn, "payments")!;

const everything = (): FetchContext => ({
  now: NOW,
  params: { range: { ...resolveRange({ preset: "30d", now: NOW }), all: true }, filters: {} } satisfies ResolvedParams,
  resolveSecret: async () => null,
});

const idsOf = (body: unknown) => (body as { data: Payment[] }).data.map((one) => one.id).sort();

describe("a list the API will not read past a point", () => {
  it("is read whole in time windows, each no larger than the API will list", async () => {
    const { http, asked } = api();
    const conn = connection();
    const result = await new RestAdapter(http).fetch(conn, op(conn), {}, everything());
    expect(idsOf(result.body)).toEqual(payments.map((one) => one.id).sort());
    expect(result.meta).toMatchObject({ truncated: false, warnings: [], reportedTotal: 1000 });
    /* No window was asked past what the API lists, after the first refusal. */
    const refusals = asked.filter((url) => Number(url.searchParams.get("page") ?? 1) * 100 > WINDOW);
    expect(refusals).toHaveLength(1);
    expect(asked.length).toBeLessThan(80);
  });

  it("counts a record on a boundary once, where the API's range includes both ends", async () => {
    const { http } = api({ inclusive: true });
    const conn = connection();
    const result = await new RestAdapter(http).fetch(conn, op(conn), {}, everything());
    expect(idsOf(result.body)).toEqual(payments.map((one) => one.id).sort());
    expect(result.meta.truncated).toBe(false);
  });

  it("narrows a range somebody chose, inside that range", async () => {
    const { http, asked } = api();
    const conn = connection();
    const year = { ...resolveRange({ preset: "30d", now: NOW }), start: NOW - 365 * DAY, end: NOW, preset: "custom" as const };
    const result = await new RestAdapter(http).fetch(conn, op(conn), {}, {
      now: NOW,
      params: { range: year, filters: {} },
      resolveSecret: async () => null,
    });
    const expected = payments.filter((one) => one.created * 1000 >= NOW - 365 * DAY && one.created * 1000 < NOW);
    expect(idsOf(result.body)).toEqual(expected.map((one) => one.id).sort());
    expect(result.meta).toMatchObject({ truncated: false, reportedTotal: expected.length });
    expect(asked.every((url) => Number(url.searchParams.get("created[gte]")) >= Math.floor((NOW - 365 * DAY) / 1000))).toBe(true);
  });

  it("keeps the first read, and what it said, where a window cannot be counted or read", async () => {
    for (const options of [{ silent: true }, { refuseWindows: true }]) {
      const { http } = api(options);
      const conn = connection();
      const result = await new RestAdapter(http).fetch(conn, op(conn), {}, everything());
      expect((result.body as { data: Payment[] }).data).toHaveLength(WINDOW);
      expect(result.meta.truncated).toBe(true);
      expect(result.meta.warnings).toContain(INCOMPLETE.laterPageRefused);
    }
  });

  it("is left as it is where the endpoint takes no time range", async () => {
    const { http, asked } = api();
    const conn = connectionSchema.parse({
      ...connection(),
      ops: [{ ...connection().ops[0]!, query: {} }],
    });
    const result = await new RestAdapter(http).fetch(conn, op(conn), {}, everything());
    expect(result.meta.warnings).toContain(INCOMPLETE.laterPageRefused);
    expect(asked).toHaveLength(4);
  });
});

describe("a stream", () => {
  it("is read for its window, each event a record, and says it is a window", async () => {
    const events = Array.from({ length: 4 }, (_, index) => `id: ${index}\ndata: {"n": ${index}}\n\n`).join("");
    const http: HttpFetch = async (url) => ({ status: 200, text: events, url, header: (name) => (name === "content-type" ? "text/event-stream" : null) });
    const conn = connectionSchema.parse({
      id: "live",
      title: "Live",
      kind: "rest",
      baseUrl: "https://api.live.example",
      ops: [{ id: "feed", title: "Feed", path: "/feed", rowsPath: "$", stream: { events: 4, seconds: 5 } }],
    });
    const result = await new RestAdapter(http).fetch(conn, getOp(conn, "feed")!, {}, everything());
    expect(result.body).toEqual([
      { id: "0", n: 0 },
      { id: "1", n: 1 },
      { id: "2", n: 2 },
      { id: "3", n: 3 },
    ]);
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.warnings).toEqual([INCOMPLETE.streamWindow(4, 5)]);
  });
});
