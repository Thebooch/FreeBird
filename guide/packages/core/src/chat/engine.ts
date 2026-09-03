import type { DbAdapter } from "../adapters/db.js";
import type { LlmAdapter, LlmMessage, LlmTokenUsage, LlmTool } from "../adapters/llm.js";
import type { ComponentRegistry } from "../components/registry.js";
import type { KnowledgeGraph } from "../knowledge/graph.js";
import { runActionPreflight } from "../actions/preflight.js";
import {
  allowsActions,
  clampConfirmation,
  narrowMode,
  resolveMode,
  type ModeInput,
  type PermissionMode,
} from "../permissions/index.js";
import {
  buildHarnessTurn,
  resolvePerActionStartToolName,
  type HarnessArgsMode,
} from "../actions/harness.js";
import { deriveActionPreview } from "../actions/preview.js";
import type { ActionBlocker } from "../actions/types.js";
import { buildPlanLayoutTool } from "../layout/tool.js";
import { solveLayout } from "../layout/solver.js";
import { resolveReferences } from "./references.js";
import { resolveProcessingToolsForTurn } from "./processingTools.js";
import { CITE_MARKER_RE, buildCitationsPrompt, extractCitations } from "./citations.js";
import { buildKnowledgePrompt } from "./knowledge-context.js";
import { buildSkillsPrompt } from "./skills-context.js";
import {
  ASK_USER_TOOL_NAME,
  buildAnswersPrompt,
  buildAskUserTool,
  parseAskUserArgs,
  toPendingQuestion,
} from "../ask/index.js";
import type { PendingQuestion, QuestionAnswer } from "../ask/types.js";
import { buildNoticesPrompt } from "./notices-context.js";
import {
  TOOL_DESCRIBE_NAME,
  TOOL_SEARCH_NAME,
  describeActionSchema,
  searchActions,
} from "../actions/tool-search.js";
import type { StateNotice } from "../notices/types.js";
import type { SkillProvider } from "../skills/types.js";
import { buildSupportPrompt } from "../support/prompt.js";
import { buildReviewPrompt } from "../review/prompt.js";
import { REVIEW_ITEMS_TOOL_NAME, buildReviewItemsTool } from "../review/tool.js";
import {
  REPORT_ISSUE_TOOL_NAME,
  buildReportIssueTool,
  buildTicketDraftPayload,
  parseReportIssueArgs,
} from "../support/engine.js";
import type { TicketDraftPayload } from "../support/engine.js";
import type { IssueClassification, TicketDraft } from "../support/ticket.js";
import type { TicketPreviewContent } from "../support/preview.js";
import type { ActionPhase, ActionState, PendingAction } from "../actions/types.js";
import { newId } from "../id.js";
import type {
  AuthContext,
  ChatMessage,
  ComponentCitation,
  GridCell,
  KnowledgeItem,
  LayoutIntent,
  LayoutPlan,
  Reference,
  WorkspaceCitation,
} from "../types.js";

/**
 * Everything a turn produced, handed to the final reply step.
 *
 * `draft` is the prose the model wrote during the tool loop. Under
 * `finalReply.mode: "always"` it was never shown to anyone, so the final step
 * is free to rewrite, keep or discard it. `deterministic` is the sentence the
 * engine would have persisted on its own — passed in rather than used, so a
 * host writing its own voice still knows what the engine concluded.
 */
export interface FinalReplyContext {
  /** Which conversation this is, so a host can keep per-session state. */
  readonly sessionId: string;
  readonly userText: string;
  readonly draft: string;
  readonly deterministic: string;
  readonly actionState: ActionState;
  readonly executedExtraTools: Array<{ name: string; args: unknown; result: unknown }>;
  readonly finalLayout?: LayoutPlan;
  readonly clarificationQuestion: string;
  /**
   * Actions this turn actually started, in order.
   *
   * Distinct from `actionState`, which is a *position*: an action with no
   * confirmation step runs, completes and leaves the phase idle, so a host
   * reading the phase alone cannot tell "nothing happened" from "something
   * happened and finished". That difference decides what the reply should
   * say, so it is reported rather than inferred.
   */
  readonly actionsRun: ReadonlyArray<{
    readonly componentId: string;
    readonly actionId: string;
  }>;
  /** Set when the turn failed outright; the reply has to say so. */
  readonly error?: string;
}

