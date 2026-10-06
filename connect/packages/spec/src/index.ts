/**
 * The connection side of FreeBird's spec: connections, connectors, catalog
 * entries, record types and their relations, evidence, rhythm and writes.
 *
 * Everything here describes an API and how to read and change it, with no
 * dashboard in sight. `@freebirdai/dash-spec` re-exports all of it and adds
 * the widget, board and onboarding vocabulary on top.
 */

export {
  COERCION_DESCRIPTIONS,
  COERCION_SEMANTICS,
  applyCoercion,
  coercionForFormat,
  coercionSchema,
  fieldFormatSchema,
} from "./coercion.js";

export {
  MAX_PAGES,
  PARAM_LOCATIONS,
  READ_SAFETY_BASES,
  authTokenRefs,
  connectionKeyRef,
  graphqlOperations,
  graphqlReadsOnly,
  pagingParamNames,
  readBodySchema,
  readSafetySchema,
  safeByProtocol,
} from "./primitives.js";

export type { OAuthSpec, ReadBody, ReadSafety } from "./primitives.js";

export type { Coercion, FieldFormat } from "./coercion.js";

export {
  authSchema,
  missingInputs,
  boardInputs,
  pathParamNames,
  requiredInputs,
  allowedHost,
  connectionSchema,
  effectiveAuth,
  filterParamsOf,
  readsRangeOf,
  getOp,
  connectionAuths,
  connectionCredentials,
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
  categoryStatusSchema,
  profileSchema,
  categorySchema,
  categorySchemaOf,
  categoriesSchemaOf,
} from "./category.js";

export type {
  ApiProfile,
  CategoryStatus,
  CategorySpec,
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

export { RECIPES, defaultFacets, defaultSort, facetsFromRecipe, recipeFor } from "./recipes.js";

export type { EntityRecipe, ListView } from "./recipes.js";

export { readField, setField } from "./field-path.js";

export {
  WRITES_VERSION,
  WRITE_METHODS,
  pathShape,
  writeBodySchema,
  writeFieldSchema,
  writeMethodSchema,
  writeOpDefSchema,
  writesListSchema,
} from "./write.js";

export type {
  WriteBody,
  WriteCommitView,
  WriteDiffRow,
  WriteField,
  WriteFieldError,
  WriteFormField,
  WriteFormView,
  WriteMethod,
  WriteOpDef,
  WriteReviewView,
} from "./write.js";

export { actionCreates, MODE_PREFERENCE, pairedAction, writeRoleOf } from "./write-roles.js";

export type { RolePaths, WriteMode, WriteRole } from "./write-roles.js";

export { mapWriteFields, unmappedFields } from "./write-map.js";

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

export {
  entityGraph,
  writesEmpty,
  writesView,
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
  EntityWrites,
  EntityWritesView,
  WriteKindView,
  WriteTarget,
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
  isSingletonOp,
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

export {
  EVIDENCE_LEVELS,
  EVIDENCE_WORDS,
  countReconciled,
  evidenceLevelSchema,
  evidenceRank,
  evidenceSchema,
  readCoverage,
  strongestEvidence,
} from "./evidence.js";

export type {
  CompletionReason,
  CompletionState,
  Evidence,
  EvidenceLevel,
  ReadCompletion,
  ReadCoverage,
  ReadExtent,
} from "./evidence.js";

export {
  CONNECTOR_CONTRACT,
  CONNECTOR_HOOKS,
  CONNECTOR_METHODS,
  CONNECTOR_PURPOSES,
  OPERATION_HOOKS,
  connectorAuthoritySchema,
  connectorDestinationSchema,
  connectorExchangeSchema,
  connectorOperationSchema,
  connectorRequestSchema,
  connectorSchema,
  connectorServes,
  requestMatches,
} from "./connector.js";

export type {
  ConnectorAuthority,
  ConnectorDestination,
  ConnectorHook,
  ConnectorOperation,
  ConnectorPurpose,
  ConnectorRequest,
  ConnectorSpec,
} from "./connector.js";

export { credentialNameSchema } from "./primitives.js";

export {
  TOKEN_FILTERS,
  dashboardParamsSchema,
  defaultGrainFor,
  filterDeclSchema,
  grainSchema,
  hasTokens,
  interpolate,
  interpolatePath,
  interpolateValue,
  parseTokens,
  quantiseEnd,
  paramsForWidget,
  rangeForWindow,
  opOfQueryKey,
  queryKey,
  queryKeyOpPrefix,
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
  TimeWindow,
  TokenFilter,
} from "./params.js";

export {
  CAPABILITIES,
  capability,
  capabilityNote,
  compatibilityMarkdown,
} from "./capabilities.js";

export type {
  Capability,
  CapabilityArea,
  CapabilityId,
  CapabilityStatus,
} from "./capabilities.js";

export { componentIdSchema } from "./primitives.js";
export type { ComponentId } from "./primitives.js";
export { FACET_MAX_PER_WIDGET } from "./entity.js";
export type { FieldGroup } from "./entity-graph.js";
export type { BriefPaths } from "./observe.js";
export { humanLabel } from "./label.js";
