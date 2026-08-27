// Plugin & context
export {
  FreeBirdPlugin,
  FREEBIRD_KEY,
  type FreeBirdPluginOptions,
  type FreeBirdContext,
} from "./plugin.js";

// Transport & store (re-exported from @freebirdai/core-state so consumers
// can install just @freebirdai/vue).
export {
  FetchTransport,
  createFetchTransport,
  TransportUnauthorizedError,
  FreeBirdStore,
  type FetchTransportOptions,
  type FreeBirdTransport,
  type FreeBirdState,
} from "@freebirdai/core-state";

// Composables
export {
  useFreeBird,
  useFreeBirdContext,
  type UseFreeBirdReturn,
} from "./composables/useFreeBird.js";
export {
  useSession,
  type UseSessionOptions,
  type UseSessionReturn,
} from "./composables/useSession.js";
export {
  useChat,
  type UseChatOptions,
  type UseChatReturn,
} from "./composables/useChat.js";
export { useLayout, type UseLayoutReturn } from "./composables/useLayout.js";
export { useCustomTabs, type UseCustomTabsReturn } from "./composables/useCustomTabs.js";
export {
  useActionState,
  useActionEvents,
  type UseActionStateReturn,
} from "./composables/useActionState.js";
export {
  useActionJournal,
  type UseActionJournalReturn,
  type UseActionJournalOptions,
} from "./composables/useActionJournal.js";

// Components
export {
  ChatPanel,
  ChatPanelRoot,
  ChatPanelMessages,
  ChatPanelForm,
  ChatPanelInput,
  ChatPanelSubmit,
  ChatPanelMessage,
  ChatPanelCitations,
  type CitationNavigateHandler,
} from "./components/ChatPanel.js";
export { DynamicGrid } from "./components/DynamicGrid.js";
export { LockToggle } from "./components/LockToggle.js";
export { InfoTrigger } from "./components/InfoTrigger.js";
export {
  CustomTabBar,
  CustomTabBarRoot,
  CustomTabBarList,
  CustomTabBarItem,
  CustomTabBarSave,
} from "./components/CustomTabBar.js";
export { FreeBirdNavLinks } from "./components/FreeBirdNavLinks.js";
export { ActionPreview } from "./components/ActionPreview.js";
export { ActionJournal } from "./components/ActionJournal.js";

// Re-export core types so consumers don't need @freebirdai/core for types alone.
export type {
  ActionContext,
  ActionDefinition,
  ActionPhase,
  ActionRecord,
  ActionRecordStatus,
  ActionState,
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  ComponentDefinition,
  ComponentRegistry,
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
