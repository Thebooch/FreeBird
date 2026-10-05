import type { ConnectionSpec, OpSpec, ResolvedParams } from "@freebirdai/connect-spec";
import { connectionSchema, getOp, graphqlReadsOnly, resolveRange } from "@freebirdai/connect-spec";
import { describe, expect, it } from "vitest";
import { fillTemplate, locateInputs, setQueryValue } from "./request.js";
import { RestAdapter, type HttpFetch, type HttpResponse } from "./rest.js";
import type { FetchContext } from "./types.js";

/**
 * Reads that are not a plain GET: a body, paging inside it, inputs that live
 * in headers and cookies, lists on the query string, and a stated total.
 */

const NOW = Date.UTC(2026, 8, 1);
const params = (filters: Record<string, string | number | boolean> = {}): ResolvedParams => ({
  range: resolveRange({ preset: "30d", now: NOW }),
  filters,
});
const ctx = (filters: Record<string, string | number | boolean> = {}): FetchContext => ({
  now: NOW,
  params: params(filters),
  resolveSecret: async () => "tok",
});

interface Sent {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
  purpose?: string;
}

const server = (answer: (sent: Sent) => { body: unknown; headers?: Record<string, string> }) => {
  const sent: Sent[] = [];
  const http: HttpFetch = async (url, init) => {
    const one: Sent = {
      url,
      method: init.method ?? "GET",
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.purpose ? { purpose: init.purpose } : {}),
    };
    sent.push(one);
    const reply = answer(one);
    const response: HttpResponse = {
      status: 200,
      text: JSON.stringify(reply.body),
      url,
      header: (name) => reply.headers?.[name.toLowerCase()] ?? null,
    };
    return response;
  };
  return { http, sent };
};

const connection = (op: Record<string, unknown>): ConnectionSpec =>
  connectionSchema.parse({
    id: "api",
    title: "API",
    kind: "rest",
    baseUrl: "https://api.example.com",
    auth: { type: "bearer", keyRef: "k" },
    ops: [{ id: "op", title: "Op", ...op }],
  });
const op = (conn: ConnectionSpec): OpSpec => getOp(conn, "op")!;

