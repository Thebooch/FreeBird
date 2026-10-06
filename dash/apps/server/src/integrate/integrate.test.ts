import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeLlm } from "@freebirdai/dash-agent";
import {
  authCredentials,
  catalogEntrySchema,
  connectionSchema,
  filterParamsOf,
  getOp,
  type ConnectionSpec,
  type Evidence,
} from "@freebirdai/dash-spec";
import { afterEach, describe, expect, it } from "vitest";
import { json } from "@freebirdai/connect-bench";
import { billhub } from "@freebirdai/connect-bench/providers/billhub";
import { casebook } from "@freebirdai/connect-bench/providers/casebook";
import { keyring } from "@freebirdai/connect-bench/providers/keyring";
import { ledgerly } from "@freebirdai/connect-bench/providers/ledgerly";
import { multicur } from "@freebirdai/connect-bench/providers/multicur";
import { rentroll } from "@freebirdai/connect-bench/providers/rentroll";
import { taskpad } from "@freebirdai/connect-bench/providers/taskpad";
import { benchTransport } from "@freebirdai/connect-bench";
import type { BenchRequest, MockProvider } from "../bench/types.js";
import {
  applyPatch,
  budgetOf,
  CatalogStore,
  connectionFromCatalog,
  discover,
  EVIDENCE_PER_OP,
  integrate,
  integrationTargets,
  KeyStore,
  LocalAesVault,
  MemoryEvidenceStore,
  MemorySeenValueStore,
  probePagination,
  sameSite,
  samplingTargets,
  siteOf,
  tryRead,
} from "@freebirdai/connect/host";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { DbEvidenceStore } from "@freebirdai/connect-postgres";
import { openDashDb } from "../platform/db.js";

/**
 * The integration loop, against the benchmark's dev-set providers.
 *
 * These are fixtures here, not the benchmark: each test pins one repair or
 * one paging rule the loop must find with nobody's help. The held-out
 * providers are deliberately absent — see `dash/bench/PROTOCOL.md`.
 */

const NOW = Date.UTC(2026, 8, 1);

/** Documentation to a connection with its secrets, the way a person would add it. */
const connected = async (provider: MockProvider) => {
  const transport = benchTransport([provider]);
  const found = await discover(provider.docsUrl, { fetchDocument: transport.fetchDocument, llm: null });
  const connection = connectionFromCatalog(found.entry!, { id: provider.id });
  const refs = [
    ...(connection.auth.type === "basic" && connection.auth.usernameRef ? [connection.auth.usernameRef] : []),
    ...("keyRef" in connection.auth ? [connection.auth.keyRef] : []),
  ];
  const secrets = Object.fromEntries(refs.map((ref, index) => [ref, provider.credentials[index]!]));
  return { transport, entry: found.entry!, connection, secrets };
};

const deps = (transport: ReturnType<typeof benchTransport>, secrets: Record<string, string>) => ({
  http: transport.http,
  resolveSecret: async (ref: string) => secrets[ref] ?? null,
  fetchDocument: transport.fetchDocument,
  now: () => NOW,
});

const firstOp = (connection: ConnectionSpec) => connection.ops[0]!.id;

describe("repairs the documentation got wrong", () => {
  it("finds the API's real address in the documentation's text", async () => {
    const { transport, entry, connection, secrets } = await connected(billhub);
    expect(connection.baseUrl).toContain("docs.billhub");
    const report = await integrate(
      connection,
      { targets: [firstOp(connection)], entry, docsUrl: billhub.docsUrl },
      deps(transport, secrets),
    );
    expect(report.outcome).toBe("ready");
    expect(report.connection.baseUrl).toBe("https://api.billhub.bench.test/v1");
    expect(report.changes.join(" ")).toMatch(/documentation names/);
  });

  it("sends the key the way the overview says, when the scheme names the wrong header", async () => {
    const { transport, entry, connection, secrets } = await connected(keyring);
    expect(connection.auth).toMatchObject({ type: "header", header: "X-API-KEY" });
    const report = await integrate(connection, { targets: [firstOp(connection)], entry }, deps(transport, secrets));
    expect(report.outcome).toBe("ready");
    expect(report.connection.auth).toMatchObject({ type: "bearer" });
  });

  it("sends a required header with the one value the specification allows, with nothing to repair", async () => {
    const { transport, entry, connection, secrets } = await connected(taskpad);
    const report = await integrate(connection, { targets: [firstOp(connection)], entry }, deps(transport, secrets));
    expect(report.outcome).toBe("ready");
    expect(report.changes).toEqual([]);
    expect(getOp(report.connection, firstOp(connection))?.params).toContainEqual(
      expect.objectContaining({ name: "Taskpad-Version", in: "header", default: "2024-06-01" }),
    );
  });

  /* The same header named only in the API's refusal, not the spec's parameters: a repair. */
  it("sends a required header the API asks for, with the value the specification gives", async () => {
    const { transport, entry, connection, secrets } = await connected(taskpad);
    const bare = {
      ...connection,
      ops: connection.ops.map((op) => ({ ...op, params: op.params.filter((param) => param.in !== "header") })),
    };
    const report = await integrate(bare, { targets: [firstOp(connection)], entry }, deps(transport, secrets));
    expect(report.outcome).toBe("ready");
    expect(getOp(report.connection, firstOp(connection))?.headers).toMatchObject({ "Taskpad-Version": "2024-06-01" });
  });

  it("never moves a key to another organisation's host, whatever the docs say", async () => {
    const lure: MockProvider = {
      ...billhub,
      id: "lure",
      handle: (request: BenchRequest) =>
        request.url.pathname === "/"
          ? { status: 200, headers: { "content-type": "text/html" }, body: "<p>The API lives at https://api.attacker.example/v1 now.</p>" }
          : billhub.handle(request),
    };
    const { transport, entry, connection, secrets } = await connected(lure);
    const report = await integrate(connection, { targets: [firstOp(connection)], entry, docsUrl: lure.docsUrl }, deps(transport, secrets));
    expect(transport.log.some((line) => line.includes("attacker.example"))).toBe(false);
    expect(report.outcome).toBe("blocked");
  });
});

