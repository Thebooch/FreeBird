/*
 * By hand: ask a public MCP server for its tools through the guarded
 * transport, to check the client against a real implementation.
 *
 *   npx tsx src/mcp/live-probe.mts https://mcp.deepwiki.com/mcp
 */
import { connectionSchema } from "@freebirdai/dash-spec";
import { nodeHttp } from "../server.js";
import { openMcpClient } from "@freebirdai/connect/mcp/client";
import { toolOps } from "@freebirdai/connect/mcp/discover";

const url = process.argv[2];
if (!url) throw new Error("usage: live-probe.mts <mcp server url>");
const connection = connectionSchema.parse({ id: "probe", title: new URL(url).hostname, kind: "mcp", baseUrl: url, ops: [] });
const client = await openMcpClient(connection, { http: nodeHttp, resolveSecret: async () => null });
console.log("server:", JSON.stringify(client.server));
const tools = await client.listTools();
for (const tool of tools) console.log(`- ${tool.name}${tool.readOnly === true ? " (read-only)" : tool.readOnly === false ? " (changes things)" : " (says nothing)"}${tool.outputSchema ? " typed" : ""}`);
const { ops, left } = toolOps(tools);
console.log(`endpoints: ${ops.map((one) => one.id).join(", ") || "none"}; left out: ${left.join(", ") || "none"}`);