describe("a read sent with POST", () => {
  const search = connection({
    method: "POST",
    path: "/deals/search",
    rowsPath: "$.results",
    body: { type: "json", template: { filter: { stage: "{{param.stage}}" }, page: { size: 2 } } },
    readSafety: { basis: "docs-inferred", note: "named searchDeals; returns a list" },
    pagination: { kind: "cursor", param: "page.after", cursorPath: "$.paging.next.after", in: "body" },
    maxPages: 10,
    params: [{ name: "stage", in: "body", type: "string" }],
  });

  it("sends its body, pages inside it, and says it is a read", async () => {
    const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    const { http, sent } = server((request) => {
      const body = JSON.parse(request.body ?? "{}") as { page?: { after?: number } };
      const start = Number(body.page?.after ?? 0);
      return { body: { results: rows.slice(start, start + 2), paging: start + 2 < rows.length ? { next: { after: start + 2 } } : {} } };
    });
    const result = await new RestAdapter(http).fetch(search, op(search), { stage: "won" }, ctx());
    expect((result.body as { results: unknown[] }).results).toHaveLength(5);
    expect(sent).toHaveLength(3);
    expect(sent.every((one) => one.method === "POST" && one.purpose === "read")).toBe(true);
    expect(JSON.parse(sent[0]!.body!)).toEqual({ filter: { stage: "won" }, page: { size: 2 } });
    expect(JSON.parse(sent[1]!.body!)).toEqual({ filter: { stage: "won" }, page: { size: 2, after: 2 } });
    expect(sent[0]!.headers["content-type"]).toBe("application/json");
  });

  it("leaves out a filter nobody set, rather than filtering by nothing", async () => {
    const { http, sent } = server(() => ({ body: { results: [] } }));
    await new RestAdapter(http).fetch(search, op(search), {}, ctx());
    expect(JSON.parse(sent[0]!.body!)).toEqual({ filter: {}, page: { size: 2 } });
  });

  it("is refused without saying why it reads", () => {
    const parsed = connectionSchema.safeParse({
      id: "api",
      title: "API",
      kind: "rest",
      baseUrl: "https://api.example.com",
      ops: [{ id: "op", title: "Op", method: "POST", path: "/x", body: { type: "json", template: {} } }],
    });
    expect(parsed.success).toBe(false);
  });

  it("is refused as a GraphQL read when the document can change something", () => {
    expect(graphqlReadsOnly("{ deals { id } }")).toBe(true);
    expect(graphqlReadsOnly("query Deals($after: String) { deals(after: $after) { id } }")).toBe(true);
    expect(graphqlReadsOnly('mutation { closeDeal(id: "1") { id } }')).toBe(false);
    expect(graphqlReadsOnly("query A { a }\nmutation B { b }")).toBe(false);
    // A keyword inside a string or a comment is not an operation.
    expect(graphqlReadsOnly('# mutation here\nquery { search(text: "mutation") { id } }')).toBe(true);
    const parsed = connectionSchema.safeParse({
      id: "api",
      title: "API",
      kind: "rest",
      baseUrl: "https://api.example.com",
      ops: [
        {
          id: "op",
          title: "Op",
          method: "POST",
          path: "/graphql",
          body: { type: "graphql", query: "mutation { wipe }" },
          readSafety: { basis: "graphql-query" },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("puts GraphQL paging in the variables", async () => {
    const graph = connection({
      method: "POST",
      path: "/graphql",
      rowsPath: "$.data.deals.nodes",
      body: { type: "graphql", query: "query D($after: String) { deals(after: $after) { nodes { id } pageInfo { endCursor hasNextPage } } }" },
      readSafety: { basis: "graphql-query" },
      pagination: {
        kind: "cursor",
        param: "after",
        cursorPath: "$.data.deals.pageInfo.endCursor",
        hasMorePath: "$.data.deals.pageInfo.hasNextPage",
        in: "body",
      },
      maxPages: 5,
    });
    const { http, sent } = server((request) => {
      const after = (JSON.parse(request.body!) as { variables: { after?: string } }).variables.after;
      return after
        ? { body: { data: { deals: { nodes: [{ id: 2 }], pageInfo: { endCursor: "z", hasNextPage: false } } } } }
        : { body: { data: { deals: { nodes: [{ id: 1 }], pageInfo: { endCursor: "c1", hasNextPage: true } } } } };
    });
    const result = await new RestAdapter(http).fetch(graph, op(graph), {}, ctx());
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]!.body!).variables).toEqual({ after: "c1" });
    expect(result.meta.pages).toBe(2);
  });
});

describe("inputs that are not on the query string", () => {
  it("sends header and cookie parameters, and their documented defaults", async () => {
    const conn = connection({
      path: "/things",
      params: [
        { name: "Api-Version", in: "header", type: "string", default: "2024-06-01" },
        { name: "workspace", in: "cookie", type: "string" },
      ],
    });
    const { http, sent } = server(() => ({ body: [] }));
    await new RestAdapter(http).fetch(conn, op(conn), { workspace: "north side" }, ctx());
    expect(sent[0]!.headers["Api-Version"]).toBe("2024-06-01");
    expect(sent[0]!.headers.cookie).toBe("workspace=north%20side");
    expect(new URL(sent[0]!.url).search).toBe("");
  });

  it("writes a list the way its parameter says", () => {
    const list = (style?: "form" | "spaceDelimited" | "pipeDelimited", explode?: boolean) => {
      const query = new URLSearchParams();
      setQueryValue(query, "status", "open, paid", {
        name: "status",
        in: "query",
        type: "array",
        required: false,
        ...(style ? { style } : {}),
        ...(explode !== undefined ? { explode } : {}),
      });
      return query.toString();
    };
    expect(list()).toBe("status=open&status=paid");
    expect(list("form", false)).toBe("status=open%2Cpaid");
    expect(list("pipeDelimited")).toBe("status=open%7Cpaid");
  });

  it("sorts supplied values by where each goes", () => {
    const located = locateInputs(
      { params: [{ name: "v", in: "header", type: "string", required: false }, { name: "q", in: "body", type: "string", required: false }] },
      { v: "2", q: "x", other: "y" },
    );
    expect(located).toMatchObject({ header: { v: "2" }, body: { q: "x" }, query: { other: "y" } });
  });

  it("keeps a single token's own type in a body", () => {
    expect(fillTemplate({ size: "{{param.size}}", label: "top {{param.size}}" }, params({ size: 50 }))).toEqual({
      size: 50,
      label: "top 50",
    });
  });
});

describe("a stated total", () => {
  it("is read from the header an API puts it in", async () => {
    const conn = connection({ path: "/things" });
    const { http } = server(() => ({ body: [{ id: 1 }], headers: { "x-total-count": "380" } }));
    const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
    expect(result.meta.reportedTotal).toBe(380);
  });

  it("is read from the body where the endpoint says it is", async () => {
    const conn = connection({ path: "/things", rowsPath: "$.items", totalPath: "$.meta.total" });
    const { http } = server(() => ({ body: { items: [{ id: 1 }], meta: { total: 12431 } } }));
    const result = await new RestAdapter(http).fetch(conn, op(conn), {}, ctx());
    expect(result.meta.reportedTotal).toBe(12431);
  });
});
