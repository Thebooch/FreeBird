import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from "@angular/core";
import type {
  ActionRecord,
  ActionState,
  ChatMessage,
  ComponentRegistry,
  CustomTab,
  GridCell,
  LayoutPlan,
  Reference,
} from "@freebirdai/core";
import type {
  ActionEvent,
  FreeBirdStore,
  FreeBirdTransport,
} from "@freebirdai/core-state";
import { FREEBIRD_REGISTRY, FREEBIRD_STORE } from "../freebird.tokens";

/**
 * The one Angular service FreeBird consumers interact with. It mirrors
 * `FreeBirdStore` state into Angular Signals so templates and computed
 * signals can read values reactively without RxJS.
 *
 * All streaming logic (SSE, abort, text deltas) lives in the underlying
 * `FreeBirdStore` — this service is a thin reactive projection.
 */
@Injectable({ providedIn: "root" })
export class FreeBirdService {
  private readonly store = inject<FreeBirdStore>(FREEBIRD_STORE);
  private readonly destroyRef = inject(DestroyRef);

  readonly registry = inject<ComponentRegistry<unknown, unknown>>(FREEBIRD_REGISTRY);

  // Writable signals mirroring FreeBirdState. Only the service mutates
  // them; components see them as readonly via the public getters below.
  private readonly _sessionId: WritableSignal<string | null>;
  private readonly _layout: WritableSignal<LayoutPlan | null>;
  private readonly _tabs: WritableSignal<CustomTab[]>;
  private readonly _messages: WritableSignal<ChatMessage[]>;
  private readonly _streaming: WritableSignal<boolean>;
  private readonly _streamingText: WritableSignal<string>;
  private readonly _latestReferences: WritableSignal<Reference[]>;
  private readonly _actionState: WritableSignal<ActionState>;
  private readonly _activeComponentIds: WritableSignal<string[]>;

  readonly sessionId: Signal<string | null>;
  readonly layout: Signal<LayoutPlan | null>;
  readonly tabs: Signal<CustomTab[]>;
  readonly messages: Signal<ChatMessage[]>;
  readonly streaming: Signal<boolean>;
  readonly streamingText: Signal<string>;
  readonly latestReferences: Signal<Reference[]>;
  readonly lockedCells: Signal<GridCell[]>;
  readonly actionState: Signal<ActionState>;
  readonly activeComponentIds: Signal<string[]>;
  readonly actionPhase: Signal<ActionState["phase"]>;
  readonly pendingAction: Signal<ActionState["pending"]>;
  readonly actionJournal: Signal<ActionRecord[]>;
  readonly pausedActions: Signal<ActionRecord[]>;

  constructor() {
    const initial = this.store.getState();
    this._sessionId = signal(initial.sessionId);
    this._layout = signal(initial.layout);
    this._tabs = signal(initial.tabs);
    this._messages = signal(initial.messages);
    this._streaming = signal(initial.streaming);
    this._streamingText = signal(initial.streamingText);
    this._latestReferences = signal(initial.latestReferences);
    this._actionState = signal(initial.actionState);
    this._activeComponentIds = signal(initial.activeComponentIds);

    this.sessionId = this._sessionId.asReadonly();
    this.layout = this._layout.asReadonly();
    this.tabs = this._tabs.asReadonly();
    this.messages = this._messages.asReadonly();
    this.streaming = this._streaming.asReadonly();
    this.streamingText = this._streamingText.asReadonly();
    this.latestReferences = this._latestReferences.asReadonly();
    this.actionState = this._actionState.asReadonly();
    this.activeComponentIds = this._activeComponentIds.asReadonly();
    this.lockedCells = computed(() => {
      const l = this._layout();
      return l ? l.cells.filter((c) => c.locked) : [];
    });
    this.actionPhase = computed(() => this._actionState().phase);
    this.pendingAction = computed(() => this._actionState().pending);
    this.actionJournal = computed(() => this._actionState().journal);
    this.pausedActions = computed(() =>
      this._actionState().journal.filter((r) => r.status === "paused"),
    );

    // Single subscription bridges the plain pub/sub store → Angular signals.
    const unsubscribe = this.store.subscribe((state) => {
      this._sessionId.set(state.sessionId);
      this._layout.set(state.layout);
      this._tabs.set(state.tabs);
      this._messages.set(state.messages);
      this._streaming.set(state.streaming);
      this._streamingText.set(state.streamingText);
      this._latestReferences.set(state.latestReferences);
      this._actionState.set(state.actionState);
      this._activeComponentIds.set(state.activeComponentIds);
    });
    this.destroyRef.onDestroy(() => unsubscribe());
  }

