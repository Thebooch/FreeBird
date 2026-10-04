import { connectionSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { ledgerly } from "../bench/providers/ledgerly.js";
import { json } from "../bench/seed.js";
import { benchTransport } from "../bench/transport.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../bench/types.js";
import { budgetOf, tryRead } from "../integrate/read.js";
import { nextAddressPaths, probePagination } from "./probe-pagination.js";

/*
 * Ways of paging the check could not confirm: an
 * address only the answer knows, pages numbered from 0, the last record's id
 * as the cursor, and parameters nothing declared. Every one is kept only when
 * its second page returns records the first did not have.
 */

const NOW = Date.UTC(2026, 8, 1);
const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `r${index + 1}`, n: index + 1 }));

const probe = async (
  host: string,
  handle: (request: BenchRequest) => BenchResponse,
  op: Record<string, unknown>,
  options: Parameters<typeof probePagination>[3] = { traverseUpTo: 10 },
) => {
  const provider: MockProvider = { ...ledgerly, id: host, hosts: [host], handle };
  const connection = connectionSchema.parse({
    id: "probed",
    title: "Probed",
    kind: "rest",
    baseUrl: `https://${host}`,
    ops: [{ id: "things", title: "Things", path: "/things", ...op }],
  });
  const transport = benchTransport([provider]);
  const asked: string[] = [];
  const result = await probePagination(
    connection,
    "things",
    {
      http: async (url, init, allowed) => (asked.push(url), transport.http(url, init, allowed)),
      resolveSecret: async () => null,
      now: () => NOW,
      budget: budgetOf(40),
    },
    options,
  );
  return { result, asked };
};

describe("the next page's address, given in the answer", () => {
  const all = rows(47);
  /* A token only the server can read: no page number or offset stands in for it. */
  const tokenOf = (start: number) => Buffer.from(`at:${start}`, "utf8").toString("base64url");
  const startOf = (request: BenchRequest) => {
    const token = request.url.searchParams.get("token");
    return token ? Number(Buffer.from(token, "base64url").toString("utf8").slice(3)) : 0;
  };

  it("is followed where it is an object with an href, to the end", async () => {
    const { result } = await probe(
      "api.hal.bench.test",
      (request) => {
        const start = startOf(request);
        const next = start + 10 < all.length ? { next: { href: `/things?token=${tokenOf(start + 10)}` } } : {};
        return json({ _embedded: { things: all.slice(start, start + 10) }, _links: { self: { href: "/things" }, ...next } });
      },
      { rowsPath: "$._embedded.things" },
    );
    expect(result.pagination).toEqual({ kind: "next-url", path: "$._links.next" });
    expect(result).toMatchObject({ level: "traversed", rows: 47, pages: 5 });
  });

  it("is followed under a key that needs quoting, and kept on the API's own host", async () => {
    const { result, asked } = await probe(
      "api.odata.bench.test",
      (request) => {
        const start = startOf(request);
        return json({
          value: all.slice(start, start + 20),
          "@odata.count": all.length,
          /* An inner host, as an API behind a proxy names itself. */
          ...(start + 20 < all.length ? { "@odata.nextLink": `http://inner.odata.internal/things?token=${tokenOf(start + 20)}` } : {}),
        });
      },
      { rowsPath: "$.value" },
    );
    expect(result.pagination).toEqual({ kind: "next-url", path: '$["@odata.nextLink"]' });
    expect(result.rows).toBe(47);
    expect(asked.every((url) => new URL(url).origin === "https://api.odata.bench.test")).toBe(true);
  });

  it("is looked for outside the records only", () => {
    expect(nextAddressPaths({ data: [{ next: "/a?b=1" }], links: { next: "https://x.test/things?page=2", prev: null } })).toEqual(["$.links.next"]);
    expect(nextAddressPaths({ next: null, meta: { next_page: 3 } })).toEqual([]);
  });
});

describe("an answer read as one record", () => {
  it("is never paged: each later answer would count as a record of its own", async () => {
    const all = rows(47);
    const { result, asked } = await probe(
      "api.onerecord.bench.test",
      (request) => {
        const page = Number(request.url.searchParams.get("page") ?? 1);
        return json({ wrapper: { things: all.slice((page - 1) * 10, page * 10) }, next: page < 5 ? `/things?page=${page + 1}` : null });
      },
      {},
    );
    expect(result.pagination).toBeNull();
    expect(result.note).toMatch(/one record/);
    expect(asked).toHaveLength(1);
  });
});

