export { Dashboard, DashStyleSheet } from "./Dashboard.jsx";
export type { DashboardProps } from "./Dashboard.jsx";
export { DashboardGrid } from "./DashboardGrid.jsx";
export { LazyWidget } from "./LazyWidget.jsx";
export { WidgetErrorBoundary } from "./WidgetErrorBoundary.jsx";
export { ParamBar } from "./ParamBar.jsx";
export { WidgetInspector } from "./WidgetInspector.jsx";
export { WidgetGroup, arrangementFor } from "./WidgetGroup.jsx";
export { WidgetShell } from "./WidgetShell.jsx";
export type { RecordCreateOffer, RecordRowActions } from "./WidgetShell.jsx";

export { DashboardProvider, useDashboard, useOptionalDashboard } from "./context.jsx";
export type {
  DashboardContextValue,
  DashboardControls,
  DashboardProviderProps,
  RecordChangeSignal,
} from "./context.jsx";

export { clampCell, completeLayout, persistCells, solveLayout } from "./layout.js";
export type { PlacementRequest, SolveLayoutOptions, SolveLayoutResult } from "./layout.js";

export {
  chromePresentationFor,
  presentationFor,
  presentationStyle,
} from "./presentation.js";
export type { PresentationSources, StoredPresentations } from "./presentation.js";

export { QueryClient, queryKey } from "./store.js";
export type { QueryEntry, QueryParams, QueryStatus } from "./store.js";

export { DASH_REACT_STYLES } from "./styles.js";
export { derivedSources, referenceColumns } from "./references.js";
export {
  MAX_LOOKUPS,
  nameOfRecord,
  unnamedLinks,
  referenceLookups,
  referenceNames,
  valueAtPath,
  withLinkedValues,
} from "./recordIndex.js";
export type {
  LinkedField,
  LookupInput,
  ReferenceLookup,
  ReferenceNames,
} from "./recordIndex.js";
export { labelColumns, useWidgetData } from "./useWidgetData.js";
export type { ApprovalVerdict, WidgetData, WidgetState } from "./useWidgetData.js";
export { WidgetDetail } from "./WidgetDetail.js";
export { RecordView } from "./RecordView.jsx";
export { RecordPage, missingTokens } from "./RecordPage.jsx";
export { EntityRecordPage } from "./EntityRecordPage.jsx";
export type { RecordChangeRequest } from "./EntityRecordPage.jsx";
export { addLabel, changeRowActions, recordChangeRequests, recordToolbar } from "./writes/requests.js";
export type { RecordChangeBase, RecordToolbar, ToolbarEntry } from "./writes/requests.js";
export { RecordForm, changedValues } from "./writes/RecordForm.jsx";
export type { FormValues, RecordFormProps, ReferenceOption } from "./writes/RecordForm.jsx";
export { WriteReview } from "./writes/WriteReview.jsx";
export type { WriteReviewProps } from "./writes/WriteReview.jsx";
export {
  detailPanes,
  headerPane,
  popTrail,
  recordPane,
  relatedPanes,
  statPanes,
  truncateTrail,
} from "./detail.js";
export type { DetailPane, TrailEntry } from "./detail.js";
export { canEmbedInExpression, entityPanes } from "./entityDetail.js";
export type { EntityPaneInput, OpenReference } from "./entityDetail.js";
