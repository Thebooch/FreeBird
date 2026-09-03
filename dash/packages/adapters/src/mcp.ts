import type { ConnectionSpec, OpSpec } from "@freebirdai/dash-spec";
import { interpolate } from "@freebirdai/dash-spec";
import { mergePages, nextPageParams } from "./paginate.js";
import {
  AdapterError,
  type FetchContext,
  type FetchResult,
  type SourceAdapter,
} from "./types.js";

/**
 * The slice of an MCP client this adapter needs.
 *
 * Injected rather than importing the SDK so `@freebirdai/dash-adapters` stays free of
 * transport dependencies — the server supplies a real client, tests supply a
 * fake. Same pattern as `HttpFetch`.
 */
export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  /**
   * The whole reason MCP is a first-class source: a declared output schema is
   * a typed contract, which removes the inference problem for this tool
   * entirely — no sampling, no LLM guessing at shape, no drift detection.
   */
  readonly outputSchema?: unknown;
}

export interface McpToolResult {
  readonly structuredContent?: unknown;
  readonly content?: ReadonlyArray<{ type: string; text?: string }>;
  readonly isError?: boolean;
}

export interface McpClient {
  listTools(): Promise<readonly McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export type McpClientFactory = (connection: ConnectionSpec) => Promise<McpClient>;

/** JSON hiding inside a prose response — the unstructured-tool fallback. */
const extractJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* not bare JSON */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* not fenced JSON either */
    }
  }
  const first = trimmed.search(/[[{]/);
  if (first >= 0) {
    const candidate = trimmed.slice(first);
    try {
      return JSON.parse(candidate);
    } catch {
      /* give up and hand back the text */
    }
  }
  return null;
};

export interface McpTierInfo {
  readonly name: string;
  /** `typed` tools skip inference entirely; `brittle` ones are best-effort. */
  readonly tier: "typed" | "brittle";
  readonly description: string | undefined;
}

/** Classify a server's tools so the UI can warn about the brittle ones. */
export const tierTools = (tools: readonly McpToolInfo[]): McpTierInfo[] =>
  tools.map((tool) => ({
    name: tool.name,
    tier: tool.outputSchema ? "typed" : "brittle",
    description: tool.description,
  }));

export class McpAdapter implements SourceAdapter {
  readonly kind = "mcp" as const;
  /** Session-oriented auth and stdio transports do not belong in a browser. */
  readonly transport = "proxy" as const;

  private readonly clients = new Map<string, Promise<McpClient>>();
  /**
   * One tool list per connection, not one per fetch.
   *
   * `fetch` needs the list to find the tool it is calling, and was asking for
   * it every single time — a round trip per widget per refresh, to learn
   * something that changes only when the server restarts. Cached beside the
   * client and dropped with it, and like the client a failure is never cached.
   */
  private readonly toolLists = new Map<string, Promise<readonly McpToolInfo[]>>();

  constructor(private readonly factory: McpClientFactory) {}

  private client(connection: ConnectionSpec): Promise<McpClient> {
    const existing = this.clients.get(connection.id);
    if (existing) return existing;
    const created = this.factory(connection).catch((error: unknown) => {
      // Do not cache a failed connection — the server may just be restarting.
      this.clients.delete(connection.id);
      this.toolLists.delete(connection.id);
      throw new AdapterError(
        error instanceof Error ? error.message : String(error),
        {
          status: 502,
          userMessage: `Could not connect to the ${connection.title} MCP server.`,
        },
      );
    });
    this.clients.set(connection.id, created);
    return created;
  }

  private tools(connection: ConnectionSpec): Promise<readonly McpToolInfo[]> {
    const existing = this.toolLists.get(connection.id);
    if (existing) return existing;
    const created = this.client(connection)
      .then((client) => client.listTools())
      .catch((error: unknown) => {
        this.toolLists.delete(connection.id);
        throw error;
      });
    this.toolLists.set(connection.id, created);
    return created;
  }

  /** Drop the cached client and tool list, so the next call reconnects. */
  invalidate(connectionId: string): void {
    this.clients.delete(connectionId);
    this.toolLists.delete(connectionId);
  }

  /** Discovery: a server's tool list becomes the connection's operations. */
  async discover(connection: ConnectionSpec): Promise<McpTierInfo[]> {
    // Discovery is the one caller that must see the server as it is now.
    this.toolLists.delete(connection.id);
    return tierTools(await this.tools(connection));
  }

  async fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    const started = Date.now();
    const client = await this.client(connection);
    const warnings: string[] = [];

    // The op's path names the tool; query entries are its arguments.
    const toolName = op.path.replace(/^\//, "");
    const baseArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(op.query)) {
      baseArgs[key] = typeof value === "string" ? interpolate(value, ctx.params) : value;
    }
    for (const [key, value] of Object.entries(overrides)) {
      const resolved = typeof value === "string" ? interpolate(value, ctx.params) : value;
      if (resolved === "") continue;
      baseArgs[key] = resolved;
    }

    const tools = await this.tools(connection);
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new AdapterError(`the ${connection.title} server has no tool "${toolName}"`, {
        status: 404,
        userMessage: `"${op.title}" is no longer offered by ${connection.title}.`,
      });
    }

    /*
     * The same pagination spec REST uses, with the token going into the tool's
     * arguments instead of a query string. A `link-header` strategy has no MCP
     * meaning at all — there are no headers — so it is reported rather than
     * silently treated as a single page.
     */
    if (op.pagination.kind === "link-header") {
      warnings.push(
        "this connection declares link-header pagination, which MCP has no equivalent for; only the first page was read",
      );
    }

    const pages: unknown[] = [];
    let args: Record<string, unknown> = { ...baseArgs };
    let pageIndex = 0;
    let truncated = false;
    let more = true;

    while (more && pageIndex < op.maxPages) {
      const result = await client.callTool(toolName, args);
      if (result.isError) {
        const text = result.content?.map((part) => part.text ?? "").join(" ") ?? "";
        throw new AdapterError(`tool "${toolName}" failed: ${text}`, {
          status: 502,
          userMessage: `${connection.title} could not complete "${op.title}".`,
        });
      }

      pages.push(readToolBody(result, tool, toolName, op, warnings, pageIndex));
      pageIndex++;

      const next =
        op.pagination.kind === "link-header"
          ? ({ kind: "none" } as const)
          : nextPageParams({
              pagination: op.pagination,
              body: pages[pages.length - 1],
              rowsPath: op.rowsPath,
              pageIndex,
            });

      if (next.kind === "params") {
        args = { ...args, ...next.params };
        if (pageIndex >= op.maxPages) {
          // Say so loudly, exactly as REST does: a silently truncated result
          // is a chart that is quietly incomplete.
          truncated = true;
          warnings.push(
            `stopped after ${op.maxPages} page(s); there is more data behind this tool`,
          );
        }
      } else {
        more = false;
      }
    }

    return {
      body: pages.length === 1 ? pages[0] : mergePages(pages, op.rowsPath, warnings),
      meta: {
        url: `mcp://${connection.id}/${toolName}`,
        status: 200,
        fetchedAt: started,
        durationMs: Date.now() - started,
        pages: pageIndex,
        truncated,
        warnings,
      },
    };
  }
}

