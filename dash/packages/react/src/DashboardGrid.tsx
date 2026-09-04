import type {
  ComponentId,
  LayoutCell,
  WidgetGroup as GroupSpec,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import { contractFor } from "@freebirdai/dash-spec";
import { useCallback, useMemo } from "react";
import { ResponsiveGridLayout, type Layout, type LayoutItem } from "react-grid-layout";
import { useMeasure } from "@freebirdai/dash-components";
import { LazyWidget } from "./LazyWidget.jsx";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary.jsx";
import { WidgetGroup } from "./WidgetGroup.jsx";
import { WidgetShell } from "./WidgetShell.jsx";
import { useDashboard } from "./context.jsx";
import { completeLayout, persistCells } from "./layout.js";

/**
 * One thing the grid places: a widget on its own, or a group of them.
 *
 * The library matches children to layout items by key, so a group has to be a
 * single child with a single key or it cannot be one rectangle. Everything
 * below iterates units rather than widgets for that reason — and a lone widget
 * is simply a unit of one, so there is no second code path.
 */
type GridUnit =
  | { readonly kind: "widget"; readonly key: string; readonly widget: WidgetSpec }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly group: GroupSpec;
      readonly members: readonly WidgetSpec[];
    };

/** The layout key a widget is placed under — its group's, when it has one. */
const unitKeyFor = (widgetId: string, group: string | undefined): string =>
  group ? `group:${group}` : widgetId;

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
  const { placed, parked } = useMemo(() => {
    const widgetById = new Map(dashboard.widgets.map((widget) => [widget.id, widget]));
    const live = new Set(widgetById.keys());
    const saved = dashboard.layout.cells.filter((cell) => live.has(cell.widgetId));

    const membersByGroup = new Map<string, LayoutCell[]>();
    for (const cell of saved) {
      if (!cell.group) continue;
      const list = membersByGroup.get(cell.group);
      if (list) list.push(cell);
      else membersByGroup.set(cell.group, [cell]);
    }
    for (const list of membersByGroup.values()) list.sort((a, b) => a.y - b.y || a.x - b.x);

    /*
     * A group needs two live members to still be one.
     *
     * Deleting a widget out of a pair leaves a declared group with one member,
     * and a frame around a single widget is a card wearing a second title bar
     * — it reads as the other half having failed to load. The survivor goes
     * back to being an ordinary tile instead, which is what somebody deleting
     * the other one meant to happen.
     */
    const groups = dashboard.groups.filter(
      (group) => (membersByGroup.get(group.id)?.length ?? 0) >= 2,
    );
    const kept = new Set(groups.map((group) => group.id));
    const groupOf = (widgetId: string): string | undefined => {
      const id = saved.find((cell) => cell.widgetId === widgetId)?.group;
      return id && kept.has(id) ? id : undefined;
    };

    const anchors = new Set(
      groups.map((group) => membersByGroup.get(group.id)![0]!.widgetId),
    );

    /*
     * Only units are placed, and that is what keeps a group from leaving a
     * hole. The packer reserves space per rectangle it is given, so handing it
     * every member of a group would have it set aside room for tiles nobody
     * draws — pushing everything below the group down by the height of its
     * hidden members.
     *
     * The rest are parked: their cells survive untouched so dissolving a group
     * restores positions that were never lost, and they are never placed.
     */
    const placeable = dashboard.widgets.filter(
      (widget) => !groupOf(widget.id) || anchors.has(widget.id),
    );
    const placeableIds = new Set(placeable.map((widget) => widget.id));
    const cells = completeLayout(
      placeable.map((widget) => ({ widgetId: widget.id, component: widget.component })),
      saved.filter((cell) => placeableIds.has(cell.widgetId)),
      dashboard.layout.gridCols,
    );

    const units = cells.map((cell) => {
      const groupId = groupOf(cell.widgetId);
      const group = groupId ? groups.find((entry) => entry.id === groupId) : undefined;
      const unit: GridUnit = group
        ? {
            kind: "group",
            key: unitKeyFor(cell.widgetId, group.id),
            group,
            members: (membersByGroup.get(group.id) ?? [])
              .map((member) => widgetById.get(member.widgetId))
              .filter((widget): widget is WidgetSpec => widget !== undefined),
          }
        : {
            kind: "widget",
            key: cell.widgetId,
            widget: widgetById.get(cell.widgetId)!,
          };
      return { cell, unit };
    });

    return {
      placed: units,
      parked: saved.filter((cell) => !placeableIds.has(cell.widgetId)),
    };
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
    () =>
      placed
        .map(({ cell, unit }) => `${unit.key}:${cell.x},${cell.y},${cell.w},${cell.h}`)
        .join("|"),
    [placed],
  );

  const items = useMemo<LayoutItem[]>(
    () =>
      placed.map(({ cell, unit }) => ({
        i: unit.key,
        x: cell.x,
        y: cell.y,
        w: cell.w,
        h: cell.h,
        ...unitBounds(unit),
      })),
    [placed],
  );

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
        persistCells(
          placed.map(({ cell, unit }) => ({ cell, key: unit.key })),
          parked,
          layout,
        ),
      );
    },
    [onLayoutChange, placed, parked],
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
      data-layout={placed.map(({ cell, unit }) => `${unit.key}:${cell.x},${cell.y}`).join(" ")}
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
          {placed.map(({ cell, unit }) => {
            const rows = cell.h;
            return (
              <div
                className="dash-grid__cell"
                key={unit.key}
                {...(unit.kind === "widget"
                  ? { "data-widget-id": unit.widget.id }
                  : { "data-group-id": unit.group.id })}
              >
                {/*
                 * Two wrappers, each with one job: hold the space until the
                 * tile is worth fetching, and keep a render crash inside this
                 * cell rather than letting it take the board down.
                 */}
                <LazyWidget minHeight={rows * ROW_HEIGHT + (rows - 1) * MARGIN[1]}>
                  {unit.kind === "group" ? (
                    <WidgetGroup
                      group={unit.group}
                      members={unit.members}
                      {...(onRemoveWidget ? { onRemoveWidget } : {})}
                      {...(onCustomiseWidget ? { onCustomiseWidget } : {})}
                      {...(onOpenRecordPage ? { onOpenRecordPage } : {})}
                    />
                  ) : (
                    <WidgetErrorBoundary widgetTitle={unit.widget.title}>
                      <WidgetShell
                        widget={unit.widget}
                        hero={unit.widget.id === heroWidgetId}
                        {...(onRemoveWidget ? { onRemove: onRemoveWidget } : {})}
                        {...(onCustomiseWidget ? { onCustomise: onCustomiseWidget } : {})}
                        {...(onOpenRecordPage ? { onOpenPage: onOpenRecordPage } : {})}
                      />
                    </WidgetErrorBoundary>
                  )}
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

/** Rows the group's own title and tab strip take before any member is drawn. */
const GROUP_CHROME_ROWS = 2;

/**
 * What a unit may be shrunk to.
 *
 * A group has no contract of its own — it is a frame, not a component — so its
 * floor is the largest floor among its members plus its own chrome. Taking the
 * smallest instead would let a frame be crushed to the size its least
 * demanding member tolerates, and the others would render inside it at a width
 * their own contracts already refuse.
 */
const unitBounds = (
  unit: GridUnit,
): { minW: number; minH: number; maxW: number; maxH: number } => {
  if (unit.kind === "widget") return sizeBounds(unit.widget.component);

  const bounds = unit.members.map((member) => sizeBounds(member.component));
  return {
    minW: Math.max(1, ...bounds.map((bound) => bound.minW)),
    minH: Math.max(2, ...bounds.map((bound) => bound.minH)) + GROUP_CHROME_ROWS,
    maxW: 12,
    maxH: 24,
  };
};
