/**
 * Pure, framework-agnostic state machine for the FreeBird action layer.
 *
 * The store wraps the types here. The server harness reduces over the same
 * shapes to decide which LLM tools to expose and which system messages to
 * inject. Keeping the machine pure means it can be unit-tested without
 * touching the network, the registry, or any framework.
 *
 * ## Phases
 *
 *   idle
 *     ─ start ─▶  collecting       (LLM is gathering args via slot-fill turns)
 *                  ─ merge_args ─▶  collecting
 *                  ─ ready_for_confirmation ─▶  awaiting_confirmation
 *                  ─ pause ─▶       idle              (record marked "paused")
 *                  ─ cancelled ─▶   idle              (record marked "terminated")
 *
 *   awaiting_confirmation
 *                  ─ begin_executing ─▶ executing
 *                  ─ cancelled       ─▶ idle          (record "terminated")
 *                  ─ pause           ─▶ idle          (record "paused")
 *
 *   executing
 *                  ─ executed ─▶ idle                 (record "completed")
 *                  ─ failed   ─▶ error                (record "failed")
 *
 *   error
 *                  ─ start    ─▶ collecting           (a fresh action wipes error)
 *                  ─ cancelled ─▶ idle
 *
 *   resume(recordId): pulls a "paused" record back into `pending` (collecting
 *                     or awaiting_confirmation depending on snapshot).
 *
 * ## Journal
 *
 * The journal is an in-memory list of {@link ActionRecord}s scoped to the
 * current store instance. We never persist the journal in v1; hosts that
 * want cross-session resume can listen to {@link ActionEvent}s emitted on
 * `journal.recorded` / `journal.discarded` and store them however they like.
 */

import type {
  ActionBlocker,
  ActionPhase,
  ActionPreviewContent,
  ActionRecord,
  ActionRecordStatus,
  ActionState,
  PendingAction,
  WorkflowStackEntry,
} from "@freebirdai/core";

export type {
  ActionBlocker,
  ActionPhase,
  ActionRecord,
  ActionRecordStatus,
  ActionState,
  PendingAction,
  WorkflowStackEntry,
};

export const initialActionState: ActionState = {
  phase: "idle",
  pending: null,
  journal: [],
  workflowStack: [],
};

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type ActionTransition =
  | {
      type: "start";
      recordId: string;
      componentId: string;
      actionId: string;
      label?: string;
      args?: Record<string, unknown>;
      missing?: string[];
      requiresConfirmation: "none" | "preview" | "strict";
      preview?: ActionPreviewContent;
      at: Date;
    }
  | {
      type: "merge_args";
      args: Record<string, unknown>;
      missing?: string[];
      preview?: ActionPreviewContent;
      at: Date;
    }
  | { type: "ready_for_confirmation"; at: Date }
  | { type: "begin_executing"; at: Date }
  | {
      type: "executed";
      result?: unknown;
      before?: unknown;
      changed?: string[];
      at: Date;
    }
  | {
      type: "failed";
      message: string;
      before?: unknown;
      at: Date;
    }
  | { type: "cancelled"; reason?: string; at: Date }
  | { type: "pause"; label?: string; at: Date }
  | { type: "resume"; recordId: string; at: Date }
  | {
      type: "block";
      message: string;
      blockers: ActionBlocker[];
      at: Date;
    }
  | { type: "unblock"; at: Date }
  | {
      type: "push_workflow";
      entry: WorkflowStackEntry;
      at: Date;
    }
  | {
      type: "resume_workflow";
      resolvedArgs: Record<string, unknown>;
      missing?: string[];
      at: Date;
    }
  | { type: "discard_record"; recordId: string }
  | { type: "hydrate_journal"; records: ActionRecord[] };

export interface TransitionOptions {
  /** Maximum journal length. Defaults to 50 in the store. */
  journalCap?: number;
}

/**
 * Pure reducer. Returns the next {@link ActionState}; never mutates input.
 *
 * Invalid transitions (e.g. `start` while a record is `in_progress`) are
 * rejected by returning the unchanged state. The store layers the
 * `onActionEvent` pub/sub on top so hosts can observe both accepted and
 * rejected transitions if they want.
 */
