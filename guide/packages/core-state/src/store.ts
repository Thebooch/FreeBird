import type {
  ChatMessage,
  ChatStreamEvent,
  CustomTab,
  GridCell,
  LayoutPlan,
  LlmUsagePayload,
  Reference,
  Ticket,
  FileTicketBody,
} from "@freebirdai/core";
import type { FreeBirdTransport } from "./transport/types.js";
import type { PendingQuestion, QuestionAnswer, StateNotice } from "@freebirdai/core";
import {
  appendNotice,
  emptyNoticeBuffer,
  flushNotices,
  type NoticeBuffer,
} from "./notices/state.js";
import {
  applyTransition,
  initialActionState,
  type ActionRecord,
  type ActionState,
  type ActionTransition,
} from "./actions/state.js";
import type { ActionEvent, ActionEventListener } from "./actions/events.js";
import {
  applySupportTransition,
  initialSupportState,
  type SupportState,
  type SupportTransition,
} from "./support/state.js";
import {
  isAffirmativeSupportConfirmation,
  isSupportDraftCancellation,
} from "./support/confirm.js";

/**
 * Serializable snapshot of the client-side state the FreeBird UI cares
 * about. Every framework adapter (React / Vue / Angular) wraps this same
 * shape with its own reactive bindings.
 */
export interface FreeBirdState {
  sessionId: string | null;
  layout: LayoutPlan | null;
  tabs: CustomTab[];
  messages: ChatMessage[];
  streaming: boolean;
  /** The partial assistant text currently being streamed (before it's persisted). */
  streamingText: string;
  /** References surfaced on the most recent assistant reply. */
  latestReferences: Reference[];
  /** Action layer: phase + pending args + journal of past records. */
  actionState: ActionState;
  /**
   * Component ids the host considers "active" right now (e.g. visible on
   * screen). Sent on every chat turn so the harness can scope `start_action`
   * to actions it can actually invoke.
   */
  activeComponentIds: string[];
  /**
   * Latest token usage from the chat stream (when the host enables
   * `emitLlmUsage` on {@link ChatEngine}). Useful for dev / admin HUDs.
   */
  lastLlmUsage: LlmUsagePayload | null;
  /**
   * The last error the chat stream reported, or null.
   *
   * Surfaced as state because a host cannot act on `console.error`. The case
   * that forced it: a stored session id outliving the database it was made in
   * produced a stream carrying only an error, so the panel sat there looking
   * idle and every later message did the same. A host that can see this can
   * start a fresh session instead of staying broken.
   */
  lastChatError: string | null;
  /**
   * A question the assistant is waiting on, or null.
   *
   * The turn genuinely ended: nothing is streaming and no request is open.
   * Answering it starts a new turn carrying the answer, which is why this is
   * state rather than a callback — a reload can re-render the card.
   */
  pendingQuestion: PendingQuestion | null;
  /** Customer-service ticket draft / filed state. */
  supportState: SupportState;
}

export type FreeBirdListener = (state: FreeBirdState) => void;
export type ExplainListener = (componentId: string) => void;

/**
 * Framework-agnostic state container for a FreeBird client.
 *
 * This class owns:
 *  - the observable state ({@link FreeBirdState})
 *  - the client transport (HTTP+SSE by default)
 *  - a small pub/sub for the "explain" event that InfoTrigger fires
 *  - the full streaming chat state machine (send / explain / abort)
 *
 * It is intentionally pure TypeScript with no reactive library dependency.
 * Each framework adapter subscribes via {@link subscribe} and mirrors the
 * state into its own reactivity system:
 *
 *   - React: `useSyncExternalStore` (or useEffect + useState)
 *   - Vue:   `ref()` + `watchEffect` cleanup
 *   - Angular: `signal()` inside an `@Injectable` service
 */
export interface FreeBirdStoreOptions {
  /** Maximum journal entries before old non-paused records are dropped. */
  journalCap?: number;
}

