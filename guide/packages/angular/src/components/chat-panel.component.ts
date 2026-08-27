import {
  ChangeDetectionStrategy,
  Component,
  ContentChild,
  EventEmitter,
  Input,
  OnInit,
  Output,
  TemplateRef,
  computed,
  inject,
  signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import type { ChatMessage, ComponentCitation } from "@freebirdai/core";
import {
  activateCitation,
  citationsFromToolPayload,
  replayPendingCitation,
} from "@freebirdai/core";
import { FreeBirdService } from "../services/freebird.service";

/**
 * Host hook for client-side routing when a citation targets another page.
 * Return `false` to fall back to a full-page `location.assign`; anything
 * else (including void) means the host's router handled it.
 */
export type CitationNavigateHandler = (
  path: string,
  citation: ComponentCitation,
) => void | boolean | Promise<void | boolean>;

/**
 * Root wrapper for the chat panel. Auto-creates a session on init unless
 * `[sessionAutoCreate]="false"` is supplied. Matches the React
 * `<ChatPanel.Root>` API.
 */
@Component({
  selector: "fb-chat-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-freebird-chat><ng-content /></div>`,
})
export class ChatPanelComponent implements OnInit {
  private readonly fb = inject(FreeBirdService);

  @Input() sessionAutoCreate = true;
  @Input() sessionTopic?: string;
  @Input() sessionTags?: string[];

  async ngOnInit(): Promise<void> {
    // A citation click may have navigated here — finish the scroll+highlight.
    void replayPendingCitation();
    if (!this.sessionAutoCreate) return;
    if (this.fb.sessionId()) return;
    try {
      await this.fb.createSession({
        topic: this.sessionTopic,
        tags: this.sessionTags,
      });
    } catch (err) {
       
      console.error("[freebird] auto createSession failed:", err);
    }
  }
}

/**
 * Scoped-slot-style messages renderer. Provide a `<ng-template>` with
 * `let-messages="messages"` / `let-streamingText="streamingText"`.
 */
@Component({
  selector: "fb-chat-panel-messages",
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-freebird-chat-messages>
      <ng-container
        *ngIf="tpl"
        [ngTemplateOutlet]="tpl"
        [ngTemplateOutletContext]="context()"
      />
    </div>
  `,
})
export class ChatPanelMessagesComponent {
  private readonly fb = inject(FreeBirdService);
  @ContentChild(TemplateRef) tpl?: TemplateRef<{
    $implicit: ChatMessage[];
    messages: ChatMessage[];
    streamingText: string;
    streaming: boolean;
  }>;

  readonly context = computed(() => ({
    $implicit: this.fb.messages(),
    messages: this.fb.messages(),
    streamingText: this.fb.streamingText(),
    streaming: this.fb.streaming(),
  }));
}

/**
 * Form wrapper that binds an input (via the `[fbChatPanelInput]` directive)
 * and a submit button, and wires them to `FreeBirdService.send()`.
 *
 * Because Angular doesn't have React context, we use template reference
 * variables + exportAs instead of provide/inject here — easier to read in
 * templates:
 *
 *   <fb-chat-panel-form #form>
 *     <input fbChatPanelInput [form]="form" />
 *     <button fbChatPanelSubmit [form]="form">Send</button>
 *   </fb-chat-panel-form>
 */
@Component({
  selector: "fb-chat-panel-form",
  standalone: true,
  exportAs: "fbChatPanelForm",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form data-freebird-chat-form (submit)="onSubmit($event)">
      <ng-content />
    </form>
  `,
})
export class ChatPanelFormComponent {
  private readonly fb = inject(FreeBirdService);

  @Input() beforeSend?: (text: string) => boolean | Promise<boolean>;
  @Output() afterSend = new EventEmitter<void>();

  readonly value = signal<string>("");
  readonly streaming = this.fb.streaming;
  readonly sessionReady = computed(() => this.fb.sessionId() != null);

  setValue(v: string): void {
    this.value.set(v);
  }

  async submit(): Promise<void> {
    const text = this.value().trim();
    if (!text || this.streaming() || !this.sessionReady()) return;
    if (this.beforeSend && (await this.beforeSend(text)) === false) return;
    this.value.set("");
    try {
      await this.fb.send(text);
    } finally {
      this.afterSend.emit();
    }
  }

  onSubmit(e: Event): void {
    e.preventDefault();
    void this.submit();
  }
}

/**
 * Directive-style input that binds to a parent form by template ref.
 * Implemented as a component for simpler template syntax.
 */
@Component({
  selector: "input[fbChatPanelInput]",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ``,
  host: {
    "data-freebird-chat-input": "",
    type: "text",
    "[value]": "form?.value() ?? ''",
    "[disabled]":
      "!!form && (form.streaming() || !form.sessionReady() || disabled)",
    "(input)": "onInput($event)",
  },
})
export class ChatPanelInputComponent {
  @Input() form?: ChatPanelFormComponent;
  @Input() disabled = false;

  onInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.form?.setValue(v);
  }
}