export interface ChatEngineOptions {
  db: DbAdapter;
  llm: LlmAdapter;
  registry: ComponentRegistry<any, any>;
  knowledge: KnowledgeGraph;
  /**
   * How much latitude the agent has, as a fixed posture or resolved per
   * caller from the turn's auth. Absent means `"full"`, which is exactly
   * what every deployment did before this option existed.
   */
  permissionMode?: ModeInput;
  /** Global system prompt prepended to every chat. */
  systemPrompt?: string;
  /** Max prior messages to include in an LLM call. */
  maxHistoryMessages?: number;
  /**
   * Args-shape mode for the action harness start / update tools.
   * Default `"per_action"` — one tool per action with typed top-level
   * fields (OpenAI-safe). `"typed"` uses a single `start_action` union;
   * `"loose"` uses generic `args` records.
   */
  harnessArgsMode?: HarnessArgsMode;
  /**
   * If a turn produces only tool calls (no user-visible text) and the
   * action layer lands in `collecting` or `awaiting_confirmation`, the
   * engine runs additional LLM completions in the same SSE stream so the
   * model can ask the missing question / summarize the preview.
   *
   * Capped at this number of inner LLM calls per `send()`. Default `3`.
   * Set to `1` to disable looping (fall back to the v1 behaviour).
   */
  maxToolSteps?: number;
  /**
   * Optional host-supplied text used when a turn would otherwise produce
   * a blank assistant bubble (the LLM only called tools and produced no
   * prose, even after the auto-loop). Two shapes:
   *
   * - `string` — used verbatim.
   * - `function` — receives `{ phase, pending }` and returns either a
   *   string to use, or `null` to fall through to the engine's built-in
   *   phase-based summary.
   *
   * When it applies, the phrase wins over the engine's generic summaries
   * — but not over a summary of executed tool results, which carries real
   * information. Default `null`: the engine uses its built-in summaries,
   * so every turn still persists a visible assistant message.
   */
  fallbackToolOnlyPhrase?:
    | string
    | ((ctx: { phase: ActionPhase; pending: PendingAction | null }) => string | null)
    | null;
  /**
   * When the LLM adapter yields a chunk with `usage` (e.g. OpenAI
   * with `includeUsage: true`), emit `llm_usage` SSE events for the client.
   */
  emitLlmUsage?: boolean;
  /**
   * Server-side hook for the same usage payload (logging, metering, etc.).
   */
  onLlmUsage?: (info: LlmUsagePayload) => void;
  /**
   * Optional USD estimate per completion. Hosts using OpenAI can pass
   * {@link estimateOpenAiChatCostUsd} from `@freebirdai/adapters-llm-openai`.
   * When provided, `estimatedUsd` is set on payloads (or `null` if the
   * model is unknown to the estimator).
   */
  estimateLlmCostUsd?: (model: string, usage: LlmTokenUsage) => number | null;
  /**
   * Catalog of host-defined processing tools. Actions/components declare
   * {@link ActionDefinition.processingTools} ids; only matching tools are
   * exposed each turn (merged with {@link SendMessageInput.extraTools}).
   */
  processingToolCatalog?: Record<string, LlmTool>;
  /**
   * Execute domain-specific tools registered via processing catalog and/or
   * {@link SendMessageInput.extraTools}. When set, the engine runs each
   * extra-tool call, feeds the result into an inner LLM step, and asks the
   * model to reply in plain text.
   */
  executeExtraTool?: (
    name: string,
    args: unknown,
    ctx: { auth: AuthContext; sessionId: string },
  ) => Promise<unknown>;
  /**
   * When true (default), every `send()` persists a non-empty assistant
   * message — using deterministic fallbacks and, if needed, one final
   * tool-free LLM summarization step.
   */
  requireAssistantReply?: boolean;
  /**
   * How the turn's user-visible reply is produced.
   *
   * `"fallback"` (default) keeps the historical behaviour: whatever prose the
   * model emitted during the tool loop IS the reply, and the final
   * summarization step only rescues a turn that produced nothing usable.
   *
   * `"always"` makes the final step the only writer of the reply. The loop's
   * prose becomes a draft handed to that step rather than something shown and
   * then replaced — so inner-step deltas are not streamed, and the final step
   * streams instead. Hosts that want one consistent voice over tool results,
   * action outcomes and errors want this; it costs one extra LLM call per turn.
   *
   * `render` replaces {@link renderTurnSummaryPrompt} with the host's own
   * instructions. It receives everything the turn produced, including the
   * deterministic summary the engine would otherwise have persisted.
   */
  finalReply?: {
    mode?: "fallback" | "always";
    render?: (ctx: FinalReplyContext) => string;
    /**
     * Model for the final step, when it should differ from the loop's.
     *
     * The two jobs are not alike. The loop decides which tools to call, which
     * is routing; the final step writes the only sentence anybody reads. A
     * host running the loop on a cheap model has no way to say that without
     * this, and would be paying for the cheap one exactly where it shows.
     */
    llm?: LlmAdapter | (() => LlmAdapter);
  };
  /**
   * Host hook for wizard missing fields / blockers beyond the action Zod
   * schema (e.g. a multi-step wizard whose later steps depend on earlier ones).
   */
  deriveActionReadiness?: (
    componentId: string,
    actionId: string,
    args: Record<string, unknown>,
  ) => {
    missing: string[];
    blockers?: ActionBlocker[];
    blockedMessage?: string;
  } | null;
  /**
   * Normalize raw LLM tool args before missing-field detection and persistence
   * (e.g. strip `"null"` placeholders for unset optional fields).
   */
  sanitizeActionArgs?: (
    componentId: string,
    actionId: string,
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  /**
   * Customer-service / escalation subsystem. When set (and `enabled` is not
   * false), injects support prompt guidance and exposes `report_issue`.
   */
  support?: SupportEngineOptions;
  /**
   * Review mechanism. When `enabled` is not false, auto-activates whenever the
   * registry has components declaring a `review` capability: injects the review
   * prompt and exposes the `review_items` tool (executed via `executeExtraTool`).
   */
  review?: { enabled?: boolean };
  /**
   * When false, the `plan_layout` grid-dashboard tool is never exposed,
   * regardless of `SendMessageInput.generateLayout`. Default `true`.
   */
  enablePlanLayout?: boolean;
  /**
   * When enabled, injects a system message (see `buildCitationsPrompt`)
   * teaching the model to append `[[cite:componentId]]` markers to replies
   * grounded in a registered component's knowledge. Those markers are
   * stripped from the displayed text and resolved into
   * {@link ComponentCitation}s carried in `toolPayload.citations` on the
   * persisted assistant message (same untyped-JSON convention
   * `workspaceCitations` already uses — no DB schema changes needed).
   * Off by default so existing deployments are unaffected.
   */
  citations?: { enabled?: boolean };
  /**
   * When enabled (default), injects a system message listing registered
   * component knowledge so the LLM can answer from site facts and cite them.
   *
   * `retrieve` lets the host swap exhaustive injection for per-message
   * retrieval (e.g. embeddings top-k): it receives the turn's auth + user
   * text and returns the site-wide items to inject. Returning null (or
   * throwing) falls back to the full `registry.listKnowledge()` list.
   * Component-attached knowledge is always injected either way.
   */
  knowledgeContext?: {
    enabled?: boolean;
    maxChars?: number;
    retrieve?: (args: {
      auth: AuthContext;
      text: string;
    }) => Promise<KnowledgeItem[] | null> | KnowledgeItem[] | null;
  };
  /**
   * Instruction packs — the procedures the assistant should follow.
   *
   * `provider` is **optional**, and its absence is a supported steady state
   * rather than a misconfiguration: the harness exists, nothing is plugged
   * into it, and no block or token is spent. That is what an open-source host
   * gets until it decides what to feed in.
   *
   * The managed build layers its defaults under the tenant's own selections:
   *
   * ```ts
   * skills: { provider: composeSkillProviders(defaults, dbSkillProvider(db)) }
   * ```
   *
   * Resolved once per turn from that turn's `auth`, so one process serving
   * many tenants cannot leak one tenant's instructions to another.
   */
  skills?: {
    enabled?: boolean;
    maxChars?: number;
    provider?: SkillProvider;
  };
  /**
   * Let the model ask one structured question and wait for the answer.
   *
   * Off by default: it changes the shape of a turn — the reply can now be a
   * card instead of prose — and no existing client knows to render one.
   */
  askUser?: { enabled?: boolean };
}

export interface SupportEngineOptions {
  enabled?: boolean;
  prompt?: string;
  requireConfirmation?: boolean;
  sink?: import("../adapters/support.js").SupportSink;
}

export interface SendMessageInput {
  sessionId: string;
  text: string;
  /** Cells currently locked on the client — the engine preserves them. */
  lockedCells?: GridCell[];
  /** If true, also generate a layout plan (default true). */
  generateLayout?: boolean;
  /** Extra tools the caller wants to expose (e.g. per-app domain tools). */
  extraTools?: Record<string, LlmTool>;
  /** Client-supplied abort signal. */
  signal?: AbortSignal;
  /**
   * Snapshot of the client's action state. The harness uses this to gate
   * which action tools are exposed and inject phase-aware system messages.
   */
  actionState?: ActionState;
  /** Components currently visible on the page. */
  activeComponentIds?: string[];
  /** Overrides the LLM adapter default model for this turn. */
  model?: string;
  /**
   * A tighter posture for this session than the deployment's.
   *
   * May only narrow. Asking for more latitude than the tenant allows is an
   * error, not a request that gets quietly clamped — see `narrowMode`.
   */
  permissionMode?: PermissionMode;
  /**
   * Answers to questions asked on an earlier turn.
   *
   * Rendered into the prompt as settled fact rather than replayed as a user
   * message: the user clicked an option, they did not type it.
   */
  answers?: QuestionAnswer[];
  /**
   * Things the user did without saying anything, since the last reply.
   *
   * Context for this message, never a request in their own right — see
   * `buildNoticesPrompt`.
   */
  notices?: StateNotice[];
  /**
   * Optional host context for support escalation (e.g. a call log row from
   * a review modal). Attached to ticket drafts filed this turn.
   */
  supportContext?: {
    subject?: Record<string, unknown>;
    transcriptExcerpt?: string;
    metadata?: Record<string, unknown>;
  };
}

/** Token usage for one inner completion within a chat `send()`. */
export interface LlmUsagePayload {
  model: string;
  usage: LlmTokenUsage;
  /** 0-based index of the LLM call within this `send()`. */
  stepIndex: number;
  /**
   * Present when {@link ChatEngineOptions.estimateLlmCostUsd} is set.
   * `null` means the estimator did not recognize the model.
   */
  estimatedUsd?: number | null;
}

/**
 * Action-layer event payloads embedded in the chat SSE stream.
 *
 * The harness emits these so the client store can fold action transitions
 * into its own state machine without polling. They are intentionally
 * narrow: the full audit trail (with `before`/`changed`/`result`) flows
 * through the dedicated `/actions/confirm` response, not through SSE.
 */
export interface ActionStreamPayload {
  recordId: string;
  componentId: string;
  actionId: string;
  args?: Record<string, unknown>;
  missing?: string[];
  requiresConfirmation?: "none" | "preview" | "strict";
  label?: string;
  reason?: string;
  preview?: import("../actions/types.js").ActionPreviewContent;
}

export interface TicketStreamPayload {
  draftId: string;
  draft?: TicketDraft;
  preview?: TicketPreviewContent;
  classification?: IssueClassification;
  subject?: Record<string, unknown>;
  transcriptExcerpt?: string;
  metadata?: Record<string, unknown>;
  ticket?: import("../support/ticket.js").Ticket;
  message?: string;
}

export interface ChatStreamEvent {
  kind:
    | "user_saved"
    | "text_delta"
    | "assistant_saved"
    | "layout_ready"
    | "error"
    | "action_started"
    | "action_args_updated"
    | "action_clarification"
    | "action_cancelled"
    | "action_paused"
    | "action_resumed"
    | "action_blocked"
    | "llm_usage"
    | "issue_classified"
    | "ticket_drafted"
    | "ticket_created"
    | "ticket_failed"
    | "question_asked";
  userMessage?: ChatMessage;
  textDelta?: string;
  assistantMessage?: ChatMessage;
  layout?: LayoutPlan;
  droppedLayoutItems?: Array<{ componentId: string; reason: string }>;
  references?: Reference[];
  error?: string;
  /** Populated on the `action_*` event kinds. */
  action?: ActionStreamPayload;
  /** For `action_blocked`: structured remediation hints. */
  blockers?: ActionBlocker[];
  /** For `action_blocked`: user-facing summary. */
  message?: string;
  /** For `action_clarification`: the LLM's question to display. */
  clarification?: string;
  /** Populated on `llm_usage` when usage tracking is enabled. */
  llmUsage?: LlmUsagePayload;
  /** Support / ticket escalation payloads. */
  ticket?: TicketStreamPayload;
  /** For `question_asked`: what the client should render and answer. */
  question?: PendingQuestion;
}

/**
 * The ChatEngine is the top-level orchestrator. A single "turn" looks like:
 *
 *   1. Persist user message.
 *   2. Look up cross-chat references via the KnowledgeGraph.
 *   3. Run an inner loop (up to `maxToolSteps`):
 *        a. Build harness tools/system messages from the *current* action state.
 *        b. Stream one LLM completion; collect text + tool calls.
 *        c. Apply tool calls; predict the next action state.
 *        d. If the step produced any text, exit the loop.
 *        e. If the new phase is `collecting`/`awaiting_confirmation`,
 *           loop again so the model can ask the missing question /
 *           summarize the preview within the same SSE stream.
 *   4. If `plan_layout` was called, run the deterministic solver, merge
 *      with locked cells, and emit a `layout_ready` event.
 *   5. Persist (or skip) the assistant reply with attached references.
 */
export class ChatEngine {
  private readonly systemPrompt: string;
  private readonly maxHistory: number;
  private readonly maxToolSteps: number;
  private readonly harnessArgsMode: HarnessArgsMode;
  private readonly fallbackToolOnlyPhrase: ChatEngineOptions["fallbackToolOnlyPhrase"];
  private readonly emitLlmUsage: boolean;
  private readonly onLlmUsage: ChatEngineOptions["onLlmUsage"];
  private readonly estimateLlmCostUsd: ChatEngineOptions["estimateLlmCostUsd"];
  private readonly executeExtraTool: ChatEngineOptions["executeExtraTool"];
  private readonly requireAssistantReply: boolean;
  /** True when the final step is the only writer of the reply. */
  private readonly finalReplyAlways: boolean;
  private readonly renderFinalReply: (ctx: FinalReplyContext) => string;
  private readonly finalReplyLlm: LlmAdapter | (() => LlmAdapter) | undefined;
  private readonly processingToolCatalog: ChatEngineOptions["processingToolCatalog"];
  private readonly deriveActionReadiness?: ChatEngineOptions["deriveActionReadiness"];
  private readonly sanitizeActionArgs?: ChatEngineOptions["sanitizeActionArgs"];
  private readonly supportEnabled: boolean;
  private readonly supportPrompt?: string;
  private readonly supportRequireConfirmation: boolean;
  private readonly reviewEnabled: boolean;
  private readonly enablePlanLayout: boolean;
  private readonly citationsEnabled: boolean;
  private readonly skillsEnabled: boolean;
  private readonly skillsMaxChars: number;
  private readonly skillProvider: SkillProvider | undefined;
  private readonly askUserEnabled: boolean;
  private readonly knowledgeContextEnabled: boolean;
  private readonly knowledgeMaxChars: number;
  private readonly knowledgeRetrieve: NonNullable<
    ChatEngineOptions["knowledgeContext"]
  >["retrieve"];

  constructor(private readonly opts: ChatEngineOptions) {
    this.systemPrompt =
      opts.systemPrompt ??
      "You are the AI assistant inside a FreeBird-powered web app. " +
        "When the user asks to see information, CALL the `plan_layout` tool with " +
        "the most relevant components. Always keep answers concise.";
    this.maxHistory = opts.maxHistoryMessages ?? 30;
    this.maxToolSteps = Math.max(1, opts.maxToolSteps ?? 3);
    this.harnessArgsMode = opts.harnessArgsMode ?? "per_action";
    this.fallbackToolOnlyPhrase = opts.fallbackToolOnlyPhrase ?? null;
    this.emitLlmUsage = opts.emitLlmUsage ?? false;
    this.onLlmUsage = opts.onLlmUsage;
    this.estimateLlmCostUsd = opts.estimateLlmCostUsd;
    this.executeExtraTool = opts.executeExtraTool;
    this.requireAssistantReply = opts.requireAssistantReply !== false;
    this.finalReplyAlways = opts.finalReply?.mode === "always";
    this.renderFinalReply = opts.finalReply?.render ?? renderTurnSummaryPrompt;
    this.finalReplyLlm = opts.finalReply?.llm;
    this.processingToolCatalog = opts.processingToolCatalog;
    this.deriveActionReadiness = opts.deriveActionReadiness;
    this.sanitizeActionArgs = opts.sanitizeActionArgs;
    this.supportEnabled = opts.support !== undefined && opts.support.enabled !== false;
    this.supportPrompt = opts.support?.prompt;
    this.supportRequireConfirmation = opts.support?.requireConfirmation !== false;
    this.reviewEnabled = opts.review?.enabled !== false;
    this.enablePlanLayout = opts.enablePlanLayout !== false;
    this.citationsEnabled = opts.citations?.enabled === true;
    // Enabled by default *when a provider is given*; no provider means the
    // whole feature is inert, which is the open-source default.
    this.skillsEnabled = opts.skills?.enabled !== false;
    this.skillsMaxChars = opts.skills?.maxChars ?? 6000;
    this.skillProvider = opts.skills?.provider;
    this.askUserEnabled = opts.askUser?.enabled === true;
    this.knowledgeContextEnabled = opts.knowledgeContext?.enabled !== false;
    this.knowledgeMaxChars = opts.knowledgeContext?.maxChars ?? 6000;
    this.knowledgeRetrieve = opts.knowledgeContext?.retrieve;
  }

  private pendingMissingOpts(): {
    deriveActionReadiness?: ChatEngineOptions["deriveActionReadiness"];
    sanitizeActionArgs?: ChatEngineOptions["sanitizeActionArgs"];
  } {
    return {
      deriveActionReadiness: this.deriveActionReadiness,
      sanitizeActionArgs: this.sanitizeActionArgs,
    };
  }

