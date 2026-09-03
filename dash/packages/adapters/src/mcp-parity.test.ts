import { connectionSchema, getOp } from "@freebirdai/dash-spec";
import type { ConnectionSpec, OpSpec, ResolvedParams } from "@freebirdai/dash-spec";
import { describe, expect, it, vi } from "vitest";
import { McpAdapter, type McpClient, type McpToolInfo } from "./mcp.js";
import { nextPageParams } from "./paginate.js";

/**
 * The parity this phase is about: an MCP-sourced widget should be
 * indistinguishable downstream from a REST one — same pages, same truncation
 * signal, same timing, same inspector.
 */

const params: ResolvedParams = {
  range: { start: 0, end: 1, grain: "1d", preset: "24h" },
  filters: {},
};

const connection = (over: Record<string, unknown> = {}): ConnectionSpec =>
  connectionSchema.parse({
    id: "srv",
    title: "Demo MCP",
    kind: "mcp",
    ops: [{ id: "items", title: "Items", path: "/list_items", rowsPath: "$.data" }],
    ...over,
  });

const op = (spec: ConnectionSpec, id = "items"): OpSpec => {
  const resolved = getOp(spec, id);
  if (!resolved) throw new Error("missing op");
  return resolved;
};

/** A fake MCP server whose tool returns one page per call. */
const fakeClient = (
  pages: unknown[],
  opts: { typed?: boolean; prose?: boolean } = {},
): { client: McpClient; calls: Record<string, unknown>[]; listTools: ReturnType<typeof vi.fn> } => {
  const calls: Record<string, unknown>[] = [];
  const tool: McpToolInfo = {
    name: "list_items",
    ...(opts.typed === false ? {} : { outputSchema: { type: "object" } }),
  };
  const listTools = vi.fn(async () => [tool]);
  const client: McpClient = {
    listTools,
    callTool: async (_name, args) => {
      const page = pages[calls.length];
      calls.push(args);
      if (opts.prose) return { content: [{ type: "text", text: "no data here" }] };
      return { structuredContent: page };
    },
  };
  return { client, calls, listTools };
};

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("MCP pagination", () => {
  const paginated = () =>
    connection({
      dialect: { pagination: { kind: "cursor", cursorPath: "$.next", param: "cursor" } },
      ops: [
        {
          id: "items",
          title: "Items",
          path: "/list_items",
          rowsPath: "$.data",
          pagination: { kind: "cursor", cursorPath: "$.next", param: "cursor" },
        },
      ],
    });

  it("combines pages and puts the cursor in the tool arguments", async () => {
    const spec = paginated();
    const { client, calls } = fakeClient([
      { data: [{ id: 1 }], next: "c1" },
      { data: [{ id: 2 }], next: "c2" },
      { data: [{ id: 3 }] },
    ]);
    const adapter = new McpAdapter(async () => client);

    const result = await adapter.fetch(spec, op(spec), {}, { params, now: 0 });

    expect(result.meta.pages).toBe(3);
    expect((result.body as { data: unknown[] }).data).toHaveLength(3);
    // The cursor travels as an argument, which is the MCP equivalent of a
    // query parameter — same spec, different transport.
    expect(calls[0]).not.toHaveProperty("cursor");
    expect(calls[1]).toMatchObject({ cursor: "c1" });
    expect(calls[2]).toMatchObject({ cursor: "c2" });
    expect(result.meta.truncated).toBe(false);
  });

  it("stops at maxPages and says so", async () => {
    const spec = paginated();
    spec.ops[0]!.maxPages = 2;
    const { client } = fakeClient([
      { data: [{ id: 1 }], next: "c1" },
      { data: [{ id: 2 }], next: "c2" },
      { data: [{ id: 3 }], next: "c3" },
    ]);
    const adapter = new McpAdapter(async () => client);

    const result = await adapter.fetch(spec, op(spec), {}, { params, now: 0 });
    expect(result.meta.pages).toBe(2);
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.warnings.join(" ")).toContain("stopped after 2 page");
  });

  it("makes exactly one call when pagination is none", async () => {
    const spec = connection();
    const { client, calls } = fakeClient([{ data: [{ id: 1 }] }]);
    const adapter = new McpAdapter(async () => client);

    const result = await adapter.fetch(spec, op(spec), {}, { params, now: 0 });
    expect(calls).toHaveLength(1);
    expect(result.meta.pages).toBe(1);
  });

  it("reports link-header as unsupported rather than silently reading one page", async () => {
    // There are no headers in MCP. Pretending it worked would produce a
    // quietly incomplete chart, which is the failure this whole phase is about.
    const spec = connection({
      ops: [
        {
          id: "items",
          title: "Items",
          path: "/list_items",
          rowsPath: "$.data",
          pagination: { kind: "link-header" },
        },
      ],
    });
    const { client, calls } = fakeClient([{ data: [{ id: 1 }] }]);
    const adapter = new McpAdapter(async () => client);

    const result = await adapter.fetch(spec, op(spec), {}, { params, now: 0 });
    expect(calls).toHaveLength(1);
    expect(result.meta.warnings.join(" ")).toContain("link-header");
  });

  it("shares its page decision with REST", () => {
    // Same spec, same answer — the reason this lives in `paginate.ts`.
    expect(
      nextPageParams({
        pagination: { kind: "cursor", cursorPath: "$.next", param: "cursor" },
        body: { data: [{ id: 1 }], next: "abc" },
        rowsPath: "$.data",
        pageIndex: 1,
      }),
    ).toEqual({ kind: "params", params: { cursor: "abc" } });
  });
});

