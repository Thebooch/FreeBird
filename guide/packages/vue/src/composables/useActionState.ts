import { computed, onMounted, onUnmounted, type ComputedRef } from "vue";
import type { ActionPhase, ActionState, PendingAction } from "@freebirdai/core";
import type { ActionEvent } from "@freebirdai/core-state";
import { useFreeBird } from "./useFreeBird.js";

export interface UseActionStateReturn {
  phase: ComputedRef<ActionPhase>;
  pending: ComputedRef<PendingAction | null>;
  lastError: ComputedRef<string | undefined>;
  state: ComputedRef<ActionState>;
  confirm: () => Promise<void>;
  cancel: (reason?: string) => Promise<void>;
  pause: (label?: string) => void;
  mergeArgs: (args: Record<string, unknown>, missing?: string[]) => void;
}

/**
 * Vue composable for the active action flow. Mirrors the React `useActionState`
 * hook but returns Vue `ComputedRef`s instead of plain values.
 */
export const useActionState = (): UseActionStateReturn => {
  const fb = useFreeBird();
  return {
    phase: computed(() => fb.actionState.value.phase),
    pending: computed(() => fb.actionState.value.pending),
    lastError: computed(() => fb.actionState.value.lastError),
    state: fb.actionState,
    confirm: fb.confirmAction,
    cancel: fb.cancelAction,
    pause: fb.pauseAction,
    mergeArgs: fb.mergeActionArgs,
  };
};

/**
 * Subscribe to action audit events; cleans up on unmount.
 */
export const useActionEvents = (handler: (event: ActionEvent) => void): void => {
  const fb = useFreeBird();
  let off: (() => void) | null = null;
  onMounted(() => {
    off = fb.store.onActionEvent(handler);
  });
  onUnmounted(() => {
    off?.();
    off = null;
  });
};
