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
import type { ActionRecord, ActionRecordStatus } from "@freebirdai/core";
import { FreeBirdService } from "../services/freebird.service";

const STATUS_LABEL: Record<ActionRecordStatus, string> = {
  in_progress: "In progress",
  paused: "Paused",
  completed: "Completed",
  terminated: "Terminated",
  failed: "Failed",
};

/**
 * Headless action-journal viewer. Pass an `<ng-template>` for full custom
 * rendering, or rely on the default `<ul>` with stable
 * `data-freebird-action-journal-*` hooks.
 *
 * @example
 *   <fb-action-journal [status]="'paused'">
 *     <ng-template let-records="records" let-resume="resume" let-discard="discard">
 *       <ol>
 *         <li *ngFor="let r of records">
 *           {{ r.label || r.componentId + ':' + r.actionId }}
 *           <button (click)="resume(r.id)">Resume</button>
 *           <button (click)="discard(r.id)">Remove</button>
 *         </li>
 *       </ol>
 *     </ng-template>
 *   </fb-action-journal>
 */
@Component({
  selector: "fb-action-journal",
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *ngIf="!hideWhenEmpty || records().length > 0">
      <ng-container
        *ngIf="tpl; else fallback"
        [ngTemplateOutlet]="tpl"
        [ngTemplateOutletContext]="ctx()"
      />
      <ng-template #fallback>
        <ul data-freebird-action-journal>
          <li
            *ngFor="let r of records(); trackBy: trackById"
            data-freebird-action-journal-item
            [attr.data-status]="r.status"
          >
            <span data-freebird-action-journal-label>
              {{ r.label || r.componentId + ":" + r.actionId }}
            </span>
            <span data-freebird-action-journal-status>
              {{ statusLabel(r.status) }}
            </span>
            <button
              *ngIf="r.status === 'paused'"
              type="button"
              (click)="resume(r.id)"
            >
              Resume
            </button>
            <button
              type="button"
              aria-label="Remove from journal"
              (click)="discard(r.id)"
            >
              ×
            </button>
          </li>
        </ul>
      </ng-template>
    </ng-container>
  `,
})
export class ActionJournalComponent {
  private readonly fb = inject(FreeBirdService);

  @Input() status?: ActionRecordStatus | ActionRecordStatus[];
  @Input() limit?: number;
  @Input() hideWhenEmpty = true;

  @ContentChild(TemplateRef) tpl?: TemplateRef<{
    $implicit: ActionRecord[];
    records: ActionRecord[];
    resume: (recordId: string) => void;
    discard: (recordId: string) => void;
  }>;

  readonly records = computed<ActionRecord[]>(() => {
    let out = this.fb.actionJournal();
    if (this.status) {
      const allow = new Set(
        Array.isArray(this.status) ? this.status : [this.status],
      );
      out = out.filter((r) => allow.has(r.status));
    }
    if (this.limit !== undefined) out = out.slice(0, this.limit);
    return out;
  });

  readonly ctx = computed(() => {
    const list = this.records();
    return {
      $implicit: list,
      records: list,
      resume: (recordId: string) => this.resume(recordId),
      discard: (recordId: string) => this.discard(recordId),
    };
  });

  trackById = (_: number, r: ActionRecord): string => r.id;
  statusLabel = (s: ActionRecordStatus): string => STATUS_LABEL[s];

  resume(recordId: string): void {
    this.fb.resumeAction(recordId);
  }
  discard(recordId: string): void {
    this.fb.discardActionRecord(recordId);
  }
}
