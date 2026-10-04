import type { HttpFetch, McpToolInfo } from "@freebirdai/dash-adapters";
import { catalogEntrySchema, connectionSchema, type CatalogEntry, type ParamDef } from "@freebirdai/dash-spec";
import { fieldsFromSchema } from "../discovery/schema-fields.js";
import { McpError, openMcpClient, type McpServerInfo } from "./client.js";

/**
 * An MCP server as a connection: its tools that only read
 * become the connection's endpoints.
 *
 * A tool is a call, and nothing about the protocol says a call reads. So a
 * tool becomes an endpoint only on one of two grounds, and says which:
 *
 * - the server's own word, `readOnlyHint` (`readSafety: spec-declared`);
 * - or, where the server says nothing either way, its name: it begins with a
 *   word for reading (list, get, read, search…) and no word in it names a
 *   change (`readSafety: docs-inferred`) — the rule a search sent with POST is
 *   imported under. Most servers annotate nothing, and their `list_…` tools
 *   are what a board is for.
 *
 * Either way it is a read on somebody's word, not the protocol's: never
 * warmed in the background, never retried, journalled each time it is sent.
 * A tool the server marks as changing or destroying things, or whose name
 * does not say it reads, is never called for a board, and the import says
 * which were left out.
 */

const READ_VERBS = new Set(["list", "get", "read", "search", "find", "fetch", "query", "lookup", "retrieve", "browse", "describe", "count", "show", "view"]);
const CHANGE_WORDS = new Set([
  ...["create", "add", "new", "update", "edit", "set", "delete", "remove", "send", "submit", "cancel", "approve", "close", "open", "upload"],
  ...["import", "export", "batch", "bulk", "start", "stop", "run", "trigger", "charge", "refund", "pay", "void", "write", "post", "put", "patch"],
  ...["manage", "generate", "install", "enable", "disable", "assign", "move", "merge", "reset", "revoke", "execute", "invoke", "test"],
]);

const nameWords = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");

/** On what ground a tool is a read, or null when nothing says it is. */
export const readGround = (tool: McpToolInfo): { basis: "spec-declared" | "docs-inferred"; note: string } | null => {
  if (tool.readOnly === false || tool.destructive === true) return null;
  if (tool.readOnly === true) return { basis: "spec-declared", note: "The server marks this tool as one that only reads." };
  const named = nameWords(tool.name);
  return named.length > 0 && READ_VERBS.has(named[0]!) && !named.some((word) => CHANGE_WORDS.has(word))
    ? { basis: "docs-inferred", note: `Named ${tool.name}: a name for reading, with no word for a change in it. The server does not say either way.` }
    : null;
};

type CatalogOp = CatalogEntry["ops"][number];
type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

