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
  return { cells: result.cells, dropped: result.dropped };
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
