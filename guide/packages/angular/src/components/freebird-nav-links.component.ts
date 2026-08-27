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
import type { CustomTab } from "@freebirdai/core";
import { FreeBirdService } from "../services/freebird.service";

/**
 * Iterates saved custom tabs into the host app's nav. Provides a scoped
 * template with `{ tab, href }` — plug in `routerLink` or a plain `<a>`:
 *
 *   <fb-freebird-nav-links baseHref="/dashboard">
 *     <ng-template let-ctx>
 *       <a [routerLink]="ctx.href">{{ ctx.tab.title }}</a>
 *     </ng-template>
 *   </fb-freebird-nav-links>
 */
@Component({
  selector: "fb-freebird-nav-links",
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container
      *ngFor="let item of rendered(); trackBy: trackById"
      [ngTemplateOutlet]="tpl || null"
      [ngTemplateOutletContext]="{ $implicit: item, tab: item.tab, href: item.href }"
    />
  `,
})
export class FreeBirdNavLinksComponent {
  private readonly fb = inject(FreeBirdService);

  @Input() baseHref = "/tabs";
  @Input() filter?: (tab: CustomTab) => boolean;

  @ContentChild(TemplateRef) tpl?: TemplateRef<{
    $implicit: { tab: CustomTab; href: string };
    tab: CustomTab;
    href: string;
  }>;

  readonly rendered = computed<Array<{ tab: CustomTab; href: string }>>(() => {
    const all = this.fb.tabs();
    const filtered = this.filter ? all.filter(this.filter) : all;
    const base = this.baseHref.replace(/\/+$/, "");
    return filtered.map((tab) => ({
      tab,
      href: `${base}/${tab.slug ?? tab.id}`,
    }));
  });

  trackById = (_: number, item: { tab: CustomTab; href: string }): string =>
    item.tab.id;
}