export type SupportEventListener = (event: SupportEvent) => void;

export type SupportEvent =
  | { kind: "ticket.drafted"; state: SupportState; at: Date }
  | { kind: "ticket.filed"; ticket: Ticket; at: Date }
  | { kind: "ticket.failed"; message: string; at: Date }
  | { kind: "ticket.cancelled"; at: Date };

export class FreeBirdStore {
  readonly transport: FreeBirdTransport;
  private state: FreeBirdState;
  private listeners = new Set<FreeBirdListener>();
  private explainListeners = new Set<ExplainListener>();
  private actionListeners = new Set<ActionEventListener>();
  private supportListeners = new Set<SupportEventListener>();
  private abortController: AbortController | null = null;
  /** Tier-1 notices waiting for a turn to ride along with. */
  private notices: NoticeBuffer = emptyNoticeBuffer();
  private readonly journalCap: number;
  private autoConfirmInFlight = false;

  constructor(
    transport: FreeBirdTransport,
    initial: Partial<FreeBirdState> = {},
    opts: FreeBirdStoreOptions = {},
  ) {
    this.transport = transport;
    this.journalCap = opts.journalCap ?? 50;
    this.state = {
      sessionId: initial.sessionId ?? null,
      layout: initial.layout ?? null,
      tabs: initial.tabs ?? [],
      messages: initial.messages ?? [],
      streaming: initial.streaming ?? false,
      streamingText: initial.streamingText ?? "",
      latestReferences: initial.latestReferences ?? [],
      actionState: initial.actionState ?? initialActionState,
      activeComponentIds: initial.activeComponentIds ?? [],
      lastChatError: null,
      pendingQuestion: initial.pendingQuestion ?? null,
      lastLlmUsage: initial.lastLlmUsage ?? null,
      supportState: initial.supportState ?? initialSupportState(),
    };
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  /** Current state snapshot. Always a fresh reference after any mutation. */
  getState(): FreeBirdState {
    return this.state;
  }

  /** Convenience — identical to `getState()` but stable across React re-renders. */
  getSnapshot = (): FreeBirdState => this.state;

  subscribe(fn: FreeBirdListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private setState(patch: Partial<FreeBirdState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  // ---------------------------------------------------------------------------
  // Primitive setters (used by hooks/composables)
  // ---------------------------------------------------------------------------

  setSessionId(id: string | null): void {
    this.setState({ sessionId: id });
  }

  setLayout(layout: LayoutPlan | null): void {
    this.setState({ layout });
  }

  setTabs(tabs: CustomTab[]): void {
    this.setState({ tabs });
  }

  setMessages(messages: ChatMessage[]): void {
    this.setState({ messages });
  }

  setStreaming(streaming: boolean): void {
    this.setState({ streaming });
  }

  setStreamingText(streamingText: string): void {
    this.setState({ streamingText });
  }

  /** Upsert a message by id — preserves ordering for new messages. */
  addMessage(m: ChatMessage): void {
    const existing = this.state.messages.findIndex((p) => p.id === m.id);
    const messages =
      existing === -1
        ? [...this.state.messages, m]
        : this.state.messages.map((p) => (p.id === m.id ? m : p));
    this.setState({ messages });
  }

  toggleLock(instanceId: string): void {
    const layout = this.state.layout;
    if (!layout) return;
    this.setState({
      layout: {
        ...layout,
        cells: layout.cells.map((c) =>
          c.instanceId === instanceId ? { ...c, locked: !c.locked } : c,
        ),
      },
    });
  }

  async refreshTabs(): Promise<void> {
    const tabs = await this.transport.listTabs();
    this.setTabs(tabs);
  }

  /** Derived: cells where `locked === true`. */
  getLockedCells(): GridCell[] {
    return this.state.layout ? this.state.layout.cells.filter((c) => c.locked) : [];
  }

  // ---------------------------------------------------------------------------
  // Explain pub/sub (InfoTrigger → ChatController bridge)
  // ---------------------------------------------------------------------------

  broadcastExplain(componentId: string): void {
    for (const fn of this.explainListeners) fn(componentId);
  }

  onExplain(fn: ExplainListener): () => void {
    this.explainListeners.add(fn);
    return () => {
      this.explainListeners.delete(fn);
    };
  }

  // ---------------------------------------------------------------------------
  // Action layer
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to action-layer audit events. Listener errors are caught and
   * logged so a misbehaving listener cannot break the chat stream.
   */
  onActionEvent(fn: ActionEventListener): () => void {
    this.actionListeners.add(fn);
    return () => {
      this.actionListeners.delete(fn);
    };
  }

  onSupportEvent(fn: SupportEventListener): () => void {
    this.supportListeners.add(fn);
    return () => {
      this.supportListeners.delete(fn);
    };
  }

  private emitSupportEvent(event: SupportEvent): void {
    for (const fn of this.supportListeners) {
      try {
        fn(event);
      } catch (err) {
         
        console.error("[freebird] onSupportEvent listener threw:", err);
      }
    }
  }

  applySupportTransition(t: SupportTransition): void {
    const prev = this.state.supportState;
    const next = applySupportTransition(prev, t);
    if (next === prev) return;
    this.setState({ supportState: next });
    const at = new Date();
    switch (t.type) {
      case "draft":
        this.emitSupportEvent({ kind: "ticket.drafted", state: next, at });
        break;
      case "filed":
        this.emitSupportEvent({ kind: "ticket.filed", ticket: t.ticket, at });
        break;
      case "failed":
        this.emitSupportEvent({ kind: "ticket.failed", message: t.message, at });
        break;
      case "cancel":
        this.emitSupportEvent({ kind: "ticket.cancelled", at });
        break;
    }
  }

  async fileTicket(overrides?: Partial<FileTicketBody>): Promise<Ticket | null> {
    const pending = this.state.supportState.pending;
    if (!pending || !this.state.sessionId) return null;
    try {
      const res = await this.transport.fileTicket({
        sessionId: this.state.sessionId,
        draft: pending.draft,
        subject: overrides?.subject ?? pending.subject,
        transcriptExcerpt:
          overrides?.transcriptExcerpt ?? pending.transcriptExcerpt,
        metadata: overrides?.metadata ?? pending.metadata,
      });
      if (res.ok && res.ticket) {
        this.applySupportTransition({ type: "filed", ticket: res.ticket });
        return res.ticket;
      }
      this.applySupportTransition({
        type: "failed",
        message: res.error ?? "Failed to file ticket",
      });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.applySupportTransition({ type: "failed", message });
      return null;
    }
  }

  cancelSupportDraft(): void {
    this.applySupportTransition({ type: "cancel" });
  }

  resetSupportState(): void {
    this.applySupportTransition({ type: "reset" });
  }

  private emitActionEvent(event: ActionEvent): void {
    for (const fn of this.actionListeners) {
      try {
        fn(event);
      } catch (err) {
         
        console.error("[freebird] onActionEvent listener threw:", err);
      }
    }
  }

  setActiveComponentIds(ids: string[]): void {
    this.setState({ activeComponentIds: ids });
  }

  /**
   * Apply an {@link ActionTransition} to the state machine and emit any
   * matching {@link ActionEvent}s. This is the single mutation point for
   * the action slice — server-driven SSE events route through here too.
   */
  applyActionTransition(t: ActionTransition): void {
    const prev = this.state.actionState;
    const next = applyTransition(prev, t, { journalCap: this.journalCap });
    if (next === prev) return;
    this.setState({ actionState: next });

    if (
      (t.type === "start" || t.type === "merge_args" || t.type === "unblock") &&
      next.phase === "executing" &&
      next.pending?.requiresConfirmation === "none" &&
      !this.autoConfirmInFlight
    ) {
      this.autoConfirmInFlight = true;
      void this.confirmAction().finally(() => {
        this.autoConfirmInFlight = false;
      });
    }

    // Derive events from the transition.
    const at = "at" in t ? t.at : new Date();
    switch (t.type) {
      case "start": {
        const record = next.journal.find((r) => r.id === t.recordId);
        if (record) {
          this.emitActionEvent({ kind: "action.started", record, state: next, at });
          this.emitActionEvent({ kind: "journal.recorded", record, at });
        }
        break;
      }
      case "merge_args":
        if (next.pending) {
          this.emitActionEvent({
            kind: "action.args_updated",
            recordId: next.pending.recordId,
            args: next.pending.args,
            missing: next.pending.missing,
            at,
          });
        }
        break;
      case "begin_executing":
        if (prev.pending) {
          this.emitActionEvent({
            kind: "action.confirmed",
            recordId: prev.pending.recordId,
            at,
          });
        }
        break;
      case "executed": {
        const record = next.journal.find((r) => r.id === prev.pending?.recordId);
        if (record) {
          this.emitActionEvent({
            kind: "action.executed",
            record,
            before: t.before,
            args: record.args,
            changed: t.changed,
            result: t.result,
            at,
          });
        }
        break;
      }
      case "failed": {
        const record = next.journal.find((r) => r.id === prev.pending?.recordId);
        if (record) {
          this.emitActionEvent({
            kind: "action.failed",
            record,
            before: t.before,
            args: record.args,
            message: t.message,
            at,
          });
        }
        break;
      }
      case "cancelled": {
        const record =
          prev.pending &&
          next.journal.find((r) => r.id === prev.pending!.recordId);
        this.emitActionEvent({
          kind: "action.cancelled",
          record: record ?? null,
          reason: t.reason,
          at,
        });
        break;
      }
      case "pause": {
        const record = next.journal.find((r) => r.id === prev.pending?.recordId);
        if (record) this.emitActionEvent({ kind: "action.paused", record, at });
        break;
      }
      case "resume": {
        const record = next.journal.find((r) => r.id === t.recordId);
        if (record) this.emitActionEvent({ kind: "action.resumed", record, at });
        break;
      }
      case "block":
        if (next.pending) {
          this.emitActionEvent({
            kind: "action.blocked",
            recordId: next.pending.recordId,
            message: t.message,
            blockers: t.blockers,
            at,
          });
        }
        break;
      case "unblock":
        if (next.pending) {
          this.emitActionEvent({
            kind: "action.unblocked",
            recordId: next.pending.recordId,
            at,
          });
        }
        break;
      case "discard_record":
        this.emitActionEvent({
          kind: "journal.discarded",
          recordId: t.recordId,
          at,
        });
        break;
    }
  }

  startAction(input: {
    recordId: string;
    componentId: string;
    actionId: string;
    label?: string;
    args?: Record<string, unknown>;
    missing?: string[];
    requiresConfirmation: "none" | "preview" | "strict";
  }): void {
    this.applyActionTransition({
      type: "start",
      recordId: input.recordId,
      componentId: input.componentId,
      actionId: input.actionId,
      label: input.label,
      args: input.args,
      missing: input.missing,
      requiresConfirmation: input.requiresConfirmation,
      at: new Date(),
    });
  }

  mergeActionArgs(args: Record<string, unknown>, missing?: string[]): void {
    this.applyActionTransition({ type: "merge_args", args, missing, at: new Date() });
  }

  /** Push the current pending action and start a remediation child action. */
  startRemediationAction(input: {
    suggestion: {
      componentId: string;
      actionId: string;
      label?: string;
      prefilledArgs?: Record<string, unknown>;
    };
    resumeField: string;
    childRecordId: string;
    childMissing?: string[];
  }): void {
    const pending = this.state.actionState.pending;
    if (!pending) return;
    const at = new Date();
    this.applyActionTransition({
      type: "push_workflow",
      entry: {
        recordId: pending.recordId,
        componentId: pending.componentId,
        actionId: pending.actionId,
        args: pending.args,
        missing: pending.missing,
        label: pending.label,
        resumeField: input.resumeField,
      },
      at,
    });
    this.applyActionTransition({
      type: "start",
      recordId: input.childRecordId,
      componentId: input.suggestion.componentId,
      actionId: input.suggestion.actionId,
      label: input.suggestion.label,
      args: input.suggestion.prefilledArgs ?? {},
      missing: input.childMissing ?? [],
      requiresConfirmation: "preview",
      at,
    });
  }

  /** After a remediation child executes, resume the parent workflow frame. */
  resumeWorkflow(resolvedArgs: Record<string, unknown>, missing?: string[]): void {
    this.applyActionTransition({
      type: "resume_workflow",
      resolvedArgs,
      missing,
      at: new Date(),
    });
  }

  unblockPending(): void {
    this.applyActionTransition({ type: "unblock", at: new Date() });
  }

  /**
   * Confirm and execute the pending action. Calls the server `confirmAction`
   * transport and folds the response back into the journal as either an
   * `executed` or `failed` transition.
   */
  async confirmAction(): Promise<void> {
    const pending = this.state.actionState.pending;
    if (!pending || !this.state.sessionId) return;
    this.applyActionTransition({ type: "begin_executing", at: new Date() });
    try {
      const res = await this.transport.confirmAction({
        sessionId: this.state.sessionId,
        recordId: pending.recordId,
        componentId: pending.componentId,
        actionId: pending.actionId,
        args: pending.args,
      });
      if (res.ok) {
        this.applyActionTransition({
          type: "executed",
          result: res.result,
          before: res.before,
          changed: res.changed,
          at: new Date(),
        });
      } else if (res.blocked && res.blockers && res.message) {
        this.applyActionTransition({
          type: "block",
          message: res.message,
          blockers: res.blockers,
          at: new Date(),
        });
      } else {
        this.applyActionTransition({
          type: "failed",
          message: res.error ?? "action failed",
          before: res.before,
          at: new Date(),
        });
      }
    } catch (err) {
      this.applyActionTransition({
        type: "failed",
        message: err instanceof Error ? err.message : String(err),
        at: new Date(),
      });
    }
  }

  async cancelAction(reason?: string): Promise<void> {
    const pending = this.state.actionState.pending;
    if (this.state.sessionId && pending) {
      try {
        await this.transport.cancelAction({
          sessionId: this.state.sessionId,
          recordId: pending.recordId,
          reason,
        });
      } catch (err) {
         
        console.error("[freebird] cancelAction transport failed:", err);
      }
    }
    this.applyActionTransition({ type: "cancelled", reason, at: new Date() });
  }

  pauseAction(label?: string): void {
    this.applyActionTransition({ type: "pause", label, at: new Date() });
  }

  resumeAction(recordId: string): void {
    this.applyActionTransition({ type: "resume", recordId, at: new Date() });
  }

  discardRecord(recordId: string): void {
    this.applyActionTransition({ type: "discard_record", recordId });
  }

  hydrateJournal(records: ActionRecord[]): void {
    this.applyActionTransition({ type: "hydrate_journal", records });
  }

  // ---------------------------------------------------------------------------
  // Chat streaming state machine
  //
  // Lives here (instead of inside each framework hook) so Vue / Angular do
  // not have to reimplement the SSE event loop.
  // ---------------------------------------------------------------------------

  async send(
    text: string,
    opts?: {
      /** Answers to a question asked on an earlier turn. */
      answers?: QuestionAnswer[];
      supportContext?: {
        subject?: Record<string, unknown>;
        transcriptExcerpt?: string;
        metadata?: Record<string, unknown>;
      };
    },
  ): Promise<void> {
    if (!this.state.sessionId) {
      throw new Error("FreeBirdStore.send: no active session. Create one first.");
    }
    // Scoped to this turn: a host reading it must not act on a stale failure.
    if (this.state.lastChatError !== null) this.setState({ lastChatError: null });
    // A new turn supersedes whatever was being asked; the card must not
    // outlive the question it belongs to.
    if (this.state.pendingQuestion !== null) this.setState({ pendingQuestion: null });

    const trimmed = text.trim();
    const supportPhase = this.state.supportState.phase;

    if (supportPhase === "awaiting_confirmation" && this.state.supportState.pending) {
      if (isAffirmativeSupportConfirmation(trimmed)) {
        this.addMessage({
          id: `user-${Date.now()}`,
          sessionId: this.state.sessionId,
          role: "user",
          content: trimmed,
          references: [],
          createdAt: new Date(),
        });
        const pendingTitle =
          this.state.supportState.pending?.draft.title ?? "Support ticket";
        const ticket = await this.fileTicket();
        if (ticket) {
          this.addMessage({
            id: `assistant-ticket-filed-${Date.now()}`,
            sessionId: this.state.sessionId,
            role: "assistant",
            content: `Ticket filed: **${ticket.title}** (${ticket.type}, ${ticket.severity}). We'll follow up on this issue.`,
            references: [],
            createdAt: new Date(),
          });
        } else {
          const err = this.state.supportState.lastError ?? "Could not file ticket.";
          this.addMessage({
            id: `assistant-ticket-failed-${Date.now()}`,
            sessionId: this.state.sessionId,
            role: "assistant",
            content: `I couldn't file the ticket for "${pendingTitle}": ${err}`,
            references: [],
            createdAt: new Date(),
          });
        }
        return;
      }
      if (isSupportDraftCancellation(trimmed)) {
        this.cancelSupportDraft();
        this.addMessage({
          id: `user-${Date.now()}`,
          sessionId: this.state.sessionId,
          role: "user",
          content: trimmed,
          references: [],
          createdAt: new Date(),
        });
        this.addMessage({
          id: `assistant-ticket-cancelled-${Date.now()}`,
          sessionId: this.state.sessionId,
          role: "assistant",
          content:
            "Ticket draft dismissed. Tell me what you'd like to change and I can prepare a new one.",
          references: [],
          createdAt: new Date(),
        });
        return;
      }
    }

    this.abortController?.abort();
    const ac = new AbortController();
    this.abortController = ac;

    /*
     * Read the buffer now, clear it only once the turn is accepted.
     *
     * A send that throws must leave the notices where they were — the model
     * never saw them, so dropping them would silently lose the fact that the
     * user changed anything at all. Clearing after the stream completes is
     * what makes a failed turn cost nothing.
     */
    const notices = flushNotices(this.notices);
    try {
      await this.runStream(
        this.transport.streamMessage({
          sessionId: this.state.sessionId,
          text,
          lockedCells: this.getLockedCells(),
          actionState: this.state.actionState,
          activeComponentIds: this.state.activeComponentIds,
          ...(opts?.answers ? { answers: opts.answers } : {}),
          ...(notices.length > 0 ? { notices } : {}),
          supportContext: opts?.supportContext,
          signal: ac.signal,
        }),
      );
      this.notices = emptyNoticeBuffer();
    } catch (err) {
      this.appendTransportErrorMessage(err);
      throw err;
    }
  }

  /**
   * Tell the model something happened, without starting a turn.
   *
   * Tier 1 of three: this one is silent, `send` is the user speaking, and an
   * action is the user acting. "The date filter moved to Q3" belongs here —
   * the assistant should know it before its next reply and should absolutely
   * not respond to it now.
   *
   * Deliberately synchronous and side-effect free: it touches no transport,
   * starts no request, and cannot fail. A host wiring it to an onChange
   * handler should never have to think about what it costs.
   */
  emitState(kind: string, summary: string, detail?: Record<string, unknown>): void {
    this.notices = appendNotice(this.notices, {
      kind,
      summary,
      ...(detail === undefined ? {} : { detail }),
      at: Date.now(),
    });
  }

  /** What would ride along with the next turn. Exposed for tests and HUDs. */
  pendingNotices(): readonly StateNotice[] {
    return this.notices.notices;
  }

  /**
   * Answer the question the assistant is waiting on.
   *
   * Sends the chosen labels as the visible message — what a person would have
   * typed — while the structured values travel separately as `answers`, so
   * the model gets the exact option ids rather than having to re-match prose.
   */
  async answerQuestion(values: readonly string[]): Promise<void> {
    const pending = this.state.pendingQuestion;
    if (!pending) {
      throw new Error("FreeBirdStore.answerQuestion: nothing is waiting on an answer.");
    }
    const labels = values.map(
      (value) => pending.options.find((option) => option.value === value)?.label ?? value,
    );
    await this.send(labels.join(", "), {
      answers: [
        { questionId: pending.questionId, question: pending.question, values: [...values] },
      ],
    });
  }

  async explain(componentId: string): Promise<void> {
    if (!this.state.sessionId) {
      throw new Error("FreeBirdStore.explain: no active session.");
    }
    this.abortController?.abort();
    const ac = new AbortController();
    this.abortController = ac;
    await this.runStream(
      this.transport.explainComponent({
        sessionId: this.state.sessionId,
        componentId,
      }),
    );
  }

  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Abort any in-flight chat stream and optionally reset local action state.
   * Call when the host auth token disappears or rotates (see transport
   * `onAuthTokenChange`).
   */
  invalidateAuth(opts?: { clearJournal?: boolean }): void {
    this.abortController?.abort();
    this.abortController = null;
    if (opts?.clearJournal) {
      try {
        this.hydrateJournal([]);
      } catch {
        /* noop */
      }
    }
  }

  /**
   * Point the store at a different conversation.
   *
   * The primitive session management is built on: `null` means "no
   * conversation yet", an id means that one. Everything the old conversation
   * put on screen — its messages, its action journal, a half-answered
   * question, an unsent notice, its last error — belongs to it and not to
   * whatever comes next, so switching drops it.
   *
   * It does **not** load the new session's messages. `useChat` already
   * refetches whenever the id changes, which is what will make opening a past
   * conversation work when there is a history to open one from; duplicating
   * that here would give the same job two owners.
   *
   * What it deliberately leaves alone is the workspace: tabs, active
   * components and the layout on screen are where the user *is*, not what
   * they were saying. Changing conversation should not move them.
   *
   * Nothing is done with the conversation being left. It stays on the server
   * exactly as it was — not saved anywhere, not indexed, not deleted. That is
   * the seam history plugs into: today nothing lists those sessions, and when
   * something does, this method is already how you would return to one.
   */
  openSession(id: string | null): void {
    // Whatever was streaming belongs to the conversation being left.
    this.abortController?.abort();
    this.abortController = null;
    this.notices = emptyNoticeBuffer();
    this.setState({
      sessionId: id,
      messages: [],
      streaming: false,
      streamingText: "",
      latestReferences: [],
      actionState: initialActionState,
      supportState: initialSupportState(),
      pendingQuestion: null,
      lastChatError: null,
      lastLlmUsage: null,
    });
  }

  async ensureMessagesLoaded(): Promise<void> {
    if (!this.state.sessionId) return;
    const msgs = await this.transport.listMessages(this.state.sessionId);
    this.setMessages(msgs);
  }

  private async runStream(iter: AsyncIterable<ChatStreamEvent>): Promise<void> {
    this.setState({ streaming: true, streamingText: "" });
    try {
      for await (const event of iter) {
        switch (event.kind) {
          case "user_saved":
            if (event.userMessage) this.addMessage(event.userMessage);
            break;
          case "question_asked":
            if (event.question) this.setState({ pendingQuestion: event.question });
            break;
          case "text_delta":
            if (event.textDelta) {
              this.setState({
                streamingText: this.state.streamingText + event.textDelta,
              });
            }
            break;
          case "layout_ready":
            if (event.layout) this.setLayout(event.layout);
            break;
          case "assistant_saved":
            if (event.assistantMessage) this.addMessage(event.assistantMessage);
            if (event.references)
              this.setState({ latestReferences: event.references });
            this.setState({ streamingText: "" });
            break;
          case "llm_usage":
            if (event.llmUsage) {
              this.setState({ lastLlmUsage: event.llmUsage });
            }
            break;
          case "action_started":
            if (event.action) {
              this.applyActionTransition({
                type: "start",
                recordId: event.action.recordId,
                componentId: event.action.componentId,
                actionId: event.action.actionId,
                label: event.action.label,
                args: event.action.args,
                missing: event.action.missing,
                requiresConfirmation:
                  event.action.requiresConfirmation ?? "preview",
                preview: event.action.preview,
                at: new Date(),
              });
            }
            break;
          case "action_args_updated":
            if (event.action) {
              this.applyActionTransition({
                type: "merge_args",
                args: event.action.args ?? {},
                missing: event.action.missing,
                preview: event.action.preview,
                at: new Date(),
              });
            }
            break;
          case "action_cancelled":
            this.applyActionTransition({
              type: "cancelled",
              reason: event.action?.reason,
              at: new Date(),
            });
            break;
          case "action_paused":
            this.applyActionTransition({
              type: "pause",
              label: event.action?.label,
              at: new Date(),
            });
            break;
          case "action_resumed":
            if (event.action?.recordId) {
              this.applyActionTransition({
                type: "resume",
                recordId: event.action.recordId,
                at: new Date(),
              });
            }
            break;
          case "action_clarification":
            // Render-only: surfaces the LLM's slot-fill question to the host
            // via the chat stream. No state mutation needed here — the
            // assistant_saved message will carry the question text.
            break;
          case "action_blocked":
            if (event.message && event.blockers) {
              this.applyActionTransition({
                type: "block",
                message: event.message,
                blockers: event.blockers,
                at: new Date(),
              });
            }
            break;
          case "issue_classified":
            break;
          case "ticket_drafted":
            if (
              event.ticket?.draftId &&
              event.ticket.draft &&
              event.ticket.preview &&
              event.ticket.classification
            ) {
              this.applySupportTransition({
                type: "draft",
                payload: {
                  draftId: event.ticket.draftId,
                  draft: event.ticket.draft,
                  preview: event.ticket.preview,
                  classification: event.ticket.classification,
                  subject: event.ticket.subject,
                  transcriptExcerpt: event.ticket.transcriptExcerpt,
                  metadata: event.ticket.metadata,
                },
              });
            }
            break;
          case "ticket_created":
            if (event.ticket?.ticket) {
              this.applySupportTransition({
                type: "filed",
                ticket: event.ticket.ticket,
              });
            }
            break;
          case "ticket_failed":
            this.applySupportTransition({
              type: "failed",
              message: event.ticket?.message ?? "Ticket failed",
            });
            break;
          case "error": {
            const errMsg = event.error ?? "Something went wrong.";
            this.setState({ lastChatError: errMsg });
            console.error("[freebird] chat error:", errMsg);
            break;
          }
        }
      }
    } finally {
      this.setState({ streaming: false });
    }
  }

  private appendTransportErrorMessage(err: unknown): void {
    if (!this.state.sessionId) return;
    const msg = err instanceof Error ? err.message : String(err);
    this.addMessage({
      id: `transport-error-${Date.now()}`,
      sessionId: this.state.sessionId,
      role: "assistant",
      content: `Sorry — I couldn't reach the assistant: ${msg}`,
      references: [],
      createdAt: new Date(),
    });
  }
}

