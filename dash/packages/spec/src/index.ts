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

export type { ComposeResponsePromptInput, FoundContext, ResponseChannel, SchedulingPromptInput } from "./agent-prompt.js";

export {
  CASE_STATUSES,
  FINAL_TASK_STATUSES,
  MAX_CALL_DEPTH,
  ON_FAILURE,
  RUN_STATUSES,
  TASK_STATUSES,
  TEMPLATE_KINDS,
  TRIGGER_NODE,
  WORKFLOW_EVERY,
  WORKFLOW_EVERY_MS,
  WORKFLOW_ONCE,
  WORKFLOW_RANGES,
  WORKFLOW_STEP_MODES,
  caseAttemptSchema,
  caseDefinitionSchema,
  caseScope,
  caseWaitSchema,
  definitionOf,
  chainEdges,
  cronSchema,
  describeCron,
  describeNode,
  describeTrigger,
  firstNode,
  isApiTrigger,
  isTimeZone,
  isWatchedTrigger,
  nextNode,
  nodeMode,
  nodeName,
  nodeOutcomes,
  ownerRefSchema,
  taskBodySchema,
  taskReversalSchema,
  taskSchema,
  triggerLimitsSchema,
  workflowCaseSchema,
  workflowEdgeSchema,
  workflowEverySchema,
  workflowInputDefSchema,
  workflowInputSchema,
  workflowLimitsSchema,
  workflowNodeSchema,
  workflowReads,
  workflowRunSchema,
  workflowSchema,
  workflowSourceSchema,
  workflowStartSchema,
  workflowStepModeSchema,
  workflowTemplateSchema,
  workflowTriggerSchema,
} from "./workflow.js";

export type {
  CaseAttempt,
  CaseDefinition,
  CaseStatus,
  CaseWait,
  OwnerRef,
  Task,
  TaskBody,
  TaskReversal,
  TaskStatus,
  TriggerLimits,
  WorkflowCase,
  WorkflowEdge,
  WorkflowEvery,
  WorkflowInput,
  WorkflowInputDef,
  WorkflowNode,
  WorkflowRun,
  WorkflowSource,
  WorkflowSpec,
  WorkflowStart,
  WorkflowStepMode,
  WorkflowTemplate,
  WorkflowTrigger,
  WorkflowTriggerKind,
} from "./workflow.js";

export {
  APPROVAL_MODES,
  BLOCK_KINDS,
  BLOCK_KIND_WORDS,
  DEFAULT_HOURS,
  DEFAULT_SETTINGS,
  EMPTY_RULES,
  FIELD_RULE_OPS,
  FIELD_RULE_WORDS,
  LAYER_KEYS,
  LOCATION_KINDS,
  LOCATION_WORDS,
  POOL_ASSIGN,
  POOL_ASSIGN_WORDS,
  SETTINGS_LAYERS,
  WEEKDAYS,
  WHEN_UNKNOWN,
  appointmentTypeSchema,
  blockSchema,
  blockSettingsSchema,
  consolidationSchema,
  typeEligibilitySchema,
  describeRecurrence,
  durationSchema,
  factPathSchema,
  fieldRuleSchema,
  hoursRangeSchema,
  localDateSchema,
  localDateTimeSchema,
  minutesOf,
  partialSettingsSchema,
  placementSchema,
  placementTargetSchema,
  poolSchema,
  recurrenceSchema,
  resolveSettings,
  ruleSetIsEmpty,
  ruleSetSchema,
  schedulingProfileSchema,
  schedulingSettingsSchema,
  timeOfDaySchema,
  weekdayOf,
  weeklyHoursSchema,
} from "./scheduling.js";

export type {
  AppointmentType,
  TypeEligibility,
  Block,
  BlockKind,
  Consolidation,
  FieldRule,
  FieldRuleOp,
  HoursRange,
  Occurrence,
  PartialSettings,
  Placement,
  PlacementTarget,
  Pool,
  Recurrence,
  ResolvedSettings,
  RuleSet,
  SchedulingProfile,
  SchedulingSettings,
  SettingsLayer,
  Weekday,
  WeeklyHours,
} from "./scheduling.js";

export {
  CALENDAR_KINDS,
  CALENDAR_STATUSES,
  calendarEnd,
  calendarEntryInputSchema,
  calendarEventSchema,
  calendarOverlaps,
  calendarSortKey,
  calendarSourceSchema,
  calendarStart,
  isDateOnly,
  ownerKey,
  upgradeCalendarEvent,
} from "./calendar.js";

export type { CalendarEntryInput, CalendarEvent, CalendarKind, CalendarSource, CalendarStatus } from "./calendar.js";

export {
  ACTIVE_BOOKING_STATUSES,
  BOOKING_EVENTS,
  BOOKING_EVENT_WORDS,
  BOOKING_ORIGINS,
  BOOKING_STATUSES,
  BOOKING_STATUS_WORDS,
  bookingActorSchema,
  bookingEventSchema,
  bookingSchema,
  bookingSuggestionSchema,
  dueAt,
  holdsOf,
  resolvedSettingsSchema,
} from "./booking.js";

export type { Booking, BookingActor, BookingEvent, BookingEventKind, BookingHold, BookingOrigin, BookingStatus, BookingSuggestion } from "./booking.js";

export {
  CONTACT_CHANNELS,
  CONTACT_FIELD_KINDS,
  CONTACT_ORIGINS,
  FIELD_SOURCES,
  MATCH_OUTCOMES,
  RESERVED_FIELD_KEYS,
  addressValueSchema,
  contactFieldDefInputSchema,
  contactFieldDefSchema,
  contactFieldKeySchema,
  contactFieldSchema,
  contactFieldSourceSchema,
  contactFieldValueSchema,
  contactInputSchema,
  contactKeys,
  contactLinkSchema,
  contactMatchRuleInputSchema,
  contactMatchRuleSchema,
  contactSchema,
  contactStatsSchema,
  fieldRefSchema,
  fieldValueFor,
  fieldValueOf,
  normalizeEmail,
  normalizePhone,
} from "./contact.js";

export type {
  AddressValue,
  Contact,
  ContactChannel,
  ContactField,
  ContactFieldDef,
  ContactFieldDefInput,
  ContactFieldKind,
  ContactFieldSource,
  ContactFieldValue,
  ContactInput,
  ContactLink,
  ContactMatchRule,
  ContactMatchRuleInput,
  ContactOrigin,
  ContactStats,
  FieldRef,
  FieldSource,
  MatchOutcome,
} from "./contact.js";

export {
  ACTION_BASES,
  ACTION_MODEL_TASKS,
  ACTION_VARIANTS,
  BASE_INFO,
  FIELD_KINDS,
  TASK_BODY_KINDS,
  actionSettingsSchema,
  actionVariant,
  describeDuration,
  durationMs,
  fieldProblems,
  fieldVisible,
  missingFields,
  outcomesFor,
  variantsOf,
  withDefaults,
} from "./actions.js";

export type { ActionBase, ActionField, ActionModelTask, ActionVariant, FieldKind, SuggestionId, TaskBodyKind } from "./actions.js";

export { passes, predicateProblem, renderText, renderValue, stepRow, templateProblem } from "./workflow-expr.js";

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
export { DASH_SCREENS, type DashScreen } from "./screens.js";