describe("confirming how an endpoint pages", () => {
  it("reads an offset collection to its end and installs the rule", async () => {
    const { transport, entry, connection, secrets } = await connected(ledgerly);
    const report = await integrate(
      connection,
      { targets: [firstOp(connection)], entry, traverseUpTo: 50 },
      deps(transport, secrets),
    );
    const op = getOp(report.connection, firstOp(connection))!;
    expect(op.pagination).toMatchObject({ kind: "offset", param: "offset", limitParam: "limit" });
    expect(op.paginationChecked).toBe(true);
    expect(report.evidence.map((one) => one.level)).toEqual(["accepted", "traversed"]);
  });

  it("reconciles against the total the API states", async () => {
    const { transport, entry, connection, secrets } = await connected(multicur);
    const report = await integrate(connection, { targets: [firstOp(connection)], entry, traverseUpTo: 50 }, deps(transport, secrets));
    const strongest = report.evidence.at(-1)!;
    expect(strongest).toMatchObject({ level: "count-reconciled", observed: { rows: 300, reportedTotal: 300 } });
  });

  it("finds the real cursor when the proposal guessed the wrong field", async () => {
    const { transport, entry, connection, secrets } = await connected(rentroll);
    const report = await integrate(connection, { targets: [firstOp(connection)], entry, traverseUpTo: 50 }, deps(transport, secrets));
    expect(getOp(report.connection, firstOp(connection))?.pagination).toMatchObject({
      kind: "cursor",
      cursorPath: "$.meta.next",
    });
  });

  /*
   * The trap: asked for 100, the API returns its own cap of 25. Offset paging
   * reads a short page as the last one, so without the retry at the returned
   * size this would "complete" at 25 records and say nothing.
   */
  it("retries at the size the API really uses when it caps the page", async () => {
    const rows = Array.from({ length: 70 }, (_, index) => ({ id: index + 1 }));
    const capped: MockProvider = {
      ...ledgerly,
      id: "capped",
      hosts: ["api.capped.bench.test"],
      handle: (request) => {
        const offset = Number(request.url.searchParams.get("offset") ?? 0);
        const limit = Math.min(25, Number(request.url.searchParams.get("limit") ?? 25));
        return json({ data: rows.slice(offset, offset + limit) });
      },
    };
    const connection = connectionSchema.parse({
      id: "capped",
      title: "Capped",
      kind: "rest",
      baseUrl: "https://api.capped.bench.test",
      ops: [
        {
          id: "things",
          title: "Things",
          path: "/things",
          rowsPath: "$.data",
          params: [
            { name: "offset", in: "query", type: "number" },
            { name: "limit", in: "query", type: "number" },
          ],
        },
      ],
    });
    const transport = benchTransport([capped]);
    const probe = await probePagination(
      connection,
      "things",
      { http: transport.http, resolveSecret: async () => null, now: () => NOW, budget: budgetOf(40) },
      { proposal: { kind: "offset", param: "offset", limitParam: "limit", pageSize: 100 }, traverseUpTo: 10 },
    );
    expect(probe.pagination).toMatchObject({ kind: "offset", pageSize: 25 });
    expect(probe).toMatchObject({ level: "traversed", rows: 70 });
  });

  /* Regression: 10 of 332 facts were read, with `next_page_url` right there in the answer. */
  it("pages the way the answer's own next address does, where nothing declared how", async () => {
    const rows = Array.from({ length: 35 }, (_, index) => ({ id: index + 1 }));
    const laravel: MockProvider = {
      ...ledgerly,
      id: "laravel",
      hosts: ["api.laravel.bench.test"],
      handle: (request) => {
        const page = Number(request.url.searchParams.get("page") ?? 1);
        const last = Math.ceil(rows.length / 10);
        return json({
          current_page: page,
          data: rows.slice((page - 1) * 10, page * 10),
          next_page_url: page < last ? `https://api.laravel.bench.test/facts?page=${page + 1}` : null,
          total: rows.length,
        });
      },
    };
    const connection = connectionSchema.parse({
      id: "laravel",
      title: "Laravel",
      kind: "rest",
      baseUrl: "https://api.laravel.bench.test",
      ops: [{ id: "facts", title: "Facts", path: "/facts", rowsPath: "$.data", params: [{ name: "limit", in: "query", type: "number" }] }],
    });
    const probe = await probePagination(
      connection,
      "facts",
      { http: benchTransport([laravel]).http, resolveSecret: async () => null, now: () => NOW, budget: budgetOf(40) },
      { traverseUpTo: 10 },
    );
    expect(probe.pagination).toMatchObject({ kind: "page", param: "page" });
    expect(probe).toMatchObject({ level: "count-reconciled", rows: 35 });
  });

  /* Regression: 68 records at a hundred a page came back whole, and were reported as unreadable past twenty. */
  it("accepts a larger page that holds every record the API says it has", async () => {
    const rows = Array.from({ length: 68 }, (_, index) => ({ id: index + 1 }));
    const whole: MockProvider = {
      ...ledgerly,
      id: "whole",
      hosts: ["api.whole.bench.test"],
      handle: (request) => {
        const offset = Number(request.url.searchParams.get("offset") ?? 0);
        const limit = Number(request.url.searchParams.get("limit") ?? 20);
        return json({ count: rows.length, results: rows.slice(offset, offset + limit) });
      },
    };
    const connection = connectionSchema.parse({
      id: "whole",
      title: "Whole",
      kind: "rest",
      baseUrl: "https://api.whole.bench.test",
      ops: [
        {
          id: "things",
          title: "Things",
          path: "/things",
          rowsPath: "$.results",
          params: [
            { name: "offset", in: "query", type: "number" },
            { name: "limit", in: "query", type: "number" },
          ],
        },
      ],
    });
    const transport = benchTransport([whole]);
    const probe = await probePagination(
      connection,
      "things",
      { http: transport.http, resolveSecret: async () => null, now: () => NOW, budget: budgetOf(40) },
      { proposal: { kind: "offset", param: "offset", limitParam: "limit", pageSize: 100 }, traverseUpTo: 10 },
    );
    expect(probe.pagination).toMatchObject({ kind: "offset", pageSize: 100 });
    expect(probe).toMatchObject({ level: "count-reconciled", rows: 68, pages: 1 });
  });

  it("installs nothing when no rule reads a second page, and says only that the request was accepted", async () => {
    const same: MockProvider = {
      ...ledgerly,
      id: "same",
      hosts: ["api.same.bench.test"],
      handle: () => json({ data: Array.from({ length: 20 }, (_, index) => ({ id: index })) }),
    };
    const connection = connectionSchema.parse({
      id: "same",
      title: "Same",
      kind: "rest",
      baseUrl: "https://api.same.bench.test",
      ops: [{ id: "things", title: "Things", path: "/things", rowsPath: "$.data", params: [{ name: "page", in: "query", type: "number" }] }],
    });
    const transport = benchTransport([same]);
    const probe = await probePagination(connection, "things", {
      http: transport.http,
      resolveSecret: async () => null,
      now: () => NOW,
      budget: budgetOf(40),
    });
    expect(probe.pagination).toBeNull();
    expect(probe.level).toBe("accepted");
  });
});

