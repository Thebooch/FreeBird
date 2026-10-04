import { connectionSchema, getOp, readCoverage, resolveRange, type ConnectionSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { INCOMPLETE } from "./incomplete.js";
import { RestAdapter, type HttpFetch } from "./rest.js";
import type { FetchContext } from "./types.js";

/*
 * How a read ended, as REST saw it end: the last page's own word, or what
 * stopped it — and never a claim that it reached the end when nothing says
 * so.
 */

const NOW = Date.UTC(2026, 8, 30);
const RECORDS = Array.from({ length: 95 }, (_, index) => ({ id: index + 1, status: index % 3 === 0 ? "open" : "closed" }));

const http: HttpFetch = async (url) => {
  const query = new URL(url).searchParams;
  const page = Number(query.get("page") ?? 1);
  const status = query.get("status");
  const matching = RECORDS.filter((one) => !status || one.status === status);
  const text = JSON.stringify({ data: matching.slice((page - 1) * 20, page * 20), total: matching.length });
  return { status: 200, text, url, header: (name) => (name === "content-type" ? "application/json" : null) };
};

const connection = (extra: Record<string, unknown> = {}, op: Record<string, unknown> = {}): ConnectionSpec =>
  connectionSchema.parse({
    id: "c",
    title: "Completion API",
    kind: "rest",
    baseUrl: "https://api.completion.test",
    auth: { type: "none" },
    ops: [
      {
        id: "items",
        title: "Items",
        path: "/items",
        rowsPath: "$.data",
        totalPath: "$.total",
        pagination: { kind: "page", param: "page", startsAt: 1, limitParam: "per_page", pageSize: 20 },
        maxPages: 10,
        params: [{ name: "status", in: "query" }],
        ...op,
      },
    ],
    ...extra,
  });

const context: FetchContext = { params: { range: resolveRange({ preset: "30d", now: NOW }), filters: {} }, now: NOW };

const fetch = (conn: ConnectionSpec, overrides: Record<string, string> = {}) =>
  new RestAdapter(http).fetch(conn, getOp(conn, "items")!, overrides, context);

describe("how a REST read ended", () => {
  it("reached its end on a short last page, and its count is about exactly what it asked for", async () => {
    const result = await fetch(connection());
    expect(result.meta).toMatchObject({ pages: 5, truncated: false, completion: { state: "traversed", reason: "short-page" } });
    expect(result.meta.totalScope).toBe(result.meta.scope);
    expect(readCoverage(result.meta, 95)?.level).toBe("count-reconciled");
  });

  it("asks a narrowed read under a scope of its own", async () => {
    const all = await fetch(connection());
    const open = await fetch(connection(), { status: "open" });
    expect(open.meta.scope).not.toBe(all.meta.scope);
    expect(open.meta).toMatchObject({ reportedTotal: 32, completion: { state: "traversed" } });
  });

  it("stopped at the page cap: partial, and said", async () => {
    const result = await fetch(connection({}, { maxPages: 2 }));
    expect(result.meta).toMatchObject({ truncated: true, completion: { state: "partial", reason: "page-cap" } });
    expect(readCoverage(result.meta, 40)).toBeNull();
  });

  it("read in one answer, where the endpoint takes no paging", async () => {
    const result = await fetch(connection({}, { pagination: { kind: "none" } }));
    expect(result.meta.completion).toEqual({ state: "traversed", reason: "single-response" });
  });

  it("cannot say, where nobody has confirmed how it pages", async () => {
    const result = await fetch(connection({ paginationPending: true }, { pagination: { kind: "none" } }));
    expect(result.meta.completion).toEqual({ state: "unknown", reason: "unconfirmed-paging" });
    expect(result.meta.warnings).toContain(INCOMPLETE.unconfirmed);
    expect(readCoverage(result.meta, 20)).toBeNull();
  });
});

/* A read that stops at its ceiling says where, and is carried on from there. */
describe("a read carried on from where it stopped", () => {
  it("hands back its next request without the key, and goes on from it to the end", async () => {
    const sent: string[] = [];
    const keyed: HttpFetch = async (url, init, host) => {
      sent.push(url);
      return http(url, init, host);
    };
    const conn = connection({ auth: { type: "query", param: "api_key", keyRef: "k" } }, { maxPages: 2 });
    const op = getOp(conn, "items")!;
    const ctx: FetchContext = { ...context, resolveSecret: async () => "sk_live_123" };
    const adapter = new RestAdapter(keyed);
    const first = await adapter.fetch(conn, op, {}, ctx);
    expect(first.meta).toMatchObject({ pages: 2, completion: { state: "partial", reason: "page-cap" } });
    expect(first.meta.continuation).toMatchObject({ kind: "rest", scope: first.meta.scope, pageIndex: 2, collected: 40, reportedTotal: 95 });
    expect(JSON.stringify(first.meta.continuation)).not.toContain("sk_live_123");

    const rows: Array<{ id: number }> = [...(first.body as { data: Array<{ id: number }> }).data];
    let next = first.meta.continuation;
    let last = first;
    while (next) {
      last = await adapter.fetch(conn, op, {}, { ...ctx, continueFrom: next });
      rows.push(...(last.body as { data: Array<{ id: number }> }).data);
      next = last.meta.continuation;
    }
    expect(rows.map((row) => row.id)).toEqual(RECORDS.map((row) => row.id));
    expect(last.meta).toMatchObject({ pages: 1, completion: { state: "traversed", reason: "short-page" } });
    /* Every request, carried on or not, sent the key; none was asked twice. */
    expect(sent.every((url) => new URL(url).searchParams.get("api_key") === "sk_live_123")).toBe(true);
    expect(new Set(sent.map((url) => new URL(url).searchParams.get("page")))).toEqual(new Set(["1", "2", "3", "4", "5"]));
  });

  it("refuses another read's place", async () => {
    const conn = connection({}, { maxPages: 2 });
    const first = await fetch(conn);
    const narrowed = new RestAdapter(http).fetch(conn, getOp(conn, "items")!, { status: "open" }, { ...context, continueFrom: first.meta.continuation! });
    await expect(narrowed).rejects.toMatchObject({ status: 409 });
  });
});

/* Regression (trackwell mock API): 50 of 264 read and shown as the whole, though the answer said there was more. */
describe("an answer that says there is more", () => {
  const answering = (body: unknown): HttpFetch => async (url) => ({
    status: 200,
    text: JSON.stringify(body),
    url,
    header: (name) => (name === "content-type" ? "application/json" : null),
  });
  const read = (body: unknown, op: Record<string, unknown> = {}) => {
    const conn = connection({}, { pagination: { kind: "none" }, rowsPath: "$.issues", totalPath: undefined, ...op });
    return new RestAdapter(answering(body)).fetch(conn, getOp(conn, "items")!, {}, context);
  };

  it("is never called complete when nothing reads the rest", async () => {
    for (const body of [
      { issues: [{ id: 1 }], isLast: false, nextPageToken: "abc" },
      { issues: [{ id: 1 }], has_more: true },
      { issues: [{ id: 1 }], links: { next: "https://api.completion.test/items?page=2" } },
    ]) {
      const result = await read(body);
      expect(result.meta).toMatchObject({ truncated: true, completion: { state: "partial", reason: "said-more" } });
      expect(result.meta.warnings).toContain(INCOMPLETE.saidMore);
    }
  });

  it("is taken at its word when it says it is the last, and a single record's own fields are only fields", async () => {
    expect((await read({ issues: [{ id: 1 }], isLast: true })).meta.completion).toMatchObject({ state: "traversed" });
    const record = await read({ id: 7, next: "2026-11-01", last: false }, { rowsPath: "$" });
    expect(record.meta.truncated).toBe(false);
  });
});
