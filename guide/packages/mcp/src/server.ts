import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomUUID } from "node:crypto";
import { resolveToolAccess } from "./access.js";
import { ConfirmationTokenStore } from "./confirm.js";
import {
  handleDescribeAction,
  handleExecuteAction,
  handleListActions,
  handlePrepareAction,
  handleReadComponent,
  handleReviewItems,
  TOOL_NAMES,
  toolInputSchemas,
  type McpRuntimeContext,
} from "./tools.js";
import type { FreeBirdMcpServer, FreeBirdMcpServerOptions } from "./types.js";

const SERVER_INSTRUCTIONS = [
  "FreeBird MCP exposes registered component actions and optional read surfaces.",
  "For writes: call freebird_list_actions or freebird_describe_action to learn schemas,",
  "then freebird_prepare_action with partial args — it returns missing[] for incomplete payloads.",
  "When requiresConfirmation is true, freebird_prepare_action returns confirmationToken;",
  "pass it to freebird_execute_action.",
  "Security: ActionDefinition.authorize() is the permission boundary — not activeComponentIds.",
].join(" ");

/**
 * Create an opt-in FreeBird MCP server. The host must explicitly construct
 * and connect this server; omitting it means no MCP surface exists.
 */
export const createFreeBirdMcpServer = <TAuth = unknown>(
  options: FreeBirdMcpServerOptions<TAuth>,
): FreeBirdMcpServer<TAuth> => {
  const sessionId = options.sessionId ?? randomUUID();
  const confirmationTokens = new ConfirmationTokenStore(
    options.confirmationTokenTtlMs,
  );

  const runtime: McpRuntimeContext<TAuth> = {
    registry: options.registry,
    mode: options.mode,
    getAuthContext: options.getAuthContext,
    sessionId,
    onActionEvent: options.onActionEvent,
    executeReviewItems: options.executeReviewItems,
    defaultReadProps: options.defaultReadProps ?? {},
    confirmationTokens,
  };

  const mcp = new McpServer(
    {
      name: options.name ?? "freebird",
      version: options.version ?? "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const access = resolveToolAccess(options.mode);

  if (access.metadata) {
    mcp.registerTool(
      TOOL_NAMES.listActions,
      {
        description:
          "List actions and readable/reviewable components exposed via MCP for this host.",
        inputSchema: {},
      },
      async () => handleListActions(runtime),
    );

    mcp.registerTool(
      TOOL_NAMES.describeAction,
      {
        description:
          "Describe one action: JSON Schema, required fields, and confirmation policy.",
        inputSchema: toolInputSchemas.describeAction.shape,
      },
      async (input) => handleDescribeAction(runtime, input),
    );
  }

  if (access.dataRead) {
    mcp.registerTool(
      TOOL_NAMES.readComponent,
      {
        description:
          "Read a component's dataSource snapshot (when the component allows MCP reads).",
        inputSchema: toolInputSchemas.readComponent.shape,
      },
      async (input) => handleReadComponent(runtime, input),
    );

    mcp.registerTool(
      TOOL_NAMES.reviewItems,
      {
        description:
          "Load reviewable items for a component that declares review capability.",
        inputSchema: toolInputSchemas.reviewItems.shape,
      },
      async (input) => handleReviewItems(runtime, input),
    );
  }

  if (access.write) {
    mcp.registerTool(
      TOOL_NAMES.prepareAction,
      {
        description:
          "Validate partial action args. Returns missing[] for incomplete payloads and a confirmationToken when ready and confirmation is required.",
        inputSchema: toolInputSchemas.prepareAction.shape,
      },
      async (input) => handlePrepareAction(runtime, input),
    );

    mcp.registerTool(
      TOOL_NAMES.executeAction,
      {
        description:
          "Execute a registered action. Requires confirmationToken from freebird_prepare_action when the action requires confirmation.",
        inputSchema: toolInputSchemas.executeAction.shape,
      },
      async (input) => handleExecuteAction(runtime, input),
    );
  }

  return {
    mcp,
    connect: async (transport: Transport) => {
      await mcp.connect(transport);
    },
    ctx: runtime,
  };
};
