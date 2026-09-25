// Re-exported so consumers have a single import surface for spec vocabulary.
export type { Grain } from "@freebirdai/dash-expr";
export { GRAINS, parseGrain, truncateToBucket } from "@freebirdai/dash-expr";

export { isAggregation, parseAggregation } from "./aggregation.js";
export type { ParsedAggregation } from "./aggregation.js";

export {
  COERCION_DESCRIPTIONS,
  COERCION_SEMANTICS,
  applyCoercion,
  coercionForFormat,
  coercionSchema,
  fieldFormatSchema,
} from "./coercion.js";
export { connectionKeyRef } from "./primitives.js";
export type { Coercion, FieldFormat } from "./coercion.js";

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
  authSchema,
  missingInputs,
  pathParamNames,
  requiredInputs,
  allowedHost,
  connectionSchema,
  effectiveAuth,
  getOp,
  connectionAuths,
  connectionKeyRefs,
  connectionNeedsAddress,
  connectionNeedsAuthSetup,
  getOpDef,
  opDefSchema,
  opUsesRange,
  opSchema,
  paginationSchema,
  resolveOp,
} from "./connection.js";
export type { AuthSpec, ConnectionSpec, OpDef, OpSpec, PaginationSpec } from "./connection.js";

export {
  ARCHETYPES,
  ARCHETYPE_IDS,
  IMPORT_VERSION,
  MAP_VERSION,
  archetypeSchema,
  catalogEntrySchema,
  dialectSchema,
  mappedFieldSchema,
  formatRangeToken,
  timeFilterSchema,
  timeFormatSchema,
} from "./dialect.js";
export type {
  Archetype,
  ArchetypeDef,
  CatalogEntry,
  DialectSpec,
  MappedField,
  TimeFilterSpec,
  TimeFormat,
} from "./dialect.js";

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
  ENTITY_KINDS,
  ENTITY_VERSION,
  VERIFY_BUDGET_DEFAULT,
  VERIFY_BUDGET_MAX,
  displayFields,
  displayName,
  entityById,
  entityDisplaySchema,
  entityFieldSchema,
  entityForResource,
  entityKindSchema,
  entitySchema,
  entityStatSchema,
  entityViewsSchema,
  fieldGroupSchema,
  fieldPathSchema,
  inferTitleMode,
  titleModeOf,
  recordOverrideSchema,
  referenceFields,
  referenceSchema,
} from "./entity.js";
export type {
  EntityDisplay,
  EntityField,
  EntityKind,
  EntitySpec,
  EntityStat,
  EntityViews,
  RecordOverride,
  ReferenceSpec,
} from "./entity.js";

export {
  CATEGORIES_MAX,
  CATEGORY_VERSION,
  STARTERS_PER_CATEGORY_MAX,
  boardLayoutSchema,
  categorySchema,
  categoryStatusSchema,
  onboardingChoicesSchema,
  onboardingPreviewSchema,
  onboardingSchema,
  onboardingStatusSchema,
  profileSchema,
  starterSchema,
  starterSizeSchema,
  widgetCheckSchema,
  widgetCheckStatusSchema,
} from "./category.js";
export type {
  ApiProfile,
  BoardLayout,
  CategorySpec,
  CategoryStatus,
  OnboardingChoices,
  OnboardingPreview,
  OnboardingSpec,
  OnboardingStatus,
  StarterSpec,
  WidgetCheck,
  WidgetCheckStatus,
} from "./category.js";

export {
  DEFAULT_TIERS,
  DEFAULT_TIER_ID,
  RHYTHM_VERSION,
  VOLATILITIES,
  apiRhythmSchema,
  connectionRhythmSchema,
  tierById,
  tierFor,
  tierSchema,
  volatilitySchema,
} from "./rhythm.js";
export type {
  ApiRhythm,
  ConnectionRhythm,
  TierDecision,
  TierSpec,
  Volatility,
} from "./rhythm.js";

export { clampCell, completeLayout, solveLayout } from "./layout.js";
export type { PlacementRequest, SolveLayoutOptions, SolveLayoutResult } from "./layout.js";

export { RECIPES, facetsFromRecipe, recipeFor } from "./recipes.js";
export type { EntityRecipe } from "./recipes.js";

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

