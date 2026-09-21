import type { EntityLinkView, WidgetSpec } from "@freebirdai/dash-spec";
import { widgetSources } from "@freebirdai/dash-spec";

/**
 * Where clicking a row goes.
 *
 * Two record pages exist and only one of them is any good. The shared one is
 * built from the record type: it names the record, groups its fields, and
 * carries the collections that point *at* it — a vendor's work orders, bills
 * and notes. The private one is a layout a model wrote into a single widget at
 * confirm time, frozen the day it was written.
 *
 * Every row click went to the private one, and `settleDetail` deliberately
 * stops planning it for any widget that names a record type — on the correct
 * reasoning that such a widget "already has a record page, and it is the
 * shared one". Nothing ever routed there, so the better page was reachable
 * only by clicking a reference *cell*, and the row itself opened a sheet that
 * was empty by design. This is the missing wire, not a new idea.
 *
 * Kept out of the component file because vitest collects no `.tsx` under
 * `apps/` — the same reason `editing.ts` and `pendingMessage.ts` are here.
 */

/**
 * The record type a widget's rows are, by the same rule the renderer uses.
 *
 * `widget.entity` when it says so; otherwise the endpoint it reads, which is
 * what every widget saved before record types existed has to be matched on.
 */
export const viewForWidget = (
  widget: WidgetSpec,
  links: Readonly<Record<string, readonly EntityLinkView[]>> | undefined,
): EntityLinkView | undefined => {
  const primary = widgetSources(widget)[0];
  if (!primary || !links) return undefined;
  const forConnection = links[primary.connection] ?? [];
  return widget.entity
    ? forConnection.find((view) => view.entity === widget.entity)
    : forConnection.find((view) => view.ops.includes(primary.op));
};

export type RecordTarget =
  /** The record type's own page, shared by every route into that record. */
  | {
      readonly kind: "entity";
      readonly connection: string;
      readonly entity: string;
      readonly id: string;
    }
  /** This widget's own sheet, for rows that are not a describable record. */
  | { readonly kind: "widget"; readonly id: string };

/**
 * What a click on this row should open.
 *
 * The shared page wins wherever the row can be resolved to a record — which
 * needs two things the widget cannot assume: a record type that says which
 * field holds its identity, and a row that actually carries a value there. A
 * grouped row carries neither, which is correct: a monthly count is not a
 * record and has no page.
 *
 * Falls back to the widget's own sheet rather than to nothing. A widget over
 * an endpoint nobody has described still has whatever layout was planned for
 * it, and losing that to gain consistency would be a plain regression.
 */
export const recordTargetFor = (
  widget: WidgetSpec,
  row: Readonly<Record<string, unknown>>,
  links: Readonly<Record<string, readonly EntityLinkView[]>> | undefined,
): RecordTarget | null => {
  const view = viewForWidget(widget, links);
  const identity = view?.identity;
  const value = identity ? row[identity] : undefined;
  const primary = widgetSources(widget)[0];

  if (view && primary && value !== undefined && value !== null && value !== "") {
    return {
      kind: "entity",
      connection: primary.connection,
      entity: view.entity,
      id: String(value),
    };
  }

  /*
   * The widget's own sheet reads its id out of the drill-down's parameters, so
   * a widget without one has no way to open a row at all.
   */
  if (!widget.drilldown) return null;
  const field = Object.values(widget.drilldown.params)
    .flatMap((param) => [...param.matchAll(/\{\{\s*row\.([^}\s|]+)/g)])
    .map((match) => match[1])
    .find((name): name is string => Boolean(name));
  const own = field ? row[field] : undefined;
  return own === undefined || own === null ? null : { kind: "widget", id: String(own) };
};