const phaseFromPending = (
  pending: PendingAction,
  requiresConfirmation: PendingAction["requiresConfirmation"],
): ActionPhase => {
  if (pending.blockers && pending.blockers.length > 0) return "blocked";
  if (pending.missing.length > 0) return "collecting";
  if (requiresConfirmation === "none") return "executing";
  return "awaiting_confirmation";
};

export const applyTransition = (
  state: ActionState,
  t: ActionTransition,
  opts: TransitionOptions = {},
): ActionState => {
  const cap = opts.journalCap ?? 50;
  switch (t.type) {
    case "start": {
      if (state.pending && state.phase !== "error") return state;
      const args = t.args ?? {};
      const missing = t.missing ?? [];
      const pending: PendingAction = {
        recordId: t.recordId,
        componentId: t.componentId,
        actionId: t.actionId,
        args,
        missing,
        requiresConfirmation: t.requiresConfirmation,
        label: t.label,
        preview: t.preview,
        startedAt: t.at,
      };
      const record: ActionRecord = {
        id: t.recordId,
        componentId: t.componentId,
        actionId: t.actionId,
        args,
        status: "in_progress",
        startedAt: t.at,
        updatedAt: t.at,
        label: t.label,
      };
      const phase: ActionPhase = phaseFromPending(pending, t.requiresConfirmation);
      return {
        phase,
        pending,
        journal: capJournal([record, ...state.journal], cap),
        workflowStack: state.workflowStack,
      };
    }

    case "merge_args": {
      if (!state.pending) return state;
      const merged = { ...state.pending.args, ...t.args };
      const missing = t.missing ?? state.pending.missing;
      const pending: PendingAction = {
        ...state.pending,
        args: merged,
        missing,
        preview: t.preview ?? state.pending.preview,
        blockers: undefined,
        blockedMessage: undefined,
      };
      const journal = patchRecord(state.journal, state.pending.recordId, (r) => ({
        ...r,
        args: merged,
        updatedAt: t.at,
      }));
      return {
        ...state,
        pending,
        journal,
        phase: phaseFromPending(pending, pending.requiresConfirmation),
      };
    }

    case "ready_for_confirmation": {
      if (!state.pending) return state;
      return { ...state, phase: "awaiting_confirmation" };
    }

    case "begin_executing": {
      if (!state.pending) return state;
      return { ...state, phase: "executing" };
    }

    case "executed": {
      if (!state.pending) return state;
      const journal = patchRecord(state.journal, state.pending.recordId, (r) => ({
        ...r,
        status: "completed" as const,
        updatedAt: t.at,
        finishedAt: t.at,
        before: t.before,
        changed: t.changed,
        result: t.result,
      }));
      return {
        phase: "idle",
        pending: null,
        journal,
        workflowStack: state.workflowStack,
      };
    }

    case "block": {
      if (!state.pending) return state;
      const pending: PendingAction = {
        ...state.pending,
        blockers: t.blockers,
        blockedMessage: t.message,
      };
      return { ...state, phase: "blocked", pending };
    }

    case "unblock": {
      if (!state.pending) return state;
      const pending: PendingAction = {
        ...state.pending,
        blockers: undefined,
        blockedMessage: undefined,
      };
      return {
        ...state,
        phase: phaseFromPending(pending, pending.requiresConfirmation),
        pending,
      };
    }

    case "push_workflow": {
      if (!state.pending) return state;
      const journal = patchRecord(state.journal, state.pending.recordId, (r) => ({
        ...r,
        status: "paused" as const,
        updatedAt: t.at,
        label: t.entry.label ?? r.label,
      }));
      return {
        phase: "idle",
        pending: null,
        journal,
        workflowStack: [...state.workflowStack, t.entry],
      };
    }

    case "resume_workflow": {
      const stack = [...state.workflowStack];
      const entry = stack.pop();
      if (!entry) return state;
      if (state.pending) return state;
      const merged = { ...entry.args, ...t.resolvedArgs };
      const missing = t.missing ?? entry.missing;
      const pending: PendingAction = {
        recordId: entry.recordId,
        componentId: entry.componentId,
        actionId: entry.actionId,
        args: merged,
        missing,
        requiresConfirmation: "preview",
        label: entry.label,
        startedAt: t.at,
        blockers: undefined,
        blockedMessage: undefined,
      };
      const journal = patchRecord(state.journal, entry.recordId, (r) => ({
        ...r,
        status: "in_progress" as const,
        args: merged,
        updatedAt: t.at,
      }));
      return {
        phase: phaseFromPending(pending, pending.requiresConfirmation),
        pending,
        journal,
        workflowStack: stack,
      };
    }

    case "failed": {
      if (!state.pending) return state;
      const journal = patchRecord(state.journal, state.pending.recordId, (r) => ({
        ...r,
        status: "failed" as const,
        updatedAt: t.at,
        finishedAt: t.at,
        before: t.before,
        error: { message: t.message },
      }));
      return {
        phase: "error",
        pending: null,
        journal,
        lastError: t.message,
        workflowStack: state.workflowStack,
      };
    }

    case "cancelled": {
      if (!state.pending) {
        // even with no pending, allow the transition to clear `error` phase
        if (state.phase === "error") {
          const next: ActionState = {
            phase: "idle",
            pending: null,
            journal: state.journal,
            workflowStack: state.workflowStack,
          };
          return next;
        }
        return state;
      }
      const journal = patchRecord(state.journal, state.pending.recordId, (r) => ({
        ...r,
        status: "terminated" as const,
        updatedAt: t.at,
        finishedAt: t.at,
      }));
      return { phase: "idle", pending: null, journal, workflowStack: state.workflowStack };
    }

    case "pause": {
      if (!state.pending) return state;
      const label = t.label ?? state.pending.label;
      const journal = patchRecord(state.journal, state.pending.recordId, (r) => ({
        ...r,
        status: "paused" as const,
        updatedAt: t.at,
        label,
      }));
      return { phase: "idle", pending: null, journal, workflowStack: state.workflowStack };
    }

    case "resume": {
      const record = state.journal.find((r) => r.id === t.recordId);
      if (!record || record.status !== "paused") return state;
      if (state.pending) return state; // refuse mid-flow resume
      const pending: PendingAction = {
        recordId: record.id,
        componentId: record.componentId,
        actionId: record.actionId,
        args: record.args,
        missing: [], // host/server may immediately re-validate via merge_args
        requiresConfirmation: "preview",
        label: record.label,
        startedAt: record.startedAt,
      };
      const journal = patchRecord(state.journal, record.id, (r) => ({
        ...r,
        status: "in_progress" as const,
        updatedAt: t.at,
      }));
      return { phase: "collecting", pending, journal, workflowStack: state.workflowStack };
    }

    case "discard_record": {
      if (state.pending?.recordId === t.recordId) return state;
      return {
        ...state,
        journal: state.journal.filter((r) => r.id !== t.recordId),
      };
    }

    case "hydrate_journal": {
      return { ...state, journal: capJournal(t.records, cap), workflowStack: state.workflowStack ?? [] };
    }

    default:
      return state;
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const patchRecord = (
  journal: ActionRecord[],
  id: string,
  patch: (r: ActionRecord) => ActionRecord,
): ActionRecord[] => journal.map((r) => (r.id === id ? patch(r) : r));

/**
 * Cap journal length, dropping oldest non-paused records first.
 *
 * "Paused" records are user/LLM-meaningful state; we'd rather drop a
 * completed/terminated audit trail than a resumable conversation.
 */
const capJournal = (records: ActionRecord[], cap: number): ActionRecord[] => {
  if (records.length <= cap) return records;
  const out = [...records];
  while (out.length > cap) {
    const idx = out
      .map((r, i) => ({ r, i }))
      .reverse()
      .find(({ r }) => r.status !== "paused");
    if (!idx) {
      // all paused; drop oldest paused
      out.pop();
    } else {
      out.splice(idx.i, 1);
    }
  }
  return out;
};

/**
 * Compute which top-level keys of `args` are missing relative to a Zod
 * schema's required keys. Used by hosts that want a quick way to derive
 * `missing` without re-running Zod themselves.
 */
export const deriveMissingFields = (
  args: Record<string, unknown>,
  required: string[],
): string[] => required.filter((k) => args[k] === undefined || args[k] === null);

/** Convenience selector for the most recent paused record. */
export const lastPaused = (state: ActionState): ActionRecord | undefined =>
  state.journal.find((r) => r.status === "paused");

/** Convenience selector for all paused records (most recent first). */
export const pausedRecords = (state: ActionState): ActionRecord[] =>
  state.journal.filter((r) => r.status === "paused");
