import {
  ChangeDetectionStrategy,
  Component,
  Input,
  inject,
} from "@angular/core";
import { FreeBirdService } from "../services/freebird.service";

/**
 * "Info" button that broadcasts an explain event. Any mounted chat
 * listener (e.g. a dedicated component created elsewhere in the app, or
 * the built-in `FreeBirdService.onExplain()`) will pick it up and stream
 * an explanation of the bound `componentId`.
 *
 * Note: unlike React/Vue, Angular does not auto-wire this to the chat —
 * call `fb.onExplain(id => fb.explain(id))` once from your root component
 * to get the same behavior. This keeps lifetime management explicit.
 */
@Component({
  selector: "fb-info-trigger",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      [attr.aria-label]="ariaLabel || 'Explain ' + componentId"
      data-freebird-info-trigger
      [attr.data-component]="componentId"
      (click)="onClick()"
    >
      <ng-content>
        <span aria-hidden="true" style="font-style: italic; font-weight: 700">i</span>
      </ng-content>
    </button>
  `,
})
export class InfoTriggerComponent {
  private readonly fb = inject(FreeBirdService);

  @Input({ required: true }) componentId!: string;
  @Input() ariaLabel?: string;

  onClick(): void {
    this.fb.broadcastExplain(this.componentId);
  }
}