  private buildReadinessSyncEvents(
    state: ActionState,
    registry: ComponentRegistry<any, any>,
  ): ChatStreamEvent[] {
    if (!state.pending || !this.deriveActionReadiness) return [];

    const pending = state.pending;
    const fullArgs = { ...pending.args };
    const host = this.deriveActionReadiness(pending.componentId, pending.actionId, fullArgs);
    const missing = computePendingMissing(
      registry,
      pending.componentId,
      pending.actionId,
      fullArgs,
      this.pendingMissingOpts(),
    );
    const events: ChatStreamEvent[] = [];

    const missingChanged =
      missing.length !== pending.missing.length || missing.some((m, i) => pending.missing[i] !== m);
    const blockersChanged =
      JSON.stringify(host?.blockers ?? []) !== JSON.stringify(pending.blockers ?? []);

    if (missingChanged && !host?.blockers?.length) {
      events.push({
        kind: "action_args_updated",
        action: {
          recordId: pending.recordId,
          componentId: pending.componentId,
          actionId: pending.actionId,
          args: {},
          missing,
        },
      });
    }

    if (host?.blockers?.length && (blockersChanged || missingChanged)) {
      events.push({
        kind: "action_blocked",
        message: host.blockedMessage ?? "Complete the missing setup steps before applying.",
        blockers: host.blockers,
        action: {
          recordId: pending.recordId,
          componentId: pending.componentId,
          actionId: pending.actionId,
          args: fullArgs,
          missing,
          requiresConfirmation: pending.requiresConfirmation,
          label: pending.label,
        },
      });
    }

    return events;
  }

