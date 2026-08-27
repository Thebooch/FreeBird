import { computed, inject, type ComputedRef } from "vue";
import type {
  ActionRecord,
  ActionState,
  ChatMessage,
  CustomTab,
  GridCell,
  LayoutPlan,
  Reference,
} from "@freebirdai/core";
import { FREEBIRD_KEY, type FreeBirdContext } from "../plugin.js";

/** Low-level access. Returns the raw store + the reactive state ref. */
export const useFreeBirdContext = (): FreeBirdContext => {
  const ctx = inject(FREEBIRD_KEY);
  if (!ctx) {
    throw new Error(
      "useFreeBird must be used inside an app that has installed FreeBirdPlugin.",
    );
  }
  return ctx;
};

/**
 * Top-level FreeBird composable. Returns reactive refs for every store
 * field plus pass-through helpers for mutations. The object itself is
 * stable; the inner refs are what rerender consumers.
 */
export interface UseFreeBirdReturn {
  sessionId: ComputedRef<string | null>;
  layout: ComputedRef<LayoutPlan | null>;
  lockedCells: ComputedRef<GridCell[]>;
  tabs: ComputedRef<CustomTab[]>;
  messages: ComputedRef<ChatMessage[]>;
  streaming: ComputedRef<boolean>;
  streamingText: ComputedRef<string>;
  latestReferences: ComputedRef<Reference[]>;
  actionState: ComputedRef<ActionState>;
  activeComponentIds: ComputedRef<string[]>;
  pausedRecords: ComputedRef<ActionRecord[]>;

  setSessionId: (id: string | null) => void;
  setLayout: (p: LayoutPlan | null) => void;
  toggleLock: (instanceId: string) => void;
  setTabs: (t: CustomTab[]) => void;
  refreshTabs: () => Promise<void>;
  addMessage: (m: ChatMessage) => void;
  setMessages: (m: ChatMessage[]) => void;
  broadcastExplain: (componentId: string) => void;
  onExplain: (fn: (componentId: string) => void) => () => void;

  setActiveComponentIds: (ids: string[]) => void;
  confirmAction: () => Promise<void>;
  cancelAction: (reason?: string) => Promise<void>;
  pauseAction: (label?: string) => void;
  resumeAction: (recordId: string) => void;
  discardActionRecord: (recordId: string) => void;
  mergeActionArgs: (args: Record<string, unknown>, missing?: string[]) => void;
  startRemediationAction: (input: {
    suggestion: {
      componentId: string;
      actionId: string;
      label?: string;
      prefilledArgs?: Record<string, unknown>;
    };
    resumeField: string;
    childRecordId: string;
    childMissing?: string[];
  }) => void;
  resumeWorkflow: (
    resolvedArgs: Record<string, unknown>,
    missing?: string[],
  ) => void;
  unblockPending: () => void;

  /** Raw store. Use with care. */
  store: FreeBirdContext["store"];
  registry: FreeBirdContext["registry"];
  transport: FreeBirdContext["store"]["transport"];
}

export const useFreeBird = (): UseFreeBirdReturn => {
  const { store, state, registry } = useFreeBirdContext();

  return {
    sessionId: computed(() => state.value.sessionId),
    layout: computed(() => state.value.layout),
    lockedCells: computed(() =>
      state.value.layout ? state.value.layout.cells.filter((c) => c.locked) : [],
    ),
    tabs: computed(() => state.value.tabs),
    messages: computed(() => state.value.messages),
    streaming: computed(() => state.value.streaming),
    streamingText: computed(() => state.value.streamingText),
    latestReferences: computed(() => state.value.latestReferences),
    actionState: computed(() => state.value.actionState),
    activeComponentIds: computed(() => state.value.activeComponentIds),
    pausedRecords: computed(() =>
      state.value.actionState.journal.filter((r) => r.status === "paused"),
    ),

    setSessionId: (id) => store.setSessionId(id),
    setLayout: (p) => store.setLayout(p),
    toggleLock: (id) => store.toggleLock(id),
    setTabs: (t) => store.setTabs(t),
    refreshTabs: () => store.refreshTabs(),
    addMessage: (m) => store.addMessage(m),
    setMessages: (m) => store.setMessages(m),
    broadcastExplain: (id) => store.broadcastExplain(id),
    onExplain: (fn) => store.onExplain(fn),

    setActiveComponentIds: (ids) => store.setActiveComponentIds(ids),
    confirmAction: () => store.confirmAction(),
    cancelAction: (reason) => store.cancelAction(reason),
    pauseAction: (label) => store.pauseAction(label),
    resumeAction: (recordId) => store.resumeAction(recordId),
    discardActionRecord: (recordId) => store.discardRecord(recordId),
    mergeActionArgs: (args, missing) => store.mergeActionArgs(args, missing),
    startRemediationAction: (input) => store.startRemediationAction(input),
    resumeWorkflow: (resolvedArgs, missing) =>
      store.resumeWorkflow(resolvedArgs, missing),
    unblockPending: () => store.unblockPending(),

    store,
    registry,
    transport: store.transport,
  };
};
