import { DEPENDENT_MAX, DependentAdapter, INCOMPLETE, RestAdapter } from "@freebirdai/dash-adapters";
import { connectionSchema, getOp, resolveRange } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { ledgerly } from "../bench/providers/ledgerly.js";
import { json } from "../bench/seed.js";
import { benchTransport } from "../bench/transport.js";
import type { MockProvider } from "../bench/types.js";
import { connectionFromCatalog } from "../catalog.js";
import { discover } from "../discovery/index.js";
import { integrate } from "./agent.js";
import { inputSources, namedInRequest } from "./inputs.js";
import { budgetOf, tryRead } from "./read.js";
import { seekRecords } from "./seek.js";

/*
 * An input no board gives, supplied by another list's records: settled by a
 * read, read once per record for a question about the whole account, and an
 * endpoint the documentation names that the import missed, found by the
 * request's own words.
 */

const NOW = Date.UTC(2026, 9, 1);

describe("a GraphQL list that needs an argument another list supplies", () => {
  const ref = (kind: string, name: string | null, ofType: unknown = null) => ({ kind, name, ofType });
  const field = (name: string, type: unknown, args: unknown[] = []) => ({ name, isDeprecated: false, args, type });
  const schema = {
    data: {
      __schema: {
        queryType: { name: "Query" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              field("organizations", ref("NON_NULL", null, ref("LIST", null, ref("OBJECT", "Organization")))),
              field("projects", ref("NON_NULL", null, ref("LIST", null, ref("OBJECT", "Project"))), [
                { name: "organizationId", defaultValue: null, type: ref("NON_NULL", null, ref("SCALAR", "ID")) },
              ]),
            ],
          },
          { kind: "OBJECT", name: "Organization", fields: [field("id", ref("SCALAR", "ID")), field("name", ref("SCALAR", "String"))] },
          {
            kind: "OBJECT",
            name: "Project",
            fields: [field("id", ref("SCALAR", "ID")), field("status", ref("SCALAR", "String")), field("budget", ref("SCALAR", "Int"))],
          },
        ],
      },
    },
  };
  const projects = Array.from({ length: 12 }, (_, index) => ({ id: `p${index + 1}`, status: index % 2 ? "active" : "paused", budget: 1000 + index }));
  const orgchart: MockProvider = {
    ...ledgerly,
    id: "orgchart",
    hosts: ["api.orgchart.bench.test"],
    handle: (request) => {
      const sent = JSON.parse(request.body ?? "{}") as { query?: string; variables?: Record<string, unknown> };
      if (sent.query?.includes("__schema")) return json(schema);
      if (sent.query?.includes("projects")) {
        if (sent.variables?.organizationId !== "org_7")
          return json({ errors: [{ message: "Argument organizationId of type ID! is required." }] });
        return json({ data: { projects } });
      }
      return json({ data: { organizations: [{ id: "org_7", name: "Acme" }] } });
    },
  };
  const connection = connectionSchema.parse({
    id: "orgchart",
    title: "Orgchart",
    kind: "rest",
    baseUrl: "https://api.orgchart.bench.test",
    ops: [{ id: "graphql", title: "The GraphQL endpoint", path: "/graphql" }],
    resources: [{ id: "record", title: "Records", listOp: "graphql" }],
  });

  it("keeps the list, settles the argument from the organisations list, and reads its projects", async () => {
    const transport = benchTransport([orgchart]);
    const deps = { http: transport.http, resolveSecret: async () => null, fetchDocument: transport.fetchDocument, now: () => NOW };
    const report = await integrate(connection, { targets: ["graphql"] }, deps);
    expect(report.connection.ops.map((op) => op.id)).toEqual(["organizations", "projects"]);
    const projectsOp = getOp(report.connection, "projects")!;
    expect(projectsOp.params.find((one) => one.name === "organizationId")).toMatchObject({
      default: "org_7",
      valueFrom: { op: "organizations", field: "id", each: false },
    });
    expect(report.ops.find((one) => one.op === "projects")?.outcome).toBe("ready");
    const read = await tryRead(report.connection, "projects", { ...deps, budget: budgetOf(10) });
    expect(read.rows).toHaveLength(12);
  });
});

describe("a question about every record another list holds", () => {
  const accounts = Array.from({ length: DEPENDENT_MAX + 10 }, (_, index) => ({ id: `a${index + 1}`, name: `Account ${index + 1}` }));
  const connection = connectionSchema.parse({
    id: "many",
    title: "Many",
    kind: "rest",
    baseUrl: "https://api.many.test",
    ops: [
      { id: "accounts", title: "Accounts", path: "/accounts", rowsPath: "$.data" },
      {
        id: "payments",
        title: "Payments",
        path: "/accounts/{{param.account}}/payments",
        rowsPath: "$.data",
        params: [{ name: "account", in: "path", required: true, valueFrom: { op: "accounts", field: "id", each: true } }],
      },
    ],
  });
  const http = async (url: string) => {
    const path = new URL(url).pathname;
    const owner = /^\/accounts\/([^/]+)\/payments$/.exec(path)?.[1];
    const text = JSON.stringify(owner ? { data: [{ id: `${owner}-1`, amount: 5 }] } : { data: accounts });
    return { status: 200, text, url, header: (name: string) => (name === "content-type" ? "application/json" : null) };
  };

  it("reads each, tags each record with what it was read under, and says when it could not read them all", async () => {
    const result = await new DependentAdapter(new RestAdapter(http)).fetch(connection, getOp(connection, "payments")!, {}, {
      params: { range: resolveRange({ preset: "30d", now: NOW }), filters: {} },
      now: NOW,
    });
    const rows = (result.body as { data: Array<{ account: string }> }).data;
    expect(rows).toHaveLength(DEPENDENT_MAX);
    expect(rows[0]).toMatchObject({ id: "a1-1", account: "a1" });
    expect(result.meta).toMatchObject({ truncated: true, completion: { state: "partial", reason: "each-capped" } });
    expect(result.meta.warnings).toContain(INCOMPLETE.dependentCap(DEPENDENT_MAX, DEPENDENT_MAX + 10, "Accounts"));
  });

  it("finds the list an input is named for, and the record a request names", () => {
    const bare = connectionSchema.parse({
      ...connection,
      ops: [connection.ops[0], { ...connection.ops[1], params: [{ name: "account_id", in: "query", required: true }], path: "/payments" }],
      resources: [{ id: "account", title: "Accounts", listOp: "accounts" }],
    });
    expect(inputSources(bare, "payments")).toEqual([{ param: "account_id", op: "accounts", field: "id" }]);
    expect(namedInRequest(accounts, "How much did Account 7 pay?")).toMatchObject({ id: "a7" });
    expect(namedInRequest(accounts, "How much was paid in total?")).toBeNull();
  });
});

