import { solveLayout } from "@freebirdai/dash-react";
import type { DashboardSpec, LayoutCell } from "@freebirdai/dash-spec";

/**
 * The bits of edit mode worth testing without a browser.
 *
 * In a `.ts` file rather than beside the component because vitest only
 * collects `.test.ts` under `apps/`, so anything reachable only from a `.tsx`
 * goes uncovered by construction.
 */

/**
 * Whether a keystroke belongs to something the user is typing into.
 *
 * Single-letter shortcuts are a good idea right up until someone types "e" in
 * the search box and the board starts wobbling. Anything editable — an input,
 * a textarea, a select, a contenteditable, or any element that has claimed a
 * text-entry role — keeps its own keys.
 */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  /*
   * Duck-typed rather than `instanceof HTMLElement`.
   *
   * `instanceof` is per-realm, so an element inside an embedded frame fails
   * the check against the parent's constructor and its keystrokes would leak
   * out as shortcuts. Reading the properties works regardless of where the
   * element came from — and lets this be tested without a DOM.
   */
  const element = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (name: string) => string | null;
  } | null;
  if (!element || typeof element.tagName !== "string") return false;
  if (element.isContentEditable === true) return true;

  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;

  const role = typeof element.getAttribute === "function" ? element.getAttribute("role") : null;
  return role === "textbox" || role === "searchbox" || role === "combobox";
};

export interface ArrangeResult {
  readonly cells: LayoutCell[];
  /** Widgets the packer could not place, and why. */
  readonly dropped: ReadonlyArray<{ widgetId: string; reason: string }>;
}

/**
 * Re-pack the whole board from scratch.
 *
 * Deliberately ignores every saved position — that is the point of the button.
 * The packer reads each component's contract, so a stat lands small and a
 * table lands wide rather than everything being squared off to one size.
 */
export const autoArrange = (dashboard: DashboardSpec): ArrangeResult => {
  const result = solveLayout(
    dashboard.widgets.map((widget) => ({
      widgetId: widget.id,
      component: widget.component,
    })),
    { gridCols: dashboard.layout.gridCols },
  );

  /*
   * Which frame each widget belongs to, carried across the repack.
   *
   * The packer is told a widget id and a component and nothing else, so every
   * cell it returns has forgotten its group — and a group whose members have
   * all forgotten it has no members, which `dashboardSchema` refuses outright.
   * The whole board then failed to save, on a button whose entire promise is
   * that it only moves things. Positions are the packer's to decide; group
   * membership is not its business and is restored here.
   */
  const groups = new Map(
    dashboard.layout.cells
      .filter((cell) => cell.group !== undefined)
      .map((cell) => [cell.widgetId, cell.group!] as const),
  );

  return {
    cells: result.cells.map((cell) => {
      const group = groups.get(cell.widgetId);
      return group ? { ...cell, group } : cell;
    }),
    dropped: result.dropped,
  };
};

/**
 * Where a newly added widget should go.
 *
 * The bottom-left, always. Dropping a widget into the first gap it fits pushes
 * the existing arrangement around, and someone who has just spent time laying
 * a board out will not thank you for rearranging it as a side effect of adding
 * one more thing.
 */
export const nextRow = (cells: readonly LayoutCell[]): number =>
  cells.reduce((lowest, cell) => Math.max(lowest, cell.y + cell.h), 0);

/* ── frames ───────────────────────────────────────────────────────────────
 *
 * Widgets shown together, changed by hand.
 *
 * Grouping was something only a setup could decide: two widgets built in one
 * breath arrived in a frame, and from then on it was permanent — no way to
 * take one out, add a third, or change how they sat. The schema has always
 * supported all three; nothing offered them.
 *
 * Membership lives on the layout *cell* rather than on the widget, which is
 * the rule these follow: two things somebody wants side by side are still two
 * widgets, with two datasets and two refresh clocks. Being seen together is a
 * fact about the board.
 */

/** Frames drop below two members are dissolved, never left holding one. */
const withLiveGroups = <T extends DashboardSpec>(dashboard: T, cells: LayoutCell[]): T => {
  const surviving = new Set(
    dashboard.groups
      .map((group) => group.id)
      .filter((id) => cells.filter((cell) => cell.group === id).length >= 2),
  );
  return {
    ...dashboard,
    groups: dashboard.groups.filter((group) => surviving.has(group.id)),
    layout: {
      ...dashboard.layout,
      cells: cells.map((cell) =>
        cell.group && !surviving.has(cell.group) ? { ...cell, group: undefined } : cell,
      ),
    },
  };
};

/**
 * Put these widgets in one frame.
 *
 * Any of them already in another frame leaves it, because a widget is drawn
 * once and cannot be in two. A frame of fewer than two is not created at all:
 * the schema refuses one, and a single tile wearing a second title bar reads
 * like the other half failed to load.
 */
export const groupWidgets = <T extends DashboardSpec>(
  dashboard: T,
  widgetIds: readonly string[],
  options: { title: string; display?: "tabs" | "row" | "stack" },
): T => {
  const members = new Set(
    widgetIds.filter((id) => dashboard.layout.cells.some((cell) => cell.widgetId === id)),
  );
  if (members.size < 2) return dashboard;

  /*
   * An id nothing on this board already answers to.
   *
   * The clock alone is not enough: two frames made in the same millisecond get
   * the same id, and then one group record shadows the other while both sets
   * of cells point at it. Rare by hand and immediate under test, which is how
   * it was found.
   */
  const taken = new Set(dashboard.groups.map((group) => group.id));
  const base = `g-${Date.now().toString(36)}`;
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  const cells = dashboard.layout.cells.map((cell) =>
    members.has(cell.widgetId) ? { ...cell, group: id } : cell,
  );

  return withLiveGroups(
    {
      ...dashboard,
      groups: [
        ...dashboard.groups,
        { id, title: options.title.slice(0, 120), display: options.display ?? "tabs" },
      ],
    } as T,
    cells,
  );
};

/** Take one widget out of its frame, dissolving the frame if one is left. */
export const ungroupWidget = <T extends DashboardSpec>(dashboard: T, widgetId: string): T =>
  withLiveGroups(
    dashboard,
    dashboard.layout.cells.map((cell) =>
      cell.widgetId === widgetId ? { ...cell, group: undefined } : cell,
    ),
  );

/** How a frame arranges its members: behind tabs, in a row, or stacked. */
export const setGroupDisplay = <T extends DashboardSpec>(
  dashboard: T,
  groupId: string,
  display: "tabs" | "row" | "stack",
): T => ({
  ...dashboard,
  groups: dashboard.groups.map((group) => (group.id === groupId ? { ...group, display } : group)),
});

/** The frame a widget is in, if any. */
export const groupOf = (
  dashboard: DashboardSpec,
  widgetId: string,
): DashboardSpec["groups"][number] | null => {
  const id = dashboard.layout.cells.find((cell) => cell.widgetId === widgetId)?.group;
  return dashboard.groups.find((group) => group.id === id) ?? null;
};
