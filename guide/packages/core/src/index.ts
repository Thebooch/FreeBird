// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export * from "./types.js";
export { newId } from "./id.js";

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------
export {
  ComponentRegistry,
  createComponentRegistry,
} from "./components/registry.js";
export {
  componentMetadataSchema,
  gridHintsSchema,
  knowledgeItemSchema,
  knowledgeSourceSchema,
  orientationSchema,
  type ComponentMetadata,
} from "./components/schema.js";

// ---------------------------------------------------------------------------
// Knowledge graph
// ---------------------------------------------------------------------------
export { KnowledgeGraph, createKnowledgeGraph } from "./knowledge/graph.js";

// ---------------------------------------------------------------------------
// Citation DOM helper (browser-side; SSR-safe)
// ---------------------------------------------------------------------------
export {
  activateCitation,
  replayPendingCitation,
  safeQuery,
  stashPendingCitation,
  readPendingCitation,
  PENDING_CITATION_KEY,
  type ActivateCitationOptions,
  type CitationActivationOutcome,
  type ReplayPendingCitationOptions,
} from "./dom/citation-dom.js";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
export { solveLayout, pickSize, type SolveLayoutOptions, type SolveLayoutResult } from "./layout/solver.js";
export { buildPlanLayoutTool } from "./layout/tool.js";

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
export {
  ChatEngine,
  createChatEngine,
  createCiteStripper,
  type ChatEngineOptions,
  type ChatStreamEvent,
  type FinalReplyContext,
  type LlmUsagePayload,
  type SendMessageInput,
} from "./chat/engine.js";
export {
  resolveProcessingToolsForTurn,
  type ResolveProcessingToolsInput,
} from "./chat/processingTools.js";
export { resolveReferences, type ResolveReferencesOptions } from "./chat/references.js";
export {
  buildCitationsPrompt,
  citationsFromToolPayload,
  extractCitations,
  CITE_MARKER_RE,
} from "./chat/citations.js";
export { buildKnowledgePrompt, type BuildKnowledgePromptOptions } from "./chat/knowledge-context.js";

// ---------------------------------------------------------------------------
// Custom tabs
// ---------------------------------------------------------------------------
export {
  CustomTabsService,
  createCustomTabsService,
  type SaveCustomTabInput,
} from "./tabs/customTabs.js";

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------
export { DigestEngine, createDigestEngine, type DigestEngineOptions, type DigestRunResult } from "./digest/engine.js";
export { parseCron, nextCronRun } from "./digest/cron.js";

// ---------------------------------------------------------------------------
// Permission modes (per-tenant posture; orthogonal to requiresConfirmation)
// ---------------------------------------------------------------------------
export {
  DEFAULT_MODE,
  allowsActions,
  clampConfirmation,
  isAtLeastAsRestrictive,
  isPermissionMode,
  narrowMode,
  resolveMode,
  restrictiveness,
  type ModeInput,
  type ModeResolver,
  type NarrowResult,
  type PermissionMode,
} from "./permissions/index.js";

// ---------------------------------------------------------------------------
// Grants (content-digest-bound approvals; shared by Guide and Dash)
// ---------------------------------------------------------------------------
export {
  canonicalize,
  digest,
  sha256Hex,
  normalizeDeclaration,
  actionCapability,
  connectionCapability,
  opCapability,
  widens,
  addedCapabilities,
  createGrant,
  evaluateGrant,
  isGranted,
  type Capability,
  type Declaration,
  type EvaluateGrantInput,
  type Grant,
  type GrantEvaluation,
  type GrantVerdict,
} from "./grants/index.js";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export * from "./actions/types.js";
export {
  buildHarnessTurn,
  type HarnessTurn,
  type BuildHarnessTurnInput,
} from "./actions/harness.js";
// HarnessArgsMode re-exported above with encode helpers
export {
  diffKeys,
  validateActionArgs,
  type ValidateArgsResult,
} from "./actions/diff.js";
export {
  actionGrantDeclaration,
  actionGrantSubject,
  grantForActionArgs,
  type ActionGrantPort,
} from "./actions/grants.js";
export {
  deriveActionPreview,
  type ActionPreviewContent,
  type ActionPreviewRow,
  type ActionPreviewFn,
} from "./actions/preview.js";
export { parseChatBoldSegments, type ChatTextSegment } from "./chat/format.js";
export {
  encodePerActionStartToolName,
  resolvePerActionStartToolName,
  PER_ACTION_START_PREFIX,
  type HarnessArgsMode,
} from "./actions/harness.js";
export {
  runActionPreflight,
  type ActionPreflightResult,
  type ActionBlocker,
  type SuggestedAction,
} from "./actions/preflight.js";
export {
  runAction,
  runAuthorize,
  prepareActionArgs,
  type RunActionInput,
  type RunActionOutcome,
  type ActionExecutionSource,
} from "./actions/run.js";

