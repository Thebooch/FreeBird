import type { ActionRecord, ActionState } from "./state.js";

/**
 * Audit event emitted by {@link FreeBirdStore.onActionEvent}.
 *
 * Hosts decide what to do with these. Common patterns:
 *   - log to a `chat_messages` row with role: "tool"
 *   - mirror the journal into a server-side audit table for compliance
 *   - trigger an undo toast on `action.executed`
 *   - feed `before` + `args` + `changed` into a custom revert button
 *
 * Events are best-effort: failures inside `onActionEvent` listeners are
 * caught and logged, never bubbled.
 */
export type ActionEvent =
  | {
      kind: "action.started";
      record: ActionRecord;
      state: ActionState;
      at: Date;
    }
  | {
      kind: "action.args_updated";
      recordId: string;
      args: Record<string, unknown>;
      missing: string[];
      at: Date;
    }
  | {
      kind: "action.confirmed";
      recordId: string;
      at: Date;
    }
  | {
      kind: "action.executed";
      record: ActionRecord;
      before?: unknown;
      args: Record<string, unknown>;
      changed?: string[];
      result?: unknown;
      at: Date;
    }
  | {
      kind: "action.failed";
      record: ActionRecord;
      before?: unknown;
      args: Record<string, unknown>;
      message: string;
      at: Date;
    }
  | {
      kind: "action.cancelled";
      record: ActionRecord | null;
      reason?: string;
      at: Date;
    }
  | {
      kind: "action.paused";
      record: ActionRecord;
      at: Date;
    }
  | {
      kind: "action.blocked";
      recordId: string;
      message: string;
      blockers: import("@freebirdai/core").ActionBlocker[];
      at: Date;
    }
  | {
      kind: "action.unblocked";
      recordId: string;
      at: Date;
    }
  | {
      kind: "action.resumed";
      record: ActionRecord;
      at: Date;
    }
  | {
      kind: "journal.recorded";
      record: ActionRecord;
      at: Date;
    }
  | {
      kind: "journal.discarded";
      recordId: string;
      at: Date;
    };

export type ActionEventListener = (event: ActionEvent) => void;