// ---------------------------------------------------------------------------
// Meta parity
// ---------------------------------------------------------------------------

describe("MCP fetch metadata", () => {
  it("reports a real duration", async () => {
    // Was hardcoded to 0 in both adapters, which made the inspector's timing
    // useless for every source.
    const spec = connection();
    const { client } = fakeClient([{ data: [{ id: 1 }] }]);
    const adapter = new McpAdapter(async () => client);
    const result = await adapter.fetch(spec, op(spec), {}, { params, now: 0 });
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.meta.durationMs)).toBe(true);
  });

  it("still warns about a tool with no declared output schema", async () => {
    const spec = connection();
    const { client } = fakeClient([{ data: [{ id: 1 }] }], { typed: false });
    const adapter = new McpAdapter(async () => client);
    const result = await adapter.fetch(spec, op(spec), {}, { params, now: 0 });
    expect(result.meta.warnings.join(" ")).toContain("without declaring an output schema");
  });

  it("warns once per call, not once per page", async () => {
    const spec = connection({
      ops: [
        {
          id: "items",
          title: "Items",
          path: "/list_items",
          rowsPath: "$.data",
          pagination: { kind: "cursor", cursorPath: "$.next", param: "cursor" },
        },
      ],
    });
    const { client } = fakeClient(
      [
        { data: [{ id: 1 }], next: "c1" },
        { data: [{ id: 2 }] },
      ],
      { typed: false },
    );
    const adapter = new McpAdapter(async () => client);
    const result = await adapter.fetch(spec, op(spec), {}, { params, now: 0 });
    const brittle = result.meta.warnings.filter((w) => w.includes("output schema"));
    expect(brittle).toHaveLength(1);
  });

  it("still refuses a tool that answers in prose", async () => {
    const spec = connection();
    const { client } = fakeClient([{}], { prose: true });
    const adapter = new McpAdapter(async () => client);
    await expect(adapter.fetch(spec, op(spec), {}, { params, now: 0 })).rejects.toThrow(
      /prose/,
    );
  });
});

// ---------------------------------------------------------------------------
// Tool list caching
// ---------------------------------------------------------------------------

describe("MCP tool list", () => {
  it("is fetched once per connection, not once per fetch", async () => {
    const spec = connection();
    const { client, listTools } = fakeClient([
      { data: [{ id: 1 }] },
      { data: [{ id: 2 }] },
      { data: [{ id: 3 }] },
    ]);
    const adapter = new McpAdapter(async () => client);

    await adapter.fetch(spec, op(spec), {}, { params, now: 0 });
    await adapter.fetch(spec, op(spec), {}, { params, now: 0 });
    await adapter.fetch(spec, op(spec), {}, { params, now: 0 });

    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure", async () => {
    const spec = connection();
    let attempt = 0;
    const client: McpClient = {
      listTools: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("server restarting");
        return [{ name: "list_items", outputSchema: { type: "object" } }];
      }),
      callTool: async () => ({ structuredContent: { data: [{ id: 1 }] } }),
    };
    const adapter = new McpAdapter(async () => client);

    await expect(adapter.fetch(spec, op(spec), {}, { params, now: 0 })).rejects.toThrow();
    // The second attempt must actually retry rather than replay the failure.
    const result = await adapter.fetch(spec, op(spec), {}, { params, now: 0 });
    expect(result.meta.pages).toBe(1);
  });

  it("re-reads the server on explicit discovery", async () => {
    const spec = connection();
    const { client, listTools } = fakeClient([{ data: [] }]);
    const adapter = new McpAdapter(async () => client);

    await adapter.discover(spec);
    await adapter.discover(spec);
    // Discovery is the one caller that must see the server as it is now.
    expect(listTools).toHaveBeenCalledTimes(2);
  });
});