// ---------------------------------------------------------------------------
// Support / customer service
// ---------------------------------------------------------------------------
export {
  ticketTypeSchema,
  ticketSeveritySchema,
  ticketDraftSchema,
  fileTicketBodySchema,
  stampTicket,
  type TicketType,
  type TicketSeverity,
  type TicketDraft,
  type Ticket,
  type IssueClassification,
  type FileTicketBody,
  type StampTicketInput,
} from "./support/ticket.js";
export { buildSupportPrompt } from "./support/prompt.js";
export {
  deriveTicketPreview,
  type TicketPreviewContent,
  type TicketPreviewRow,
} from "./support/preview.js";
export {
  REPORT_ISSUE_TOOL_NAME,
  buildReportIssueTool,
  parseReportIssueArgs,
  classificationFromDraft,
  buildTicketDraftPayload,
  type TicketDraftPayload,
} from "./support/engine.js";
export type { SupportSink, SupportSinkResult } from "./adapters/support.js";
export type { SupportEngineOptions } from "./chat/engine.js";

// ---------------------------------------------------------------------------
// Review mechanism
// ---------------------------------------------------------------------------
export {
  ALL_REVIEW_DISPOSITIONS,
  type ReviewDisposition,
  type ReviewableItem,
  type ReviewCapability,
  type ReviewableComponentSummary,
} from "./review/types.js";
export { buildReviewPrompt } from "./review/prompt.js";
export {
  REVIEW_ITEMS_TOOL_NAME,
  buildReviewItemsTool,
} from "./review/tool.js";

// ---------------------------------------------------------------------------
// Adapters (re-exported from subpath as well)
// ---------------------------------------------------------------------------
export * from "./adapters/db.js";
export * from "./adapters/llm.js";
export * from "./adapters/email.js";

// ---------------------------------------------------------------------------
// Top-level convenience factory.
// ---------------------------------------------------------------------------
import { createComponentRegistry } from "./components/registry.js";
import { createKnowledgeGraph } from "./knowledge/graph.js";
import { createChatEngine } from "./chat/engine.js";
import { createCustomTabsService } from "./tabs/customTabs.js";
import { createDigestEngine } from "./digest/engine.js";
import type { DbAdapter } from "./adapters/db.js";
import type { LlmAdapter } from "./adapters/llm.js";
import type { EmailAdapter } from "./adapters/email.js";
import type { SupportEngineOptions } from "./chat/engine.js";

export interface CreateFreeBirdOptions {
  db: DbAdapter;
  llm: LlmAdapter;
  email?: EmailAdapter;
  systemPrompt?: string;
  summaryPrompt?: string;
  support?: SupportEngineOptions;
  review?: { enabled?: boolean };
}

/**
 * Create a fully-wired FreeBird instance: a registry, knowledge graph, chat
 * engine, custom tabs service, and (if email is supplied) a digest engine.
 *
 * Host apps typically import this once at startup and share the returned
 * object across their server and worker processes.
 */
export const createFreeBird = <TRender = unknown, TAuth = unknown>(
  opts: CreateFreeBirdOptions,
) => {
  const registry = createComponentRegistry<TRender, TAuth>();
  const knowledge = createKnowledgeGraph(registry);
  const chat = createChatEngine({
    db: opts.db,
    llm: opts.llm,
    registry,
    knowledge,
    systemPrompt: opts.systemPrompt,
    support: opts.support,
    review: opts.review,
  });
  const tabs = createCustomTabsService(opts.db);
  const digest = opts.email
    ? createDigestEngine({
        db: opts.db,
        llm: opts.llm,
        email: opts.email,
        registry,
        summaryPrompt: opts.summaryPrompt,
      })
    : undefined;

  return { registry, knowledge, chat, tabs, digest };
};

export type FreeBird<TRender = unknown, TAuth = unknown> = ReturnType<
  typeof createFreeBird<TRender, TAuth>
>;
