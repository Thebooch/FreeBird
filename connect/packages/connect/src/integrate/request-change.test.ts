import { connectionSchema, getOp, resolveRange, type ConnectionSpec } from "@freebirdai/connect-spec";
import { RestAdapter, type HttpFetch } from "../adapters/index.js";
import { describe, expect, it } from "vitest";
import { applyPatch } from "./patch.js";
import { requestChange } from "./request-change.js";
import { methodStrategy } from "./strategies.js";

/*
 * A repair that edits the request itself — method, path, body, GraphQL
 * document, how a list is written — held to the documentation and to the
 * account's writes.
 */

const NOW = Date.UTC(2026, 8, 30);
const connection = (op: Record<string, unknown>): ConnectionSpec =>
  connectionSchema.parse({
    id: "c",
    title: "Request API",
    kind: "rest",
    baseUrl: "https://api.request.test/v1",
    auth: { type: "none" },
    ops: [{ id: "orders", title: "Orders", path: "/orders", rowsPath: "$.data", ...op }],
  });
const ground = [
  "POST /orders/search with a JSON body { status } finds orders.",
  "POST /graphql answers queries: salesOrders { nodes { id total } }.",
  "POST /orders creates an order.",
  "GET /orders?status=open,paid takes statuses separated by commas.",
].join("\n");
const writes = [{ method: "POST", path: "/orders" }];

describe("a repair to the request", () => {
  it("moves a read to the POST and body the documentation gives, saying why it reads", () => {
    const base = connection({});
    const asked = requestChange({ method: "POST", path: "/orders/search", bodyType: "json", body: '{"status": ""}' }, base, "orders", { ground, writes });
    expect(asked && "change" in asked).toBe(true);
    const next = applyPatch(base, { ops: { orders: (asked as { change: object }).change } });
    const op = getOp(next!, "orders")!;
    expect(op).toMatchObject({ method: "POST", path: "/orders/search", body: { type: "json", template: { status: "" } }, readSafety: { basis: "docs-inferred" } });
  });

  it("replaces a GraphQL document with the one the API answers, as a query by protocol", () => {
    const base = connection({
      method: "POST",
      path: "/graphql",
      body: { type: "graphql", query: "query { orders { nodes { id total } } }", variables: {} },
      readSafety: { basis: "graphql-query" },
      rowsPath: "$.data.orders.nodes",
    });
    const asked = requestChange({ bodyType: "graphql", body: "query { salesOrders { nodes { id total } } }" }, base, "orders", { ground, writes });
    const next = applyPatch(base, { ops: { orders: { ...(asked as { change: object }).change, rowsPath: "$.data.salesOrders.nodes" } } });
    expect(getOp(next!, "orders")).toMatchObject({ body: { type: "graphql", query: "query { salesOrders { nodes { id total } } }" }, readSafety: { basis: "graphql-query" } });
    /* A mutation never passes as a read, whoever writes it. */
    expect(applyPatch(base, { ops: { orders: { body: { type: "graphql", query: "mutation { deleteOrders }", variables: {} } } } })).toBeNull();
  });

  it("writes a list the way the API reads it", async () => {
    const base = connection({ params: [{ name: "status", in: "query", type: "array" }] });
    const asked = requestChange({ lists: [{ name: "status", style: "form", explode: false }] }, base, "orders", { ground, writes });
    const next = applyPatch(base, { ops: { orders: (asked as { change: object }).change } })!;
    const sent: string[] = [];
    const http: HttpFetch = async (url) => {
      sent.push(url);
      return { status: 200, text: '{"data":[]}', url, header: () => "application/json" };
    };
    await new RestAdapter(http).fetch(next, getOp(next, "orders")!, { status: "open,paid" }, {
      params: { range: resolveRange({ preset: "30d", now: NOW }), filters: {} },
      now: NOW,
    });
    expect(decodeURIComponent(sent[0]!)).toContain("status=open,paid");
  });

  it("refuses a path the documentation never names, a POST to one of the account's changes, and a GET with a body", () => {
    const base = connection({});
    expect(requestChange({ path: "/admin/orders/export" }, base, "orders", { ground, writes })).toEqual({
      refused: "/admin/orders/export is not a path the documentation names",
    });
    expect(requestChange({ method: "POST", path: "/orders", bodyType: "json", body: "{}" }, base, "orders", { ground, writes })).toEqual({
      refused: "POST /orders is an endpoint that changes things in the account",
    });
    expect(requestChange({ method: "GET", bodyType: "json", body: "{}" }, base, "orders", { ground, writes })).toEqual({ refused: "a GET sends no body" });
  });

  it("tries, by itself, the POST the specification reads a refused GET with — never one it describes as a create", async () => {
    const base = connection({});
    const op = getOp(base, "orders")!;
    const docs = (post: Record<string, unknown>) => ({
      text: async () => "",
      outline: async () => "",
      spec: async () => ({ paths: { "/orders": { get: { summary: "Orders" }, post } } }),
    });
    const refused = { kind: "notFound" as const, status: 405, message: "Orders: 405" };
    const search = await methodStrategy.propose({
      connection: base,
      op,
      attempt: refused,
      docs: docs({ summary: "Search orders", requestBody: { content: { "application/json": { example: { status: "open" } } } } }),
    });
    expect(search[0]?.patch.ops?.orders).toMatchObject({ method: "POST", body: { type: "json", template: { status: "open" } }, readSafety: { basis: "spec-declared" } });
    const create = await methodStrategy.propose({ connection: base, op, attempt: refused, docs: docs({ summary: "Create an order" }) });
    expect(create).toEqual([]);
  });

  it("drops a POST read's body and its basis when a repair moves it back to a GET", () => {
    const base = connection({ method: "POST", body: { type: "json", template: {} }, readSafety: { basis: "model-inferred" } });
    const next = applyPatch(base, { ops: { orders: { method: "GET" } } })!;
    const op = getOp(next, "orders")!;
    expect(op.method).toBe("GET");
    expect(op.body).toBeUndefined();
    expect(op.readSafety).toBeUndefined();
  });
});
