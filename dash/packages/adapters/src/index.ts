export { InlineAdapter } from "./inline.js";
export type { InlineFixture, InlineResolver } from "./inline.js";
export { McpAdapter, tierTools } from "./mcp.js";
export type { McpClient, McpClientFactory, McpTierInfo, McpToolInfo, McpToolResult } from "./mcp.js";
export { ProxyAdapter } from "./proxy.js";
export { AdapterRegistry } from "./registry.js";
export { RestAdapter } from "./rest.js";
export type { HttpFetch, HttpResponse } from "./rest.js";
export { AdapterError, emptyMeta } from "./types.js";
export type {
  FetchContext,
  FetchMeta,
  FetchResult,
  SourceAdapter,
  Transport,
} from "./types.js";
