// Provider & context
export {
  FreeBirdProvider,
  useFreeBird,
  type FreeBirdProviderProps,
  type FreeBirdContextValue,
} from "./provider.js";

// Transport (re-exported from @freebirdai/core-state so consumers' imports
// from @freebirdai/react continue to work unchanged from 0.1.x).
export {
  FetchTransport,
  createFetchTransport,
  TransportUnauthorizedError,
  FreeBirdStore,
  type FetchTransportOptions,
  type FreeBirdTransport,
  type FreeBirdState,
} from "@freebirdai/core-state";

// Hooks
export { useChat, type UseChatReturn, type UseChatOptions } from "./hooks/useChat.js";
export { useLayout, type UseLayoutReturn } from "./hooks/useLayout.js";
export { useCustomTabs, type UseCustomTabsReturn } from "./hooks/useCustomTabs.js";
export { useSession, type UseSessionReturn, type UseSessionOptions } from "./hooks/useSession.js";
export {
  useActionState,
  useActionEvents,
  type UseActionStateReturn,
} from "./hooks/useActionState.js";
export {
  useActionJournal,
  type UseActionJournalReturn,
  type UseActionJournalOptions,
} from "./hooks/useActionJournal.js";

// Components (headless primitives)
export {
  ChatPanel,
  type ChatPanelCitationsProps,
  type CitationNavigateHandler,
} from "./components/ChatPanel.js";
export { DynamicGrid, type DynamicGridProps } from "./components/DynamicGrid.js";
export { LockToggle, type LockToggleProps } from "./components/LockToggle.js";
export { InfoTrigger, type InfoTriggerProps } from "./components/InfoTrigger.js";
export { CustomTabBar } from "./components/CustomTabBar.js";
export {
  FreeBirdNavLinks,
  type FreeBirdNavLinksProps,
  type NavLinkRenderProps,
} from "./components/FreeBirdNavLinks.js";
export {
  ActionPreview,
  type ActionPreviewProps,
  type ActionPreviewRenderProps,
} from "./components/ActionPreview.js";
export {
  ActionJournal,
  type ActionJournalProps,
  type ActionJournalRenderProps,
} from "./components/ActionJournal.js";

// Re-export core types so consumers don't need @freebirdai/core for types alone
export type {
  ActionDefinition,
  ActionContext,
  ActionPhase,
  ActionRecord,
  ActionRecordStatus,
  ActionState,
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  ComponentCitation,
  ComponentDefinition,
  ConfirmationPolicy,
  CustomTab,
  DigestConfig,
  GridCell,
  KnowledgeItem,
  LayoutPlan,
  OrientationHint,
  PendingAction,
  PreviewStrategy,
  Reference,
} from "@freebirdai/core";
export type { ActionEvent, ActionEventListener } from "@freebirdai/core-state";