  // ---------------------------------------------------------------------------
  // Store passthroughs (no signal mutation — the subscriber above handles that)
  // ---------------------------------------------------------------------------

  get transport(): FreeBirdTransport {
    return this.store.transport;
  }

  setSessionId(id: string | null): void {
    this.store.setSessionId(id);
  }
  setLayout(p: LayoutPlan | null): void {
    this.store.setLayout(p);
  }
  setTabs(t: CustomTab[]): void {
    this.store.setTabs(t);
  }
  setMessages(m: ChatMessage[]): void {
    this.store.setMessages(m);
  }
  addMessage(m: ChatMessage): void {
    this.store.addMessage(m);
  }
  toggleLock(instanceId: string): void {
    this.store.toggleLock(instanceId);
  }
  refreshTabs(): Promise<void> {
    return this.store.refreshTabs();
  }
  broadcastExplain(componentId: string): void {
    this.store.broadcastExplain(componentId);
  }
  onExplain(fn: (componentId: string) => void): () => void {
    return this.store.onExplain(fn);
  }

  // ---------------------------------------------------------------------------
  // Chat actions
  // ---------------------------------------------------------------------------

  send(text: string): Promise<void> {
    return this.store.send(text);
  }
  explain(componentId: string): Promise<void> {
    return this.store.explain(componentId);
  }
  abort(): void {
    this.store.abort();
  }

  async createSession(input?: {
    title?: string;
    topic?: string;
    tags?: string[];
  }): Promise<string> {
    const s = await this.store.transport.createSession(input ?? {});
    this.store.setSessionId(s.id);
    return s.id;
  }

  // ---------------------------------------------------------------------------
  // Custom tabs
  // ---------------------------------------------------------------------------

  async saveTab(input: { title: string; layout?: LayoutPlan }): Promise<CustomTab> {
    const target = input.layout ?? this._layout();
    if (!target) throw new Error("FreeBirdService.saveTab: no layout to save.");
    const tab = await this.store.transport.saveTab({ title: input.title, layout: target });
    this.store.setTabs([...this._tabs(), tab]);
    return tab;
  }

  async loadTab(id: string): Promise<void> {
    const tab = await this.store.transport.getTab(id);
    if (tab) this.store.setLayout(tab.layout);
  }

  async deleteTab(id: string): Promise<void> {
    await this.store.transport.deleteTab(id);
    this.store.setTabs(this._tabs().filter((t) => t.id !== id));
  }

  // ---------------------------------------------------------------------------
  // Action layer
  // ---------------------------------------------------------------------------

  setActiveComponentIds(ids: string[]): void {
    this.store.setActiveComponentIds(ids);
  }
  confirmAction(): Promise<void> {
    return this.store.confirmAction();
  }
  cancelAction(reason?: string): Promise<void> {
    return this.store.cancelAction(reason);
  }
  pauseAction(label?: string): void {
    this.store.pauseAction(label);
  }
  resumeAction(recordId: string): void {
    this.store.resumeAction(recordId);
  }
  discardActionRecord(recordId: string): void {
    this.store.discardRecord(recordId);
  }
  mergeActionArgs(args: Record<string, unknown>, missing?: string[]): void {
    this.store.mergeActionArgs(args, missing);
  }
  onActionEvent(handler: (event: ActionEvent) => void): () => void {
    return this.store.onActionEvent(handler);
  }
}
