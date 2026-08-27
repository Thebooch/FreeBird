import { useEffect } from "react";
import type {
  ActionPhase,
  ActionState,
  PendingAction,
} from "@freebirdai/core";
import type { ActionEvent } from "@freebirdai/core-state";
import { useFreeBird } from "../provider.js";

export interface UseActionStateReturn {
  /** Current phase: idle | collecting | awaiting_confirmation | executing | error. */
  phase: ActionPhase;
  /** The action currently being collected/awaiting/executing, or null. */
  pending: PendingAction | null;
  /** Latest validation/handler error message, surfaced in the `error` phase. */
  lastError?: string;
  /** Full {@link ActionState} for power users. */
  state: ActionState;
  /** Confirm and execute the pending action. */
  confirm: () => Promise<void>;
  /** Cancel the pending action (also clears `error` phase). */
  cancel: (reason?: string) => Promise<void>;
  /** Park the pending action; it goes into the journal as `paused`. */
  pause: (label?: string) => void;
  /** Merge args into the pending action (advanced; usually the LLM does this). */
  mergeArgs: (args: Record<string, unknown>, missing?: string[]) => void;
}

/**
 * Reactive view of the current action flow.
 *
 * Pair with {@link useActionJournal} to render past records, and with
 * the headless `<ActionPreview>` component to drive the confirmation UI.
 */
export const useActionState = (): UseActionStateReturn => {
  const fb = useFreeBird();
  return {
    phase: fb.actionState.phase,
    pending: fb.actionState.pending,
    lastError: fb.actionState.lastError,
    state: fb.actionState,
    confirm: fb.confirmAction,
    cancel: fb.cancelAction,
    pause: fb.pauseAction,
    mergeArgs: fb.mergeActionArgs,
  };
};

/**
 * Subscribe to action audit events. Convenience over `store.onActionEvent`
 * that handles cleanup on unmount.
 *
 * @example
 * useActionEvents(useCallback((ev) => {
 *   if (ev.kind === "action.executed") toast.success("Saved");
 * }, []));
 */
export const useActionEvents = (
  handler: (event: ActionEvent) => void,
): void => {
  const fb = useFreeBird();
  useEffect(() => fb.store.onActionEvent(handler), [fb.store, handler]);
};