describe("pages numbered from 0", () => {
  const all = rows(64);
  const zeroBased = (request: BenchRequest) => {
    const page = Number(request.url.searchParams.get("page") ?? 0);
    const size = Math.min(50, Number(request.url.searchParams.get("size") ?? 20));
    return json({ content: all.slice(page * size, (page + 1) * size) });
  };

  it("are read from 0: a rule whose first page is the API's second is never kept", async () => {
    const { result } = await probe("api.zero.bench.test", zeroBased, {
      rowsPath: "$.content",
      params: [{ name: "page", in: "query", type: "number" }],
    });
    expect(result.pagination).toMatchObject({ kind: "page", param: "page", startsAt: 0 });
    /* Every record, the first twenty included. */
    expect(result).toMatchObject({ level: "traversed", rows: 64 });
  });

  it("are read from 0 at the size the endpoint declares, too", async () => {
    const { result } = await probe("api.zerosized.bench.test", zeroBased, {
      rowsPath: "$.content",
      params: [
        { name: "page", in: "query", type: "number" },
        { name: "size", in: "query", type: "number" },
      ],
    });
    expect(result.pagination).toMatchObject({ kind: "page", startsAt: 0, limitParam: "size" });
    expect(result.rows).toBe(64);
  });
});

describe("the last record's id as the cursor", () => {
  it("is tried where a cursor parameter is declared and the answer holds no cursor", async () => {
    const all = rows(33);
    const { result } = await probe(
      "api.keyset.bench.test",
      (request) => {
        const after = request.url.searchParams.get("starting_after");
        const start = after ? all.findIndex((one) => one.id === after) + 1 : 0;
        return json({ data: all.slice(start, start + 10) });
      },
      { rowsPath: "$.data", params: [{ name: "starting_after", in: "query", type: "string" }] },
    );
    expect(result.pagination).toEqual({ kind: "cursor", param: "starting_after", cursorPath: "$.data[last].id" });
    expect(result).toMatchObject({ level: "traversed", rows: 33 });
  });
});

describe("parameters nothing declared", () => {
  const all = rows(58);

  it("are tried by their usual names when the answer says there is more, and kept only when they advance", async () => {
    const { result } = await probe(
      "api.undeclared.bench.test",
      (request) => {
        const page = Math.max(1, Number(request.url.searchParams.get("page") ?? 1));
        return json({ items: all.slice((page - 1) * 25, page * 25), total: all.length });
      },
      { rowsPath: "$.items" },
    );
    expect(result.pagination).toMatchObject({ kind: "page", param: "page", startsAt: 1 });
    expect(result).toMatchObject({ level: "count-reconciled", rows: 58 });
  });

  it("install nothing on an API that ignores them, and say how many records it holds", async () => {
    const { result } = await probe("api.ignores.bench.test", () => json({ items: all.slice(0, 25), total: all.length }), { rowsPath: "$.items" });
    expect(result.pagination).toBeNull();
    expect(result.note).toMatch(/holds 58 records, but no way of reading past the first 25 worked/);
  });

  it("are not tried at all when nothing says there is more", async () => {
    const { result, asked } = await probe("api.quiet.bench.test", () => json({ items: all.slice(0, 25) }), { rowsPath: "$.items" });
    expect(result.pagination).toBeNull();
    expect(asked.some((url) => /[?&](page|offset)=/.test(url))).toBe(false);
  });
});