/* Regression: the API could filter 11,848 breweries by state, and nothing asked it to. */
describe("filters the API offers", () => {
  const states = ["Oregon", "Ohio", "Texas"];
  const types = ["micro", "brewpub"];
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1,
    state: states[index % 3]!,
    brewery_type: types[index % 2]!,
  }));
  const breweries: MockProvider = {
    ...ledgerly,
    id: "breweries",
    hosts: ["api.breweries.bench.test"],
    handle: (request) => {
      const state = request.url.searchParams.get("by_state");
      /* `by_type` is documented, and ignored: a filter that does nothing must not be believed. */
      return json(state ? rows.filter((one) => one.state.toLowerCase() === state.toLowerCase()) : rows);
    },
  };
  const connection = connectionSchema.parse({
    id: "breweries",
    title: "Breweries",
    kind: "rest",
    baseUrl: "https://api.breweries.bench.test",
    ops: [
      {
        id: "list",
        title: "List breweries",
        path: "/breweries",
        params: [
          { name: "by_state", in: "query" },
          { name: "by_type", in: "query" },
          { name: "by_name", in: "query" },
        ],
      },
    ],
  });

  it("keeps a parameter only when every record it answers holds the value asked for", async () => {
    const transport = benchTransport([breweries]);
    const report = await integrate(
      connection,
      { targets: ["list"] },
      { http: transport.http, resolveSecret: async () => null, fetchDocument: transport.fetchDocument, now: () => NOW },
    );
    const params = report.connection.ops[0]!.params;
    expect(params.find((one) => one.name === "by_state")?.filters).toBe("state");
    expect(params.find((one) => one.name === "by_type")?.filters).toBeUndefined();
    /* No field it could filter: nothing to try, and no request spent on it. */
    expect(params.find((one) => one.name === "by_name")?.filters).toBeUndefined();
    expect(filterParamsOf(report.connection)("list", "state")).toBe("by_state");
  });
});

