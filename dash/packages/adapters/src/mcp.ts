import type { ConnectionSpec, OpSpec } from "@freebirdai/dash-spec";
import { interpolate } from "@freebirdai/dash-spec";
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

  constructor(private readonly factory: McpClientFactory) {}

  private client(connection: ConnectionSpec): Promise<McpClient> {
    const existing = this.clients.get(connection.id);
    if (existing) return existing;
    const created = this.factory(connection).catch((error: unknown) => {
      // Do not cache a failed connection — the server may just be restarting.
      this.clients.delete(connection.id);
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

  /** Discovery: a server's tool list becomes the connection's operations. */
  async discover(connection: ConnectionSpec): Promise<McpTierInfo[]> {
    const client = await this.client(connection);
    return tierTools(await client.listTools());
  }

  async fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    const client = await this.client(connection);

    // The op's path names the tool; query entries are its arguments.
    const toolName = op.path.replace(/^\//, "");
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(op.query)) {
      args[key] = typeof value === "string" ? interpolate(value, ctx.params) : value;
    }
    for (const [key, value] of Object.entries(overrides)) {
      const resolved = typeof value === "string" ? interpolate(value, ctx.params) : value;
      if (resolved === "") continue;
      args[key] = resolved;
    }

    const tools = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new AdapterError(`the ${connection.title} server has no tool "${toolName}"`, {
        status: 404,
        userMessage: `"${op.title}" is no longer offered by ${connection.title}.`,
      });
    }

    const result = await client.callTool(toolName, args);
    if (result.isError) {
      const text = result.content?.map((part) => part.text ?? "").join(" ") ?? "";
      throw new AdapterError(`tool "${toolName}" failed: ${text}`, {
        status: 502,
        userMessage: `${connection.title} could not complete "${op.title}".`,
      });
    }

    const warnings: string[] = [];
    let body: unknown;

    if (tool.outputSchema && result.structuredContent !== undefined) {
      // The fast path: a typed contract, taken at its word.
      body = result.structuredContent;
    } else if (result.structuredContent !== undefined) {
      body = result.structuredContent;
      warnings.push(
        `"${toolName}" returned structured data without declaring an output schema — its shape may change without warning`,
      );
    } else {
      const text = result.content?.map((part) => part.text ?? "").join("\n") ?? "";
      const parsed = extractJson(text);
      if (parsed === null) {
        throw new AdapterError(`tool "${toolName}" returned prose, not data`, {
          status: 422,
          userMessage: `"${op.title}" answers in prose rather than data, so it cannot drive a widget directly.`,
        });
      }
      body = parsed;
      warnings.push(
        `"${toolName}" returned text that had to be parsed as JSON — this binding is brittle and may break when the wording changes`,
      );
    }

    return {
      body,
      meta: {
        url: `mcp://${connection.id}/${toolName}`,
        status: 200,
        fetchedAt: ctx.now,
        durationMs: 0,
        pages: 1,
        truncated: false,
        warnings,
      },
    };
  }
}
