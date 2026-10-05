/**
 * The API-mapping half of the authoring agent: reading an API's map, record
 * types, references, views, categories and rhythm, writing connectors and
 * repairs, and the LLM adapter shape they all share.
 *
 * Moved out of `@freebirdai/dash-agent`, which re-exports all of it.
 */
export { inferShape, schemaDrifted } from "./infer.js";
export type { FieldFormat, FieldInfo, InferredShape, JsonKind } from "./infer.js";
export { fakeLlm } from "./llm.js";
export type {
  LlmAdapter,
  LlmGenerateOptions,
  LlmMessage,
  LlmStreamChunk,
  LlmTokenUsage,
  LlmTool,
  RecordedCall,
} from "./llm.js";
export { MAP_SYSTEM_PROMPT, buildMapPrompt, mapApi, pruneAmbiguousRelations } from "./apimap.js";
export type { MapInput, MapProposal, MapResult } from "./apimap.js";
export {
  ENTITY_SYSTEM_PROMPT,
  acceptEntityLabel,
  buildEntityPrompt,
  describeEntities,
  entityFromProposal,
  entityProposalSchema,
  fieldsOfResource,
  scopeOf,
} from "./entities.js";
export type { EntityInput, EntityProposal, EntityResult } from "./entities.js";
export {
  REFERENCE_SYSTEM_PROMPT,
  buildReferencePrompt,
  classifyReferences,
  referenceCandidates,
  referenceProposalSchema,
} from "./references.js";
export type { ReferenceCandidate, ReferenceInput, ReferenceResult } from "./references.js";
export {
  CATEGORY_SYSTEM_PROMPT,
  buildCategoryPrompt,
  categoriesFromProposal,
  categoriseApi,
  categoryFingerprint,
  categoryId,
} from "./categories.js";
export type { CategoryInput, CategoryProposal, CategoryResult } from "./categories.js";
export {
  RHYTHM_SYSTEM_PROMPT,
  buildRhythmPrompt,
  classifyRhythm,
  rhythmFromProposal,
} from "./rhythm.js";
export type { RhythmProposal, RhythmResult } from "./rhythm.js";
export { UNTRUSTED_METADATA, callTool } from "./retry.js";
export { VIEWS_SYSTEM_PROMPT, chooseViews } from "./views.js";
export type { ViewProposal, ViewsInput, ViewsResult } from "./views.js";
export { buildMatchPrompt, matchFieldsSchema, matchFieldsTool, matchWriteFields } from "./writes.js";
export type { MatchFieldsInput, MatchFieldsProposal, MatchFieldsResult } from "./writes.js";
export { buildRepairPrompt, proposeRepair, repairProposalSchema, repairTool } from "./repair.js";
export type { RepairInput, RepairProposal } from "./repair.js";
export { HOOKS, buildConnectorPrompt, connectorProposalSchema, connectorTool, proposeConnector } from "./connector.js";
export type { ConnectorInput, ConnectorProposal } from "./connector.js";
export type { BriefCandidate, BriefField } from "./candidate.js";
