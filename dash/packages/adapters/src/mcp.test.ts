import type { ConnectionSpec, OpSpec, ResolvedParams } from "@freebirdai/dash-spec";
import { connectionSchema, getOp, resolveRange } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import {
  McpAdapter,
  type McpClient,
  type McpToolInfo,
  type McpToolResult,
  tierTools,
} from "./mcp.js";
import { AdapterError, type FetchContext } from "./types.js";

const NOW = Date.UTC(2026, 7, 4);

const ctx: FetchContext = {
  now: NOW,
  params: {
    range: resolveRange({ preset: "7d", now: NOW }),
    filters: { region: "emea" },
  } satisfies ResolvedParams,
};

const connection = (): ConnectionSpec =>
  connectionSchema.parse({
    id: "tools",
    title: "Ops MCP",
    kind: "mcp",
    baseUrl: "https://mcp.example.com",
    ops: [
      {
        id: "incidents",
        title: "Incidents",
        path: "/list_incidents",
        query: { since: "{{range.start | iso}}", region: "{{param.region}}" },
      },
    ],
  });

/** Adapters always receive a resolved op; `getOp` is what resolves it. */
const op = (conn: ConnectionSpec): OpSpec => getOp(conn, conn.ops[0]!.id)!;

const fakeClient = (tools: McpToolInfo[], result: McpToolResult): { client: McpClient; calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      listTools: async () => tools,
      callTool: async (name, args) => {
        calls.push({ name, args });
        return result;
      },
    },
  };
};

const TYPED: McpToolInfo = {
  name: "list_incidents",
  description: "Recent incidents",
  outputSchema: { type: "object" },
};
const UNTYPED: McpToolInfo = { name: "list_incidents", description: "Recent incidents" };

describe("tierTools", () => {
  it("separates typed contracts from brittle prose tools", () => {
    expect(tierTools([TYPED, UNTYPED, { name: "other" }])).toEqual([
      { name: "list_incidents", tier: "typed", description: "Recent incidents" },
      { name: "list_incidents", tier: "brittle", description: "Recent incidents" },
      { name: "other", tier: "brittle", description: undefined },
    ]);
  });
});

describe("McpAdapter", () => {
  it("must run server-side", () => {
    expect(new McpAdapter(async () => fakeClient([], {}).client).transport).toBe("proxy");
  });

  it("takes a declared output schema at its word, with no warning", async () => {
    const { client } = fakeClient([TYPED], { structuredContent: { incidents: [{ id: 1 }] } });
    const conn = connection();
    const result = await new McpAdapter(async () => client).fetch(conn, op(conn), {}, ctx);

    expect(result.body).toEqual({ incidents: [{ id: 1 }] });
    // The whole point of the typed path: nothing to warn about.
    expect(result.meta.warnings).toEqual([]);
    expect(result.meta.url).toBe("mcp://tools/list_incidents");
  });

  it("warns when structured data arrives with no schema declared", async () => {
    const { client } = fakeClient([UNTYPED], { structuredContent: { incidents: [] } });
    const conn = connection();
    const result = await new McpAdapter(async () => client).fetch(conn, op(conn), {}, ctx);

    expect(result.body).toEqual({ incidents: [] });
    expect(result.meta.warnings[0]).toMatch(/without declaring an output schema/);
  });

  it("parses JSON out of a text response and flags the binding brittle", async () => {
    const { client } = fakeClient([UNTYPED], {
      content: [{ type: "text", text: 'Here you go:\n```json\n{"incidents":[{"id":7}]}\n```' }],
    });
    const conn = connection();
    const result = await new McpAdapter(async () => client).fetch(conn, op(conn), {}, ctx);

    expect(result.body).toEqual({ incidents: [{ id: 7 }] });
    expect(result.meta.warnings[0]).toMatch(/brittle/);
  });

  it("parses bare and embedded JSON too", async () => {
    const conn = connection();
    const bare = fakeClient([UNTYPED], { content: [{ type: "text", text: '[{"id":1}]' }] });
    expect(
      (await new McpAdapter(async () => bare.client).fetch(conn, op(conn), {}, ctx)).body,
    ).toEqual([{ id: 1 }]);

    const embedded = fakeClient([UNTYPED], {
      content: [{ type: "text", text: 'Found 1 incident: {"id":2}' }],
    });
    expect(
      (await new McpAdapter(async () => embedded.client).fetch(conn, op(conn), {}, ctx)).body,
    ).toEqual({ id: 2 });
  });

  it("refuses prose that contains no data rather than inventing rows", async () => {
    const { client } = fakeClient([UNTYPED], {
      content: [{ type: "text", text: "Everything looks fine today!" }],
    });
    const conn = connection();
    const error: AdapterError = await new McpAdapter(async () => client)
      .fetch(conn, op(conn), {}, ctx)
      .then(() => {
        throw new Error("should have rejected");
      })
      .catch((e: AdapterError) => e);

    expect(error.status).toBe(422);
    expect(error.userMessage).toMatch(/answers in prose rather than data/);
  });

  it("interpolates params into tool arguments", async () => {
    const { client, calls } = fakeClient([TYPED], { structuredContent: {} });
    const conn = connection();
    await new McpAdapter(async () => client).fetch(conn, op(conn), { limit: 10 }, ctx);

    expect(calls[0]).toEqual({
      name: "list_incidents",
      args: {
        since: new Date(resolveRange({ preset: "7d", now: NOW }).start).toISOString(),
        region: "emea",
        limit: 10,
      },
    });
  });

  it("names a tool that has disappeared from the server", async () => {
    const { client } = fakeClient([{ name: "something_else" }], { structuredContent: {} });
    const conn = connection();
    const error: AdapterError = await new McpAdapter(async () => client)
      .fetch(conn, op(conn), {}, ctx)
      .then(() => {
        throw new Error("should have rejected");
      })
      .catch((e: AdapterError) => e);

    expect(error.status).toBe(404);
    expect(error.userMessage).toMatch(/no longer offered by Ops MCP/);
  });

  it("surfaces a tool-reported error", async () => {
    const { client } = fakeClient([TYPED], {
      isError: true,
      content: [{ type: "text", text: "upstream timeout" }],
    });
    const conn = connection();
    await expect(
      new McpAdapter(async () => client).fetch(conn, op(conn), {}, ctx),
    ).rejects.toThrow(/upstream timeout/);
  });

  it("does not cache a failed connection", async () => {
    let attempts = 0;
    const adapter = new McpAdapter(async () => {
      attempts++;
      if (attempts === 1) throw new Error("server restarting");
      return fakeClient([TYPED], { structuredContent: { ok: true } }).client;
    });
    const conn = connection();

    const failure: AdapterError = await adapter
      .fetch(conn, op(conn), {}, ctx)
      .then(() => {
        throw new Error("should have rejected");
      })
      .catch((e: AdapterError) => e);
    expect(failure.message).toMatch(/server restarting/);
    expect(failure.userMessage).toMatch(/Could not connect/);

    // A restart must not poison the connection for the rest of the session.
    expect((await adapter.fetch(conn, op(conn), {}, ctx)).body).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("discovers and tiers a server's tools", async () => {
    const { client } = fakeClient([TYPED, { name: "summarize" }], { structuredContent: {} });
    expect(await new McpAdapter(async () => client).discover(connection())).toEqual([
      { name: "list_incidents", tier: "typed", description: "Recent incidents" },
      { name: "summarize", tier: "brittle", description: undefined },
    ]);
  });
});