  async *send(input: SendMessageInput, auth: AuthContext): AsyncIterable<ChatStreamEvent> {
    const { db, llm, registry, knowledge } = this.opts;

    // 1. Persist user message
    /*
     * Guarded, and it is the only statement out here that is.
     *
     * Everything after this runs inside the try below, so a failure there
     * becomes an `error` event the client can show. This one did not: if the
     * session does not exist — a stored id outliving the database it was made
     * in, which happens after a restore or a wipe — the append throws, the
     * generator ends before yielding anything, and the caller gets an empty
     * 200. No user message, no error, no reason. Silence is the one answer a
     * client cannot do anything with.
     */
    let userMessage;
    try {
      userMessage = await db.appendMessage(
        { sessionId: input.sessionId, role: "user", content: input.text },
        auth,
      );
    } catch (err) {
      yield {
        kind: "error",
        error:
          `that conversation could not be written to (${
            err instanceof Error ? err.message : String(err)
          }) — its session may no longer exist`,
      };
      return;
    }
    yield { kind: "user_saved", userMessage };

    try {
      /*
       * Posture for this turn, resolved once from the caller's auth.
       *
       * Inside the try so a throwing resolver becomes a visible error rather
       * than an empty 200 — and resolved once rather than per tool call, so
       * one turn cannot straddle two postures.
       */
      const tenantMode: PermissionMode = await resolveMode(
        this.opts.permissionMode,
        auth,
      );
      const narrowed = narrowMode(tenantMode, input.permissionMode);
      if (!narrowed.ok) {
        yield { kind: "error", error: narrowed.reason };
        return;
      }
      const permissionMode = narrowed.mode;

      // 2. Cross-chat references
      const { references, contextMessages } = await resolveReferences(db, knowledge, auth, {
        text: input.text,
        currentSessionId: input.sessionId,
      });

      // 3. Build base messages (shared across inner steps).
      const history = await db.listMessages(input.sessionId, auth);
      const recent = history.slice(-this.maxHistory);
      const baseMessages: LlmMessage[] = [{ role: "system", content: this.systemPrompt }];
      if (this.supportEnabled) {
        baseMessages.push({
          role: "system",
          content: buildSupportPrompt(this.supportPrompt),
        });
      }
      const reviewable = this.reviewEnabled ? registry.listReviewable() : [];
      if (reviewable.length > 0) {
        baseMessages.push({
          role: "system",
          content: buildReviewPrompt(reviewable),
        });
      }
      if (this.knowledgeContextEnabled) {
        let siteItems: KnowledgeItem[] | undefined;
        if (this.knowledgeRetrieve) {
          try {
            const retrieved = await this.knowledgeRetrieve({
              auth,
              text: input.text,
            });
            if (retrieved) siteItems = retrieved;
          } catch {
            // Retrieval is an optimization — never let it break the turn.
          }
        }
        const knowledgePrompt = buildKnowledgePrompt(registry, {
          maxChars: this.knowledgeMaxChars,
          ...(siteItems ? { siteItems } : {}),
        });
        if (knowledgePrompt) {
          baseMessages.push({ role: "system", content: knowledgePrompt });
        }
      }
      /*
       * Skills, after the facts and before the citation rules.
       *
       * A throwing provider costs the turn its instructions and nothing else.
       * Failing the whole reply because a skill lookup went wrong would trade
       * a degraded answer for no answer, which is never the better trade.
       */
      if (this.skillsEnabled && this.skillProvider) {
        try {
          const skills = await this.skillProvider({
            auth,
            sessionId: input.sessionId,
            text: input.text,
            activeComponentIds: input.activeComponentIds ?? [],
          });
          const skillsPrompt = buildSkillsPrompt(skills, {
            maxChars: this.skillsMaxChars,
            activeComponentIds: input.activeComponentIds ?? [],
          });
          if (skillsPrompt) baseMessages.push({ role: "system", content: skillsPrompt });
        } catch (err) {
           
          console.warn("[freebird] skill provider failed; continuing without skills:", err);
        }
      }

      // Background first: what changed, then what was settled, then the rules.
      if (input.notices && input.notices.length > 0) {
        const noticesPrompt = buildNoticesPrompt(input.notices);
        if (noticesPrompt) baseMessages.push({ role: "system", content: noticesPrompt });
      }

      // What was already asked and settled, so the model does not ask again.
      if (input.answers && input.answers.length > 0) {
        const answersPrompt = buildAnswersPrompt(input.answers);
        if (answersPrompt) baseMessages.push({ role: "system", content: answersPrompt });
      }

      if (this.citationsEnabled) {
        const citationsPrompt = buildCitationsPrompt(registry);
        if (citationsPrompt) {
          baseMessages.push({ role: "system", content: citationsPrompt });
        }
      }
      if (input.supportContext) {
        const ctxParts: string[] = [];
        if (input.supportContext.subject) {
          ctxParts.push(
            "Support subject context (attach to any ticket):\n" +
              JSON.stringify(input.supportContext.subject, null, 2),
          );
        }
        if (input.supportContext.transcriptExcerpt) {
          ctxParts.push("Transcript excerpt:\n" + input.supportContext.transcriptExcerpt);
        }
        if (input.supportContext.metadata) {
          ctxParts.push("Metadata:\n" + JSON.stringify(input.supportContext.metadata, null, 2));
        }
        if (ctxParts.length > 0) {
          baseMessages.push({
            role: "system",
            content: ctxParts.join("\n\n"),
          });
        }
      }
      if (contextMessages.length > 0) {
        baseMessages.push({
          role: "system",
          content: renderReferenceContext(contextMessages),
        });
      }
      for (const m of recent) {
        if (m.role === "tool") continue;
        baseMessages.push({ role: m.role, content: m.content });
      }

      // 4. Inner step loop
      let assistantText = "";
      let pendingQuestion: PendingQuestion | undefined;
      let layoutIntent: LayoutIntent | undefined;
      const extraToolResults: Array<{ name: string; args: unknown }> = [];
      const executedExtraTools: Array<{
        name: string;
        args: unknown;
        result: unknown;
      }> = [];
      const stepContinuationMessages: LlmMessage[] = [];
      let actionState: ActionState = input.actionState ?? {
        phase: "idle",
        pending: null,
        journal: [],
        workflowStack: [],
      };
      if (!actionState.workflowStack) {
        actionState = { ...actionState, workflowStack: [] };
      }
      let clarificationQuestion = "";
      let ticketDraftedThisTurn = false;
      /** Every action started this turn, for the final reply's context. */
      const actionsRun: Array<{ componentId: string; actionId: string }> = [];

      const turnExtraTools = resolveProcessingToolsForTurn({
        baseExtraTools: input.extraTools,
        processingToolCatalog: this.processingToolCatalog,
        actionState: input.actionState,
        activeComponentIds: input.activeComponentIds,
        registry: this.opts.registry,
      });
      // Expose `review_items` (host-executed via executeExtraTool) whenever the
      // registry has reviewable components.
      if (reviewable.length > 0 && this.executeExtraTool) {
        turnExtraTools[REVIEW_ITEMS_TOOL_NAME] = buildReviewItemsTool(reviewable);
      }
      /*
       * Not gated on the permission posture. A read-only session may still be
       * asked which record it meant — asking is not acting, and refusing to
       * disambiguate would make the restricted mode worse at reading, which
       * is the one thing it is for.
       */
      const askUserTool = this.askUserEnabled ? buildAskUserTool() : null;

      for (let step = 0; step < this.maxToolSteps; step += 1) {
        // 4a. Tools + harness system messages for this step.
        const tools: Record<string, LlmTool> = { ...turnExtraTools };
        // Keep plan_layout available until we capture a layout intent for this
        // turn. Restricting it to step 0 broke "show me X" when step 0 ran a
        // processing tool (a host lookup/parse tool, etc.) and
        // looped without ever exposing plan_layout again.
        const actionBlocksLayoutFollowUp =
          actionState.phase !== "idle" && actionState.phase !== "error" && step > 0;
        if (
          this.enablePlanLayout &&
          input.generateLayout !== false &&
          !layoutIntent &&
          !actionBlocksLayoutFollowUp
        ) {
          tools.plan_layout = buildPlanLayoutTool(registry);
        }
        // Only while nothing has been asked yet: one question per turn, or a
        // model could stack cards the user has to answer in an order nobody
        // specified.
        if (askUserTool && !pendingQuestion) tools[ASK_USER_TOOL_NAME] = askUserTool;
        const harness = buildHarnessTurn({
          registry,
          actionState,
          activeComponentIds: input.activeComponentIds,
          argsMode: this.harnessArgsMode,
          permissionMode,
        });
        Object.assign(tools, harness.tools);
        if (this.supportEnabled && actionState.phase === "idle") {
          tools[REPORT_ISSUE_TOOL_NAME] = buildReportIssueTool();
        }

        const messages: LlmMessage[] = [...baseMessages];
        if (stepContinuationMessages.length > 0) {
          messages.splice(1, 0, ...stepContinuationMessages);
        }
        if (harness.systemMessages.length > 0) {
          messages.splice(1, 0, ...harness.systemMessages);
        }
        // Only force a text-only final step once the action is ready for the
        // user to confirm — not while still idle/collecting (otherwise the
        // model cannot call start_action / update_action_args after processing
        // host processing tools).
        const forceTextOnlyStep =
          step === this.maxToolSteps - 1 &&
          (executedExtraTools.length > 0 || step > 0) &&
          (actionState.phase === "awaiting_confirmation" || actionState.phase === "executing");

        if (step > 0 || forceTextOnlyStep) {
          // Nudge the model that we're now in an inner step continuation —
          // it should respond with a brief plain-text turn (a question or
          // confirmation summary) rather than re-emitting tool calls.
          messages.splice(1, 0, {
            role: "system",
            content: renderInnerStepHint(actionState, {
              layoutCaptured: layoutIntent !== undefined,
              extraToolsRan: executedExtraTools.length > 0,
              forceTextOnly: forceTextOnlyStep,
            }),
          });
        }

        // 4b. Stream this step.
        let stepText = "";
        const stepActionEvents: ChatStreamEvent[] = [];
        const stepExtraToolCalls: Array<{
          id: string;
          name: string;
          args: unknown;
        }> = [];
        let stepLayoutCalled = false;
        // Searching or describing is never the end of a turn: the model asked
        // a question of the registry and needs another step to act on it.
        let ranSearchTool = false;

        for await (const chunk of llm.stream({
          messages,
          tools: forceTextOnlyStep ? undefined : tools,
          signal: input.signal,
          model: input.model,
        })) {
          if (chunk.textDelta) {
            stepText += chunk.textDelta;
            assistantText += chunk.textDelta;
            /*
             * Under `finalReply: "always"` this text is a draft, not the
             * reply. Streaming it would show the user a preamble that the
             * final step then replaces — and `text_delta` is additive on the
             * client with no reset event, so the bubble would read as both
             * until `assistant_saved` lands. The final step streams instead.
             */
            if (!this.finalReplyAlways) {
              yield { kind: "text_delta", textDelta: chunk.textDelta };
            }
          }
          if (chunk.usage && (this.emitLlmUsage || this.onLlmUsage)) {
            const model = chunk.model ?? input.model ?? llm.defaultModel;
            const estimatedUsd = this.estimateLlmCostUsd?.(model, chunk.usage);
            const llmUsage: LlmUsagePayload = {
              model,
              usage: chunk.usage,
              stepIndex: step,
              ...(this.estimateLlmCostUsd !== undefined
                ? { estimatedUsd: estimatedUsd ?? null }
                : {}),
            };
            this.onLlmUsage?.(llmUsage);
            if (this.emitLlmUsage) {
              yield { kind: "llm_usage", llmUsage };
            }
          }
          if (chunk.toolCall) {
            const handled = handleActionToolCall(chunk.toolCall, registry, actionState, {
              deriveActionReadiness: this.deriveActionReadiness,
              sanitizeActionArgs: this.sanitizeActionArgs,
              permissionMode,
            });
            if (handled) {
              stepActionEvents.push(handled);
            } else if (chunk.toolCall.name === REPORT_ISSUE_TOOL_NAME) {
              const draft = parseReportIssueArgs(chunk.toolCall.args);
              if (draft) {
                const draftId = newId("ticket");
                const payload = buildTicketDraftPayload(draftId, draft, input.supportContext);
                stepActionEvents.push({
                  kind: "issue_classified",
                  ticket: {
                    draftId,
                    draft: payload.draft,
                    classification: payload.classification,
                  },
                });
                stepActionEvents.push({
                  kind: "ticket_drafted",
                  ticket: payload as TicketDraftPayload,
                });
                ticketDraftedThisTurn = true;
              }
            } else if (chunk.toolCall.name === "plan_layout") {
              layoutIntent = chunk.toolCall.args as LayoutIntent;
              stepLayoutCalled = true;
            } else if (
              chunk.toolCall.name === TOOL_SEARCH_NAME ||
              chunk.toolCall.name === TOOL_DESCRIBE_NAME
            ) {
              /*
               * Resolved here rather than through `executeExtraTool`: both
               * answer from the registry the engine already holds, so routing
               * them out to the host would make a lookup the host cannot do
               * any better into something it is obliged to implement.
               */
              const args = (chunk.toolCall.args ?? {}) as Record<string, unknown>;
              const result =
                chunk.toolCall.name === TOOL_SEARCH_NAME
                  ? {
                      actions: searchActions(
                        registry.listActions(
                          input.activeComponentIds && input.activeComponentIds.length > 0
                            ? { componentIds: input.activeComponentIds }
                            : undefined,
                        ).map((entry) => ({
                          ref: `${entry.componentId}:${entry.action.id}`,
                          componentId: entry.componentId,
                          actionId: entry.action.id,
                          description: entry.action.description,
                        })),
                        typeof args.query === "string" ? args.query : "",
                      ),
                    }
                  : (describeActionSchema(registry, args.action) ?? {
                      error: "no such action",
                    });
              executedExtraTools.push({
                name: chunk.toolCall.name,
                args: chunk.toolCall.args,
                result,
              });
              extraToolResults.push({ name: chunk.toolCall.name, args: chunk.toolCall.args });
              ranSearchTool = true;
            } else if (chunk.toolCall.name === ASK_USER_TOOL_NAME) {
              /*
               * The turn stops here.
               *
               * Every other tool feeds something back into the loop; this one
               * waits on a human, so there is nothing further to say. Looping
               * would only produce prose restating the question the card is
               * already showing.
               */
              const parsedAsk = parseAskUserArgs(chunk.toolCall.args);
              if (parsedAsk) pendingQuestion = toPendingQuestion(newId("q"), parsedAsk);
            } else if (turnExtraTools[chunk.toolCall.name] && this.executeExtraTool) {
              stepExtraToolCalls.push(chunk.toolCall);
            } else {
              extraToolResults.push({
                name: chunk.toolCall.name,
                args: chunk.toolCall.args,
              });
            }
          }
        }

        let ranExtraTools = false;
        if (stepExtraToolCalls.length > 0 && this.executeExtraTool) {
          for (const tc of stepExtraToolCalls) {
            try {
              const result = await this.executeExtraTool(tc.name, tc.args, {
                auth,
                sessionId: input.sessionId,
              });
              executedExtraTools.push({
                name: tc.name,
                args: tc.args,
                result,
              });
              extraToolResults.push({ name: tc.name, args: tc.args });
            } catch (err) {
              const result = {
                error: err instanceof Error ? err.message : String(err),
              };
              executedExtraTools.push({
                name: tc.name,
                args: tc.args,
                result,
              });
              extraToolResults.push({ name: tc.name, args: tc.args });
            }
          }
          stepContinuationMessages.push({
            role: "system",
            content: renderExtraToolContinuation(
              executedExtraTools.slice(-stepExtraToolCalls.length),
              this.finalReplyAlways,
            ),
          });
          ranExtraTools = true;
        } else if (stepExtraToolCalls.length > 0) {
          extraToolResults.push(
            ...stepExtraToolCalls.map((tc) => ({
              name: tc.name,
              args: tc.args,
            })),
          );
        }

        // Bridge processing-tool normalized args into action events from this
        // step (start_action + a host processing tool in one turn) and into
        // an already-pending action so the confirmation card shows all fields.
        if (ranExtraTools) {
          const stepTools = executedExtraTools.slice(-stepExtraToolCalls.length);
          mergeProcessingToolsIntoActionEvents(
            stepActionEvents,
            stepTools,
            actionState.pending?.args,
            registry,
          );
          if (actionState.pending) {
            const bridged = extractNormalizedArgsFromProcessingTools(
              actionState.pending,
              stepTools,
            );
            if (bridged) {
              const fullMerged = { ...actionState.pending.args, ...bridged };
              const missing = computePendingMissing(
                registry,
                actionState.pending.componentId,
                actionState.pending.actionId,
                fullMerged,
                this.pendingMissingOpts(),
              );
              stepActionEvents.push({
                kind: "action_args_updated",
                action: {
                  recordId: actionState.pending.recordId,
                  componentId: actionState.pending.componentId,
                  actionId: actionState.pending.actionId,
                  args: bridged,
                  missing,
                },
              });
            }
          }
        }

        // 4c. Yield the action events from this step.
        for (const ev of stepActionEvents) {
          if (ev.kind === "action_clarification" && ev.clarification?.trim()) {
            clarificationQuestion = ev.clarification.trim();
          }
          if (ev.kind === "action_started" && ev.action) {
            actionsRun.push({
              componentId: ev.action.componentId,
              actionId: ev.action.actionId,
            });
          }
          yield ev;
        }

        // 4d. Predict the new action state for the next step's harness.
        actionState = simulateActionState(
          actionState,
          stepActionEvents,
          registry,
          this.pendingMissingOpts(),
        );

        const readinessEvents = this.buildReadinessSyncEvents(
          actionState,
          registry,
        );
        for (const ev of readinessEvents) {
          yield ev;
        }
        if (readinessEvents.length > 0) {
          actionState = simulateActionState(
            actionState,
            readinessEvents,
            registry,
            this.pendingMissingOpts(),
          );
        }

        // 4d2. Server-side preflight (entity resolution, missing prerequisites).
        if (actionState.pending) {
          const def = registry.getAction(
            actionState.pending.componentId,
            actionState.pending.actionId,
          );
          const fullPendingArgs = { ...actionState.pending.args };
          if (def?.preflight) {
            const pf = await runActionPreflight(def, fullPendingArgs as never, {
              auth,
              sessionId: input.sessionId,
            });
            if (!pf.ok) {
              const blockedEv: ChatStreamEvent = {
                kind: "action_blocked",
                message: pf.message,
                blockers: pf.blockers,
                action: {
                  recordId: actionState.pending.recordId,
                  componentId: actionState.pending.componentId,
                  actionId: actionState.pending.actionId,
                  args: fullPendingArgs,
                  missing: actionState.pending.missing,
                  requiresConfirmation: actionState.pending.requiresConfirmation,
                  label: actionState.pending.label,
                },
              };
              yield blockedEv;
              stepActionEvents.push(blockedEv);
              actionState = {
                ...actionState,
                phase: "blocked",
                pending: {
                  ...actionState.pending,
                  blockers: pf.blockers,
                  blockedMessage: pf.message,
                },
              };
            } else if (pf.resolvedArgs && Object.keys(pf.resolvedArgs).length > 0) {
              const merged = {
                ...fullPendingArgs,
                ...pf.resolvedArgs,
              };
              const missing = computePendingMissing(
                registry,
                actionState.pending.componentId,
                actionState.pending.actionId,
                merged,
                this.pendingMissingOpts(),
              );
              const resolvedEv: ChatStreamEvent = {
                kind: "action_args_updated",
                action: {
                  recordId: actionState.pending.recordId,
                  componentId: actionState.pending.componentId,
                  actionId: actionState.pending.actionId,
                  args: pf.resolvedArgs,
                  missing,
                },
              };
              yield resolvedEv;
              stepActionEvents.push(resolvedEv);
              actionState = simulateActionState(
                actionState,
                [resolvedEv],
                registry,
                this.pendingMissingOpts(),
              );
            }
          }
        }

        // 4e. Loop guard: stop if we got user-visible text, hit a layout,
        // or the new phase is terminal-for-this-turn. Only loop when a
        // *progress-making* transition fired — `request_clarification`,
        // `cancel_action`, and `pause_action` are deliberate "wait for
        // the user" turns and must not auto-loop.
        const phase = actionState.phase;
        const phaseIsLoopable =
          phase === "collecting" || phase === "awaiting_confirmation" || phase === "blocked";
        const progressKinds: ChatStreamEvent["kind"][] = [
          "action_started",
          "action_args_updated",
          "action_resumed",
          "action_blocked",
        ];
        const madeProgress = stepActionEvents.some((ev) => progressKinds.includes(ev.kind));
        /*
         * A tool result the model has not seen yet is worth another step,
         * whether or not it said something first.
         *
         * This used to require the step to be silent, which quietly wasted the
         * work: a model that emits "I'll look up what endpoints are available"
         * *alongside* the tool call had the tool run, its result queued into
         * `stepContinuationMessages` — and then the loop broke on the prose, so
         * the result was fetched and discarded. The user was left with a
         * promise and no answer, and whether it happened at all came down to
         * whether the model narrated, which varies run to run.
         *
         * Text emitted in the same step as the call cannot be the answer,
         * because the result did not exist when it was written. So it is a
         * preamble, not a conclusion, and the turn is not finished. The
         * accumulated text carries it forward, so the user reads "I'll look
         * that up" followed by what was found. `maxToolSteps` still bounds it.
         */
        // A question outranks every reason to loop: the next thing that
        // happens is a person clicking, not another model call.
        if (pendingQuestion) break;
        const shouldLoopForExtraTools = (ranExtraTools || ranSearchTool) && !stepLayoutCalled;
        const shouldLoop =
          shouldLoopForExtraTools ||
          (stepText.trim().length === 0 && madeProgress && !stepLayoutCalled && phaseIsLoopable);
        if (!shouldLoop) break;
      }

      // 4f. When args fully validate, advance to confirmation only if preflight
      // passes (wizard prerequisites, schedule completeness, entity resolution).
      if (
        actionState.pending &&
        actionState.phase === "collecting" &&
        actionState.pending.missing.length === 0
      ) {
        const pendingAt4f = actionState.pending;
        const fullPendingArgs = { ...pendingAt4f.args };
        const def = registry.getAction(pendingAt4f.componentId, pendingAt4f.actionId);
        const parsed = def?.schema
          ? (
              def.schema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
            ).safeParse(fullPendingArgs)
          : null;
        let canAdvance = parsed?.success ?? true;

        const preAdvanceReadiness = this.buildReadinessSyncEvents(
          actionState,
          registry,
        );
        if (preAdvanceReadiness.length > 0) {
          for (const ev of preAdvanceReadiness) {
            yield ev;
          }
          actionState = simulateActionState(
            actionState,
            preAdvanceReadiness,
            registry,
            this.pendingMissingOpts(),
          );
          canAdvance = false;
        }

        if (canAdvance && def?.preflight) {
          const pf = await runActionPreflight(
            def,
            (parsed?.success ? parsed.data : fullPendingArgs) as never,
            { auth, sessionId: input.sessionId },
          );
          if (!pf.ok) {
            const blockedEv: ChatStreamEvent = {
              kind: "action_blocked",
              message: pf.message,
              blockers: pf.blockers,
              action: {
                recordId: pendingAt4f.recordId,
                componentId: pendingAt4f.componentId,
                actionId: pendingAt4f.actionId,
                args: fullPendingArgs,
                missing: pendingAt4f.missing,
                requiresConfirmation: pendingAt4f.requiresConfirmation,
                label: pendingAt4f.label,
              },
            };
            yield blockedEv;
            actionState = {
              ...actionState,
              phase: "blocked",
              pending: {
                ...pendingAt4f,
                blockers: pf.blockers,
                blockedMessage: pf.message,
              },
            };
            canAdvance = false;
          } else if (pf.resolvedArgs && Object.keys(pf.resolvedArgs).length > 0) {
            const merged = {
              ...fullPendingArgs,
              ...pf.resolvedArgs,
            };
            const missing = computePendingMissing(
              registry,
              pendingAt4f.componentId,
              pendingAt4f.actionId,
              merged,
              this.pendingMissingOpts(),
            );
            const resolvedEv: ChatStreamEvent = {
              kind: "action_args_updated",
              action: {
                recordId: pendingAt4f.recordId,
                componentId: pendingAt4f.componentId,
                actionId: pendingAt4f.actionId,
                args: pf.resolvedArgs,
                missing,
              },
            };
            yield resolvedEv;
            actionState = simulateActionState(
              actionState,
              [resolvedEv],
              registry,
              this.pendingMissingOpts(),
            );
            if (missing.length > 0) {
              canAdvance = false;
            } else {
              const pf2 = await runActionPreflight(def, merged as never, {
                auth,
                sessionId: input.sessionId,
              });
              if (!pf2.ok) {
                const blockedEv: ChatStreamEvent = {
                  kind: "action_blocked",
                  message: pf2.message,
                  blockers: pf2.blockers,
                  action: {
                    recordId: pendingAt4f.recordId,
                    componentId: pendingAt4f.componentId,
                    actionId: pendingAt4f.actionId,
                    args: merged,
                    missing,
                    requiresConfirmation: pendingAt4f.requiresConfirmation,
                    label: pendingAt4f.label,
                  },
                };
                yield blockedEv;
                actionState = {
                  ...actionState,
                  phase: "blocked",
                  pending: {
                    ...pendingAt4f,
                    args: merged,
                    missing,
                    blockers: pf2.blockers,
                    blockedMessage: pf2.message,
                  },
                };
                canAdvance = false;
              }
            }
          }
        }

        if (
          canAdvance &&
          actionState.pending &&
          actionState.phase === "collecting" &&
          actionState.pending.missing.length === 0
        ) {
          const readyPending = actionState.pending;
          const readyEv: ChatStreamEvent = {
            kind: "action_args_updated",
            action: {
              recordId: readyPending.recordId,
              componentId: readyPending.componentId,
              actionId: readyPending.actionId,
              args: {},
              missing: [],
            },
          };
          yield readyEv;
          actionState = simulateActionState(
            actionState,
            [readyEv],
            registry,
            this.pendingMissingOpts(),
          );
        }
      }

      // 5. Solve layout if the LLM emitted one
      let finalLayout: LayoutPlan | undefined;
      let dropped: Array<{ componentId: string; reason: string }> = [];
      if (layoutIntent) {
        const result = solveLayout(registry, layoutIntent, {
          locked: input.lockedCells ?? [],
        });
        finalLayout = result.plan;
        dropped = result.dropped;
        yield {
          kind: "layout_ready",
          layout: finalLayout,
          droppedLayoutItems: dropped,
        };
      }

      // 6. Persist the assistant message — every turn gets user-visible prose.
      const trimmed = assistantText.trim();
      /*
       * Under `finalReply: "always"` the loop's prose was never streamed, so
       * nothing has reached the user yet however much of it there is.
       */
      let streamedContent = this.finalReplyAlways ? false : trimmed.length > 0;
      let finalContent = resolveAssistantContent({
        assistantText: trimmed,
        finalLayout,
        executedExtraTools,
        clarificationQuestion,
      });

      /*
       * A question is the turn's visible outcome.
       *
       * Falling through to the generic "empty bubble" fallbacks would put a
       * summary of nothing above a card that already says everything — so the
       * question text becomes the reply when the model offered no prose of
       * its own, and the fallbacks never run.
       */
      if (pendingQuestion && !finalContent) {
        finalContent = pendingQuestion.question;
      }

      // Empty bubble: prefer a summary of real tool results, then the
      // host-configured phrase, then the engine's generic phase summary.
      let hostPhraseApplied = false;
      if (!finalContent) {
        const toolSummary = summarizeExtraToolResults(executedExtraTools);
        if (toolSummary) {
          finalContent = toolSummary;
        } else {
          const hostPhrase = resolveFallbackPhrase(this.fallbackToolOnlyPhrase, actionState);
          if (hostPhrase) {
            finalContent = hostPhrase;
            hostPhraseApplied = true;
          } else {
            finalContent = resolveDefaultTurnSummary(actionState, executedExtraTools) ?? "";
          }
        }
      }

      /*
       * A host-configured phrase is an explicit choice — don't second-guess it
       * with an extra LLM call. `finalReplyAlways` overrides all of that: the
       * host has said the final step writes every reply, and everything above
       * is an input to it rather than a competitor.
       */
      const needsLlmSummary =
        this.requireAssistantReply &&
        (this.finalReplyAlways ||
          (!hostPhraseApplied &&
            (executedExtraTools.length > 0 ||
              actionState.phase !== "idle" ||
              clarificationQuestion.length > 0 ||
              isWeakToolOnlyFallback(trimmed)) &&
            (!finalContent || isWeakToolOnlyFallback(finalContent))));

      if (needsLlmSummary) {
        /*
         * Streamed, not buffered. When this step owns the whole reply it is
         * the only text the user will see, and waiting for it to finish before
         * showing a character is exactly the latency the loop's own streaming
         * used to hide. Citation markers are held back incrementally so
         * `[[cite:x]]` never appears on screen and then vanishes.
         */
        const stripper = createCiteStripper(this.citationsEnabled);
        let summary = "";
        for await (const delta of this.streamFinalReply({
          llm,
          input,
          sessionId: input.sessionId,
          userText: input.text,
          baseMessages,
          draft: trimmed,
          deterministic: finalContent,
          actionState,
          actionsRun,
          executedExtraTools,
          ...(finalLayout ? { finalLayout } : {}),
          clarificationQuestion,
        })) {
          summary += delta;
          const safe = stripper.push(delta);
          if (safe) yield { kind: "text_delta", textDelta: safe };
        }
        const tail = stripper.flush();
        if (tail) yield { kind: "text_delta", textDelta: tail };
        if (summary.trim()) {
          finalContent = summary.trim();
          streamedContent = true;
        }
      }

      if (!hostPhraseApplied && (!finalContent || isWeakToolOnlyFallback(finalContent))) {
        const actionSummary = resolveDefaultTurnSummary(actionState, executedExtraTools);
        if (actionSummary) {
          finalContent = actionSummary;
          if (!streamedContent) {
            yield { kind: "text_delta", textDelta: finalContent };
            streamedContent = true;
          }
        }
      }

      if (!finalContent) {
        finalContent =
          (ticketDraftedThisTurn
            ? "I've prepared a support ticket draft. Review the ticket card below and click **File ticket**, or reply to confirm."
            : null) ??
          resolveDefaultTurnSummary(actionState, executedExtraTools) ??
          resolveProceedWithoutActionHint(input.text, executedExtraTools) ??
          "I processed your request. Let me know if you'd like to adjust anything or need help with a follow-up.";
      }

      if (!streamedContent && finalContent) {
        yield { kind: "text_delta", textDelta: finalContent };
      }

      const workspaceCitations =
        (!finalLayout || finalLayout.cells.length === 0) && executedExtraTools.length > 0
          ? collectWorkspaceCitations(executedExtraTools)
          : [];

      // Strip [[cite:id]] markers the model appended (per buildCitationsPrompt's
      // instructions, injected into baseMessages above) and resolve each into
      // a clickable ComponentCitation — extractCitations silently drops ids
      // that don't resolve to a real, locatable component.
      let citations: ComponentCitation[] = [];
      if (this.citationsEnabled) {
        const extracted = extractCitations(finalContent, registry);
        finalContent = extracted.text;
        citations = extracted.citations;
      }

      const toolPayloads = collectToolPayloads(executedExtraTools);

      let toolPayload: unknown;
      if (layoutIntent && finalLayout && finalLayout.cells.length > 0) {
        toolPayload = layoutIntent;
      } else if (
        workspaceCitations.length > 0 ||
        extraToolResults.length > 0 ||
        citations.length > 0 ||
        toolPayloads.length > 0
      ) {
        toolPayload = {
          ...(workspaceCitations.length > 0 ? { workspaceCitations } : {}),
          ...(citations.length > 0 ? { citations } : {}),
          ...(extraToolResults.length > 0 ? { extraTools: extraToolResults } : {}),
          ...(toolPayloads.length > 0 ? { toolPayloads } : {}),
        };
      } else if (layoutIntent) {
        toolPayload = layoutIntent;
      }

      const assistantMessage = await db.appendMessage(
        {
          sessionId: input.sessionId,
          role: "assistant",
          content: finalContent,
          references,
          toolName: layoutIntent ? "plan_layout" : undefined,
          toolPayload,
        },
        auth,
      );
      yield {
        kind: "assistant_saved",
        assistantMessage,
        references,
      };
      // After the reply is saved, so a client that renders the card beside the
      // message has the message to attach it to.
      if (pendingQuestion) {
        yield { kind: "question_asked", question: pendingQuestion };
      }
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      yield {
        kind: "error",
        error: errorText,
      };
      try {
        /*
         * A host that owns every reply owns this one too: an error is
         * something to explain, not a template to print. The attempt is
         * guarded because the thing that just failed is often the model
         * itself, and a second failure must not lose the first one's message.
         */
        let content = `Sorry — I couldn't complete that request: ${errorText}`;
        if (this.finalReplyAlways && this.requireAssistantReply) {
          try {
            let written = "";
            for await (const delta of this.streamFinalReply({
              llm,
              input,
              baseMessages: [
                { role: "system", content: this.systemPrompt },
                { role: "user", content: input.text },
              ],
              sessionId: input.sessionId,
              userText: input.text,
              draft: "",
              deterministic: content,
              actionsRun: [],
              actionState: input.actionState ?? {
                phase: "idle",
                pending: null,
                journal: [],
                workflowStack: [],
              },
              executedExtraTools: [],
              clarificationQuestion: "",
              error: errorText,
            })) {
              written += delta;
              yield { kind: "text_delta", textDelta: delta };
            }
            if (written.trim()) content = written.trim();
          } catch {
            // The model is what failed. The sentence above still says so.
          }
        }
        const assistantMessage = await db.appendMessage(
          {
            sessionId: input.sessionId,
            role: "assistant",
            content,
            references: [],
          },
          auth,
        );
        yield { kind: "assistant_saved", assistantMessage, references: [] };
      } catch {
        // If persistence fails too, at least the error event was emitted.
      }
    }
  }

