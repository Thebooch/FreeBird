import type { ComponentId, LayoutCell } from "@freebirdai/dash-spec";
import { contractFor } from "@freebirdai/dash-spec";
import { useCallback, useMemo } from "react";
import { ResponsiveGridLayout, type Layout, type LayoutItem } from "react-grid-layout";
import { useMeasure } from "@freebirdai/dash-components";
import { LazyWidget } from "./LazyWidget.jsx";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary.jsx";
import { WidgetShell } from "./WidgetShell.jsx";
import { useDashboard } from "./context.jsx";
import { completeLayout } from "./layout.js";

const ROW_HEIGHT = 34;
const MARGIN: readonly [number, number] = [12, 12];

/**
 * Breakpoints, and why the smallest is a single column.
 *
 * A twelve-column arrangement squeezed onto a phone is not a layout, it is a
 * queue of illegible slivers. Below the tablet width every widget takes the
 * full width and the saved positions are deliberately ignored.
 */
const BREAKPOINTS = { lg: 1200, md: 900, sm: 640, xs: 0 } as const;
const COLS = { lg: 12, md: 12, sm: 6, xs: 1 } as const;

/**
 * The 12-column grid.
 *
 * Placement for anything the saved layout does not mention comes from the
 * deterministic packer, which reads each component's contract and picks a size
 * variant that suits it. The grid library has no notion of that, so the two
 * split the work: the packer decides where a *new* widget lands, and the grid
 * owns dragging, resizing and compaction from then on.
 */
