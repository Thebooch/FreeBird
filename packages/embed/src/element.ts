import type { FreeBirdStore, FreeBirdState } from "@freebirdai/core-state";
import type { ComponentCitation } from "@freebirdai/core";
import { WIDGET_CSS } from "./styles.js";

/**
 * `<freebird-chat>` — the vanilla, Shadow-DOM chat widget. A thin renderer
 * over {@link FreeBirdStore}: subscribes to state, re-renders the message
 * list, and forwards composer/confirm-card interactions back to the store.
 *
 * Session creation is lazy — the first open (or send) creates the session,
 * so pages that never touch the widget never hit the backend.
 */
export interface FreeBirdChatOptions {
  store: FreeBirdStore;
  title: string;
  placeholder: string;
  position: "bottom-right" | "bottom-left" | "full-right" | "full-left";
  accent?: string;
  /** Called once, on first open, to create/restore the chat session. */
  ensureSession: () => Promise<void>;
  /** Called when the visitor clicks a citation chip under an assistant reply. */
  onCiteClick?: (citation: ComponentCitation) => void;
}

/** Defensive extraction — `toolPayload` is untyped JSON on the wire. */
const citationsFromPayload = (payload: unknown): ComponentCitation[] => {
  if (!payload || typeof payload !== "object") return [];
  const citations = (payload as { citations?: unknown }).citations;
  return Array.isArray(citations) ? (citations as ComponentCitation[]) : [];
};

interface ChatCard {
  title?: string;
  text: string;
}

export class FreeBirdChatElement extends HTMLElement {
  private options: FreeBirdChatOptions | null = null;
  private unsubscribe: (() => void) | null = null;
  private cards: ChatCard[] = [];
  private sessionReady: Promise<void> | null = null;

  private messagesEl!: HTMLElement;
  private confirmEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private sendBtn!: HTMLButtonElement;

  configure(options: FreeBirdChatOptions): void {
    this.options = options;
    if (options.accent) {
      this.style.setProperty("--freebird-accent", options.accent);
    }
    this.setAttribute("data-position", options.position);
    if (this.isConnected) this.mount();
  }

  /** Show a show-in-chat card (called by the local-action executor). */
  showCard(card: ChatCard): void {
    this.cards = [...this.cards, card];
    this.open();
    this.render();
  }

  open(): void {
    if (!this.hasAttribute("data-open")) {
      this.setAttribute("data-open", "");
      void this.ensureSession();
      queueMicrotask(() => this.inputEl?.focus());
    }
  }

  close(): void {
    this.removeAttribute("data-open");
  }

  toggle(): void {
    this.hasAttribute("data-open") ? this.close() : this.open();
  }

