import type { DashboardSpec, WidgetSpec } from "@freebirdai/dash-spec";

/**
 * One name for every widget in the workspace.
 *
 * The assistant addresses widgets by a single id: it is the component id in
 * the registry, the thing `[[cite:...]]` names, and the argument the view
 * actions take. Widget ids are only unique **within** a board — `addWidget`
 * de-duplicates against the board it is adding to and nothing else — so two
 * tabs can legitimately both hold a `leases-by-status`. Registering the
 * workspace therefore needs a name that survives that.
 *
 * The rule is "plain unless it has to be qualified", so the overwhelmingly
 * common case reads as the widget's own id and a collision is the only thing
 * that costs anything. Qualification uses `--` rather than `__` (the action
 * tool encoder's separator) or `:`/`.` (which `CITE_MARKER_RE` rejects, so a
 * citation carrying one would be silently dropped).
 */

export const HANDLE_SEPARATOR = "--";

export interface WidgetHandle {
  /** Registry component id, citation id, and what the view actions take. */
  readonly handle: string;
  readonly widgetId: string;
  readonly dashboardId: string;
  readonly dashboardTitle: string;
  readonly widget: WidgetSpec;
  /** True for the board the conversation is currently about. */
  readonly current: boolean;
}

/** Where a citation for this widget points. Matches `apps/web`'s hash routes. */
export const pageFor = (dashboardId: string): string =>
  `#/d/${encodeURIComponent(dashboardId)}`;

/** The DOM hook `DashboardGrid` already puts on every cell. */
export const selectorFor = (widgetId: string): string =>
  `[data-widget-id="${widgetId}"]`;

export const workspaceHandles = (
  dashboards: readonly DashboardSpec[],
  currentDashboardId: string | null,
): WidgetHandle[] => {
  const seenIds = new Map<string, number>();
  for (const board of dashboards) {
    for (const widget of board.widgets) {
      seenIds.set(widget.id, (seenIds.get(widget.id) ?? 0) + 1);
    }
  }

  const taken = new Set<string>();
  const out: WidgetHandle[] = [];
  for (const board of dashboards) {
    for (const widget of board.widgets) {
      const plain = (seenIds.get(widget.id) ?? 0) === 1;
      let handle = plain ? widget.id : `${widget.id}${HANDLE_SEPARATOR}${board.id}`;
      /*
       * A widget genuinely called `x--somebooard` could still collide with a
       * qualified name. Step aside the way the roster id does rather than
       * throw: `register` rejects duplicates, and one unlucky title must not
       * be able to take the whole chat down.
       */
      for (let n = 2; taken.has(handle); n++) {
        handle = `${widget.id}${HANDLE_SEPARATOR}${board.id}-${n}`;
      }
      taken.add(handle);
      out.push({
        handle,
        widgetId: widget.id,
        dashboardId: board.id,
        dashboardTitle: board.title,
        widget,
        current: board.id === currentDashboardId,
      });
    }
  }
  return out;
};

/** Look one up by handle, or by bare widget id when that is unambiguous. */
export const resolveHandle = (
  handles: readonly WidgetHandle[],
  wanted: string,
): WidgetHandle | null => {
  const exact = handles.find((entry) => entry.handle === wanted);
  if (exact) return exact;
  /*
   * A model that answers with the bare widget id where the workspace needed a
   * qualified one has named the right thing at the wrong level — the same
   * situation `pickEndpoints` handles by resolving a group that holds exactly
   * one endpoint. Resolve it when it is unambiguous, refuse when it is not.
   */
  const byWidgetId = handles.filter((entry) => entry.widgetId === wanted);
  return byWidgetId.length === 1 ? byWidgetId[0]! : null;
};