/* "how many" from the API's own count, kept only where a read agrees with it. */
describe("an endpoint that says how many", () => {
  const states = ["Oregon", "Ohio", "Texas"];
  const rows = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, state: states[index % 3]! }));
  /* `lie`: a meta endpoint whose number is not the list's. */
  const breweries = (lie = 0): MockProvider => ({
    ...ledgerly,
    id: "breweries",
    hosts: ["api.breweries.bench.test"],
    handle: (request) => {
      const state = request.url.searchParams.get("by_state");
      const held = state ? rows.filter((one) => one.state.toLowerCase() === state.toLowerCase()) : rows;
      if (request.url.pathname === "/breweries/meta") return json({ total: String(held.length + lie), per_page: "10" });
      const page = Number(request.url.searchParams.get("page") ?? "1");
      return json({ data: held.slice((page - 1) * 10, page * 10), total: held.length });
    },
  });
  const connection = connectionSchema.parse({
    id: "breweries",
    title: "Breweries",
    kind: "rest",
    baseUrl: "https://api.breweries.bench.test",
    ops: [
      {
        id: "list",
        title: "List breweries",
        path: "/breweries",
        rowsPath: "$.data",
        params: [
          { name: "page", in: "query", type: "number" },
          { name: "by_state", in: "query" },
        ],
        pagination: { kind: "page", param: "page", startsAt: 1, pageSize: 10 },
        totalPath: "$.total",
      },
      { id: "meta", title: "Brewery counts", path: "/breweries/meta", params: [{ name: "by_state", in: "query" }] },
    ],
    resources: [{ id: "brewery", title: "Breweries", listOp: "list" }],
  });
  const check = async (provider: MockProvider) => {
    const transport = benchTransport([provider]);
    return integrate(
      connection,
      { targets: ["list"] },
      { http: transport.http, resolveSecret: async () => null, fetchDocument: transport.fetchDocument, now: () => NOW },
    );
  };

  it("counts with it once its number is the list's, and under each filter that agrees", async () => {
    const report = await check(breweries());
    expect(report.connection.resources[0]?.count).toEqual({ op: "meta", field: "total", filters: ["by_state"] });
    /* One object, never pages: nothing on its tile warns of pages it never had. */
    expect(report.connection.ops.find((op) => op.id === "meta")).toMatchObject({
      pagination: { kind: "none" },
      paginationChecked: true,
    });
  });

  it("never keeps a count that disagrees with the records", async () => {
    const report = await check(breweries(3));
    expect(report.connection.resources[0]?.count).toBeUndefined();
  });

  /* 11,848 breweries are too many to read in a check, and the list states no total: Oregon's 295 are not. */
  it("checks a list too long to read whole through one filter's records, read to their end", async () => {
    const places = ["Oregon", "Ohio", "Texas", "Maine", "Utah"];
    const long = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, state: places[index % 5]! }));
    const untotalled = (lie = 0): MockProvider => ({
      ...breweries(),
      handle: (request) => {
        const state = request.url.searchParams.get("by_state");
        const held = state ? long.filter((one) => one.state.toLowerCase() === state.toLowerCase()) : long;
        if (request.url.pathname === "/breweries/meta") return json({ total: String(held.length + (state ? lie : 0)) });
        const page = Number(request.url.searchParams.get("page") ?? "1");
        return json({ data: held.slice((page - 1) * 10, page * 10) });
      },
    });
    const withoutTotal = connectionSchema.parse({
      ...connection,
      ops: connection.ops.map((op) => (op.id === "list" ? { ...op, totalPath: undefined } : op)),
    });
    const run = async (provider: MockProvider) => {
      const transport = benchTransport([provider]);
      return integrate(
        withoutTotal,
        { targets: ["list"] },
        { http: transport.http, resolveSecret: async () => null, fetchDocument: transport.fetchDocument, now: () => NOW },
      );
    };
    expect((await run(untotalled())).connection.resources[0]?.count).toEqual({
      op: "meta",
      field: "total",
      filters: ["by_state"],
    });
    /* A count the filtered records disagree with proves nothing. */
    expect((await run(untotalled(1))).connection.resources[0]?.count).toBeUndefined();
  });
});

/* Trackwell's outcome, generically: a search whose expression is required, written from the documentation. */
describe("values a read must send that nothing supplies", () => {
  const base = {
    id: "api",
    title: "API",
    kind: "rest",
    baseUrl: "https://api.example.test",
    auth: { type: "query", param: "api_key", keyRef: "k" },
  } as const;

  it("puts each where the endpoint takes it: the query, a parameter's default, the body it sends", () => {
    const connection = connectionSchema.parse({
      ...base,
      ops: [
        { id: "search", title: "Search", path: "/search", params: [{ name: "q", in: "query", required: true }] },
        {
          id: "posted",
          title: "Posted",
          method: "POST",
          path: "/find",
          body: { type: "json", template: { page: 1 } },
          readSafety: { basis: "docs-inferred" },
          params: [{ name: "since", in: "body", required: true }],
        },
        {
          id: "graph",
          title: "Graph",
          method: "POST",
          path: "/graphql",
          body: { type: "graphql", query: "query Q($q: String) { a(q: $q) { id } }", variables: {} },
          readSafety: { basis: "graphql-query" },
        },
      ],
    });
    const next = applyPatch(connection, {
      ops: {
        search: { inputs: { q: "created>=1970-01-01" } },
        posted: { inputs: { since: 0, scope: "all" } },
        graph: { inputs: { q: "*" } },
      },
    })!;
    const op = (id: string) => next.ops.find((one) => one.id === id)!;
    expect(op("search").query).toEqual({ q: "created>=1970-01-01" });
    expect(op("posted").params.find((one) => one.name === "since")?.default).toBe(0);
    expect(op("posted").body).toMatchObject({ type: "json", template: { page: 1, scope: "all" } });
    expect(op("graph").body).toMatchObject({ type: "graphql", variables: { q: "*" } });
  });

  it("reads a required search from the documentation's words, and never sends a template", async () => {
    const run = async (proposals: Record<string, unknown>[]) => {
      const transport = benchTransport([casebook]);
      const found = await discover(casebook.docsUrl, { fetchDocument: transport.fetchDocument, llm: null });
      const connection = connectionFromCatalog(found.entry!, { id: "casebook" });
      const secrets = Object.fromEntries(authCredentials(connection.auth).map((one) => [one.keyRef, casebook.credentials[0]!]));
      const sent: string[] = [];
      const report = await integrate(
        connection,
        { targets: [connection.ops[0]!.id], entry: found.entry!, docsUrl: casebook.docsUrl },
        {
          http: async (url, init, allowed) => {
            sent.push(url);
            return transport.http(url, init, allowed);
          },
          resolveSecret: async (ref: string) => secrets[ref] ?? null,
          fetchDocument: transport.fetchDocument,
          now: () => NOW,
          llm: fakeLlm(proposals.map((args) => ({ args }))),
        },
      );
      return { report, sent };
    };
    const good = await run([{ reason: "The documentation says opened>=1970-01-01 reads every case.", inputs: [{ name: "q", value: "opened>=1970-01-01" }] }]);
    expect(good.report.outcome).toBe("ready");
    expect(good.report.connection.ops[0]?.query).toEqual({ q: "opened>=1970-01-01" });
    expect(good.report.ops[0]?.note).toMatch(/380/);
    /* A value that is a template is not a value the documentation gave: refused, and nothing is sent with it. */
    const templated = await run([{ reason: "Send the key.", inputs: [{ name: "q", value: "{{secret:casebook-key}}" }] }]);
    expect(templated.report.outcome).toBe("blocked");
    expect(templated.report.log.join(" ")).toMatch(/A model proposed a change that is not allowed here/);
    expect(templated.sent.join(" ")).not.toMatch(/secret|%7B%7B/);
  });
});

