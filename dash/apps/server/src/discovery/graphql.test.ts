import { catalogEntrySchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { graphqlReads, looksLikeSdl, parseIntrospection, parseSdl, withGraphqlReads } from "./graphql.js";

/*
 * A GraphQL API set up from its schema: the reads are written
 * from what the schema declares, the same way every time.
 */

const STORE_SDL = `"""A store's admin API."""
schema { query: QueryRoot }

"""An ISO-8601 date and time."""
scalar DateTime
scalar Decimal
enum Status { PAID PENDING REFUNDED }
directive @cost(weight: Int) on FIELD_DEFINITION

type QueryRoot {
  shop: Shop!
  order(id: ID!): Order
  "Orders, oldest first."
  orders(first: Int, after: String, query: String, reverse: Boolean = false): OrderConnection!
  customers(first: Int!, after: String): CustomerConnection!
  search(term: String!): [Order!]!
  tags: [String!]!
}

type Shop { id: ID! name: String! }

type OrderConnection { edges: [OrderEdge!]! nodes: [Order!]! pageInfo: PageInfo! }
type OrderEdge { cursor: String! node: Order! }
type CustomerConnection { edges: [CustomerEdge!]! pageInfo: PageInfo! totalCount: Int! }
type CustomerEdge { node: Customer! }
type PageInfo { hasNextPage: Boolean! endCursor: String }

type Order implements Node & Record @key(fields: "id") {
  id: ID!
  "When it was cancelled; null if it was not."
  cancelledAt: DateTime
  status: Status
  test: Boolean!
  tags: [String!]!
  totalPrice: Decimal! @deprecated(reason: "Use totalPriceSet.")
  totalPriceSet: MoneyBag!
  customer: Customer
  lines(first: Int): LineConnection!
}
type MoneyBag { shopMoney: Money! }
type Money { amount: Decimal! currencyCode: String! }
type Customer { id: ID! displayName: String! orders(first: Int): OrderConnection! }
type LineConnection { nodes: [Line!]! pageInfo: PageInfo! }
type Line { id: ID! }
`;

describe("a GraphQL schema, as SDL", () => {
  const schema = parseSdl(STORE_SDL)!;

  it("reads its types, fields, arguments, enums and deprecations", () => {
    expect(schema.queryType).toBe("QueryRoot");
    expect(schema.types.get("Status")?.values).toEqual(["PAID", "PENDING", "REFUNDED"]);
    const order = schema.types.get("Order")!;
    expect(order.fields.find((field) => field.name === "totalPrice")?.deprecated).toBe(true);
    expect(schema.types.get("QueryRoot")?.fields.find((field) => field.name === "orders")?.args.map((arg) => arg.name)).toEqual([
      "first",
      "after",
      "query",
      "reverse",
    ]);
    expect(looksLikeSdl(STORE_SDL)).toBe(true);
    expect(looksLikeSdl("<html><p>type Query is our favourite</p></html>")).toBe(false);
  });

  it("writes one query per list, paged by its cursor, with every plain field and the objects it carries", () => {
    const reads = graphqlReads(schema, { path: "/graphql.json" });
    const orders = reads.ops.find((op) => op.id === "orders")!;
    expect(orders).toMatchObject({
      method: "POST",
      path: "/graphql.json",
      title: "Orders, oldest first.",
      readSafety: { basis: "graphql-query" },
      rowsPath: "$.data.orders.nodes",
      pagination: {
        kind: "cursor",
        param: "after",
        cursorPath: "$.data.orders.pageInfo.endCursor",
        hasMorePath: "$.data.orders.pageInfo.hasNextPage",
        in: "body",
      },
    });
    expect(orders.body).toMatchObject({ type: "graphql" });
    const query = orders.body?.type === "graphql" ? orders.body.query : "";
    expect(query).toContain("orders(first: 100, after: $after)");
    expect(query).toContain("totalPriceSet { shopMoney { amount currencyCode } }");
    expect(query).toContain("customer { id displayName }");
    /* Deprecated, a nested connection, and a cycle back to orders: none selected. */
    expect(query).not.toContain("totalPrice ");
    expect(query).not.toContain("lines");
    expect(orders.fields?.map((field) => field.name)).toEqual([
      "id",
      "cancelledAt",
      "status",
      "test",
      "tags",
      "totalPriceSet.shopMoney.amount",
      "totalPriceSet.shopMoney.currencyCode",
      "customer.id",
      "customer.displayName",
    ]);
    expect(orders.fields?.find((field) => field.name === "cancelledAt")).toMatchObject({ format: "iso8601", nullable: true });
    expect(orders.fields?.find((field) => field.name === "status")?.values).toEqual(["PAID", "PENDING", "REFUNDED"]);
    /* It is a catalog entry's op as written. */
    expect(() => catalogEntrySchema.parse({ id: "s", title: "S", baseUrl: "https://s.test", dialect: { auth: { type: "none" }, pagination: { kind: "none" } }, ops: reads.ops, resources: reads.resources })).not.toThrow();
  });

  it("pages through edges where there are no nodes, counts where the connection says, and keeps what needs an input as an input", () => {
    const reads = graphqlReads(schema, { path: "/graphql" });
    const customers = reads.ops.find((op) => op.id === "customers")!;
    expect(customers.rowsPath).toBe("$.data.customers.edges[*].node");
    expect(customers.totalPath).toBe("$.data.customers.totalCount");
    expect(reads.ops.map((op) => op.id)).toEqual(["orders", "customers", "search"]);
    expect(reads.skipped).toEqual([]);
    /* An argument it insists on is the read's input, filled into the query's variables. */
    const search = reads.ops.find((op) => op.id === "search")!;
    expect(search.params).toEqual([{ name: "term", in: "body", type: "string", required: true }]);
    expect(search.body).toMatchObject({ type: "graphql", variables: { term: "{{param.term}}" } });
    expect((search.body as { query: string }).query).toMatch(/query DashSearch\(\$term: String!\) \{ search\(term: \$term\)/);
    expect(reads.resources.map((one) => [one.id, one.listOp])).toEqual([
      ["order", "orders"],
      ["customer", "customers"],
    ]);
  });
});

describe("a GraphQL schema, by introspection", () => {
  const ref = (kind: string, name: string | null, ofType: unknown = null) => ({ kind, name, ofType });
  const answer = {
    data: {
      __schema: {
        queryType: { name: "Query" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              {
                name: "characters",
                isDeprecated: false,
                args: [
                  { name: "page", defaultValue: null, type: ref("SCALAR", "Int") },
                  { name: "filter", defaultValue: null, type: ref("INPUT_OBJECT", "FilterCharacter") },
                ],
                type: ref("OBJECT", "Characters"),
              },
            ],
          },
          {
            kind: "OBJECT",
            name: "Characters",
            fields: [
              { name: "info", isDeprecated: false, args: [], type: ref("OBJECT", "Info") },
              { name: "results", isDeprecated: false, args: [], type: ref("LIST", null, ref("OBJECT", "Character")) },
            ],
          },
          {
            kind: "OBJECT",
            name: "Info",
            fields: [
              { name: "count", isDeprecated: false, args: [], type: ref("SCALAR", "Int") },
              { name: "next", isDeprecated: false, args: [], type: ref("SCALAR", "Int") },
            ],
          },
          {
            kind: "OBJECT",
            name: "Character",
            fields: [
              { name: "id", isDeprecated: false, args: [], type: ref("SCALAR", "ID") },
              { name: "status", isDeprecated: false, args: [], type: ref("SCALAR", "String") },
            ],
          },
          { kind: "INPUT_OBJECT", name: "FilterCharacter", fields: null },
          { kind: "OBJECT", name: "__Schema", fields: [] },
        ],
      },
    },
  };

  it("reads the same model, and pages a wrapped list by its page argument, counted by its info", () => {
    const schema = parseIntrospection(answer)!;
    expect(schema.queryType).toBe("Query");
    expect(schema.types.has("__Schema")).toBe(false);
    const [characters] = graphqlReads(schema, { path: "/graphql" }).ops;
    expect(characters).toMatchObject({
      id: "characters",
      rowsPath: "$.data.characters.results",
      totalPath: "$.data.characters.info.count",
      pagination: { kind: "page", param: "page", startsAt: 1, in: "body" },
    });
    expect(characters!.body?.type === "graphql" && characters!.body.query).toBe(
      "query DashCharacters($page: Int) { characters(page: $page) { results { id status } info { count } } }",
    );
    expect(parseIntrospection({ data: {} })).toBeNull();
  });
});

