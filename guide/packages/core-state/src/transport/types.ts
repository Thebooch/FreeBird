import type {
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  CustomTab,
  DigestConfig,
  GridCell,
  LayoutPlan,
  FileTicketBody,
  Ticket,
  QuestionAnswer,
} from "@freebirdai/core";
import type { ActionState } from "../actions/state.js";

/** Result of `transport.confirmAction`. */
export interface ConfirmActionResult {
  ok: boolean;
  recordId: string;
  result?: unknown;
  before?: unknown;
  changed?: string[];
  /** Set when `ok === false`. */
  error?: string;
  blocked?: boolean;
  message?: string;
  blockers?: import("@freebirdai/core").ActionBlocker[];
}

/**
 * The FreeBird client transport. Implementations decide *how* the browser
 * talks to the engine — typically HTTP+SSE against `@freebirdai/server`, but
 * could also be an in-memory transport for SSR/tests.
 */
export interface FreeBirdTransport {
  // chat
  createSession: (input: { title?: string; topic?: string; tags?: string[] }) => Promise<ChatSession>;
  listMessages: (sessionId: string) => Promise<ChatMessage[]>;
  streamMessage: (input: {
    sessionId: string;
    text: string;
    lockedCells?: GridCell[];
    /**
     * Snapshot of the client's action state. Lets the server harness
     * gate which action tools the LLM may call (e.g. only `update_action_args`
     * when collecting). Optional for backwards-compat.
     */
    actionState?: ActionState;
    /** Component ids currently visible. Scopes `start_action` candidates. */
    activeComponentIds?: string[];
    /** Answers to questions asked on an earlier turn. */
    answers?: QuestionAnswer[];
    supportContext?: {
      subject?: Record<string, unknown>;
      transcriptExcerpt?: string;
      metadata?: Record<string, unknown>;
    };
    signal?: AbortSignal;
  }) => AsyncIterable<ChatStreamEvent>;

  fileTicket: (
    input: FileTicketBody,
  ) => Promise<{ ok: boolean; ticket?: Ticket; error?: string }>;

  // layout
  getActiveLayout: (sessionId: string) => Promise<LayoutPlan | null>;

  // actions
  /**
   * Confirm and execute the pending action. Servers should:
   *   1. Re-validate args against the action's Zod schema.
   *   2. Capture `before` via `def.readCurrent` if present.
   *   3. Invoke `def.handler`.
   *   4. Compute `changed` = diff(before, args).
   *   5. Persist an audit `ChatMessage` and emit `onActionEvent`.
   */
  confirmAction: (input: {
    sessionId: string;
    recordId: string;
    componentId: string;
    actionId: string;
    args: Record<string, unknown>;
  }) => Promise<ConfirmActionResult>;

  cancelAction: (input: {
    sessionId: string;
    recordId: string;
    reason?: string;
  }) => Promise<{ ok: true }>;

  updateActionArgs: (input: {
    sessionId: string;
    recordId: string;
    componentId?: string;
    actionId?: string;
    args: Record<string, unknown>;
  }) => Promise<{ ok: boolean; missing: string[]; error?: string }>;

  // custom tabs
  listTabs: () => Promise<CustomTab[]>;
  saveTab: (input: { title: string; layout: LayoutPlan; digest?: DigestConfig }) => Promise<CustomTab>;
  getTab: (id: string) => Promise<CustomTab | null>;
  updateTab: (id: string, input: Partial<Pick<CustomTab, "title" | "layout" | "digest">>) => Promise<CustomTab>;
  deleteTab: (id: string) => Promise<void>;

  // info trigger / knowledge lookup
  explainComponent: (input: { sessionId: string; componentId: string }) => AsyncIterable<ChatStreamEvent>;
}