const slug = (value: string, fallback: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || fallback;

const words = (name: string): string => {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const paramType = (schema: unknown): ParamDef["type"] => {
  const type = isRecord(schema) ? schema.type : undefined;
  const format = isRecord(schema) ? schema.format : undefined;
  if (format === "date" || format === "date-time") return "date";
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return "array";
  return "string";
};

/** A tool's arguments, as the parameters of the endpoint it becomes. */
const paramsOf = (tool: McpToolInfo): ParamDef[] => {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties)
    .slice(0, 60)
    .map(([name, property]) => {
      const described = isRecord(property) && typeof property.description === "string" ? property.description.slice(0, 300) : undefined;
      const fallback = isRecord(property) ? property.default : undefined;
      const allowed = isRecord(property) && Array.isArray(property.enum) ? property.enum.filter((one) => typeof one === "string").slice(0, 50) : [];
      return {
        name,
        in: "query" as const,
        type: paramType(property),
        required: required.has(name),
        ...(described ? { description: described } : {}),
        ...(allowed.length > 0 ? { enum: allowed as string[] } : {}),
        ...(typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean" ? { default: fallback } : {}),
      };
    });
};

/** Where a typed tool's records are, and what they hold, from the schema it declares for its answer. */
const shapeOf = (tool: McpToolInfo): { rowsPath?: string; fields?: CatalogOp["fields"] } => {
  const schema = isRecord(tool.outputSchema) ? tool.outputSchema : null;
  if (!schema) return {};
  const same = (node: unknown) => node;
  if (schema.type === "array") {
    const fields = fieldsFromSchema(schema, same, "$");
    return { rowsPath: "$", ...(fields.length > 0 ? { fields } : {}) };
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const lists = Object.entries(properties).filter(
    ([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && isRecord(value) && value.type === "array" && isRecord(value.items) && value.items.type === "object",
  );
  if (lists.length === 1) {
    const rowsPath = `$.${lists[0]![0]}`;
    const fields = fieldsFromSchema(schema, same, rowsPath);
    return { rowsPath, ...(fields.length > 0 ? { fields } : {}) };
  }
  return {};
};

/** The tools that say they only read, as endpoints; and the names of those that do not. */
export const toolOps = (tools: readonly McpToolInfo[]): { ops: CatalogOp[]; left: string[] } => {
  const ops: CatalogOp[] = [];
  const left: string[] = [];
  const taken = new Set<string>();
  for (const tool of tools) {
    const ground = readGround(tool);
    if (!ground) {
      left.push(tool.name);
      continue;
    }
    let id = slug(tool.name, "tool");
    for (let suffix = 2; taken.has(id); suffix++) id = `${slug(tool.name, "tool").slice(0, 56)}_${suffix}`;
    taken.add(id);
    const shape = shapeOf(tool);
    const parsed = catalogEntrySchema.shape.ops.removeDefault().element.safeParse({
      id,
      title: (tool.title ?? words(tool.name)).slice(0, 120),
      /* The tool's name is its address: see `McpAdapter`. */
      path: `/${tool.name}`,
      archetype: "list",
      ...(tool.description ? { description: tool.description.replace(/\s+/g, " ").trim().slice(0, 400) } : {}),
      ...(shape.rowsPath ? { rowsPath: shape.rowsPath } : {}),
      ...(shape.fields ? { fields: shape.fields } : {}),
      params: paramsOf(tool),
      readSafety: ground,
    });
    if (parsed.success) ops.push(parsed.data);
    else left.push(tool.name);
  }
  return { ops, left };
};

export interface McpDiscovery {
  readonly entry: CatalogEntry;
  readonly warnings: string[];
  readonly note: string;
}

const entryId = (url: string, server: McpServerInfo | null): string =>
  ((server?.name ?? new URL(url).hostname.replace(/^(mcp|api|www)\./, "")) || "mcp")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "mcp";

const leftOut = (left: readonly string[]): string =>
  `${left.length} tool${left.length === 1 ? "" : "s"} ${left.length === 1 ? "is" : "are"} not known to only read, and ${left.length === 1 ? "was" : "were"} left out: ${left.slice(0, 6).join(", ")}${left.length > 6 ? ", and others" : ""}. A board only ever calls a tool its server marks read-only, or one named for reading that nothing says changes anything.`;

/**
 * Whether an address is an MCP server, and if so what it offers. Null when it
 * does not answer as one. An address that answers but refuses without a key
 * becomes an entry that asks for one, with its tools read once the key is in.
 */
export const discoverMcp = async (url: string, deps: { readonly http: HttpFetch }): Promise<McpDiscovery | null> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const address = url.replace(/\/+$/, "");
  const probe = connectionSchema.parse({ id: "mcp-probe", title: parsed.hostname, kind: "mcp", baseUrl: address, ops: [] });
  const keyRef = "mcp-key";
  const base = (server: McpServerInfo | null) => {
    const id = entryId(address, server);
    return { id, title: server?.name ?? parsed.hostname, kind: "mcp" as const, baseUrl: address, origin: "docs" as const, verified: false };
  };
  try {
    const client = await openMcpClient(probe, { http: deps.http, resolveSecret: async () => null });
    const tools = await client.listTools();
    const { ops, left } = toolOps(tools);
    const warnings = left.length > 0 ? [leftOut(left)] : [];
    const entry = catalogEntrySchema.safeParse({
      ...base(client.server),
      dialect: { auth: { type: "none" }, pagination: { kind: "none" } },
      authRequired: false,
      ops,
      resources: [],
      ...(client.server.instructions ? { notes: client.server.instructions.slice(0, 1000) } : {}),
    });
    if (!entry.success) return null;
    return {
      entry: entry.data,
      warnings,
      note: `An MCP server offering ${tools.length} tool${tools.length === 1 ? "" : "s"}; ${ops.length} only read${ops.length === 1 ? "s" : ""} and ${ops.length === 1 ? "is" : "are"} set up as endpoints.`,
    };
  } catch (error) {
    if (!(error instanceof McpError) || (error.status !== 401 && error.status !== 403)) return null;
    /* It is there, and wants a key before it says anything: asked for, and read once it is in. */
    const entry = catalogEntrySchema.safeParse({
      ...base(null),
      id: `${entryId(address, null)}-mcp`.slice(0, 64),
      dialect: { auth: { type: "bearer", keyRef }, pagination: { kind: "none" } },
      ops: [],
      resources: [],
      keyHelp: "This MCP server needs an access token. Paste the token its provider gives you for connecting clients.",
    });
    return entry.success
      ? { entry: entry.data, warnings: [], note: "An MCP server that needs an access token before it lists its tools." }
      : null;
  }
};

/** Whether an address is worth asking as an MCP server before anything else: its path or host says so. */
export const looksLikeMcpAddress = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return /(^|\/)(mcp|sse)\/?$/i.test(parsed.pathname) || /^mcp[.-]/i.test(parsed.hostname);
  } catch {
    return false;
  }
};
