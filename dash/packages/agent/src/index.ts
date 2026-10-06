export {
  buildWidget,
  coercionsFor,
  componentFits,
  fieldsForRole,
  missingRoles,
  unfillableRoles,
  valueTypesOf,
  widgetId,
} from "./bind.js";
export type { BindableField, BuildInput, RoleBinding } from "./bind.js";
export {
  MAX_PARTS,
  ROLE_STEP,
  addPart,
  applyAnswer,
  conciergeDraftSchema,
  draftFingerprint,
  draftPartSchema,
  drilldownDraftSchema,
  isPlacedCurrent,
  isRoleStep,
  joinDraftSchema,
  newDraft,
  partCount,
  partStep,
  partView,
  partsOf,
  placeDraft,
  roleOfStep,
  skipStep,
  splitPartStep,
  withPart,
} from "./concierge/draft.js";
export type {
  ConciergeDraft,
  DraftPart,
  DrilldownDraft,
  JoinDraft,
  FieldGroupDraft,
  HeaderDraft,
  SectionDraft,
} from "./concierge/draft.js";
export { buildAll, buildFromDraft, buildInterleaved } from "./concierge/build.js";
export { canFacet, facetFields, facetableFields } from "./concierge/facets.js";
export type { FacetChoiceInput, FacetableInput } from "./concierge/facets.js";
export {
  applyArrangement,
  feasibleArrangements,
  pairEndpoints,
  pairFields,
} from "./concierge/arrange.js";
export type { Arrangement, ArrangementOption, JoinPairing } from "./concierge/arrange.js";
export type { BuildAllResult, BuildResult } from "./concierge/build.js";
export {
  EFFECT_STEPS,
  allSteps,
  allStepsAcross,
  applyStep,
  applyStepAcross,
  describeField,
  emptyContext,
  contextForConnection,
  extraFieldOptions,
  extrasRole,
  fieldPool,
  highlightOptions,
  labelsFor,
  nextStep,
  nextStepAcross,
  preferredForRole,
  readiness,
  readinessAcross,
  remainingSteps,
  remainingStepsAcross,
  settle,
  settleAcross,
  skipStepAcross,
  valueOfAcross,
  viewOptions,
  withJoinedColumns,
} from "./concierge/steps.js";
export { revise, takeReading } from "./concierge/revise.js";
export type { DraftPatch, Rejection, ReviseResult } from "./concierge/revise.js";
export type {
  ChildCollection,
  ConciergeContext,
  DrillDownCandidate,
  JoinCandidate,
  MissingPiece,
  ReadPlan,
  Step,
  StepEntry,
  StepOption,
} from "./concierge/steps.js";
export { inferShape, schemaDrifted } from "@freebirdai/connect/agent";
export type { FieldFormat, FieldInfo, InferredShape, JsonKind } from "@freebirdai/connect/agent";
export { fakeLlm } from "@freebirdai/connect/agent";
export type {
  LlmAdapter,
  LlmGenerateOptions,
  LlmMessage,
  LlmStreamChunk,
  LlmTokenUsage,
  LlmTool,
  RecordedCall,
} from "@freebirdai/connect/agent";
export { mapProposal } from "./map.js";
export type { MappedProposal } from "./map.js";
export { MAP_SYSTEM_PROMPT, buildMapPrompt, mapApi, pruneAmbiguousRelations } from "@freebirdai/connect/agent";
export type { MapInput, MapProposal, MapResult } from "@freebirdai/connect/agent";
export {
  ENTITY_SYSTEM_PROMPT,
  acceptEntityLabel,
  buildEntityPrompt,
  describeEntities,
  entityFromProposal,
  entityProposalSchema,
  fieldsOfResource,
  scopeOf,
} from "@freebirdai/connect/agent";
export type { EntityInput, EntityProposal, EntityResult } from "@freebirdai/connect/agent";
export {
  REFERENCE_SYSTEM_PROMPT,
  buildReferencePrompt,
  classifyReferences,
  referenceCandidates,
  referenceProposalSchema,
} from "@freebirdai/connect/agent";
export type { ReferenceCandidate, ReferenceInput, ReferenceResult } from "@freebirdai/connect/agent";

export {
  BRIEF_SYSTEM_PROMPT,
  briefCandidates,
  briefFromParts,
  resolveCandidate,
  briefSchema,
  buildBriefPrompt,
  writeBrief,
} from "./brief.js";
export { patchFromBrief } from "./concierge/from-brief.js";
export type {
  BriefCandidate,
  BriefField,
  BriefParts,
  WriteBriefInput,
  WriteBriefResult,
} from "./brief.js";
export { buildDetailPrompt, planDetail } from "./detail.js";
export type {
  ChildOption,
  DetailGroup,
  DetailHeader,
  DetailPlan,
  DetailPlanInput,
  DetailProposal,
} from "./detail.js";
export { distinctValues, looksChoosable } from "./narrow.js";
export type { DistinctValuesResult, FieldValue } from "./narrow.js";
export { matchValues, pickNarrowingField } from "./narrow-llm.js";
export type { FieldPick, ValueMatch } from "./narrow-llm.js";
export { proposeWidget } from "./propose.js";
export type { Ambiguity, ProposalResult, ProposeInput } from "./propose.js";
export { highlightCandidates, nounFromTitle } from "./authoring.js";
export {
  CATEGORY_SYSTEM_PROMPT,
  buildCategoryPrompt,
  categoriesFromProposal,
  categoriseApi,
  categoryFingerprint,
  categoryId,
} from "@freebirdai/connect/agent";
export type { CategoryInput, CategoryProposal, CategoryResult } from "@freebirdai/connect/agent";
export {
  STARTER_SYSTEM_PROMPT,
  buildStarterPrompt,
  composeCategory,
  composeStarters,
  starterBatchKey,
  startersFromProposal,
} from "./starters.js";
export type {
  ComposedCategory,
  StarterCheck,
  StarterInput,
  StarterProposal,
  StarterResult,
} from "./starters.js";
export {
  RHYTHM_SYSTEM_PROMPT,
  buildRhythmPrompt,
  classifyRhythm,
  rhythmFromProposal,
} from "@freebirdai/connect/agent";
export type { RhythmProposal, RhythmResult } from "@freebirdai/connect/agent";
export { UNTRUSTED_METADATA, callTool } from "@freebirdai/connect/agent";
export { VIEWS_SYSTEM_PROMPT, chooseViews } from "@freebirdai/connect/agent";
export type { ViewProposal, ViewsInput, ViewsResult } from "@freebirdai/connect/agent";
export type { AuthoredWidget } from "./authoring.js";
export { SYSTEM_PROMPT, buildUserPrompt, proposalSchema, proposeWidgetTool } from "./tool.js";
export type { Proposal } from "./tool.js";

export { draftPatchSchema } from "./concierge/patch.js";
export { buildMatchPrompt, matchFieldsSchema, matchFieldsTool, matchWriteFields } from "@freebirdai/connect/agent";
export type { MatchFieldsInput, MatchFieldsProposal, MatchFieldsResult } from "@freebirdai/connect/agent";
export { buildRepairPrompt, proposeRepair, repairProposalSchema, repairTool } from "@freebirdai/connect/agent";
export type { RepairInput, RepairProposal } from "@freebirdai/connect/agent";
export { HOOKS, buildConnectorPrompt, connectorProposalSchema, connectorTool, proposeConnector } from "@freebirdai/connect/agent";
export type { ConnectorInput, ConnectorProposal } from "@freebirdai/connect/agent";
