import type { DashboardSpec, LayoutCell } from "@freebirdai/dash-spec";

/**
 * Saving where the user put things.
 *
 * The grid has been draggable since it was written, and every drag was thrown
 * away: the host passed an `onLayoutChange` that logged to the console. A
 * layout that silently resets on reload is worse than one that cannot be
 * changed at all, because the work looks like it landed.
 *
 * Kept in a `.ts` file rather than beside the component: vitest only collects
 * `.test.ts` under `apps/`, never `.tsx`, so logic that lives in a component
 * file goes untested by construction. The timer is injected for the same
 * reason — a test should not wait a second per assertion.
 */

/**
 * The dashboard with these cells, and without cells for widgets that are gone.
 *
 * A cell whose widget no longer exists reserves space for something nothing
 * renders, and the packer then lays the survivors out around a hole — the same
 * reasoning that makes `removeWidget` drop the cell along with the widget.
 */
export const withLayoutCells = (
  dashboard: DashboardSpec,
  cells: readonly LayoutCell[],
): DashboardSpec => {
  const live = new Set(dashboard.widgets.map((widget) => widget.id));
  return {
    ...dashboard,
    layout: {
      ...dashboard.layout,
      cells: cells.filter((cell) => live.has(cell.widgetId)),
    },
  };
};

export interface LayoutSaverOptions {
  /** Writes the spec. Rejects with a message a person can read. */
  readonly put: (dashboard: DashboardSpec) => Promise<void>;
  readonly delayMs?: number;
  readonly onError?: (message: string) => void;
  /** Injected so tests do not wait a second per assertion. */
  readonly schedule?: (run: () => void, ms: number) => number;
  readonly cancel?: (handle: number) => void;
}

export interface LayoutSaver {
  /** Record an edit. The write is coalesced. */
  readonly save: (dashboard: DashboardSpec, cells: readonly LayoutCell[]) => void;
  /** Write anything outstanding now. Returns what is pending, or null. */
  readonly flush: () => DashboardSpec | null;
  readonly cancel: () => void;
}

const DEFAULT_DELAY_MS = 1000;

/**
 * Coalesce a burst of drags into one write.
 *
 * A drag emits a cell update on every pointer release, and a rearrange is
 * several of those in a row. Writing each one races the others to the same
 * document and puts the slowest response last, which is how a layout ends up
 * showing an intermediate arrangement.
 */
export const createLayoutSaver = (options: LayoutSaverOptions): LayoutSaver => {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms) as unknown as number);
  const cancelTimer = options.cancel ?? ((handle: number) => clearTimeout(handle));

  let pending: DashboardSpec | null = null;
  let handle: number | null = null;

  const write = (): DashboardSpec | null => {
    const next = pending;
    pending = null;
    handle = null;
    if (!next) return null;

    void options.put(next).catch((error: unknown) => {
      /*
       * A failed layout save must say so. The widgets are still where the user
       * dragged them on screen, so staying silent means the next reload
       * quietly undoes the work and nothing ever explained why.
       */
      options.onError?.(
        error instanceof Error ? error.message : "Could not save this layout.",
      );
    });
    return next;
  };

  return {
    save: (dashboard, cells) => {
      pending = withLayoutCells(dashboard, cells);
      if (handle !== null) cancelTimer(handle);
      handle = schedule(write, delayMs);
    },
    flush: () => {
      if (handle !== null) cancelTimer(handle);
      return write();
    },
    cancel: () => {
      if (handle !== null) cancelTimer(handle);
      handle = null;
      pending = null;
    },
  };
};
