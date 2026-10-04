import { prepareAuth, type HttpFetch, type McpClient, type McpToolInfo, type McpToolResult } from "@freebirdai/dash-adapters";
import { allowedHost, type ConnectionSpec } from "@freebirdai/dash-spec";

/**
 * An MCP server, reached over streamable HTTP.
 *
 * Only what reading needs: `initialize`, `tools/list`, `tools/call`. Written
 * over the server's own transport rather than an SDK's, so a connection to an
 * MCP server is held to exactly what any other connection is: the SSRF guard,
 * a host pinned to the connection's address, the credential broker, and — in
 * the benchmark and in tests — a transport that answers in process.
 *
 * Each JSON-RPC request is one POST. The server answers with JSON, or with an
 * event stream that carries the answer as one of its messages; both are read
 * whole, since the stream ends once the answer is sent.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Tool lists are paged by cursor; a server with more pages than this is not read further. */
const MAX_TOOL_PAGES = 20;

export class McpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface RpcAnswer {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
  readonly id?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The JSON-RPC answer to request `id`, out of a JSON body or an event stream. */
export const rpcAnswerIn = (text: string, contentType: string | null, id: number): RpcAnswer | null => {
  const matches = (value: unknown): value is RpcAnswer => isRecord(value) && value.id === id && ("result" in value || "error" in value);
  const fromJson = (raw: string): RpcAnswer | null => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.find(matches) ?? null;
      return matches(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  if (!(contentType ?? "").toLowerCase().includes("text/event-stream")) return fromJson(text);
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    const answer = data === "" ? null : fromJson(data);
    if (answer) return answer;
  }
  return null;
};

export interface McpHttpDeps {
  readonly http: HttpFetch;
  readonly resolveSecret: (keyRef: string) => Promise<string | null>;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

/** What the server said about itself when the session opened. */
export interface McpServerInfo {
  readonly name?: string;
  readonly version?: string;
  readonly protocolVersion: string;
  readonly instructions?: string;
}

export interface HttpMcpClient extends McpClient {
  readonly server: McpServerInfo;
}

/** Open a session with the MCP server a connection points at. */
export const openMcpClient = async (connection: ConnectionSpec, deps: McpHttpDeps): Promise<HttpMcpClient> => {
  const url = connection.baseUrl;
  if (!url) throw new McpError(`${connection.title} has no address`);
  const host = allowedHost(connection);
  let session: string | null = null;
  let version = MCP_PROTOCOL_VERSION;
  /* Once the server has said which version it speaks, every request names it. */
  let ready = false;
  let nextId = 1;

  const post = async (body: unknown, id: number | null): Promise<RpcAnswer | null> => {
    /* The connection's own sign-in, resolved for every request: an OAuth token may have been renewed. */
    const prepared = await prepareAuth(connection, connection.auth, deps.resolveSecret);
    const target = new URL(url);
    for (const [name, value] of prepared.query) target.searchParams.set(name, value);
    const response = await deps.http(
      target.toString(),
      {
        method: "POST",
        headers: {
          ...prepared.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(ready ? { "mcp-protocol-version": version } : {}),
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify(body),
        purpose: "read",
        ...(connection.privateNetwork ? { privateNetwork: true } : {}),
      },
      host,
    );
    if (response.status === 401 || response.status === 403)
      throw new McpError(`${connection.title} refused the sign-in (${response.status})`, response.status);
    if (response.status >= 400) throw new McpError(`${connection.title} answered ${response.status}`, response.status);
    const opened = response.header("mcp-session-id");
    if (opened) session = opened;
    if (id === null) return null;
    const answer = rpcAnswerIn(response.text, response.header("content-type"), id);
    if (!answer) throw new McpError(`${connection.title} did not answer the request`);
    return answer;
  };

  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++;
    const answer = await post({ jsonrpc: "2.0", id, method, params }, id);
    if (answer?.error) throw new McpError(answer.error.message ?? `${method} failed`, undefined, answer.error.code);
    return answer?.result;
  };

  const initialize = async (): Promise<McpServerInfo> => {
    session = null;
    ready = false;
    const result = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: deps.clientName ?? "freebird-dash", version: deps.clientVersion ?? "0.1.0" },
    });
    const info = isRecord(result) ? result : {};
    if (typeof info.protocolVersion === "string") version = info.protocolVersion;
    ready = true;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, null);
    const server = isRecord(info.serverInfo) ? info.serverInfo : {};
    return {
      protocolVersion: version,
      ...(typeof server.name === "string" ? { name: server.name } : {}),
      ...(typeof server.version === "string" ? { version: server.version } : {}),
      ...(typeof info.instructions === "string" ? { instructions: info.instructions.slice(0, 2000) } : {}),
    };
  };

  const server = await initialize();

  /** A session the server has forgotten (404) is opened again, once, and the request sent again. */
  const withSession = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof McpError) || error.status !== 404 || !session) throw error;
      await initialize();
      return run();
    }
  };

  return {
    server,
    async listTools(): Promise<readonly McpToolInfo[]> {
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const result = await withSession(() => request("tools/list", cursor ? { cursor } : {}));
        const listed = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
        for (const tool of listed) {
          if (!isRecord(tool) || typeof tool.name !== "string") continue;
          const annotations = isRecord(tool.annotations) ? tool.annotations : {};
          tools.push({
            name: tool.name,
            ...(typeof tool.title === "string" ? { title: tool.title } : {}),
            ...(typeof tool.description === "string" ? { description: tool.description } : {}),
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
            ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
            ...(typeof annotations.readOnlyHint === "boolean" ? { readOnly: annotations.readOnlyHint } : {}),
            ...(annotations.destructiveHint === true ? { destructive: true } : {}),
          });
        }
        cursor = isRecord(result) && typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      const result = await withSession(() => request("tools/call", { name, arguments: args }));
      const answer = isRecord(result) ? result : {};
      return {
        ...(answer.structuredContent !== undefined ? { structuredContent: answer.structuredContent } : {}),
        ...(Array.isArray(answer.content)
          ? {
              content: answer.content
                .filter(isRecord)
                .map((part) => ({ type: String(part.type ?? "text"), ...(typeof part.text === "string" ? { text: part.text } : {}) })),
            }
          : {}),
        ...(answer.isError === true ? { isError: true } : {}),
      };
    },
  };
};
