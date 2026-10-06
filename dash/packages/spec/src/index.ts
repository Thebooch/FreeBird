// The connection side of the spec lives in @freebirdai/connect-spec and is
// re-exported whole, so every existing import from dash-spec keeps working.
// `categorySchema` and `CategorySpec` below take precedence: they are the
// same record with its starters typed as Dash briefs.
export * from "@freebirdai/connect-spec";

// Re-exported so consumers have a single import surface for spec vocabulary.
export type { Grain } from "@freebirdai/expr";

export { GRAINS, parseGrain, truncateToBucket } from "@freebirdai/expr";

export { isAggregation, parseAggregation } from "./aggregation.js";

export type { ParsedAggregation } from "./aggregation.js";

export {
  COMPONENT_CONTRACTS,
  contractFor,
  COMPONENT_IDS,
  componentIdSchema,
  gridHintsSchema,
  roleContractSchema,
  sizeVariantSchema,
  validateBinding,
} from "./contracts.js";

export type {
  BindingIssue,
  BindingValidation,
  ColumnMeta,
  ColumnReference,
  ComponentContract,
  ComponentId,
  GridHints,
  RoleContract,
  SizeVariant,
} from "./contracts.js";

export {
  FACET_EMPTY_KEY,
  FACET_MAX_PER_WIDGET,
  FACET_MAX_VALUES,
  facetKey,
  facetOptionSchema,
  facetSchema,
  facetTone,
  facetToneSchema,
  facetValueSchema,
  facetsSchema,
  validateFacets,
} from "./facet.js";

export type { FacetOption, FacetSpec, FacetValue } from "./facet.js";

export {
  boardLayoutSchema,
  categorySchema,
  onboardingChoicesSchema,
  onboardingOf,
  onboardingPreviewSchema,
  onboardingSchema,
  onboardingStatusSchema,
  starterSchema,
  starterSizeSchema,
  startersOf,
  widgetCheckSchema,
  widgetCheckStatusSchema,
} from "./category.js";

export type {
  BoardLayout,
  CategorySpec,
  OnboardingChoices,
  OnboardingPreview,
  OnboardingSpec,
  OnboardingStatus,
  StarterSpec,
  WidgetCheck,
  WidgetCheckStatus,
} from "./category.js";

export { clampCell, completeLayout, solveLayout } from "./layout.js";

export type { PlacementRequest, SolveLayoutOptions, SolveLayoutResult } from "./layout.js";

export {
  ALONGSIDE_MODES,
  WIDGET_INTENTS,
  columnForPath,
  compileBrief,
  widgetBriefSchema,
} from "./brief.js";

export type {
  AlongsideMode,
  CompileBriefInput,
  CompiledBrief,
  WidgetBrief,
  WidgetIntent,
} from "./brief.js";

export { answerBrief, briefOptions } from "./brief-options.js";

export type { BriefControl, BriefOption, BriefOptionsInput } from "./brief-options.js";

export { recompileWidget } from "./recompile.js";

export {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  inviteSchema,
  memberSchema,
  permissionSchema,
  principalSchema,
  roleSchema,
  scopeCapability,
  workspaceSchema,
} from "./access.js";

export type { Invite, Member, Permission, Principal, Role, Scope, Workspace } from "./access.js";

export {
  AGENT_COLORS,
  AGENT_PERMISSIONS,
  AGENT_TOOL_INFO,
  AGENT_TOOL_KINDS,
  AGENT_TOOL_MODES,
  agentInputSchema,
  agentKnowledgeSchema,
  agentReachSchema,
  agentSchema,
  agentToolKindSchema,
  agentToolModeSchema,
  agentToolSchema,
  contextRuleSchema,
  contextSourceSchema,
  dedupeReach,
  describeScope,
  isReplyTool,
  reachCovers,
  sharedAgentKnowledgeSchema,
  summarizeReach,
} from "./agent.js";

export type {
  AgentInput,
  AgentKnowledge,
  AgentReach,
  AgentSpec,
  AgentTool,
  AgentToolKind,
  AgentToolKindInfo,
  AgentToolMode,
  ContextRule,
  ContextSource,
  ReachProblem,
  SharedAgentKnowledge,
} from "./agent.js";

export { BASE_RESPONSE_PROMPT, composeResponsePrompt } from "./agent-prompt.js";

export type { ComposeResponsePromptInput, FoundContext, ResponseChannel } from "./agent-prompt.js";

export { referenceIds, targetOfRow } from "./reference.js";

export type { ReferenceRow } from "./reference.js";

export {
  anchorCell,
  dashboardSchema,
  groupMembers,
  groupSize,
  layoutCellSchema,
  layoutSchema,
  parseDashboard,
  parseDuration,
  parseWidget,
  refreshSchema,
  widgetGroupSchema,
  widgetSchema,
  widgetSources,
  drawnColumns,
  withoutWidget,
  widgetSourceSchema,
  widgetStatesSchema,
  FAN_OUT_WHOLE_MAX,
} from "./dashboard.js";

export type {
  DashboardSpec,
  FieldGroup,
  Layout,
  LayoutCell,
  ParseResult,
  WidgetGroup,
  WidgetSpec,
} from "./dashboard.js";

export {
  DENSITIES,
  EMPTY_PRESENTATION,
  PRESENTATION_DEFAULTS,
  PRESENTATION_MANIFESTS,
  WIDGET_CHROME_ID,
  defaultPresentationFor,
  densitySchema,
  fieldLabel,
  humanLabel,
  isSlotHidden,
  manifestFor,
  orderedSlots,
  presentationSchema,
  resolvePresentation,
  settingBool,
  settingNumber,
  settingString,
  settingValueSchema,
  slotLabel,
  slotOf,
  slotSpecSchema,
  tokenNameSchema,
  tokenValueSchema,
} from "./presentation.js";

export type {
  Density,
  FieldLabels,
  Presentation,
  PresentationInput,
  PresentationManifest,
  SettingDef,
  SettingValue,
  SlotDef,
  SlotSpec,
} from "./presentation.js";

export {
  annotateStepSchema,
  coerceStepSchema,
  deriveStepSchema,
  extractStepSchema,
  fieldNameSchema,
  filterStepSchema,
  groupKeySchema,
  groupStepSchema,
  highlightSchema,
  limitStepSchema,
  pipelineSchema,
  pipelineStepSchema,
  renameStepSchema,
  selectStepSchema,
  sortStepSchema,
  validateExpressionSource,
  validatePathSource,
} from "./pipeline.js";

export type { ExtractStep, GroupStep, HighlightSpec, PipelineStep } from "./pipeline.js";

export {
  ALL_ROWS,
  groupByShapeSchema,
  groupColumn,
  isEmptyShape,
  measureShapeSchema,
  rolesForShape,
  shapeProblems,
  shapeSteps,
  widgetShapeSchema,
} from "./shape.js";

export type { GroupByShape, MeasureShape, WidgetShape } from "./shape.js";

export type { NamedSource } from "./dashboard.js";

export type { BuiltinComponentId } from "./contracts.js";

export { findNarrowing, narrowingFileSchema, narrowingSchema } from "./narrowing.js";

export type { Narrowing, NarrowingFile } from "./narrowing.js";

export { describeMetric, metricSchema, reconcileRuleSchema } from "./metric.js";

export type { MetricDefinition, ReconcileRule } from "./metric.js";