  /**
   * One tool-free LLM call that writes the turn's reply.
   *
   * Yields deltas rather than returning a string so the caller can stream it.
   * That matters under `finalReply.mode: "always"`, where this is the only
   * text the user ever sees and buffering it would mean a silent wait for the
   * whole reply.
   */
  private async *streamFinalReply(
    ctx: FinalReplyContext & {
      llm: LlmAdapter;
      input: SendMessageInput;
      baseMessages: LlmMessage[];
    },
  ): AsyncGenerator<string, void, undefined> {
    const prompt = this.renderFinalReply(ctx);
    const llm =
      typeof this.finalReplyLlm === "function"
        ? this.finalReplyLlm()
        : (this.finalReplyLlm ?? ctx.llm);
    for await (const chunk of llm.stream({
      messages: [
        ...ctx.baseMessages,
        {
          role: "system",
          content: prompt,
        },
      ],
      signal: ctx.input.signal,
      model: ctx.input.model,
    })) {
      if (chunk.textDelta) yield chunk.textDelta;
    }
  }
}

const renderReferenceContext = (msgs: ChatMessage[]): string => {
  const lines = msgs.map(
    (m) =>
      `- [${m.role} · ${m.createdAt.toISOString().slice(0, 10)} · session ${m.sessionId}] ${m.content}`,
  );
  return (
    "Relevant context from the user's other chats (cite in the form " +
    '"From chat {session_id}" when used):\n' +
    lines.join("\n")
  );
};

const renderInnerStepHint = (
  state: ActionState,
  ctx?: {
    layoutCaptured?: boolean;
    extraToolsRan?: boolean;
    forceTextOnly?: boolean;
  },
): string => {
  if (ctx?.forceTextOnly) {
    return (
      "FINAL STEP: Reply to the user in plain text only. Summarize tool " +
      "results above, state what you will do next, or ask for missing " +
      "details. Do NOT call any tools."
    );
  }
  const p = state.pending;
  if (!p) {
    if (ctx?.extraToolsRan) {
      return (
        "Processing tools already returned results above. Reply in plain " +
        "text: summarize what you found, confirm the change you will make, " +
        "or ask for anything still missing. Use `start_action` / " +
        "`update_action_args` only if you have not started the relevant " +
        "action yet — otherwise do NOT call tools in this reply."
      );
    }
    if (!ctx?.layoutCaptured) {
      return (
        "Respond to the user's message. For data/list/count questions about any dashboard area, " +
        "call the relevant host read tool, then summarize in plain text. " +
        "For view/show/open requests, call `plan_layout` with relevant componentIds. " +
        "For changes, use lookup/read tools and `start_action`. Do NOT leave the reply empty."
      );
    }
    return "Continue the conversation. Reply with plain text.";
  }
  const ref = `${p.componentId}:${p.actionId}`;
  if (state.phase === "collecting") {
    if (p.missing.length === 0) {
      if (p.blockers?.length) {
        return (
          `Action \`${ref}\` is blocked: ${p.blockedMessage ?? "complete prerequisite steps first"}. ` +
          `When the user supplies a missing value, call the relevant processing tool ` +
          `or use \`update_action_args\` to record it — the confirmation card will refresh.`
        );
      }
      return (
        `Action \`${ref}\` has all required schema fields. Reply with a one-sentence ` +
        `summary. If the action card shows blockers, ask for those first; otherwise ` +
        `tell the user to click Apply on the confirmation card.`
      );
    }
    const missing = p.missing.join(", ");
    return (
      `You just started action \`${ref}\` on the user's behalf. ` +
      `Now reply to the user with a brief, friendly question asking for the ` +
      `missing fields (${missing}). Do NOT call any tool in this reply — ` +
      `the user must answer first.`
    );
  }
  if (state.phase === "awaiting_confirmation") {
    return (
      `You just started action \`${ref}\` and all required fields are set. ` +
      `Reply with a one-sentence summary of what will happen and ask the ` +
      `user to click confirm. Do NOT call any tool.`
    );
  }
  if (state.phase === "blocked") {
    const reason =
      p.blockedMessage ??
      "A prerequisite record is missing. Explain what is needed and point the user to the remediation card.";
    return (
      `Action \`${ref}\` is blocked: ${reason} ` +
      `When the user supplies a missing value, call the relevant processing tool ` +
      `or use \`update_action_args\` to record it — the confirmation card will refresh. ` +
      `For missing entities, use remediation start_action refs if shown.`
    );
  }
  return "Continue the conversation. Reply with plain text.";
};

const isProceedAffirmation = (text: string): boolean => {
  const t = text.trim();
  if (!t) return false;
  return (
    /^(yes|yep|yeah|ok\.?|sure|proceed|go ahead|do it|confirm)\.?!?$/i.test(t) ||
    /\bproceed with creating\b/i.test(t)
  );
};

/** When the user says "proceed" but no action was started, avoid a dead-end loop. */
const resolveProceedWithoutActionHint = (
  userText: string,
  executedExtraTools: Array<{ name: string; result: unknown }>,
): string | null => {
  if (!isProceedAffirmation(userText)) return null;
  if (executedExtraTools.length > 0) {
    return (
      "I'm lining up that change now — you'll see a confirmation card once the " +
      "action is started. If it doesn't appear, tell me again what you'd like to " +
      "change and I'll open it for review."
    );
  }
  return (
    "I don't have a pending change to apply yet. Tell me what you'd like to " +
    "change and I'll open a confirmation card for you to review."
  );
};

/**
 * When a turn runs host processing tools while an action is blocked or
 * collecting, merge their `normalizedArgs` into the pending action so
 * preflight can re-run and unlock the Apply button.
 */
const mergeProcessingToolsIntoActionEvents = (
  events: ChatStreamEvent[],
  stepTools: Array<{ name: string; args: unknown; result: unknown }>,
  pendingArgs: Record<string, unknown> | undefined,
  registry: ComponentRegistry<any, any>,
): void => {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || (ev.kind !== "action_started" && ev.kind !== "action_args_updated") || !ev.action) {
      continue;
    }
    const bridged = extractNormalizedArgsFromProcessingTools(
      {
        componentId: ev.action.componentId,
        actionId: ev.action.actionId,
      },
      stepTools,
    );
    if (!bridged) continue;