export const DashboardGrid = ({
  onLayoutChange,
  heroWidgetId,
  onRemoveWidget,
  onCustomiseWidget,
  onOpenRecordPage,
  editing,
}: {
  onLayoutChange?: (cells: LayoutCell[]) => void;
  heroWidgetId?: string;
  onRemoveWidget?: (widgetId: string) => void;
  onCustomiseWidget?: (widgetId: string) => void;
  onOpenRecordPage?: (widgetId: string, row: Record<string, unknown>) => void;
  /** Drag and resize are off unless the board is in edit mode. */
  editing?: boolean;
}): JSX.Element => {
  const { dashboard } = useDashboard();
  /*
   * Our own measurement rather than the library's `useContainerWidth`.
   *
   * That hook returns a React 19 style `RefObject<T | null>`, which does not
   * fit a React 18 `ref` prop, and this package is pinned to 18. `useMeasure`
   * is the same ResizeObserver by another name and already ships here.
   */
  const [containerRef, size] = useMeasure<HTMLDivElement>();
  const width = size.width;

  /*
   * Cells are derived from the dashboard on every render rather than held in
   * state. Holding them meant they were computed once at mount and went stale
   * the moment the widget set changed — swapping dashboards or adding a widget
   * left a grid full of ids that no longer existed, and nothing rendered.
   */
  const cells = useMemo(() => {
    const requests = dashboard.widgets.map((widget) => ({
      widgetId: widget.id,
      component: widget.component,
    }));
    const live = new Set(requests.map((request) => request.widgetId));
    const saved = dashboard.layout.cells.filter((cell) => live.has(cell.widgetId));
    return completeLayout(requests, saved, dashboard.layout.gridCols);
  }, [dashboard]);

  /**
   * A remount key for the grid.
   *
   * The library seeds its layout into internal state and only re-reads the
   * prop by comparing it against its own *compacted* copy, so a layout handed
   * in after mount does not reliably take effect — tidying the board wrote the
   * new positions and left the old ones on screen.
   *
   * Keying on the arrangement forces a fresh seed exactly when the
   * arrangement changes for a reason other than dragging. A drag updates the
   * library's own state and does not touch the spec, so this stays stable
   * through one and the interaction is never interrupted. The remount is
   * cheap: the query cache lives above this component, so the widgets redraw
   * from memory rather than re-fetching.
   */
  const seedKey = useMemo(
    () => cells.map((cell) => `${cell.widgetId}:${cell.x},${cell.y},${cell.w},${cell.h}`).join("|"),
    [cells],
  );

  const items = useMemo<LayoutItem[]>(() => {
    const componentOf = new Map(dashboard.widgets.map((widget) => [widget.id, widget.component]));
    return cells.map((cell) => ({
      i: cell.widgetId,
      x: cell.x,
      y: cell.y,
      w: cell.w,
      h: cell.h,
      ...sizeBounds(componentOf.get(cell.widgetId)),
    }));
  }, [cells, dashboard.widgets]);

  /**
   * Turn a finished drag into saved cells.
   *
   * Reachable only from `onDragStop` and `onResizeStop`. The grid also emits a
   * layout on mount and after every automatic reflow, and writing those back
   * is how a board develops the habit of rearranging itself on reload — so
   * those callbacks are deliberately not wired to anything.
   */
  const persist = useCallback(
    (layout: Layout) => {
      if (!onLayoutChange) return;
      onLayoutChange(
        layout.map((item) => ({
          widgetId: item.i,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          // Everything on the board is a position somebody can see and move,
          // so there is no longer a meaningful unlocked cell.
          locked: true,
        })),
      );
    },
    [onLayoutChange],
  );

  return (
    <div
      className="dash-grid-host"
      ref={containerRef}
      data-editing={editing ? "true" : "false"}
      /*
       * The arrangement this component believes in, as text.
       *
       * The grid renders through transforms, so "what did the component
       * decide" and "what did the library draw" are different questions and
       * only the second is visible in the DOM. Keeping the first one readable
       * is what turned a layout bug from guesswork into one measurement.
       */
      data-layout={cells.map((cell) => `${cell.widgetId}:${cell.x},${cell.y}`).join(" ")}
    >
      {width > 0 && (
        <ResponsiveGridLayout
          key={seedKey}
          className="dash-grid"
          width={width}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={ROW_HEIGHT}
          margin={MARGIN}
          containerPadding={[0, 0]}
          layouts={{ lg: items, md: items, sm: items, xs: items }}
          dragConfig={{ enabled: editing === true, bounded: false }}
          resizeConfig={{ enabled: editing === true, handles: ["se"] }}
          /*
           * Only a finished drag or resize is saved. `onLayoutChange` also
           * fires on mount and on every compaction, and persisting those is
           * exactly the "widgets keep moving on reload" bug.
           */
          onDragStop={(layout: Layout) => persist(layout)}
          onResizeStop={(layout: Layout) => persist(layout)}
        >
          {dashboard.widgets.map((widget) => {
            const cell = cells.find((entry) => entry.widgetId === widget.id);
            const rows = cell?.h ?? 6;
            return (
              <div className="dash-grid__cell" key={widget.id} data-widget-id={widget.id}>
                {/*
                 * Two wrappers, each with one job: hold the space until the
                 * tile is worth fetching, and keep a render crash inside this
                 * cell rather than letting it take the board down.
                 */}
                <LazyWidget minHeight={rows * ROW_HEIGHT + (rows - 1) * MARGIN[1]}>
                  <WidgetErrorBoundary widgetTitle={widget.title}>
                    <WidgetShell
                      widget={widget}
                      hero={widget.id === heroWidgetId}
                      {...(onRemoveWidget ? { onRemove: onRemoveWidget } : {})}
                      {...(onCustomiseWidget ? { onCustomise: onCustomiseWidget } : {})}
                      {...(onOpenRecordPage ? { onOpenPage: onOpenRecordPage } : {})}
                    />
                  </WidgetErrorBoundary>
                </LazyWidget>

                {/*
                 * A transparent sheet over the whole tile while editing.
                 *
                 * Without it a mousedown meant as the start of a drag lands on
                 * whatever is underneath — a sort header, a row that opens a
                 * record, a link — so rearranging the board keeps triggering
                 * the things on it.
                 */}
                {editing && <div className="dash-edit-guard" aria-hidden="true" />}
              </div>
            );
          })}
        </ResponsiveGridLayout>
      )}
    </div>
  );
};

/**
 * The size range a component is willing to be drawn at.
 *
 * The floor comes from its contract's smallest declared variant, so a table
 * cannot be crushed to three columns where its own contract says six. The
 * ceiling is the grid rather than the largest variant: the variants are
 * recommendations for automatic placement, and wanting a widget wider than any
 * of them is a reasonable thing to want.
 */
const sizeBounds = (
  component: ComponentId | undefined,
): { minW: number; minH: number; maxW: number; maxH: number } => {
  const sizes = component ? contractFor(component)?.grid.sizes : undefined;
  if (!sizes || sizes.length === 0) return { minW: 1, minH: 2, maxW: 12, maxH: 24 };
  return {
    minW: Math.min(...sizes.map((size) => size.w)),
    minH: Math.min(...sizes.map((size) => size.h)),
    maxW: 12,
    maxH: 24,
  };
};