/* Regression: the API says an input is required that its documentation never marked so. */
describe("an input the API's own answer says is required", () => {
  const payments = Array.from({ length: 9 }, (_, index) => ({ id: `pay_${index + 1}`, account_id: `acc_${(index % 3) + 1}`, amount: 10 }));
  const ledger: MockProvider = {
    ...ledgerly,
    id: "ledger",
    hosts: ["api.ledger.bench.test"],
    handle: (request) => {
      const { pathname, searchParams } = request.url;
      if (pathname === "/accounts") return json({ data: [{ id: "acc_1" }, { id: "acc_2" }, { id: "acc_3" }] });
      if (pathname === "/payments") {
        const account = searchParams.get("account_id");
        if (!account) return json({ error: "account_id is required: payments are listed one account at a time" }, 400);
        return json({ data: payments.filter((one) => one.account_id === account) });
      }
      return json({ error: "not found" }, 404);
    },
  };
  const connection = connectionSchema.parse({
    id: "ledger",
    title: "Ledger",
    kind: "rest",
    baseUrl: "https://api.ledger.bench.test",
    ops: [
      { id: "accounts", title: "List accounts", path: "/accounts", rowsPath: "$.data" },
      { id: "payments", title: "List payments", path: "/payments", rowsPath: "$.data", params: [{ name: "account_id", in: "query" }] },
    ],
    resources: [
      { id: "account", title: "Accounts", listOp: "accounts" },
      { id: "payment", title: "Payments", listOp: "payments" },
    ],
  });

  it("is required from then on, supplied by the list that holds it, and read for every one", async () => {
    const transport = benchTransport([ledger]);
    const deps = { http: transport.http, resolveSecret: async () => null, fetchDocument: transport.fetchDocument, now: () => NOW };
    const report = await integrate(connection, { targets: ["payments"] }, deps);
    expect(getOp(report.connection, "payments")!.params.find((one) => one.name === "account_id")).toMatchObject({
      required: true,
      valueFrom: { op: "accounts", field: "id", each: true },
    });
    expect(report.ops.find((one) => one.op === "payments")?.outcome).toBe("ready");
    const read = await tryRead(report.connection, "payments", { ...deps, budget: budgetOf(10) });
    expect(read.rows).toHaveLength(9);
  });
});

describe("records the import never took", () => {
  const charges = Array.from({ length: 30 }, (_, index) => ({ id: `ch_${index + 1}`, amount: 10 + index }));
  const billdesk: MockProvider = {
    ...ledgerly,
    id: "billdesk",
    hosts: ["api.billdesk.bench.test"],
    docsUrl: "https://api.billdesk.bench.test/openapi.json",
    handle: (request) => {
      const { pathname } = request.url;
      if (pathname === "/openapi.json")
        return json({
          openapi: "3.0.3",
          info: { title: "Billdesk", version: "1", description: "Every charge is listed at GET /v1/charges, newest first." },
          servers: [{ url: "https://api.billdesk.bench.test/v1" }],
          components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Key" } } },
          security: [{ key: [] }],
          paths: { "/customers": { get: { summary: "List customers", responses: { "200": { description: "Customers." } } } } },
        });
      if (pathname === "/v1/customers") return json({ data: [{ id: "c1" }, { id: "c2" }] });
      if (pathname === "/v1/charges") return json({ data: charges });
      return json({ error: "not found" }, 404);
    },
  };

  it("are found by the request's own words among the endpoints the documentation names, and kept once they answer", async () => {
    const transport = benchTransport([billdesk]);
    const found = await discover(billdesk.docsUrl, { fetchDocument: transport.fetchDocument, llm: null });
    const connection = connectionFromCatalog(found.entry!, { id: "billdesk" });
    expect(connection.ops.map((op) => op.path)).toEqual(["/customers"]);
    const sought = await seekRecords({
      connection,
      entry: found.entry!,
      request: "How much have charges brought in?",
      docsUrl: billdesk.docsUrl,
      deps: { http: transport.http, resolveSecret: async () => "bd_key", fetchDocument: transport.fetchDocument, now: () => NOW },
    });
    expect(sought?.added).toEqual(["charges"]);
    expect(sought?.connection.ops.map((op) => op.path)).toEqual(["/customers", "/charges"]);
    expect(sought?.entry.resources.map((one) => one.listOp)).toContain("charges");
  });
});