/**
 * Submit button bound to a parent form by template ref.
 */
@Component({
  selector: "button[fbChatPanelSubmit]",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-content />`,
  host: {
    type: "submit",
    "data-freebird-chat-submit": "",
    "[attr.data-streaming]": "form?.streaming() ? '' : null",
    "[disabled]":
      "!form || form.streaming() || !form.sessionReady() || !form.value().trim() || disabled",
  },
})
export class ChatPanelSubmitComponent {
  @Input() form?: ChatPanelFormComponent;
  @Input() disabled = false;
}

/**
 * Citation chips under an assistant reply — matches React's
 * `<ChatPanel.Citations>`. Also usable standalone.
 */
@Component({
  selector: "fb-chat-panel-citations",
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div *ngIf="citations.length" data-freebird-chat-citations>
      <button
        *ngFor="let c of citations; let i = index"
        type="button"
        data-freebird-chat-citation
        [attr.data-kind]="c.kind ?? 'component'"
        [attr.data-component]="c.componentId"
        (click)="onChipClick(c)"
      >
        {{ c.title }}
      </button>
    </div>
  `,
})
export class ChatPanelCitationsComponent {
  @Input({ required: true }) message!: ChatMessage;
  /** Client-side routing hook for cross-page citations. */
  @Input() onCitationNavigate?: CitationNavigateHandler;

  get citations(): ComponentCitation[] {
    if (this.message.role !== "assistant") return [];
    return citationsFromToolPayload(this.message.toolPayload);
  }

  onChipClick(citation: ComponentCitation): void {
    void activateCitation(citation, {
      ...(this.onCitationNavigate ? { onNavigate: this.onCitationNavigate } : {}),
    });
  }
}

/**
 * Convenience single-message renderer — matches React's
 * `<ChatPanel.Message>`.
 */
@Component({
  selector: "fb-chat-panel-message",
  standalone: true,
  imports: [CommonModule, ChatPanelCitationsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      data-freebird-chat-message
      [attr.data-role]="message.role"
    >
      {{ message.content }}
      <div *ngIf="message.references?.length" data-freebird-chat-refs>
        <span
          *ngFor="let r of message.references; let i = index"
          data-freebird-chat-ref
          [attr.data-tag]="r.tag"
          [attr.data-component]="r.componentId"
        >
          {{ r.reason }}
        </span>
      </div>
      <fb-chat-panel-citations
        [message]="message"
        [onCitationNavigate]="onCitationNavigate"
      />
    </div>
  `,
})
export class ChatPanelMessageComponent {
  @Input({ required: true }) message!: ChatMessage;
  /** Client-side routing hook for cross-page citation chips. */
  @Input() onCitationNavigate?: CitationNavigateHandler;
}