/**
 * The data inside one tool result, and how much to trust it.
 *
 * Three tiers, and the warnings are the point: a declared `outputSchema` is a
 * contract, structured content without one is a shape that may change without
 * notice, and prose that happens to contain JSON is a binding that breaks when
 * the wording does. Only the first is safe to build on, and a reader deserves
 * to know which they have. Warned once, on the first page, rather than once
 * per page of the same call.
 */
const readToolBody = (
  result: McpToolResult,
  tool: McpToolInfo,
  toolName: string,
  op: OpSpec,
  warnings: string[],
  pageIndex: number,
): unknown => {
  const first = pageIndex === 0;
  if (tool.outputSchema && result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (result.structuredContent !== undefined) {
    if (first) {
      warnings.push(
        `"${toolName}" returned structured data without declaring an output schema — its shape may change without warning`,
      );
    }
    return result.structuredContent;
  }
  const text = result.content?.map((part) => part.text ?? "").join("\n") ?? "";
  const parsed = extractJson(text);
  if (parsed === null) {
    throw new AdapterError(`tool "${toolName}" returned prose, not data`, {
      status: 422,
      userMessage: `"${op.title}" answers in prose rather than data, so it cannot drive a widget directly.`,
    });
  }
  if (first) {
    warnings.push(
      `"${toolName}" returned text that had to be parsed as JSON — this binding is brittle and may break when the wording changes`,
    );
  }
  return parsed;
};
