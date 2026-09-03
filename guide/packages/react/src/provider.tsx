import React, {
  createContext,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  ActionRecord,
  ActionState,
  ChatMessage,
  ComponentRegistry,
  CustomTab,
  GridCell,
  LayoutPlan,
  Reference,
} from "@freebirdai/core";
import {
  FetchTransport,
  FreeBirdStore,
  type FetchTransportOptions,
  type FreeBirdTransport,
} from "@freebirdai/core-state";

/**
 * The shape exposed to every FreeBird React hook. It preserves the
 * 0.1.x API so consumers of the React package are not affected by the
 * internal extraction of `@freebirdai/core-state`.
 */
export interface FreeBirdContextValue {
  /** Component registry. Used by DynamicGrid to resolve `componentId` to a renderer. */
  registry: ComponentRegistry<React.ReactNode, unknown>;
  /** Transport. Defaults to FetchTransport if not supplied. */
  transport: FreeBirdTransport;
  /** Underlying store — advanced consumers only. */
  store: FreeBirdStore;

  // Reactive fields (mirrored from FreeBirdStore via useSyncExternalStore)
  sessionId: string | null;
  layout: LayoutPlan | null;
  lockedCells: GridCell[];
  tabs: CustomTab[];
  messages: ChatMessage[];
  streaming: boolean;
  streamingText: string;
  latestReferences: Reference[];
  actionState: ActionState;
  activeComponentIds: string[];
  /** The last error the chat stream reported, or null. */
  lastChatError: string | null;
  pausedRecords: ActionRecord[];

  // Setters / actions (delegate to store)
  setSessionId: (id: string | null) => void;
  /**
   * Switch to another conversation, dropping what the last one put on screen.
   *
   * `null` means "none yet". Pass an id to return to a past conversation once
   * there is a history to pick one from — `useChat` loads its messages.
   */
  openSession: (id: string | null) => void;
  setLayout: (p: LayoutPlan | null) => void;
  toggleLock: (instanceId: string) => void;
  setTabs: (t: CustomTab[]) => void;
  refreshTabs: () => Promise<void>;
  addMessage: (m: ChatMessage) => void;
  setMessages: (m: ChatMessage[]) => void;
  setStreaming: (s: boolean) => void;
  broadcastExplain: (componentId: string) => void;
  onExplain: (handler: (componentId: string) => void) => () => void;

  // Action layer
  setActiveComponentIds: (ids: string[]) => void;
  confirmAction: () => Promise<void>;
  cancelAction: (reason?: string) => Promise<void>;
  pauseAction: (label?: string) => void;
  resumeAction: (recordId: string) => void;
  discardActionRecord: (recordId: string) => void;
  mergeActionArgs: (args: Record<string, unknown>, missing?: string[]) => void;
}

const FreeBirdContext = createContext<FreeBirdContextValue | null>(null);

export interface FreeBirdProviderProps {
  registry: ComponentRegistry<React.ReactNode, unknown>;
  /** Override the default FetchTransport. */
  transport?: FreeBirdTransport;
  /** Options passed to the default FetchTransport when `transport` is omitted. */
  transportOptions?: FetchTransportOptions;
  /**
   * Advanced: pass a pre-built FreeBirdStore. Useful for SSR hydration
   * or when you want to share a store across multiple providers.
   */
  store?: FreeBirdStore;
  /** Initial session id if the host app already created one (e.g. during SSR). */
  initialSessionId?: string;
  /** Initial layout if the host app wants to hydrate one. */
  initialLayout?: LayoutPlan | null;
  children: React.ReactNode;
}

/**
 * Top-level provider. Wrap your app in this once. Creates a single
 * FreeBirdStore and exposes its state via React context. Internally uses
 * `useSyncExternalStore` so SSR, concurrent rendering, and tearing are
 * handled correctly.
 */
export const FreeBirdProvider: React.FC<FreeBirdProviderProps> = ({
  registry,
  transport,
  transportOptions,
  store: storeOverride,
  initialSessionId,
  initialLayout,
  children,
}) => {
  const storeRef = useRef<FreeBirdStore>();
  if (!storeRef.current) {
    if (storeOverride) {
      storeRef.current = storeOverride;
    } else {
      const t = transport ?? new FetchTransport(transportOptions);
      storeRef.current = new FreeBirdStore(t, {
        sessionId: initialSessionId ?? null,
        layout: initialLayout ?? null,
      });
    }
  }
  const store = storeRef.current!;

  const state = useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );

  const lockedCells = useMemo(
    () => (state.layout ? state.layout.cells.filter((c) => c.locked) : []),
    [state.layout],
  );

  const pausedRecords = useMemo(
    () => state.actionState.journal.filter((r) => r.status === "paused"),
    [state.actionState.journal],
  );

  const value = useMemo<FreeBirdContextValue>(
    () => ({
      registry,
      transport: store.transport,
      store,

      sessionId: state.sessionId,
      layout: state.layout,
      lockedCells,
      tabs: state.tabs,
      messages: state.messages,
      streaming: state.streaming,
      streamingText: state.streamingText,
      latestReferences: state.latestReferences,
      actionState: state.actionState,
      activeComponentIds: state.activeComponentIds,
      lastChatError: state.lastChatError,
      pausedRecords,

      setSessionId: (id) => store.setSessionId(id),
      openSession: (id) => store.openSession(id),
      setLayout: (p) => store.setLayout(p),
      toggleLock: (id) => store.toggleLock(id),
      setTabs: (t) => store.setTabs(t),
      refreshTabs: () => store.refreshTabs(),
      addMessage: (m) => store.addMessage(m),
      setMessages: (m) => store.setMessages(m),
      setStreaming: (s) => store.setStreaming(s),
      broadcastExplain: (id) => store.broadcastExplain(id),
      onExplain: (h) => store.onExplain(h),

      setActiveComponentIds: (ids) => store.setActiveComponentIds(ids),
      confirmAction: () => store.confirmAction(),
      cancelAction: (reason) => store.cancelAction(reason),
      pauseAction: (label) => store.pauseAction(label),
      resumeAction: (recordId) => store.resumeAction(recordId),
      discardActionRecord: (recordId) => store.discardRecord(recordId),
      mergeActionArgs: (args, missing) => store.mergeActionArgs(args, missing),
    }),
    [registry, store, state, lockedCells, pausedRecords],
  );

  return <FreeBirdContext.Provider value={value}>{children}</FreeBirdContext.Provider>;
};

export const useFreeBird = (): FreeBirdContextValue => {
  const v = useContext(FreeBirdContext);
  if (!v) {
    throw new Error("useFreeBird must be used inside <FreeBirdProvider>");
  }
  return v;
};
