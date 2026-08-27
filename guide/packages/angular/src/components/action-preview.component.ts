import {
  ChangeDetectionStrategy,
  Component,
  ContentChild,
  Input,
  TemplateRef,
  computed,
  inject,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import type { ActionPhase, PendingAction } from "@freebirdai/core";
import { FreeBirdService } from "../services/freebird.service";

/**
 * Headless action confirmation preview.
 *
 * Renders nothing while the action machine is idle. When a pending action
 * exists, projects either:
 *   1. Your `<ng-template>` content (preferred) — receives a render context
 *      `{ pending, phase, error, confirm, cancel, pause }`.
 *   2. A minimal default UI with stable `data-freebird-action-*` hooks.
 *
 * @example
 *   <fb-action-preview>
 *     <ng-template let-pending="pending" let-confirm="confirm" let-cancel="cancel">
 *       <my-card>
 *         <pre>{{ pending.args | json }}</pre>
 *         <button (click)="confirm()">Apply</button>
 *         <button (click)="cancel()">Cancel</button>
 *       </my-card>
 *     </ng-template>
 *   </fb-action-preview>
 */
@Component({
  selector: "fb-action-preview",
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *ngIf="visible()">
      <ng-container
        *ngIf="tpl; else fallback"
        [ngTemplateOutlet]="tpl"
        [ngTemplateOutletContext]="ctx()"
      />
      <ng-template #fallback>
        <div
          role="dialog"
          aria-label="Confirm action"
          data-freebird-action-preview
          [attr.data-phase]="fb.actionPhase()"
        >
          <div data-freebird-action-preview-header>
            <strong>{{ pending()!.label || pending()!.componentId + ":" + pending()!.actionId }}</strong>
          </div>
          <pre data-freebird-action-preview-body>{{ pending()!.args | json }}</pre>
          <div
            *ngIf="fb.actionState().lastError as err"
            role="alert"
            data-freebird-action-preview-error
          >
            {{ err }}
          </div>
          <div data-freebird-action-preview-actions>
            <button
              type="button"
              data-freebird-action-confirm
              [disabled]="
                fb.actionPhase() === 'executing' || fb.actionPhase() === 'collecting'
              "
              (click)="confirm()"
            >
              Confirm
            </button>
            <button type="button" data-freebird-action-cancel (click)="cancel()">
              Cancel
            </button>
            <button type="button" data-freebird-action-pause (click)="pause()">
              Pause
            </button>
          </div>
        </div>
      </ng-template>
    </ng-container>
  `,
})
export class ActionPreviewComponent {
  readonly fb = inject(FreeBirdService);

  /** When true, suppresses the preview while an action is mid-execution. */
  @Input() hideWhileExecuting = false;

  @ContentChild(TemplateRef) tpl?: TemplateRef<{
    $implicit: PendingAction;
    pending: PendingAction;
    phase: ActionPhase;
    error: string | undefined;
    confirm: () => Promise<void>;
    cancel: (reason?: string) => Promise<void>;
    pause: (label?: string) => void;
  }>;

  readonly pending = computed(() => this.fb.pendingAction());

  readonly visible = computed(() => {
    const p = this.fb.pendingAction();
    if (!p) return false;
    if (this.fb.actionPhase() === "idle") return false;
    if (this.hideWhileExecuting && this.fb.actionPhase() === "executing")
      return false;
    return true;
  });

  readonly ctx = computed(() => {
    const p = this.fb.pendingAction()!;
    return {
      $implicit: p,
      pending: p,
      phase: this.fb.actionPhase(),
      error: this.fb.actionState().lastError,
      confirm: () => this.fb.confirmAction(),
      cancel: (reason?: string) => this.fb.cancelAction(reason),
      pause: (label?: string) => this.fb.pauseAction(label),
    };
  });

  confirm(): Promise<void> {
    return this.fb.confirmAction();
  }
  cancel(): Promise<void> {
    return this.fb.cancelAction();
  }
  pause(): void {
    this.fb.pauseAction();
  }
}