    const def = registry.getAction(ev.action.componentId, ev.action.actionId);
    const fullArgs =
      ev.kind === "action_started"
        ? { ...(ev.action.args ?? {}), ...bridged }
        : { ...(pendingArgs ?? {}), ...(ev.action.args ?? {}), ...bridged };
    const missing = def ? deriveMissing(def.schema as any, fullArgs) : ev.action.missing;

    events[i] = {
      ...ev,
      action: {
        ...ev.action,
        args: ev.kind === "action_started" ? fullArgs : { ...ev.action.args, ...bridged },
        missing,
      },
    };
  }
};

/**
 * Merge `normalizedArgs` contributed by host processing tools into the
 * pending action's args.
 *
 * Any host tool can participate by returning `normalizedArgs` on its result.
 * Two optional guards are honored when present:
 *
 * - `actionRef: "componentId:actionId"` — the contribution is ignored unless
 *   it targets the pending action.
 * - `invalid: unknown[]` — a non-empty array means the tool could not resolve
 *   every value, so nothing is merged.
 *
 * Results carrying an `error` are always skipped.
 */
const extractNormalizedArgsFromProcessingTools = (
  actionRef: { componentId: string; actionId: string },
  tools: Array<{ name: string; args: unknown; result: unknown }>,
): Record<string, unknown> | null => {
  const ref = `${actionRef.componentId}:${actionRef.actionId}`;
  let merged: Record<string, unknown> = {};

  for (const tool of tools) {
    const result = tool.result as Record<string, unknown> | null;
    if (!result || typeof result !== "object" || result.error) continue;

    const normalized = result.normalizedArgs;
    if (!normalized || typeof normalized !== "object") continue;

    // Scoped contributions must target the pending action.
    if (typeof result.actionRef === "string" && result.actionRef !== ref) continue;

    const invalid = result.invalid as unknown[] | undefined;
    if (Array.isArray(invalid) && invalid.length > 0) continue;

    merged = {
      ...merged,
      ...(normalized as Record<string, unknown>),
    };
  }

  return Object.keys(merged).length > 0 ? merged : null;
};

/**
 * Widget ids referenced by host tools when no layout was opened this turn.
 *
 * Host processing tools opt in by returning a `workspaceCitations` array
 * (or a `componentIds: string[]`) on their result. Results carrying an
 * `error` are skipped.
 */
/**
 * Structured extras a processing tool wants to reach the client with.
 *
 * A tool result is otherwise consumed entirely by the model: it is rendered
 * into a continuation message and then thrown away. A host whose tool produced
 * something the *bubble* needs to render - a coverage note, a scope offer -
 * has no way to carry it, and the engine already reads shape out of tool
 * results for `workspaceCitations`. Same convention, generalised: a result may
 * carry `payload`, and it lands on the assistant message under `toolPayloads`
 * keyed by the tool that produced it. The engine never interprets it.
 */
