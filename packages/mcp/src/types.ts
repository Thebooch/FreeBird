import type {
  AuthContext,
  ComponentRegistry,
  ReviewableItem,
} from "@freebirdai/core";
import type { McpAccessMode } from "./access.js";
import type { ConfirmationTokenStore } from "./confirm.js";

/** Audit events emitted when MCP executes actions. Mirrors server shape. */
export type McpActionEvent =
  | {
      kind: "action.executed";
      sessionId: string;
      recordId: string;
      componentId: string;
      actionId: string;
      args: Record<string, unknown>;
      before?: unknown;
      changed?: string[];
      result?: unknown;
      source: "mcp";
      at: Date;
    }
  | {
      kind: "action.failed";
      sessionId: string;
      recordId: string;
      componentId: string;
      actionId: string;
      args: Record<string, unknown>;
      before?: unknown;
      message: string;
      source: "mcp";
      at: Date;
    }
  | {
      kind: "action.unauthorized";
      sessionId: string;
      recordId: string;
      componentId: string;
      actionId: string;
      args: Record<string, unknown>;
      reason?: string;
      source: "mcp";
      at: Date;
    }
  | {
      kind: "action.blocked";
      sessionId: string;
      recordId: string;
      componentId: string;
      actionId: string;
      args: Record<string, unknown>;
      message: string;
      blockers: import("@freebirdai/core").ActionBlocker[];
      source: "mcp";
      at: Date;
    };

export interface McpToolContext<TAuth = AuthContext> {
  auth: TAuth;
  sessionId: string;
}

export interface FreeBirdMcpServerOptions<TAuth = AuthContext> {
  /** Component registry with actions and optional dataSource/review. */
  registry: ComponentRegistry<any, TAuth>;
  /**
   * Global MCP access mode. Host must explicitly choose when constructing
   * the server — there is no default that exposes writes.
   */
  mode: McpAccessMode;
  /**
   * Resolve auth for each MCP tool invocation. Return null to reject the
   * call (e.g. MCP disabled for this tenant/user).
   */
  getAuthContext: () => TAuth | null | Promise<TAuth | null>;
  /**
   * Session id scoped to the MCP client connection. Used for action audit
   * trails and confirmation tokens.
   */
  sessionId?: string;
  /** Server name reported to MCP clients. */
  name?: string;
  /** Server version reported to MCP clients. */
  version?: string;
  /**
   * Host hook for MCP action audit events. Use to log, throttle, or bridge
   * into browser sessions.
   */
  onActionEvent?: (
    event: McpActionEvent,
    auth: TAuth,
  ) => void | Promise<void>;
  /**
   * Required when reviewable components exist. Mirrors chat
   * `executeExtraTool` for `review_items`.
   */
  executeReviewItems?: (
    input: {
      componentId: string;
      onlyConcerning?: boolean;
      limit?: number;
    },
    ctx: McpToolContext<TAuth>,
  ) => Promise<{ items: ReviewableItem[] }>;
  /** Props passed to dataSource when reading a component. Default `{}`. */
  defaultReadProps?: Record<string, unknown>;
  /** Confirmation token TTL. Default 5 minutes. */
  confirmationTokenTtlMs?: number;
}

export interface FreeBirdMcpServer<TAuth = AuthContext> {
  /** Underlying MCP SDK server instance. */
  mcp: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
  /** Connect to a transport (stdio, streamable HTTP, etc.). */
  connect: (
    transport: import("@modelcontextprotocol/sdk/shared/transport.js").Transport,
  ) => Promise<void>;
  /** Internal context shared by tool handlers. */
  readonly ctx: {
    registry: ComponentRegistry<any, TAuth>;
    mode: McpAccessMode;
    getAuthContext: () => TAuth | null | Promise<TAuth | null>;
    sessionId: string;
    onActionEvent?: FreeBirdMcpServerOptions<TAuth>["onActionEvent"];
    executeReviewItems?: FreeBirdMcpServerOptions<TAuth>["executeReviewItems"];
    defaultReadProps: Record<string, unknown>;
    confirmationTokens: ConfirmationTokenStore;
  };
}