export { readField } from "./field-path.js";
export { bundleOf, bundlesOf, ownFields } from "./bundles.js";
export type { Bundle } from "./bundles.js";
export { parentsFrom, recordKeyString, valueForParam } from "./record-key.js";
export {
  fieldCoercion,
  fieldReading,
  fieldSemantic,
  isFlagField,
  observeEntity,
  observeField,
  readingsDiffer,
  rerootBrief,
  rerootEntity,
  wrapperOf,
} from "./observe.js";
export type { SeenField } from "./observe.js";
export type { RecordKey } from "./record-key.js";

export { referenceIds, targetOfRow } from "./reference.js";
export type { ReferenceRow } from "./reference.js";

export {
  entityGraph,
  entityLinkViews,
  fieldLexicon,
  entityPageView,
  linkColumn,
  targetFor,
  targetsOf,
} from "./entity-graph.js";
export type {
  AddressPart,
  EntityBackref,
  EntityGraph,
  EntityGraphInput,
  EntityLinkView,
  EntityPageField,
  EntityPageSection,
  EntityPageView,
  EntityReference,
  EntityReferenceView,
  LinkedPart,
  OmittedSection,
  ReachCost,
  ReachPlan,
  RecordAddress,
  UnreachableLink,
} from "./entity-graph.js";

export {
  SERVER_VALUE,
  authCredentials,
  authKeyRefs,
  fnv1a,
  idSchema,
  looksLikePlaceholder,
  paramDefSchema,
  queryValueSchema,
  rekeyAuth,
  resolveServerUrl,
  serverTemplateSchema,
  serverVariableSchema,
  templateVariableNames,
} from "./primitives.js";
export type { AuthCredential, ServerTemplate, ServerVariable } from "./primitives.js";
export type { ParamDef } from "./primitives.js";

export {
  CAPABILITY_REPORT_VERSION,
  capabilityReportSchema,
  diffReports,
  drillDownSchema,
  enumerationOutcomeSchema,
  fingerprintOps,
  fingerprintConnection,
  isStale,
  joinSchema,
  parseCapabilityReport,
  persistedFieldSchema,
  persistedShapeSchema,
  toAllowlist,
  unknownResourceSchema,
} from "./report.js";
export type {
  AllowedOp,
  CapabilityAllowlist,
  CapabilityReport,
  EnumerationOutcome,
  PersistedField,
  PersistedShape,
  ReportDiff,
  UnknownResourceRecord,
} from "./report.js";

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
  TOKEN_FILTERS,
  dashboardParamsSchema,
  defaultGrainFor,
  filterDeclSchema,
  grainSchema,
  hasTokens,
  interpolate,
  interpolateValue,
  parseTokens,
  quantiseEnd,
  queryKey,
  queryKeyPrefix,
  rangePresetSchema,
  resolveGrain,
  resolveRange,
} from "./params.js";
export type {
  DashboardParams,
  FilterDecl,
  ParsedToken,
  QueryParams,
  RangePreset,
  ResolvedParams,
  ResolveRangeInput,
  TimeRange,
  TokenFilter,
} from "./params.js";

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

export {
  SEMANTICS,
  aggregationSchema,
  statusTone,
  formatSchema,
  flagLabel,
  flagValue,
  formatValue,
  guessSemantic,
  looksLikeFlag,
  isFieldNoise,
  looksLikeApiLink,
  looksLikeIdentifier,
  normaliseName,
  semanticTypeSchema,
  valueTypeSchema,
} from "./semantics.js";
export type {
  StatusTone,
  Aggregation,
  FormatOptions,
  FormatSpec,
  SemanticDef,
  SemanticType,
  ValueType,
} from "./semantics.js";

export {
  canDrillDown,
  collectionKey,
  deriveResourceGraph,
  deriveResourceModel,
  nounFromPathParam,
  commonPathPrefix,
  pathSegments,
  resolveSameNoun,
  sharedPathPrefix,
  relationSchema,
  resourceForOp,
  resourceSchema,
  singularNoun,
} from "./resource.js";
export type { RelationSpec, ResourceModel, ResourceSpec, ShapeOp } from "./resource.js";
export { inferIdField, relationGraph } from "./relations.js";
export type {
  ChildLink,
  GraphField,
  GraphOp,
  LinkFetch,
  PeerLink,
  RecordLink,
  RelationGraph,
  RelationGraphInput,
  UnusableLink,
} from "./relations.js";
export type { NamedSource } from "./dashboard.js";
export type { BuiltinComponentId } from "./contracts.js";
export { findNarrowing, narrowingFileSchema, narrowingSchema } from "./narrowing.js";
export type { Narrowing, NarrowingFile } from "./narrowing.js";