const collectToolPayloads = (
  tools: Array<{ name: string; args: unknown; result: unknown }>,
): Array<{ tool: string; payload: unknown }> => {
  const out: Array<{ tool: string; payload: unknown }> = [];
  for (const tool of tools) {
    const result = tool.result;
    if (!result || typeof result !== "object") continue;
    if ("error" in result && (result as { error?: unknown }).error) continue;
    const payload = (result as { payload?: unknown }).payload;
    if (payload === undefined || payload === null) continue;
    out.push({ tool: tool.name, payload });
  }
  return out;
};

const collectWorkspaceCitations = (
  tools: Array<{ name: string; args: unknown; result: unknown }>,
): WorkspaceCitation[] => {
  const seen = new Set<string>();
  const citations: WorkspaceCitation[] = [];

  const add = (componentId: unknown): void => {
    if (typeof componentId !== "string" || componentId.length === 0) return;
    if (seen.has(componentId)) return;
    seen.add(componentId);
    citations.push({ componentId });
  };

  for (const tool of tools) {
    const result = tool.result;
    if (!result || typeof result !== "object") continue;
    if ("error" in result && (result as { error?: unknown }).error) continue;

    const explicit = (result as { workspaceCitations?: WorkspaceCitation[] }).workspaceCitations;
    if (Array.isArray(explicit)) {
      for (const c of explicit) {
        if (!c?.componentId || seen.has(c.componentId)) continue;
        seen.add(c.componentId);
        citations.push(c);
      }
    }

    const ids = (result as { componentIds?: unknown }).componentIds;
    if (Array.isArray(ids)) {
      for (const id of ids) add(id);
    }
  }

  return citations;
};

/**
 * What the loop is told after a processing tool ran.
 *
 * `brief` is for hosts whose final step writes the reply. The loop's remaining
 * job there is to decide whether anything else needs calling — it never writes
 * a sentence — so handing it the whole result pays twice for material only one
 * of the two steps uses. On a tool that returns records that is not a small
 * difference: fifty rows, pretty-printed, measured tens of thousands of tokens
 * per turn, and the final step was given them again.
 *
 * The full result is untouched either way. It reaches the final step through
 * `executedExtraTools`, which is where the writing happens.
 */
const renderExtraToolContinuation = (
  results: Array<{ name: string; args: unknown; result: unknown }>,
  brief = false,
): string => {
  if (brief) {
    const excerpt = results
      .map((r) => `${r.name}(${JSON.stringify(r.args).slice(0, 200)}) -> ${JSON.stringify(r.result).slice(0, 600)}`)
      .join("\n");
    return (
      `These tools have already run this turn, and their full results are held:\n${excerpt}\n\n` +
      `A later step writes the reply from the full results, so do NOT summarize them here, ` +
      `and do NOT call any of these again with the same arguments — it would return the same ` +
      `thing and cost the user twice. Call a tool only if it is a genuinely different question. ` +
      `Otherwise reply with one short sentence and stop.`
    );
  }
  const payload = results
    .map((r) => `Tool \`${r.name}\` returned:\n${JSON.stringify(r.result, null, 2)}`)
    .join("\n\n");
  return (
    `${payload}\n\n` +
    `Using those results, reply to the user in plain, conversational text. ` +
    `Summarize what you found or what you'll do next. Do NOT call tools in this reply.`
  );
};

const resolveAssistantContent = (ctx: {
  assistantText: string;
  finalLayout?: LayoutPlan;
  executedExtraTools: Array<{ name: string; result: unknown }>;
  clarificationQuestion?: string;
}): string => {
  if (ctx.assistantText.trim().length > 0) return ctx.assistantText.trim();
  if (ctx.clarificationQuestion?.trim()) return ctx.clarificationQuestion.trim();
  if (ctx.finalLayout) {
    const count = ctx.finalLayout.cells.length;
    if (count === 0) {
      return "I've cleared the workspace layout.";
    }
    const ids = [...new Set(ctx.finalLayout.cells.map((cell) => cell.componentId))];
    const preview = ids.slice(0, 4).join(", ");
    const suffix = ids.length > 4 ? ` and ${ids.length - 4} more` : "";
    return `I've updated your workspace with ${count} component${count === 1 ? "" : "s"}: ${preview}${suffix}. Ask a follow-up to refine the view.`;
  }
  return "";
};

const summarizeExtraToolResults = (
  tools: Array<{ name: string; result: unknown }>,
): string | null => {
  if (tools.length === 0) return null;

  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const tool = tools[i]!;
    const result = tool.result as { error?: string } | null;
    if (result?.error) {
      return `I ran into a problem while running \`${tool.name}\`: ${result.error}`;
    }
  }

  // Host tools opt into a deterministic summary by returning a `summary`
  // string on their result. Otherwise we return null and the engine asks
  // the LLM to summarize the raw results instead.
  const last = tools[tools.length - 1]!;
  const result = last.result as { summary?: unknown } | null;
  if (result && typeof result === "object" && typeof result.summary === "string") {
    const summary = result.summary.trim();
    if (summary.length > 0) return summary;
  }
  return null;
};

const WEAK_TOOL_ONLY_FALLBACKS = new Set([
  "I processed your request. Let me know if you'd like to adjust anything or need a follow-up.",
  "I processed your request. Let me know if you'd like to adjust anything or need help with a follow-up.",
  "I've finished that step — let me know how you'd like to proceed.",
]);

const isWeakToolOnlyFallback = (text: string): boolean => WEAK_TOOL_ONLY_FALLBACKS.has(text.trim());

const resolveDefaultTurnSummary = (
  state: ActionState,
  executedExtraTools: Array<{ name: string; result: unknown }>,
): string | null => {
  const p = state.pending;
  const label = p?.label ?? p?.actionId ?? "your request";

  for (const tool of executedExtraTools) {
    const result = tool.result as { error?: string };
    if (result?.error) {
      return `I ran into a problem while running \`${tool.name}\`: ${result.error}`;
    }
  }

  switch (state.phase) {
    case "collecting":
      if (p?.missing?.length) {
        return `I'm working on ${label}. I still need: ${p.missing.join(", ")}. What can you tell me?`;
      }
      return `I'm gathering details for ${label}. What else should I know?`;
    case "awaiting_confirmation":
      return `I've prepared ${label}. Review the confirmation card and click Apply when you're ready, or tell me what to change.`;
    case "blocked":
      return (
        p?.blockedMessage ??
        "Something is missing before we can continue. Use the remediation steps above, then we'll pick up where we left off."
      );
    case "executing":
      return `Applying ${label} now. I'll let you know when it's done.`;
    case "error":
      return `Something went wrong with ${label}. Check the details above or tell me how you'd like to proceed.`;
    case "idle":
    default:
      return null;
  }
};

const renderTurnSummaryPrompt = (ctx: FinalReplyContext): string => {
  const parts: string[] = [
    ctx.draft
      ? "The user just sent a message and the system ran tools/actions. A draft reply was written but never shown to anyone; rewrite it."
      : "The user just sent a message and the system ran tools/actions, but no assistant prose was produced yet.",
    `User message: ${JSON.stringify(ctx.userText)}`,
    `Action phase: ${ctx.actionState.phase}`,
  ];
  if (ctx.draft) parts.push(`Draft reply (never shown to the user): ${ctx.draft}`);
  if (ctx.error) parts.push(`The turn failed with: ${ctx.error}`);
  if (ctx.actionState.pending) {
    parts.push(
      `Pending action: ${ctx.actionState.pending.componentId}:${ctx.actionState.pending.actionId}`,
    );
    if (ctx.actionState.pending.missing.length > 0) {
      parts.push(`Missing fields: ${ctx.actionState.pending.missing.join(", ")}`);
    }
    if (ctx.actionState.pending.blockedMessage) {
      parts.push(`Blocked because: ${ctx.actionState.pending.blockedMessage}`);
    }
  }
  if (ctx.clarificationQuestion) {
    parts.push(`Clarification needed: ${ctx.clarificationQuestion}`);
  }
  if (ctx.finalLayout) {
    parts.push(
      `Layout updated with ${ctx.finalLayout.cells.length} component(s): ${ctx.finalLayout.cells.map((c) => c.componentId).join(", ")}`,
    );
  }
  if (ctx.executedExtraTools.length > 0) {
    parts.push(
      "Tool results:\n" +
        ctx.executedExtraTools
          .map((t) => `- ${t.name}: ${JSON.stringify(t.result).slice(0, 800)}`)
          .join("\n"),
    );
  }
  if (ctx.deterministic) {
    parts.push(`The system's own summary of this turn: ${ctx.deterministic}`);
  }
  parts.push(
    "Write 1–3 short sentences for the user summarizing what happened, what succeeded, what failed, or what you need next. " +
      "Ask a follow-up question when information is missing. Do NOT call any tools.",
  );
  return parts.join("\n");
};

const resolveFallbackPhrase = (
  hook: ChatEngineOptions["fallbackToolOnlyPhrase"],
  state: ActionState,
): string | null => {
  if (hook == null) return null;
  if (typeof hook === "string") return hook;
  try {
    const out = hook({ phase: state.phase, pending: state.pending });
    return out && out.trim().length > 0 ? out : null;
  } catch (err) {
    console.warn("[freebird] chat: fallbackToolOnlyPhrase threw; ignoring.", err);
    return null;
  }
};

/**
 * Predict the next {@link ActionState} from the events the harness just
 * emitted. Used by the auto-loop to rebuild the harness for the next
 * inner step. Mirrors the relevant transitions of the `core-state`
 * reducer but only what the engine needs to know:
 *
 *   - phase
 *   - pending (componentId, actionId, args, missing, requiresConfirmation)
 *
 * Journal mutations and detailed timestamps are left to the client store
 * (which has the full reducer).
 */
const simulateActionState = (
  state: ActionState,
  events: ChatStreamEvent[],
  registry: ComponentRegistry<any, any>,
  pendingMissingOpts?: {
    deriveActionReadiness?: ChatEngineOptions["deriveActionReadiness"];
    sanitizeActionArgs?: ChatEngineOptions["sanitizeActionArgs"];
  },
): ActionState => {
  let next = state;
  for (const ev of events) {
    switch (ev.kind) {
      case "action_started": {
        const a = ev.action;
        if (!a) break;
        const args = (a.args ?? {}) as Record<string, unknown>;
        const missing = computePendingMissing(
          registry,
          a.componentId,
          a.actionId,
          args,
          pendingMissingOpts,
        );
        const host = pendingMissingOpts?.deriveActionReadiness?.(a.componentId, a.actionId, args);
        const requiresConfirmation = a.requiresConfirmation ?? "preview";
        const phase = resolvePhaseFromPending(missing, requiresConfirmation, host?.blockers);
        next = {
          ...next,
          phase,
          pending: {
            recordId: a.recordId,
            componentId: a.componentId,
            actionId: a.actionId,
            args,
            missing,
            label: a.label,
            requiresConfirmation,
            startedAt: new Date(),
            preview: a.preview,
            blockers: host?.blockers,
            blockedMessage: host?.blockedMessage,
          },
        };
        break;
      }
      case "action_args_updated": {
        if (!next.pending) break;
        const merged = {
          ...next.pending.args,
          ...(ev.action?.args ?? {}),
        } as Record<string, unknown>;
        const missing = computePendingMissing(
          registry,
          next.pending.componentId,
          next.pending.actionId,
          merged,
          pendingMissingOpts,
        );
        const host = pendingMissingOpts?.deriveActionReadiness?.(
          next.pending.componentId,
          next.pending.actionId,
          merged,
        );
        const def = registry.getAction(next.pending.componentId, next.pending.actionId);
        const preview =
          ev.action?.preview ??
          (def
            ? deriveActionPreview(def, merged, {
                componentId: next.pending.componentId,
                label: next.pending.label,
              })
            : next.pending.preview);
        const pending = {
          ...next.pending,
          args: merged,
          missing,
          preview,
          blockers: host?.blockers,
          blockedMessage: host?.blockedMessage,
        };
        const phase = resolvePhaseFromPending(
          missing,
          pending.requiresConfirmation,
          host?.blockers,
        );
        next = { ...next, phase, pending };
        break;
      }
      case "action_blocked": {
        if (!next.pending || !ev.blockers) break;
        next = {
          ...next,
          phase: "blocked",
          pending: {
            ...next.pending,
            blockers: ev.blockers,
            blockedMessage: ev.message,
          },
        };
        break;
      }
      case "action_cancelled":
      case "action_paused":
        next = { ...next, phase: "idle", pending: null };
        break;
      case "action_resumed": {
        const recordId = ev.action?.recordId;
        if (!recordId) break;
        const rec = next.journal.find((r) => r.id === recordId);
        if (!rec) break;
        const missing = (rec as { missing?: string[] }).missing ?? [];
        next = {
          ...next,
          phase: missing.length > 0 ? "collecting" : "awaiting_confirmation",
          pending: {
            recordId: rec.id,
            componentId: rec.componentId,
            actionId: rec.actionId,
            args: rec.args,
            missing,
            label: rec.label,
            requiresConfirmation: "preview",
            startedAt: new Date(),
          },
        };
        break;
      }
      default:
        break;
    }
  }
  return next;
};

