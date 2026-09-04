import type { BuildAllResult } from "@freebirdai/dash-agent";
import type { DashboardSpec, FilterDecl, LayoutCell, WidgetSpec } from "@freebirdai/dash-spec";
import { groupSize, parseDashboard, parseWidget } from "@freebirdai/dash-spec";

/**
 * Writing a finished setup onto a board.
 *
 * One function rather than two because there are two doors into it — the REST
 * wizard and the chat's `confirm_setup` — and they must produce the same
 * board. They already shared `buildFromDraft`; what they did not share was
 * everything after it, which was fine while a setup produced exactly one
 * widget and nothing else. A setup that produces three widgets and a frame has
 * enough steps after the build for the two doors to drift.
 */

export interface CommitResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly next?: DashboardSpec;
  readonly widgets: readonly WidgetSpec[];
  readonly groupId?: string;
  readonly filtersAdded: readonly string[];
}

const failed = (error: string): CommitResult => ({ ok: false, error, widgets: [], filtersAdded: [] });

/** The first row nothing already occupies. */
const firstFreeRow = (board: DashboardSpec): number =>
  board.layout.cells.reduce((lowest, cell) => Math.max(lowest, cell.y + cell.h), 0);

export const commitSetup = (input: {
  readonly board: DashboardSpec;
  readonly built: BuildAllResult;
  /** Ids already on the board, so a group's id cannot collide. */
  readonly groupId?: string;
}): CommitResult => {
  const { board, built } = input;
  if (built.widgets.length === 0) {
    return failed(built.errors.join("; ") || "it did not validate");
  }

  /*
   * Re-parsed rather than trusted. Each was validated when the summary was
   * rendered, but this is the call that writes — the same rule `add_widget`
   * follows, for the same reason.
   */
  const widgets: WidgetSpec[] = [];
  for (const candidate of built.widgets) {
    const revalidated = parseWidget(candidate);
    if (!revalidated.ok || !revalidated.value) {
      return failed(revalidated.errors.join("; ") || "it no longer validates");
    }
    widgets.push(revalidated.value);
  }

  // A `{{param.x}}` the board has not declared is a parse error, so a widget
  // wanting a search box arrives with the filter that feeds it.
  const declared = new Set(board.params.filters.map((filter) => filter.key));
  const added: FilterDecl[] = built.requiresFilters.filter((filter) => !declared.has(filter.key));

  /*
   * A frame, when the setup asked for one and there is more than one widget to
   * put in it. `buildAll` already refuses to report a group of one, so this is
   * belt and braces against a shape the dashboard schema would reject anyway.
   */
  const wantsGroup = built.group !== undefined && widgets.length > 1;
  const groupId = input.groupId ?? `g-${Date.now().toString(36)}`;

  /*
   * Cells are written only for a group's members, because membership lives on
   * the cell. Everything else is left for the packer, which is what has always
   * placed a newly added widget and does it better than a fixed guess.
   */
  let cells: LayoutCell[] = [...board.layout.cells];
  if (wantsGroup) {
    const display = built.group!.display;
    const size = groupSize(
      widgets.map((widget) => widget.component),
      display,
      board.layout.gridCols,
    );
    const top = firstFreeRow(board);
    cells = [
      ...cells,
      ...widgets.map((widget, index) =>
        index === 0
          ? { widgetId: widget.id, x: 0, y: top, w: size.w, h: size.h, locked: true, group: groupId }
          : {
              /*
               * Parked. Never drawn from — only the anchor's rectangle is —
               * but it still has to be a legal cell, and it is what the widget
               * falls back to the day the frame is taken apart.
               */
              widgetId: widget.id,
              x: Math.min(index, board.layout.gridCols - 1),
              y: top + 1,
              w: Math.max(1, Math.min(size.w, board.layout.gridCols - index)),
              h: size.h,
              locked: true,
              group: groupId,
            },
      ),
    ];
  }

  const next = parseDashboard({
    ...board,
    params: { ...board.params, filters: [...board.params.filters, ...added] },
    widgets: [...board.widgets, ...widgets],
    ...(wantsGroup
      ? {
          groups: [
            ...board.groups,
            { id: groupId, title: built.group!.title, display: built.group!.display },
          ],
        }
      : {}),
    layout: { ...board.layout, cells },
  });
  if (!next.ok || !next.value) {
    return failed(next.errors.join("; ") || "the board did not validate");
  }

  return {
    ok: true,
    next: next.value,
    widgets,
    ...(wantsGroup ? { groupId } : {}),
    filtersAdded: added.map((filter) => filter.key),
  };
};
