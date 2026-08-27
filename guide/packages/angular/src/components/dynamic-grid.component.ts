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
import type { GridCell } from "@freebirdai/core";
import { FreeBirdService } from "../services/freebird.service";

/**
 * Angular `DynamicGrid` — lays out cells on a CSS Grid using the data
 * from the current layout plan. The inner component rendering is
 * delegated to the host template: provide a `<ng-template>` with
 * `let-cell="cell"` to render each cell however you like.
 *
 * Drag-and-drop is **not** included in v1; wire up `@angular/cdk/drag-drop`
 * or `angular-gridster2` yourself using `lockedCells() + toggleLock()`.
 *
 * Usage:
 *
 *   <fb-dynamic-grid>
 *     <ng-template let-cell="cell">
 *       <ng-container [ngSwitch]="cell.componentId">
 *         <app-revenue-chart *ngSwitchCase="'revenueChart'" />
 *         ...
 *       </ng-container>
 *     </ng-template>
 *   </fb-dynamic-grid>
 */
@Component({
  selector: "fb-dynamic-grid",
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      data-freebird-grid
      [attr.data-freebird-locks]="showLocks ? 'show' : 'hide'"
      [style.display]="'grid'"
      [style.gridTemplateColumns]="gridTemplateColumns()"
      [style.gridAutoRows.px]="rowHeightPx"
      [style.gap.px]="gapPx"
    >
      <div
        *ngFor="let cell of effectiveCells(); trackBy: trackByInstance"
        data-freebird-cell
        [attr.data-component]="cell.componentId"
        [attr.data-locked]="cell.locked ? '' : null"
        [attr.data-importance]="cell.importance"
        [attr.data-orientation]="cell.orientation"
        [style.gridColumn]="'span ' + cell.w + ' / span ' + cell.w"
        [style.gridColumnStart]="cell.x + 1"
        [style.gridRowStart]="cell.y + 1"
        [style.gridRowEnd]="'span ' + cell.h"
      >
        <ng-container
          *ngIf="tpl; else missing"
          [ngTemplateOutlet]="tpl"
          [ngTemplateOutletContext]="{ $implicit: cell, cell: cell }"
        />
        <ng-template #missing>
          <div data-freebird-cell-missing>
            Missing component: {{ cell.componentId }}
          </div>
        </ng-template>
      </div>
    </div>
  `,
})
export class DynamicGridComponent {
  private readonly fb = inject(FreeBirdService);

  @Input() cells?: GridCell[];
  @Input() gridCols?: number;
  @Input() showLocks = true;
  @Input() rowHeightPx = 72;
  @Input() gapPx = 12;

  @ContentChild(TemplateRef) tpl?: TemplateRef<{
    $implicit: GridCell;
    cell: GridCell;
  }>;

  readonly effectiveCells = computed<GridCell[]>(
    () => this.cells ?? this.fb.layout()?.cells ?? [],
  );

  readonly effectiveGridCols = computed<number>(
    () => this.gridCols ?? this.fb.layout()?.gridCols ?? 12,
  );

  readonly gridTemplateColumns = computed<string>(
    () => `repeat(${this.effectiveGridCols()}, 1fr)`,
  );

  trackByInstance = (_: number, c: GridCell): string => c.instanceId;
}