/** Best-effort missing-field detection used by both the engine simulator
 *  and the `start_action` payload builder. */
const deriveMissing = (
  schema: { safeParse?: (input: unknown) => any },
  value: unknown,
): string[] => {
  if (typeof schema?.safeParse !== "function") return [];
  try {
    const result = schema.safeParse(value);
    if (result?.success) return [];
    const out: string[] = [];
    for (const issue of result.error?.issues ?? []) {
      const path = issue.path.join(".") || "__root__";
      if (
        issue.code === "invalid_type" &&
        "received" in issue &&
        (issue as { received?: string }).received === "undefined"
      ) {
        out.push(path);
        continue;
      }
      if (issue.code === "too_small" && (issue as { type?: string }).type === "array") {
        out.push(path);
      }
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
};

const computePendingMissing = (
  registry: ComponentRegistry<any, any>,
  componentId: string,
  actionId: string,
  args: Record<string, unknown>,
  opts?: {
    deriveActionReadiness?: ChatEngineOptions["deriveActionReadiness"];
    sanitizeActionArgs?: ChatEngineOptions["sanitizeActionArgs"];
  },
): string[] => {
  const cleaned = opts?.sanitizeActionArgs?.(componentId, actionId, args) ?? args;
  const def = registry.getAction(componentId, actionId);
  const schemaMissing = def ? deriveMissing(def.schema as any, cleaned) : [];
  const host = opts?.deriveActionReadiness?.(componentId, actionId, cleaned);
  const hostMissing = host?.missing ?? [];
  return [...new Set([...schemaMissing, ...hostMissing])];
};

const resolvePhaseFromPending = (
  missing: string[],
  requiresConfirmation: "none" | "preview" | "strict",
  blockers?: ActionBlocker[],
): ActionPhase => {
  if (blockers?.length) return "blocked";
  if (missing.length > 0) return "collecting";
  if (requiresConfirmation === "none") return "executing";
  return "awaiting_confirmation";
};

interface HandleActionToolContext {
  deriveActionReadiness?: ChatEngineOptions["deriveActionReadiness"];
  sanitizeActionArgs?: ChatEngineOptions["sanitizeActionArgs"];
  /** Resolved for this turn. Absent means `"full"`. */
  permissionMode?: PermissionMode;
}

/**
 * Fold an LLM action tool call into a {@link ChatStreamEvent}, when it is
 * one of the harness-owned tools. Returns `null` for non-action tools so
 * the engine can fall through to its default routing.
 */
const parseStartPayload = (raw: unknown): { label?: string; initial: Record<string, unknown> } => {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const label = typeof o.label === "string" ? o.label : undefined;
  const nested = o.args && typeof o.args === "object" ? (o.args as Record<string, unknown>) : {};
  const { label: _l, args: _a, ...top } = o;
  return { label, initial: { ...top, ...nested } };
};

const buildStartedActionPayload = (
  registry: ComponentRegistry<any, any>,
  componentId: string,
  actionId: string,
  label: string | undefined,
  initial: Record<string, unknown>,
  ctx: HandleActionToolContext,
): ChatStreamEvent | null => {
  const def = registry.getAction(componentId, actionId);
  if (!def) return null;
  const mode = ctx.permissionMode ?? "full";
  // Belt and braces behind the harness, which under `readonly` never offered
  // the tool that gets here. A model that hallucinates the tool name anyway
  // must not be able to open an action.
  if (!allowsActions(mode)) return null;
  const requiresConfirmation = clampConfirmation(mode, def.requiresConfirmation ?? "preview");
  const mergedInitial = { ...initial };
  const args = ctx.sanitizeActionArgs?.(componentId, actionId, mergedInitial) ?? mergedInitial;
  const missing = computePendingMissing(registry, componentId, actionId, args, {
    deriveActionReadiness: ctx.deriveActionReadiness,
    sanitizeActionArgs: ctx.sanitizeActionArgs,
  });
  const preview = deriveActionPreview(def, args, {
    componentId,
    label,
  });
  return {
    kind: "action_started",
    action: {
      recordId: newId("act"),
      componentId,
      actionId,
      label,
      args,
      missing,
      requiresConfirmation,
      preview,
    },
  };
};

const handleActionToolCall = (
  call: { id: string; name: string; args: unknown },
  registry: ComponentRegistry<any, any>,
  actionState: ActionState,
  ctx: HandleActionToolContext = {},
): ChatStreamEvent | null => {
  const perAction = resolvePerActionStartToolName(call.name, registry);
  if (perAction) {
    const { label, initial } = parseStartPayload(call.args);
    return buildStartedActionPayload(
      registry,
      perAction.componentId,
      perAction.actionId,
      label,
      initial,
      ctx,
    );
  }

  switch (call.name) {
    case "start_action": {
      const args = call.args as {
        action: string;
        label?: string;
        args?: Record<string, unknown>;
      };
      const [componentId, actionId] = args.action.split(":");
      if (!componentId || !actionId) return null;
      return buildStartedActionPayload(
        registry,
        componentId,
        actionId,
        args.label,
        args.args ?? {},
        ctx,
      );
    }
    case "update_action_args": {
      if (!actionState.pending) return null;
      const patch = (call.args as { args?: Record<string, unknown> }).args ?? {};
      const mergedRaw = {
        ...actionState.pending.args,
        ...patch,
      };
      const merged =
        ctx.sanitizeActionArgs?.(
          actionState.pending.componentId,
          actionState.pending.actionId,
          mergedRaw,
        ) ?? mergedRaw;
      const argsDelta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(merged)) {
        if (
          !(k in actionState.pending.args) ||
          JSON.stringify(actionState.pending.args[k]) !== JSON.stringify(v)
        ) {
          argsDelta[k] = v;
        }
      }
      const missing = computePendingMissing(
        registry,
        actionState.pending.componentId,
        actionState.pending.actionId,
        merged,
        ctx.deriveActionReadiness
          ? {
              deriveActionReadiness: ctx.deriveActionReadiness,
              sanitizeActionArgs: ctx.sanitizeActionArgs,
            }
          : undefined,
      );
      const def = registry.getAction(actionState.pending.componentId, actionState.pending.actionId);
      const preview = def
        ? deriveActionPreview(def, merged, {
            componentId: actionState.pending.componentId,
            label: actionState.pending.label,
          })
        : undefined;
      return {
        kind: "action_args_updated",
        action: {
          recordId: actionState.pending.recordId,
          componentId: actionState.pending.componentId,
          actionId: actionState.pending.actionId,
          args: argsDelta,
          missing,
          preview,
        },
      };
    }
    case "request_clarification": {
      const q = (call.args as { question?: string }).question ?? "";
      return { kind: "action_clarification", clarification: q };
    }
    case "cancel_action": {
      if (!actionState.pending) return null;
      const reason = (call.args as { reason?: string }).reason;
      return {
        kind: "action_cancelled",
        action: {
          recordId: actionState.pending.recordId,
          componentId: actionState.pending.componentId,
          actionId: actionState.pending.actionId,
          reason,
        },
      };
    }
    case "pause_action": {
      if (!actionState.pending) return null;
      const label = (call.args as { label?: string }).label;
      return {
        kind: "action_paused",
        action: {
          recordId: actionState.pending.recordId,
          componentId: actionState.pending.componentId,
          actionId: actionState.pending.actionId,
          label,
        },
      };
    }
    case "resume_action": {
      const recordId = (call.args as { recordId?: string }).recordId;
      const record = actionState.journal.find((r) => r.id === recordId && r.status === "paused");
      if (!record) return null;
      return {
        kind: "action_resumed",
        action: {
          recordId: record.id,
          componentId: record.componentId,
          actionId: record.actionId,
          label: record.label,
        },
      };
    }
    default:
      return null;
  }
};

export const createChatEngine = (opts: ChatEngineOptions): ChatEngine => new ChatEngine(opts);

/**
 * Hold back citation markers while text streams.
 *
 * Markers are stripped from the persisted reply, but a stream emits text
 * before that happens - so without this, `[[cite:id]]` appears on screen and
 * then vanishes when `assistant_saved` lands. A marker can straddle two
 * chunks, so anything that could still grow into one is held until it either
 * completes (and is dropped) or is proved not to be a marker.
 */
const CITE_OPEN = "[[cite:";
/**
 * How far back to look for an unfinished marker. A component id is bounded by
 * what `CITE_MARKER_RE` accepts, and holding an unbounded tail would mean a
 * single stray bracket stopped the stream from ever emitting again.
 */
const MAX_HELD = 256;

export const createCiteStripper = (
  enabled: boolean,
): { push(delta: string): string; flush(): string } => {
  if (!enabled) return { push: (delta) => delta, flush: () => "" };
  let held = "";
  /**
   * Index at which the unemittable tail begins; `held.length` when there is
   * none. Scanned left to right so the *earliest* hold-worthy bracket wins —
   * looking backwards from the end finds the inner bracket of `[[` and reads
   * its tail as text that could never be a marker.
   */
  const openTailAt = (text: string): number => {
    const from = Math.max(0, text.length - MAX_HELD);
    for (let start = from; start < text.length; start++) {
      if (text[start] !== "[") continue;
      const tail = text.slice(start);
      if (tail.startsWith(CITE_OPEN)) {
        // Opened but not closed: hold until the rest of it arrives.
        if (!tail.includes("]]")) return start;
        // Closed: the regex removes it, so there is nothing to hold.
        continue;
      }
      if (CITE_OPEN.startsWith(tail)) return start;
    }
    return text.length;
  };
  return {
    push(delta) {
      held += delta;
      const cut = openTailAt(held);
      const ready = held.slice(0, cut).replace(CITE_MARKER_RE, "");
      held = held.slice(cut);
      return ready;
    },
    flush() {
      const rest = held.replace(CITE_MARKER_RE, "");
      held = "";
      return rest;
    },
  };
};