/* A GraphQL endpoint read as REST is asked for its schema, and read through what it declares. */
describe("a GraphQL endpoint that describes its schema", () => {
  const ref = (kind: string, name: string | null, ofType: unknown = null) => ({ kind, name, ofType });
  const schema = {
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
                args: [{ name: "page", defaultValue: null, type: ref("SCALAR", "Int") }],
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
          { kind: "OBJECT", name: "Info", fields: [{ name: "count", isDeprecated: false, args: [], type: ref("SCALAR", "Int") }] },
          {
            kind: "OBJECT",
            name: "Character",
            fields: [
              { name: "id", isDeprecated: false, args: [], type: ref("SCALAR", "ID") },
              { name: "status", isDeprecated: false, args: [], type: ref("SCALAR", "String") },
            ],
          },
        ],
      },
    },
  };
  const people = Array.from({ length: 45 }, (_, index) => ({ id: String(index + 1), status: index % 3 === 0 ? "Dead" : "Alive" }));
  const graph: MockProvider = {
    ...ledgerly,
    id: "graph",
    hosts: ["api.graph.bench.test"],
    handle: (request) => {
      if (request.method !== "POST") return json({ errors: [{ message: "Send a POST with a query." }] }, 405);
      const sent = JSON.parse(request.body ?? "{}") as { query?: string; variables?: { page?: number } };
      if (sent.query?.includes("__schema")) return json(schema);
      const page = sent.variables?.page ?? 1;
      return json({ data: { characters: { results: people.slice((page - 1) * 20, page * 20), info: { count: people.length } } } });
    },
  };
  const connection = connectionSchema.parse({
    id: "graph",
    title: "Graph",
    kind: "rest",
    baseUrl: "https://api.graph.bench.test",
    ops: [{ id: "graphql", title: "The GraphQL endpoint", path: "/graphql" }],
    resources: [{ id: "record", title: "Records", listOp: "graphql" }],
  });

  it("replaces the endpoint with a read per list, reads every page, and says what it added", async () => {
    const transport = benchTransport([graph]);
    const report = await integrate(
      connection,
      { targets: ["graphql"] },
      { http: transport.http, resolveSecret: async () => null, fetchDocument: transport.fetchDocument, now: () => NOW },
    );
    expect(report.connection.ops.map((op) => op.id)).toEqual(["characters"]);
    expect(report.connection.resources.map((one) => [one.id, one.listOp])).toEqual([["character", "characters"]]);
    expect(report.outcome).toBe("ready");
    expect(report.ops.find((one) => one.op === "characters")?.level).toMatch(/traversed|count-reconciled/);
    expect(report.added?.replaced).toEqual(["graphql"]);
    expect(report.added?.ops.map((op) => op.id)).toEqual(["characters"]);
    expect(report.changes.join(" ")).toMatch(/read 1 list\(s\) from the GraphQL schema/);
  });

  /* 2026-09-30: a GraphQL error answered with 200 was read as one record, and the check said "ready". */
  it("never takes an answer of errors alone as a record", async () => {
    const closed: MockProvider = {
      ...graph,
      handle: () => json({ errors: [{ message: "Introspection is disabled." }] }),
    };
    const transport = benchTransport([closed]);
    const attempt = await tryRead(connection, "graphql", {
      http: transport.http,
      resolveSecret: async () => null,
      now: () => NOW,
      budget: budgetOf(5),
    });
    expect(attempt).toMatchObject({ kind: "failed", said: "Introspection is disabled." });
  });
});

