import {
  ChangeDetectionStrategy,
  Component,
  ContentChild,
  EventEmitter,
  Input,
  OnInit,
  Output,
  TemplateRef,
  inject,
  signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import type { CustomTab } from "@freebirdai/core";
import { FreeBirdService } from "../services/freebird.service";

/**
 * Root wrapper for the custom tab bar. Fetches tabs on init.
 */
@Component({
  selector: "fb-custom-tab-bar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-freebird-tabs><ng-content /></div>`,
})
export class CustomTabBarComponent implements OnInit {
  private readonly fb = inject(FreeBirdService);
  ngOnInit(): void {
    this.fb.refreshTabs().catch(() => {});
  }
}

/**
 * Iterates over saved tabs and renders a scoped template for each:
 *
 *   <fb-custom-tab-bar-list>
 *     <ng-template let-tab="tab">
 *       <button (click)="loadTab(tab.id)">{{ tab.title }}</button>
 *     </ng-template>
 *   </fb-custom-tab-bar-list>
 */
@Component({
  selector: "fb-custom-tab-bar-list",
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-freebird-tabs-list>
      <ng-container
        *ngFor="let t of fb.tabs(); trackBy: trackById"
        [ngTemplateOutlet]="tpl || null"
        [ngTemplateOutletContext]="{ $implicit: t, tab: t }"
      />
    </div>
  `,
})
export class CustomTabBarListComponent {
  readonly fb = inject(FreeBirdService);
  @ContentChild(TemplateRef) tpl?: TemplateRef<{
    $implicit: CustomTab;
    tab: CustomTab;
  }>;
  trackById = (_: number, t: CustomTab): string => t.id;
}

/**
 * A single tab button. Loading a tab replaces the live layout with the
 * tab's saved layout unless `onSelect` is bound.
 */
@Component({
  selector: "fb-custom-tab-bar-item",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      data-freebird-tab
      [attr.data-id]="tab.id"
      [attr.data-slug]="tab.slug"
      [attr.data-has-digest]="tab.digest ? '' : null"
      (click)="onClick()"
    >
      <ng-content>{{ tab.title }}</ng-content>
    </button>
  `,
})
export class CustomTabBarItemComponent {
  private readonly fb = inject(FreeBirdService);
  @Input({ required: true }) tab!: CustomTab;
  @Output() select = new EventEmitter<CustomTab>();

  async onClick(): Promise<void> {
    if (this.select.observed) {
      this.select.emit(this.tab);
    } else {
      await this.fb.loadTab(this.tab.id);
    }
  }
}

/**
 * "Save current layout as a new tab" button. Uses `window.prompt` by
 * default; pass `[promptTitle]` to wire into your own dialog.
 */
@Component({
  selector: "fb-custom-tab-bar-save",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      data-freebird-tabs-save
      [attr.data-saving]="saving() ? '' : null"
      [disabled]="!fb.layout() || saving() || disabled"
      (click)="onClick()"
    >
      <ng-content>Save tab</ng-content>
    </button>
  `,
})
export class CustomTabBarSaveComponent {
  readonly fb = inject(FreeBirdService);
  @Input() promptTitle?: () => string | null | Promise<string | null>;
  @Input() disabled = false;
  @Output() saved = new EventEmitter<CustomTab>();
  readonly saving = signal(false);

  async onClick(): Promise<void> {
    if (!this.fb.layout() || this.saving()) return;
    this.saving.set(true);
    try {
      const title = this.promptTitle
        ? await this.promptTitle()
        : typeof window !== "undefined"
          ? window.prompt("Name this tab:")
          : "Custom tab";
      if (!title) return;
      const tab = await this.fb.saveTab({ title });
      this.saved.emit(tab);
    } finally {
      this.saving.set(false);
    }
  }
}
