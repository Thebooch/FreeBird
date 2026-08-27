import {
  ChangeDetectionStrategy,
  Component,
  Input,
  computed,
  inject,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { FreeBirdService } from "../services/freebird.service";

/**
 * Per-cell lock toggle. Renders a `<button>` whose `aria-pressed`
 * reflects the lock state. Pass any content inside `<ng-content>` (icon,
 * text, etc.) or project a `<ng-template>` for full custom rendering.
 */
@Component({
  selector: "fb-lock-toggle",
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      data-freebird-lock-toggle
      [attr.data-locked]="locked() ? '' : null"
      [attr.aria-pressed]="locked()"
      (click)="toggle()"
    >
      <ng-content />
    </button>
  `,
})
export class LockToggleComponent {
  private readonly fb = inject(FreeBirdService);

  @Input({ required: true }) instanceId!: string;

  readonly locked = computed<boolean>(
    () =>
      !!this.fb
        .layout()
        ?.cells.find((c) => c.instanceId === this.instanceId)?.locked,
  );

  toggle(): void {
    this.fb.toggleLock(this.instanceId);
  }
}
