/*
 * Public API of @freebirdai/angular
 *
 * This file is the entry point ng-packagr reads (see ng-package.json).
 * It re-exports:
 *
 *  - `provideFreeBird(...)` for standalone DI setup
 *  - `FreeBirdService`      for reading/mutating state from components
 *  - Standalone components (ChatPanel, DynamicGrid, LockToggle, etc.)
 *  - Transport & store from `@freebirdai/core-state`
 *  - Core types from `@freebirdai/core` for convenience
 */

// DI
export { FREEBIRD_STORE, FREEBIRD_REGISTRY } from "./freebird.tokens";
export {
  provideFreeBird,
  type ProvideFreeBirdOptions,
} from "./freebird.provider";

// Service
export { FreeBirdService } from "./services/freebird.service";

// Components
export {
  ChatPanelComponent,
  ChatPanelMessagesComponent,
  ChatPanelFormComponent,
  ChatPanelInputComponent,
  ChatPanelSubmitComponent,
  ChatPanelMessageComponent,
  ChatPanelCitationsComponent,
  type CitationNavigateHandler,
} from "./components/chat-panel.component";
export { DynamicGridComponent } from "./components/dynamic-grid.component";
export { LockToggleComponent } from "./components/lock-toggle.component";
export { InfoTriggerComponent } from "./components/info-trigger.component";
export {
  CustomTabBarComponent,
  CustomTabBarListComponent,
  CustomTabBarItemComponent,
  CustomTabBarSaveComponent,
} from "./components/custom-tab-bar.component";
export { FreeBirdNavLinksComponent } from "./components/freebird-nav-links.component";
export { ActionPreviewComponent } from "./components/action-preview.component";
export { ActionJournalComponent } from "./components/action-journal.component";

// Transport & store (re-export so consumers only need @freebirdai/angular)
export {
  FetchTransport,
  createFetchTransport,
  TransportUnauthorizedError,
  FreeBirdStore,
  type FetchTransportOptions,
  type FreeBirdTransport,
  type FreeBirdState,
} from "@freebirdai/core-state";
export type { ActionEvent, ActionEventListener } from "@freebirdai/core-state";

// Core types
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