describe("a GraphQL schema the documentation publishes", () => {
  const entry = catalogEntrySchema.parse({
    id: "store",
    title: "Store",
    /* The prose read settled on the endpoint itself as the address. */
    baseUrl: "https://api.store.test/admin/2026-07/graphql.json",
    dialect: { auth: { type: "header", header: "X-Token", keyRef: "store-token" }, pagination: { kind: "none" } },
    ops: [{ id: "list", title: "List records", path: "/" }],
    resources: [{ id: "record", title: "Records", listOp: "list" }],
  });
  const page = {
    url: "https://developer.store.test/docs/admin",
    html: `<h1>Admin API</h1><pre>POST https://api.store.test/admin/2026-07/graphql.json</pre><p>The schema is at <a href="/docs/admin/schema.graphql">schema.graphql</a>.</p>`,
  };

  it("replaces the prose guess with reads written from it, at the endpoint's own address", async () => {
    const asked: string[] = [];
    const found = await withGraphqlReads(entry, page, async (url) => {
      asked.push(url);
      return { status: 200, text: STORE_SDL, url };
    });
    expect(asked).toEqual(["https://developer.store.test/docs/admin/schema.graphql"]);
    expect(found?.entry.baseUrl).toBe("https://api.store.test/admin/2026-07");
    expect(found?.entry.ops.map((op) => [op.id, op.path])).toEqual([
      ["orders", "/graphql.json"],
      ["customers", "/graphql.json"],
      ["search", "/graphql.json"],
    ]);
    expect(found?.entry.resources.map((one) => one.id)).toEqual(["order", "customer"]);
    /* Sign-in is the prose read's, kept. */
    expect(found?.entry.dialect.auth).toMatchObject({ type: "header", header: "X-Token" });
    expect(found?.warnings).toEqual([]);
  });

  it("reads a schema written into the page, and says nothing when there is none", async () => {
    const inline = { url: page.url, html: `<pre>POST https://api.store.test/admin/2026-07/graphql.json</pre><pre>${STORE_SDL.replace(/</g, "&lt;")}</pre>` };
    expect((await withGraphqlReads(entry, inline, async () => ({ status: 404, text: "", url: "" })))?.entry.ops).toHaveLength(3);
    expect(await withGraphqlReads(entry, { url: page.url, html: "<p>No schema here.</p>" }, async () => ({ status: 404, text: "", url: "" }))).toBeNull();
  });
});

