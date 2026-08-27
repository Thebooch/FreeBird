/** Host-defined remediation the LLM or UI can offer when preflight fails. */
export interface SuggestedAction {
  componentId: string;
  actionId: string;
  label?: string;
  prefilledArgs?: Record<string, unknown>;
}

export interface ActionBlocker {
  code: string;
  field?: string;
  message?: string;
  suggestActions?: SuggestedAction[];
}

export type ActionPreflightResult =
  | { ok: true; resolvedArgs?: Record<string, unknown> }
  | { ok: false; message: string; blockers: ActionBlocker[] };

/**
 * Wire-format types for the FreeBird action layer.
 *
 * Lives in `@freebirdai/core` so both the server harness and the client
 * state store can share them. `@freebirdai/core-state` re-exports these
 * and adds the pure reducer (`applyTransition`) on top.
 */

export type ActionPhase =
  | "idle"
  | "collecting"
  | "blocked"
  | "awaiting_confirmation"
  | "executing"
  | "error";

/** Paused parent action waiting for a remediation child to finish. */
export interface WorkflowStackEntry {
  recordId: string;
  componentId: string;
  actionId: string;
  args: Record<string, unknown>;
  missing: string[];
  label?: string;
  /** Parent arg field to set when the child action completes (e.g. contactId). */
  resumeField?: string;
  /** Optional child result field to read (defaults to resumeField). */
  resultField?: string;
}

export type ActionRecordStatus =
  | "in_progress"
  | "paused"
  | "completed"
  | "terminated"
  | "failed";

export interface ActionPreviewRow {
  label: string;
  value: string;
  multiline?: boolean;
}

export interface ActionPreviewContent {
  title: string;
  summary: string;
  rows: ActionPreviewRow[];
}

export interface PendingAction {
  recordId: string;
  componentId: string;
  actionId: string;
  args: Record<string, unknown>;
  missing: string[];
  requiresConfirmation: "none" | "preview" | "strict";
  label?: string;
  startedAt: Date;
  /** Structured confirmation copy (derived or from action.preview). */
  preview?: ActionPreviewContent;
  /** Set when preflight fails — remediation suggestions for host UI / harness. */
  blockers?: ActionBlocker[];
  blockedMessage?: string;
}

export interface ActionRecord {
  id: string;
  componentId: string;
  actionId: string;
  args: Record<string, unknown>;
  status: ActionRecordStatus;
  startedAt: Date;
  updatedAt: Date;
  finishedAt?: Date;
  label?: string;
  before?: unknown;
  changed?: string[];
  result?: unknown;
  error?: { message: string };
}

export interface ActionState {
  phase: ActionPhase;
  pending: PendingAction | null;
  journal: ActionRecord[];
  lastError?: string;
  /** Parents paused while a prerequisite create/update action runs. */
  workflowStack: WorkflowStackEntry[];
}