describe("an answer that is only an error, whatever its status", () => {
  const readOnce = async (body: unknown) => {
    const provider: MockProvider = { ...ledgerly, id: "errs", hosts: ["api.errs.bench.test"], handle: () => json(body) };
    const connection = connectionSchema.parse({
      id: "errs",
      title: "Errs",
      kind: "rest",
      baseUrl: "https://api.errs.bench.test",
      ops: [{ id: "things", title: "Things", path: "/things" }],
    });
    return tryRead(connection, "things", { http: benchTransport([provider]).http, resolveSecret: async () => null, now: () => NOW, budget: budgetOf(5) });
  };

  it("is a failed read, said in the answer's own words: never a record to build on", async () => {
    /* What an XML API answers with a 200, read as XML. */
    const xml = await readOnce({ ErrorResponse: { messages: { resultCode: "Error", message: { code: "E00007", text: "Authentication failed." } } } });
    expect(xml).toMatchObject({ kind: "failed", said: "Authentication failed." });
    expect(await readOnce({ success: false, message: "Unknown method." })).toMatchObject({ kind: "failed", said: "Unknown method." });
    expect(await readOnce({ error: { code: 12, description: "No such report." } })).toMatchObject({ kind: "failed", said: "No such report." });
  });

  it("is not a record that failed, an empty error field, or an answer with records in it", async () => {
    expect((await readOnce({ id: "pay_1", amount: 12, status: "failed", message: "Card declined." })).kind).toBe("ok");
    expect((await readOnce({ error: null })).kind).toBe("ok");
    expect((await readOnce({ status: "error", message: "partial", data: [{ id: 1 }] })).kind).not.toBe("failed");
  });
});

describe("larger pages through a next address", () => {
  it("asks for a hundred where the address says twenty, when the API holds more than the most pages a read takes", async () => {
    const all = rows(1351);
    const { result } = await probe(
      "api.pages.bench.test",
      (request) => {
        const offset = Number(request.url.searchParams.get("offset") ?? 0);
        const limit = Math.min(100, Number(request.url.searchParams.get("limit") ?? 20));
        const after = offset + limit;
        return json({
          count: all.length,
          next: after < all.length ? `https://api.pages.bench.test/things?offset=${after}&limit=${limit}` : null,
          results: all.slice(offset, after),
        });
      },
      { rowsPath: "$.results" },
      { traverseUpTo: 20 },
    );
    expect(result.pagination).toEqual({ kind: "offset", param: "offset", limitParam: "limit", pageSize: 100 });
    expect(result).toMatchObject({ level: "count-reconciled", rows: 1351 });
  });
});

describe("a next address with a token and a size", () => {
  it("is followed at a hundred a page, the size sent with the first request from then on", async () => {
    const all = rows(1351);
    const token = (at: number) => Buffer.from(`at:${at}`).toString("base64url");
    const { result } = await probe(
      "api.tokens.bench.test",
      (request) => {
        const raw = request.url.searchParams.get("cursor");
        const at = raw ? Number(Buffer.from(raw, "base64url").toString().slice(3)) : 0;
        const size = Math.min(100, Number(request.url.searchParams.get("limit") ?? 20));
        const after = at + size;
        return json({ total: all.length, items: all.slice(at, after), next: after < all.length ? `/things?cursor=${token(after)}&limit=${size}` : null });
      },
      { rowsPath: "$.items" },
      { traverseUpTo: 20 },
    );
    expect(result.pagination).toEqual({ kind: "next-url", path: "$.next" });
    expect(result.query).toEqual({ limit: "100" });
    expect(result).toMatchObject({ level: "count-reconciled", rows: 1351 });
  });
});

/* Regression (trackwell mock API): the answer handed back `nextPageToken`, and nothing tried sending it. */
describe("a token the answer hands back under a parameter's own name", () => {
  const all = rows(130);
  const tokenOf = (start: number) => Buffer.from(JSON.stringify({ o: start }), "utf8").toString("base64url");

  it("is sent back as that parameter, to the end, and every record is handed over", async () => {
    const { result } = await probe(
      "api.tokened.test",
      (request) => {
        const token = request.url.searchParams.get("nextPageToken");
        const start = token ? (JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { o: number }).o : 0;
        const page = all.slice(start, start + 50);
        const end = start + page.length;
        return json({ issues: page, isLast: end >= all.length, ...(end < all.length ? { nextPageToken: tokenOf(end) } : {}) });
      },
      { rowsPath: "$.issues", params: [{ name: "nextPageToken", in: "query" }] },
    );
    expect(result.pagination).toMatchObject({ kind: "cursor", param: "nextPageToken", cursorPath: "$.nextPageToken" });
    expect(result).toMatchObject({ level: "traversed", rows: 130 });
    expect(result.records).toHaveLength(130);
  });
});