  connectedCallback(): void {
    if (this.options) this.mount();
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private ensureSession(): Promise<void> {
    if (!this.sessionReady) {
      this.sessionReady = this.options!.ensureSession().catch((err) => {
        console.error("[freebird] session create failed:", err);
        this.sessionReady = null;
        throw err;
      });
    }
    return this.sessionReady;
  }

  private mount(): void {
    if (this.shadowRoot) return;
    const opts = this.options!;
    const root = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = WIDGET_CSS;
    root.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="header">
        <span></span>
        <button type="button" data-close aria-label="Close chat">×</button>
      </div>
      <div class="messages" role="log" aria-live="polite"></div>
      <div class="confirm" hidden></div>
      <form class="composer">
        <input type="text" autocomplete="off" />
        <button type="submit">Send</button>
      </form>
      <div class="footer">Powered by <a href="https://github.com/Thebooch/FreeBird" target="_blank" rel="noreferrer">FreeBird</a></div>
    `;
    root.appendChild(panel);

    const launcher = document.createElement("button");
    launcher.className = "launcher";
    launcher.setAttribute("aria-label", "Open chat");
    launcher.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.7 1.4 5.1 3.7 6.7-.2.8-.8 2.1-1.9 3.2 0 0 2.8-.2 4.9-1.6 1 .3 2.1.4 3.3.4 5.5 0 10-3.9 10-8.7S17.5 3 12 3z"/></svg>';
    root.appendChild(launcher);

    (panel.querySelector(".header span") as HTMLElement).textContent = opts.title;
    this.messagesEl = panel.querySelector(".messages") as HTMLElement;
    this.confirmEl = panel.querySelector(".confirm") as HTMLElement;
    this.inputEl = panel.querySelector("input") as HTMLInputElement;
    this.inputEl.placeholder = opts.placeholder;
    this.sendBtn = panel.querySelector(".composer button") as HTMLButtonElement;

    launcher.addEventListener("click", () => this.toggle());
    (panel.querySelector("[data-close]") as HTMLElement).addEventListener(
      "click",
      () => this.close(),
    );
    (panel.querySelector("form") as HTMLFormElement).addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        void this.submit();
      },
    );

    this.unsubscribe = opts.store.subscribe(() => this.render());
    this.render();
  }

  private async submit(): Promise<void> {
    const opts = this.options!;
    const text = this.inputEl.value.trim();
    if (!text || opts.store.getState().streaming) return;
    this.inputEl.value = "";
    try {
      await this.ensureSession();
      await opts.store.send(text);
    } catch {
      // store.send already surfaced a transport-error message in-chat.
    }
  }

  private render(): void {
    if (!this.shadowRoot || !this.options) return;
    const state = this.options.store.getState();
    this.renderMessages(state);
    this.renderConfirm(state);
    this.sendBtn.disabled = state.streaming;
  }

  private renderMessages(state: FreeBirdState): void {
    const el = this.messagesEl;
    el.textContent = "";
    for (const m of state.messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (!m.content) continue;
      const bubble = document.createElement("div");
      bubble.className = `msg ${m.role}`;
      bubble.textContent = m.content;
      el.appendChild(bubble);

      if (m.role === "assistant") {
        const citations = citationsFromPayload(m.toolPayload);
        if (citations.length > 0) {
          const chips = document.createElement("div");
          chips.className = "citations";
          for (const citation of citations) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "citation-chip";
            chip.textContent = citation.title;
            chip.addEventListener("click", () => this.options?.onCiteClick?.(citation));
            chips.appendChild(chip);
          }
          el.appendChild(chips);
        }
      }
    }
    for (const card of this.cards) {
      const bubble = document.createElement("div");
      bubble.className = "msg card";
      if (card.title) {
        const t = document.createElement("div");
        t.className = "card-title";
        t.textContent = card.title;
        bubble.appendChild(t);
      }
      const body = document.createElement("div");
      body.textContent = card.text;
      bubble.appendChild(body);
      el.appendChild(bubble);
    }
    if (state.streaming) {
      const typing = document.createElement("div");
      if (state.streamingText) {
        typing.className = "msg assistant";
        typing.textContent = state.streamingText;
      } else {
        typing.className = "typing";
        typing.textContent = "…";
      }
      el.appendChild(typing);
    }
    el.scrollTop = el.scrollHeight;
  }

  /**
   * One confirm surface, two producers: pending *actions* (preview/strict)
   * and pending *support tickets*. Whichever is active renders; Apply/Cancel
   * route back to the store.
   */
  private renderConfirm(state: FreeBirdState): void {
    const el = this.confirmEl;
    const store = this.options!.store;
    const pendingAction =
      state.actionState.phase === "awaiting_confirmation"
        ? state.actionState.pending
        : null;
    const pendingTicket =
      state.supportState.phase === "awaiting_confirmation"
        ? state.supportState.pending
        : null;

    if (!pendingAction && !pendingTicket) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = "";

    const title = document.createElement("div");
    title.className = "confirm-title";
    const rows = document.createElement("div");
    rows.className = "confirm-rows";
    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const primary = document.createElement("button");
    primary.className = "primary";
    primary.type = "button";
    const secondary = document.createElement("button");
    secondary.type = "button";
    secondary.textContent = "Cancel";

    if (pendingAction) {
      title.textContent = pendingAction.label ?? pendingAction.actionId;
      rows.textContent = Object.entries(pendingAction.args)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n");
      primary.textContent = "Apply";
      primary.addEventListener("click", () => void store.confirmAction());
      secondary.addEventListener("click", () => void store.cancelAction());
    } else if (pendingTicket) {
      title.textContent = `File ticket: ${pendingTicket.draft.title}`;
      rows.textContent = `${pendingTicket.draft.type} · ${pendingTicket.draft.severity}\n${pendingTicket.draft.summary}`;
      primary.textContent = "File ticket";
      primary.addEventListener("click", () => void store.fileTicket());
      secondary.addEventListener("click", () => store.cancelSupportDraft());
    }

    actions.append(primary, secondary);
    el.append(title, rows, actions);
  }
}

export const ELEMENT_TAG = "freebird-chat";

export const defineChatElement = (): void => {
  if (typeof customElements !== "undefined" && !customElements.get(ELEMENT_TAG)) {
    customElements.define(ELEMENT_TAG, FreeBirdChatElement);
  }
};
