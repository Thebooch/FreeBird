import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpAdapter, type HttpFetch } from "@freebirdai/connect/adapters";
import { connectionSchema, getOp, resolveRange } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionFromCatalog } from "@freebirdai/connect/catalog";
import { discover } from "@freebirdai/connect/discovery/index";
import { integrate } from "@freebirdai/connect/integrate/agent";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/vault";
import { openMcpClient, rpcAnswerIn } from "@freebirdai/connect/mcp/client";
import { discoverMcp, looksLikeMcpAddress, readGround } from "@freebirdai/connect/mcp/discover";

/*
 * An MCP server as a connection: a small server that speaks
 * streamable HTTP, answered in process through the transport every other
 * connection uses.
 */

const URL_ = "https://mcp.tickets.test/mcp";
const TOKEN = "tok_mcp_41";
const NOW = Date.UTC(2026, 8, 30);

const tickets = Array.from({ length: 23 }, (_, index) => ({ id: `T-${index + 1}`, status: index % 3 === 0 ? "open" : "closed", minutes: 5 + index }));

const TOOLS = [
  {
    name: "list_tickets",
    title: "List tickets",
    description: "Every ticket, newest first.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "closed"], description: "Only tickets in this state." } } },
    outputSchema: {
      type: "object",
      properties: {
        tickets: { type: "array", items: { type: "object", properties: { id: { type: "string" }, status: { type: "string" }, minutes: { type: "integer" } } } },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_ticket",
    description: "One ticket.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true },
  },
  { name: "close_ticket", description: "Closes a ticket.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "delete_everything", description: "Do not call.", annotations: { destructiveHint: true } },
  /* Says nothing about itself: a name for reading, so a read on the name's word. */
  { name: "searchAgents", description: "Find agents by name.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  /* Named for reading and marked as changing things: the server's word wins. */
  { name: "list_and_archive", annotations: { readOnlyHint: false } },
];

interface Seen {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly params: unknown;
}

const server = (options: { token?: string; sse?: boolean; expireAfter?: number } = {}) => {
  const seen: Seen[] = [];
  let sessions = 0;
  let session = "";
  let calls = 0;
  const http: HttpFetch = async (url, init, allowedHost) => {
    if (new URL(url).hostname !== allowedHost) throw new Error(`pinned to ${allowedHost}`);
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      status,
      text: typeof body === "string" ? body : JSON.stringify(body),
      url,
      header: (name: string) => ({ "content-type": "application/json", ...headers })[name.toLowerCase()] ?? null,
    });
    if (options.token && init.headers.authorization !== `Bearer ${options.token}`) return answer(401, { error: "unauthorized" });
    const message = JSON.parse(init.body ?? "{}") as { id?: number; method: string; params?: Record<string, unknown> };
    seen.push({ method: message.method, headers: init.headers, params: message.params });
    const reply = (result: unknown, headers: Record<string, string> = {}) =>
      options.sse
        ? answer(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`, { "content-type": "text/event-stream", ...headers })
        : answer(200, { jsonrpc: "2.0", id: message.id, result }, headers);
    if (message.method === "initialize") {
      session = `s-${++sessions}`;
      calls = 0;
      return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Tickets", version: "2.1" } }, { "mcp-session-id": session });
    }
    if (init.headers["mcp-session-id"] !== session) return answer(404, { error: "no such session" });
    if (message.method === "notifications/initialized") return answer(202, "");
    if (options.expireAfter !== undefined && ++calls > options.expireAfter) {
      session = "gone";
      return answer(404, { error: "session expired" });
    }
    if (message.method === "tools/list") {
      const at = Number(message.params?.cursor ?? 0);
      return reply({ tools: TOOLS.slice(at, at + 2), ...(at + 2 < TOOLS.length ? { nextCursor: String(at + 2) } : {}) });
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = (message.params?.arguments ?? {}) as { status?: string };
      if (name === "searchAgents") return reply({ content: [{ type: "text", text: JSON.stringify({ agents: [{ id: 1, name: "Ada" }, { id: 2, name: "Ben" }] }) }] });
      if (name !== "list_tickets") return reply({ content: [{ type: "text", text: "not here" }], isError: true });
      const rows = tickets.filter((one) => !args.status || one.status === args.status);
      return reply({ structuredContent: { tickets: rows }, content: [{ type: "text", text: JSON.stringify({ tickets: rows }) }] });
    }
    return answer(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  };
  return { http, seen };
};

const connection = (auth: unknown = { type: "none" }) =>
  connectionSchema.parse({ id: "tickets", title: "Tickets", kind: "mcp", baseUrl: URL_, auth, ops: [] });

describe("an MCP client over the server's own transport", () => {
  it("opens a session, lists every page of tools, and calls one", async () => {
    const { http, seen } = server({ token: TOKEN });
    const client = await openMcpClient(connection({ type: "bearer", keyRef: "k" }), { http, resolveSecret: async () => TOKEN });
    expect(client.server).toMatchObject({ name: "Tickets", protocolVersion: "2025-03-26" });
    const tools = await client.listTools();
    expect(tools.map((one) => [one.name, one.readOnly])).toEqual([
      ["list_tickets", true],
      ["get_ticket", true],
      ["close_ticket", undefined],
      ["delete_everything", undefined],
      ["searchAgents", undefined],
      ["list_and_archive", false],
    ]);
    const called = await client.callTool("list_tickets", { status: "open" });
    expect((called.structuredContent as { tickets: unknown[] }).tickets).toHaveLength(8);
    expect(seen.map((one) => one.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/list", "tools/call"]);
    /* After the handshake every request names the session and the version the server chose. */
    expect(seen.slice(1).every((one) => one.headers["mcp-session-id"] === "s-1" && one.headers["mcp-protocol-version"] === "2025-03-26")).toBe(true);
    expect(seen[0]!.headers["mcp-protocol-version"]).toBeUndefined();
  });

  it("reads an answer sent as an event stream, and opens a forgotten session again", async () => {
    const { http, seen } = server({ sse: true, expireAfter: 1 });
    const client = await openMcpClient(connection(), { http, resolveSecret: async () => null });
    expect(await client.listTools()).toHaveLength(6);
    expect(seen.filter((one) => one.method === "initialize").length).toBeGreaterThan(1);
    expect(rpcAnswerIn('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n', "text/event-stream", 7)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
    expect(rpcAnswerIn('{"jsonrpc":"2.0","id":8,"result":{}}', "application/json", 7)).toBeNull();
  });
});

describe("an MCP server as a connection", () => {
  it("imports the tools the server marks read-only, and says which it left out", async () => {
    const { http } = server();
    const found = (await discoverMcp(URL_, { http }))!;
    expect(found.entry).toMatchObject({ kind: "mcp", baseUrl: URL_, title: "Tickets", dialect: { auth: { type: "none" } } });
    expect(found.entry.ops.map((op) => [op.id, op.path, op.readSafety?.basis])).toEqual([
      ["list_tickets", "/list_tickets", "spec-declared"],
      ["get_ticket", "/get_ticket", "spec-declared"],
      ["searchagents", "/searchAgents", "docs-inferred"],
    ]);
    /* A typed tool says where its records are and what they hold; its arguments are parameters. */
    expect(found.entry.ops[0]).toMatchObject({ title: "List tickets", rowsPath: "$.tickets", params: [{ name: "status", required: false, enum: ["open", "closed"] }] });
    expect(found.entry.ops[0]!.fields?.map((field) => field.name)).toEqual(["id", "status", "minutes"]);
    expect(found.entry.ops[1]!.params).toEqual([expect.objectContaining({ name: "id", required: true })]);
    expect(found.warnings.join(" ")).toMatch(/3 tools are not known to only read, and were left out: close_ticket, delete_everything, list_and_archive/);
    /* A name says it reads only by its first word, and never with a word for a change in it. */
    expect(readGround({ name: "get_and_delete_report" })).toBeNull();
    expect(readGround({ name: "ask_question" })).toBeNull();
    expect(readGround({ name: "read_wiki_structure" })?.basis).toBe("docs-inferred");
    expect(readGround({ name: "listUsers", destructive: true })).toBeNull();
  });

  it("is found from the address a person pastes, and asks for a token where the server wants one", async () => {
    expect(looksLikeMcpAddress(URL_)).toBe(true);
    expect(looksLikeMcpAddress("https://docs.example.com/api")).toBe(false);
    const open = await discover(URL_, { fetchDocument: async () => ({ status: 404, text: "", url: URL_ }), http: server().http });
    expect(open).toMatchObject({ source: "mcp", entry: { kind: "mcp" } });
    const locked = await discover(URL_, { fetchDocument: async () => ({ status: 404, text: "", url: URL_ }), http: server({ token: TOKEN }).http });
    expect(locked.entry).toMatchObject({ kind: "mcp", ops: [], dialect: { auth: { type: "bearer" } } });
    /* Without a transport to ask with, an MCP address is only a page that could not be read. */
    expect((await discover(URL_, { fetchDocument: async () => ({ status: 404, text: "", url: URL_ }) })).entry).toBeNull();
  });

  it("is checked like any connection: its tools listed once the token is in, read, and never a tool that changes things", async () => {
    const { http, seen } = server({ token: TOKEN });
    const entry = (await discover(URL_, { fetchDocument: async () => ({ status: 404, text: "", url: URL_ }), http }))!.entry!;
    const made = connectionFromCatalog(entry, { id: "tickets" });
    expect(made.kind).toBe("mcp");
    const report = await integrate(
      made,
      { targets: [] },
      {
        http,
        resolveSecret: async () => TOKEN,
        fetchDocument: async (url) => ({ status: 404, text: "", url }),
        now: () => NOW,
      },
    );
    expect(report.outcome).toBe("ready");
    expect(report.connection.ops.map((op) => op.id)).toEqual(["list_tickets", "get_ticket", "searchagents"]);
    expect(report.ops[0]).toMatchObject({ op: "list_tickets", outcome: "ready" });
    expect(report.observed.list_tickets).toMatchObject({ rowsPath: "$.tickets" });
    expect(report.added?.ops.map((op) => op.id)).toEqual(["list_tickets", "get_ticket", "searchagents"]);
    const called = seen.filter((one) => one.method === "tools/call").map((one) => (one.params as { name: string }).name);
    expect(called.every((name) => name === "list_tickets" || name === "searchAgents")).toBe(true);
    expect(report.log.join(" ")).toMatch(/left out, and are never called for a board: close_ticket, delete_everything, list_and_archive/);
  });

  it("says a refused token as that", async () => {
    const { http } = server({ token: TOKEN });
    const report = await integrate(
      connection({ type: "bearer", keyRef: "k" }),
      { targets: [] },
      { http, resolveSecret: async () => "wrong", fetchDocument: async (url) => ({ status: 404, text: "", url }), now: () => NOW },
    );
    expect(report).toMatchObject({ outcome: "blocked", blocked: expect.stringMatching(/refused the access token/) });
  });
});

describe("a board reading an MCP tool", () => {
  let dir: string;
  beforeEach(() => {
    vi.stubEnv("DASH_MIN_GAP_MS", "0");
    dir = mkdtempSync(join(tmpdir(), "dash-mcp-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("goes through /api/query like any other read, with the tool's arguments as its parameters", async () => {
    const { http, seen } = server({ token: TOKEN });
    const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
    const app = buildServer({ store, keys, http });
    const entry = (await discoverMcp(URL_, { http: server().http }))!.entry;
    store.putConnection({ ...connectionFromCatalog(entry, { id: "tickets" }), auth: { type: "bearer", keyRef: "tickets-key" } });
    keys.set("tickets-key", TOKEN);
    const response = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: { connection: "tickets", op: "list_tickets", params: { status: "open" }, range: { preset: "30d" }, filters: {}, mode: "refresh", maxAgeMs: 0 },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json().body as { tickets: unknown[] }).tickets).toHaveLength(8);
    expect(seen.filter((one) => one.method === "tools/call").map((one) => one.params)).toEqual([{ name: "list_tickets", arguments: { status: "open" } }]);
    await app.close();
  });

  it("reads through the adapter directly, for a check or the keeper", async () => {
    const { http } = server();
    const adapter = new McpAdapter((one) => openMcpClient(one, { http, resolveSecret: async () => null }));
    const entry = (await discoverMcp(URL_, { http }))!.entry;
    const made = connectionFromCatalog(entry, { id: "tickets" });
    const result = await adapter.fetch(made, getOp(made, "list_tickets")!, {}, { now: NOW, params: { range: resolveRange({ preset: "30d", now: NOW }), filters: {} } });
    expect((result.body as { tickets: unknown[] }).tickets).toHaveLength(23);
  });
});