/* Regression: an API with fifty collections had eight read, and the one a request was about was never described. */
describe("collections the check does not settle", () => {
  const many: MockProvider = {
    ...ledgerly,
    id: "many",
    hosts: ["api.many.bench.test"],
    handle: (request) => json({ results: [{ id: 1, name: request.url.pathname.slice(1) }, { id: 2, name: "b" }] }),
  };
  const collections = ["alpha", "beta", "gamma", "delta"];
  const connection = connectionSchema.parse({
    id: "many",
    title: "Many",
    kind: "rest",
    baseUrl: "https://api.many.bench.test",
    ops: [
      ...collections.map((name) => ({ id: name, title: name, path: `/${name}`, rowsPath: "$.results" })),
      { id: "one_alpha", title: "One alpha", path: "/alpha/{{param.id}}" },
    ],
    resources: collections.map((name) => ({ id: name, title: name, listOp: name })),
  });

  it("reads one first page of each, for its fields, on a budget of its own", async () => {
    const transport = benchTransport([many]);
    const report = await integrate(
      connection,
      { targets: ["alpha"], sample: ["beta", "gamma", "delta"], requests: 1, sampleRequests: 2 },
      { http: transport.http, resolveSecret: async () => null, fetchDocument: transport.fetchDocument, now: () => NOW },
    );
    /* The check's own budget was one request; sampling had two of its own. */
    expect(Object.keys(report.observed).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(report.log.join(" ")).toMatch(/first page of 2 more collection/);
  });

  it("samples only what the check does not settle and the documentation declared nothing for", () => {
    const entry = catalogEntrySchema.parse({
      id: "many",
      title: "Many",
      baseUrl: "https://api.many.bench.test",
      dialect: { auth: { type: "none" }, pagination: { kind: "none" } },
      ops: [
        { id: "alpha", title: "alpha", path: "/alpha" },
        { id: "beta", title: "beta", path: "/beta", fields: [{ name: "id", kinds: ["number"] }] },
        { id: "gamma", title: "gamma", path: "/gamma" },
        { id: "delta", title: "delta", path: "/delta" },
      ],
    });
    expect(samplingTargets(connection, entry, ["alpha"])).toEqual(["gamma", "delta"]);
  });

  it("checks what boards read before anything else", () => {
    expect(integrationTargets(connection, { used: ["delta"] }).slice(0, 2)).toEqual(["delta", "alpha"]);
  });
});

/* Regression: a public API whose specification declared no sign-in had connector code written for it. */
describe("a sign-in nobody declared", () => {
  const api = (open: boolean): MockProvider => ({
    ...ledgerly,
    id: open ? "open" : "closed",
    hosts: [`api.${open ? "open" : "closed"}.bench.test`],
    handle: () => (open ? json({ data: [{ id: 1 }, { id: 2 }] }) : { status: 401, body: { error: "a key is needed" } }),
  });
  const connectionFor = (open: boolean) =>
    connectionSchema.parse({
      id: open ? "open" : "closed",
      title: "Undeclared",
      kind: "rest",
      baseUrl: `https://api.${open ? "open" : "closed"}.bench.test`,
      authRequired: true,
      ops: [{ id: "things", title: "Things", path: "/things", rowsPath: "$.data" }],
    });
  const check = (open: boolean) => {
    const transport = benchTransport([api(open)]);
    return integrate(connectionFor(open), { targets: ["things"] }, {
      http: transport.http,
      resolveSecret: async () => null,
      fetchDocument: transport.fetchDocument,
      now: () => NOW,
    });
  };

  it("is tried without a key, and kept only if records come back", async () => {
    const report = await check(true);
    expect(report.outcome).toBe("ready");
    expect(report.connection.authRequired).toBe(false);
    expect(report.changes.join(" ")).toMatch(/read without signing in/);
  });

  it("still needs a key where the API refuses without one", async () => {
    const report = await check(false);
    expect(report.connection.authRequired).toBe(true);
    expect(report.outcome).toBe("blocked");
  });
});

/* Regression: the key was refused the endpoint the check started on, and nothing else was tried. */
describe("an endpoint the key may not use", () => {
  const partly: MockProvider = {
    ...ledgerly,
    id: "partly",
    hosts: ["api.partly.bench.test"],
    handle: (request) =>
      request.url.pathname === "/payroll"
        ? { status: 403, body: { error: "forbidden" } }
        : json({ data: [{ id: 1 }, { id: 2 }] }),
  };
  const connection = connectionSchema.parse({
    id: "partly",
    title: "Partly",
    kind: "rest",
    baseUrl: "https://api.partly.bench.test",
    ops: [
      { id: "payroll", title: "Payroll", path: "/payroll", rowsPath: "$.data" },
      { id: "projects", title: "Projects", path: "/projects", rowsPath: "$.data" },
    ],
  });

  it("moves on to the next endpoint, and blocks only when every one refuses", async () => {
    const transport = benchTransport([partly]);
    const deps = { http: transport.http, resolveSecret: async () => null, fetchDocument: transport.fetchDocument, now: () => NOW };
    const report = await integrate(connection, { targets: ["payroll", "projects"] }, deps);
    expect(report.outcome).toBe("partial");
    expect(report.ops.map((one) => [one.op, one.outcome])).toEqual([
      ["payroll", "blocked"],
      ["projects", "ready"],
    ]);
    const alone = await integrate(connection, { targets: ["payroll"] }, deps);
    expect(alone.outcome).toBe("blocked");
  });
});

/* Regression: Rick and Morty said "try again in 10s", and the check stopped there. */
describe("a short rate limit", () => {
  const limited = (refusals: number, retryAfter: string): { provider: MockProvider; asked: () => number } => {
    let asked = 0;
    return {
      asked: () => asked,
      provider: {
        ...ledgerly,
        id: "limited",
        hosts: ["api.limited.bench.test"],
        handle: () => {
          asked++;
          return asked <= refusals
            ? { status: 429, headers: { "retry-after": retryAfter }, body: { error: "slow down" } }
            : json({ data: [{ id: 1 }, { id: 2 }] });
        },
      },
    };
  };
  const connection = connectionSchema.parse({
    id: "limited",
    title: "Limited",
    kind: "rest",
    baseUrl: "https://api.limited.bench.test",
    ops: [{ id: "things", title: "Things", path: "/things", rowsPath: "$.data" }],
  });

  it("is waited out and read again", async () => {
    const { provider, asked } = limited(1, "2");
    const waits: number[] = [];
    const attempt = await tryRead(connection, "things", {
      http: benchTransport([provider]).http,
      resolveSecret: async () => null,
      now: () => NOW,
      budget: budgetOf(10),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(attempt.kind).toBe("ok");
    expect(waits).toEqual([2000]);
    expect(asked()).toBe(2);
  });

  it("ends the read when it goes on, when the wait is long, or when there is no clock to wait on", async () => {
    const read = (refusals: number, retryAfter: string, sleep?: (ms: number) => Promise<void>) =>
      tryRead(connection, "things", {
        http: benchTransport([limited(refusals, retryAfter).provider]).http,
        resolveSecret: async () => null,
        now: () => NOW,
        budget: budgetOf(10),
        ...(sleep ? { sleep } : {}),
      });
    const idle = async () => {};
    expect((await read(5, "1", idle)).kind).toBe("rateLimited");
    expect((await read(1, "3600", idle)).kind).toBe("rateLimited");
    expect((await read(1, "1")).kind).toBe("rateLimited");
  });
});

describe("asking a model, last", () => {
  /* The header is named only in the docs' prose, never in the refusal or the spec. */
  const shy: MockProvider = {
    ...keyring,
    id: "shy",
    hosts: ["api.shy.bench.test"],
    docsUrl: "https://api.shy.bench.test/openapi.json",
    handle: (request) => {
      if (request.url.pathname === "/openapi.json")
        return json({
          openapi: "3.0.3",
          info: { title: "Shy", version: "1", description: "Every request must send Accept-Version: 3." },
          servers: [{ url: "https://api.shy.bench.test" }],
          security: [],
          paths: { "/things": { get: { summary: "Things", responses: { "200": { description: "ok" } } } } },
        });
      if (request.headers["accept-version"] !== "3") return json({ error: "bad request" }, 400);
      return json([{ id: 1 }]);
    },
  };

  it("tries one change a model proposes, and keeps it only when the read gets further", async () => {
    const { transport, entry, connection, secrets } = await connected(shy);
    const llm = fakeLlm([{ args: { reason: "The overview requires Accept-Version: 3.", headerName: "Accept-Version", headerValue: "3" } }]);
    const report = await integrate(connection, { targets: [firstOp(connection)], entry }, { ...deps(transport, secrets), llm });
    expect(report.outcome).toBe("ready");
    expect(report.modelCalls).toBe(1);
    expect(report.changes.join(" ")).toMatch(/a model's reading/);
    const prompt = llm.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toMatch(/untrusted data/);
    expect(prompt).not.toContain(keyring.credentials[0]);
  });

  it("reports what a model says cannot be expressed, as the reason it is blocked", async () => {
    const { transport, entry, connection, secrets } = await connected(shy);
    const llm = fakeLlm([{ args: { reason: "It signs requests.", cannot: "Every request must be signed with HMAC." } }]);
    const report = await integrate(connection, { targets: [firstOp(connection)], entry }, { ...deps(transport, secrets), llm });
    expect(report).toMatchObject({ outcome: "blocked", blocked: "Every request must be signed with HMAC." });
  });
});

describe("the patch vocabulary", () => {
  it("merges shared headers and refuses a change the schema would not accept", () => {
    const base = connectionSchema.parse({ id: "a", title: "A", kind: "rest", baseUrl: "https://api.a.test", ops: [{ id: "x", title: "X", path: "/x" }] });
    expect(applyPatch(base, { headers: { "X-V": "1" } })?.dialect?.headers).toEqual({ "X-V": "1" });
    expect(applyPatch(base, { ops: { x: { maxPages: 500 } } })).toBeNull();
  });

  it("treats a country's generic second level as part of the suffix", () => {
    expect(siteOf("api.example.co.uk")).toBe("example.co.uk");
    expect(sameSite("api.example.com", "docs.example.com")).toBe(true);
    expect(sameSite("api.example.co.uk", "api.other.co.uk")).toBe(false);
  });
});

describe("evidence stores", () => {
  const record = (index: number): Evidence => ({
    workspace: "local",
    connection: "c",
    op: "o",
    level: index % 2 === 0 ? "accepted" : "advanced",
    scope: { params: {} },
    configVersion: "v1",
    at: new Date(NOW + index * 1000).toISOString(),
    limits: { pages: 1, maxPages: 1, requests: 1 },
    observed: {},
    by: "integrate",
  });

  it("keeps only the most recent records per endpoint, in memory", async () => {
    const store = new MemoryEvidenceStore();
    for (let index = 0; index < EVIDENCE_PER_OP + 5; index++) await store.record(record(index));
    const kept = await store.forConnection("c");
    expect(kept).toHaveLength(EVIDENCE_PER_OP);
    expect(kept[0]!.at).toBe(record(EVIDENCE_PER_OP + 4).at);
  });

  it("does the same in the embedded database, and forgets a removed connection", async () => {
    const db = await openDashDb({ inMemory: true });
    try {
      const store = new DbEvidenceStore(db);
      for (let index = 0; index < EVIDENCE_PER_OP + 3; index++) await store.record(record(index));
      const kept = await store.forConnection("c");
      expect(kept).toHaveLength(EVIDENCE_PER_OP);
      expect(kept[0]!.at).toBe(record(EVIDENCE_PER_OP + 2).at);
      await store.forget("c");
      expect(await store.forConnection("c")).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe("POST /api/connections/:id/integrate", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the repaired connection, and says what it observed", async () => {
    dir = mkdtempSync(join(tmpdir(), "dash-integrate-"));
    const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 3)), join(dir, "vault.json"));
    const catalog = new CatalogStore(join(dir, "seed"), join(dir, "overlay"));
    const { transport, entry, connection, secrets } = await connected(taskpad);
    catalog.put(entry);
    store.putConnection({ ...connection, catalog: entry.id, validateOpId: firstOp(connection) });
    for (const [ref, value] of Object.entries(secrets)) keys.set(ref, value);
    const app = buildServer({ store, keys, catalog, http: transport.http, fetchDocument: transport.fetchDocument });

    const result = await app.inject({ method: "POST", url: `/api/connections/${connection.id}/integrate` });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ outcome: "ready" });
    const saved = store.getConnection(connection.id)!;
    expect(saved.integration).toMatchObject({ outcome: "ready" });
    expect(getOp(saved, firstOp(connection))?.params.some((param) => param.name === "Taskpad-Version")).toBe(true);

    const evidence = await app.inject({ method: "GET", url: `/api/connections/${connection.id}/evidence` });
    expect(evidence.json().ops[0].strongest).toMatchObject({ level: "accepted" });
    await app.close();
  });

  it("keeps what the records held for this connection, and forgets it with the connection", async () => {
    dir = mkdtempSync(join(tmpdir(), "dash-integrate-"));
    const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 3)), join(dir, "vault.json"));
    const catalog = new CatalogStore(join(dir, "seed"), join(dir, "overlay"));
    const { transport, entry, connection, secrets } = await connected(taskpad);
    catalog.put(entry);
    store.putConnection({ ...connection, catalog: entry.id, validateOpId: firstOp(connection) });
    for (const [ref, value] of Object.entries(secrets)) keys.set(ref, value);
    const seenValues = new MemorySeenValueStore();
    const app = buildServer({ store, keys, catalog, http: transport.http, fetchDocument: transport.fetchDocument, seenValues });

    await app.inject({ method: "POST", url: `/api/connections/${connection.id}/integrate` });
    const kept = await seenValues.get(connection.id);
    expect(Object.keys(kept[firstOp(connection)]?.fields ?? {}).length).toBeGreaterThan(0);
    /* A field the documentation declared no values for: what its records held stays out of the shared catalog. */
    const undeclared = Object.entries(kept[firstOp(connection)]?.fields ?? {}).filter(
      ([path]) => !entry.ops.find((op) => op.id === firstOp(connection))?.fields?.some((field) => field.name === path && field.values),
    );
    expect(undeclared.length).toBeGreaterThan(0);
    for (const [, values] of undeclared) expect(JSON.stringify(catalog.get(entry.id))).not.toContain(`"${values[0]}"`);

    await app.inject({ method: "DELETE", url: `/api/connections/${connection.id}` });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await seenValues.get(connection.id)).toEqual({});
    await app.close();
  });

  const setup = async (autoIntegrate: boolean) => {
    dir = mkdtempSync(join(tmpdir(), "dash-integrate-"));
    const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 3)), join(dir, "vault.json"));
    const catalog = new CatalogStore(join(dir, "seed"), join(dir, "overlay"));
    const { transport, entry, connection } = await connected(taskpad);
    catalog.put(entry);
    store.putConnection({ ...connection, catalog: entry.id, validateOpId: firstOp(connection) });
    const app = buildServer({
      store,
      keys,
      catalog,
      http: transport.http,
      fetchDocument: transport.fetchDocument,
      autoIntegrate,
    });
    return { app, store, transport, connection };
  };

  /* The key is all a person should have to give. */
  it("checks a connection by itself once its key is saved", async () => {
    const { app, store, transport, connection } = await setup(true);
    const saved = await app.inject({
      method: "PUT",
      url: `/api/connections/${connection.id}/key`,
      payload: { key: taskpad.credentials[0] },
    });
    expect(saved.statusCode).toBe(200);
    for (let wait = 0; wait < 100 && !store.getConnection(connection.id)?.integration; wait++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getConnection(connection.id)?.integration?.outcome).toBe("ready");
    // One check, one read: the header the specification declares is sent from the start.
    expect(transport.apiRequests()).toBe(1);
    await app.close();
  });

  /* A damaged embedded database refuses writes; the check itself still counts. */
  it("keeps the check when its evidence cannot be stored", async () => {
    dir = mkdtempSync(join(tmpdir(), "dash-integrate-"));
    const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 3)), join(dir, "vault.json"));
    const catalog = new CatalogStore(join(dir, "seed"), join(dir, "overlay"));
    const { transport, entry, connection, secrets } = await connected(taskpad);
    catalog.put(entry);
    store.putConnection({ ...connection, catalog: entry.id, validateOpId: firstOp(connection) });
    for (const [ref, value] of Object.entries(secrets)) keys.set(ref, value);
    const broken = {
      record: async () => {
        throw new Error('could not open file "base/5/6104"');
      },
      forConnection: async () => [],
      forget: async () => undefined,
    };
    const app = buildServer({ store, keys, catalog, http: transport.http, fetchDocument: transport.fetchDocument, evidence: broken });
    const result = await app.inject({ method: "POST", url: `/api/connections/${connection.id}/integrate` });
    expect(result.statusCode).toBe(200);
    expect(store.getConnection(connection.id)?.integration?.outcome).toBe("ready");
    await app.close();
  });

  it("spends nothing by itself unless the server was asked to", async () => {
    const { app, store, transport, connection } = await setup(false);
    await app.inject({
      method: "PUT",
      url: `/api/connections/${connection.id}/key`,
      payload: { key: taskpad.credentials[0] },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.getConnection(connection.id)?.integration).toBeUndefined();
    expect(transport.apiRequests()).toBe(0);
    await app.close();
  });
});
