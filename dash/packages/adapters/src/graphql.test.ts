import { describe, expect, it, vi } from "vitest";
import { connectionSchema, getOp, resolveRange } from "@freebirdai/dash-spec";
import { buildSchema } from "graphql";
import { GraphqlAdapter, validateGraphqlRead, type GraphqlHttpFetch } from "./graphql.js";

const schema = `type Item { id: ID!, title: String! } type Page { items: [Item!]!, next: String, more: Boolean! }
  type Query { items(first: Int!, after: String): Page! item(id: ID!): Item }
  type Mutation { remove(id: ID!): Boolean! }`;
const document = `query List($first: Int!, $after: String) { items(first: $first, after: $after) { items { id title } next more } }`;
const connection = () => connectionSchema.parse({ id: "example", title: "Example", kind: "graphql", baseUrl: "https://example.com/graphql", graphqlSchema: schema,
  auth: { type: "bearer", keyRef: "key" }, ops: [{ id: "list", title: "Items", path: "/", rowsPath: "$.data.items.items", maxPages: 2,
    graphql: { document, variables: { first: 2 } }, pagination: { kind: "cursor", cursorPath: "$.data.items.next", hasMorePath: "$.data.items.more", param: "after" } }] });
const context = () => ({ now: 100, params: { range: resolveRange({ preset: "30d", now: 100 }), filters: {} }, resolveSecret: vi.fn(async () => "secret") });
const response = (data: unknown) => ({ status: 200, text: JSON.stringify(data), url: "https://example.com/graphql", header: () => null });

describe("GraphQL read adapter", () => {
  it("validates variables, applies auth and follows declared cursors", async () => {
    const http = vi.fn<GraphqlHttpFetch>().mockResolvedValueOnce(response({ data: { items: { items: [{ id: "1", title: "One" }], next: "c1", more: true } } }))
      .mockResolvedValueOnce(response({ data: { items: { items: [{ id: "2", title: "Two" }], next: null, more: false } } }));
    const c = connection();
    const result = await new GraphqlAdapter(http).fetch(c, getOp(c, "list")!, {}, context());
    expect(result.body).toMatchObject({ data: { items: { items: [{ id: "1" }, { id: "2" }] } } });
    expect(JSON.parse(http.mock.calls[1]![1].body).variables).toEqual({ first: 2, after: "c1" });
    expect(http.mock.calls[0]![1].headers.authorization).toBe("Bearer secret");
    expect(result.meta.truncated).toBe(false);
  });
  it("rejects mutations, including unused ones, before credentials or network", async () => {
    const c = connection();
    const op = getOp(c, "list")!;
    op.graphql!.document += ` mutation Remove($id: ID!) { remove(id: $id) }`;
    op.graphql!.operationName = "List";
    const ctx = context(); const http = vi.fn<GraphqlHttpFetch>();
    await expect(new GraphqlAdapter(http).fetch(c, op, {}, ctx)).rejects.toThrow("mutations");
    expect(http).not.toHaveBeenCalled();
    expect(ctx.resolveSecret).not.toHaveBeenCalled();
  });
  it("rejects invalid variable types and undeclared variables", async () => {
    const c = connection(); const http = vi.fn<GraphqlHttpFetch>();
    await expect(new GraphqlAdapter(http).fetch(c, getOp(c, "list")!, { first: "bad" }, context())).rejects.toThrow("Int");
    await expect(new GraphqlAdapter(http).fetch(c, getOp(c, "list")!, { unexpected: 2 }, context())).rejects.toThrow("undeclared");
    expect(http).not.toHaveBeenCalled();
  });
  it("does not claim complete data after GraphQL field errors", async () => {
    const c = connection();
    const http = vi.fn<GraphqlHttpFetch>().mockResolvedValue(response({ data: { items: { items: [{ id: "1" }], more: true } }, errors: [{ message: "Private provider detail" }] }));
    const result = await new GraphqlAdapter(http).fetch(c, getOp(c, "list")!, {}, context());
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.warnings.join(" ")).not.toContain("Private provider detail");
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("accounts for fragment expansion and rejects schema-invalid fields", () => {
    expect(() => validateGraphqlRead(buildSchema(schema), document, undefined, 2, 100)).toThrow("depth");
    expect(() => validateGraphqlRead(buildSchema(schema), document, undefined, 8, 2)).toThrow("complexity");
    expect(() => validateGraphqlRead(buildSchema(schema), `{ unknown }`, undefined, 8, 100)).toThrow("unknown");
  });
});
