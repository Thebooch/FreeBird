// Transport
export type { FreeBirdTransport, ConfirmActionResult } from "./transport/types.js";
export {
  FetchTransport,
  createFetchTransport,
  TransportUnauthorizedError,
  type FetchTransportOptions,
} from "./transport/fetch.js";

// Store
export {
  FreeBirdStore,
  type FreeBirdState,
  type FreeBirdListener,
  type ExplainListener,
  type FreeBirdStoreOptions,
} from "./store.js";

// Action layer
export {
  applyTransition,
  initialActionState,
  deriveMissingFields,
  lastPaused,
  pausedRecords,
  type ActionPhase,
  type ActionRecordStatus,
  type PendingAction,
  type ActionRecord,
  type ActionState,
  type ActionTransition,
  type TransitionOptions,
} from "./actions/state.js";
export type { ActionEvent, ActionEventListener } from "./actions/events.js";
export {
  applySupportTransition,
  initialSupportState,
  type SupportPhase,
  type SupportDraftState,
  type SupportState,
  type SupportTransition,
} from "./support/state.js";
export type { SupportEvent, SupportEventListener } from "./store.js";

// Tier-1 state notices: told to the model, never a turn of their own.
export {
  appendNotice,
  emptyNoticeBuffer,
  flushNotices,
  COALESCE_WINDOW_MS,
  MAX_NOTICES,
  MAX_SUMMARY_CHARS,
  MAX_TOTAL_CHARS,
  type NoticeBuffer,
} from "./notices/state.js";
