import type { FieldGroup, WidgetSpec } from "@freebirdai/dash-spec";

/**
 * Turning a drill-down into ordinary widgets.
 *
 * Pure and separate from the component, because what matters here is which
 * spec gets built — the connection it inherits, the recursion it must not
 * carry, the id it is namespaced under — and none of that needs a DOM to
 * check.
 */

/** One pane of a record view: the record, or a collection belonging to it. */
export interface DetailPane {
  readonly id: string;
  readonly title: string;
  readonly spec: WidgetSpec;
  /** Present when rows in this pane open something of their own. */
  readonly opens?: WidgetSpec;
  /**
   * Whether this pane wants to be a tab where there is room for tabs.
   *
   * The record pane is never a tab — it is the thing the tabs belong to.
   */
  readonly tab?: boolean;
  /** Field sections, on the record pane only. */
  readonly groups?: readonly FieldGroup[];
}

/**
 * The record a row opens, plus any collections belonging to it.
 *
 * Every pane is an ordinary `WidgetSpec`, so the existing compile → run →
 * validate path renders it with no knowledge that it came from a drill-down.
 * If a pane needs anything `useWidgetData` cannot already do, the design is
 * wrong rather than the plumbing incomplete.
 */
export const detailPanes = (parent: WidgetSpec): DetailPane[] => {
  const detail = parent.drilldown;
  if (!detail || !parent.source) return [];

  const connection = parent.source.connection;

  /** Shared skeleton. `drilldown` is cleared so nothing recurses. */
  const paneSpec = (
    id: string,
    title: string,
    part: {
      op: string;
      params: Readonly<Record<string, string>>;
      component: string;
      pipeline: WidgetSpec["pipeline"];
      roles: WidgetSpec["roles"];
      format?: WidgetSpec["format"];
    },
  ): WidgetSpec => ({
    ...parent,
    id,
    title,
    component: part.component,
    source: { connection, op: part.op, params: part.params },
    pipeline: part.pipeline,
    roles: part.roles,
    format: part.format ?? parent.format,
    // A pane must never carry the parent's drill-down: it would re-open the
    // record you are already looking at, from inside itself.
    drilldown: undefined,
    sources: [],
  });

  const panes: DetailPane[] = [
    {
      id: "record",
      title: detail.title ?? parent.title,
      spec: paneSpec(`${parent.id}__detail`, detail.title ?? parent.title, detail),
      ...(detail.groups.length > 0 ? { groups: detail.groups } : {}),
    },
  ];

  /*
   * The identity block, when the drill-down declares one.
   *
   * Built as an ordinary widget over the *same* endpoint as the record, so it
   * costs no extra request — the query cache serves both from one fetch.
   */
  if (detail.header) {
    panes.push({
      id: "header",
      title: detail.title ?? parent.title,
      spec: paneSpec(`${parent.id}__header`, detail.title ?? parent.title, {
        op: detail.op,
        params: detail.params,
        component: "recordHeader",
        pipeline: detail.pipeline,
        roles: {
          ...(detail.header.title ? { title: detail.header.title } : {}),
          ...(detail.header.subtitle ? { subtitle: detail.header.subtitle } : {}),
          ...(detail.header.status ? { status: detail.header.status } : {}),
          ...(detail.header.facts.length > 0 ? { facts: [...detail.header.facts] } : {}),
        },
      }),
    });
  }

  for (const related of detail.related) {
    panes.push({
      id: related.id,
      title: related.title,
      spec: paneSpec(`${parent.id}__rel__${related.id}`, related.title, related),
      tab: related.display === "tab",
      ...(related.opensRecord
        ? {
            opens: paneSpec(
              `${parent.id}__rel__${related.id}__record`,
              related.title,
              related.opensRecord,
            ),
          }
        : {}),
    });
  }

  return panes;
};

/** The identity block, if the drill-down asked for one. */
export const headerPane = (panes: readonly DetailPane[]): DetailPane | undefined =>
  panes.find((pane) => pane.id === "header");

/** The record itself. */
export const recordPane = (panes: readonly DetailPane[]): DetailPane | undefined =>
  panes.find((pane) => pane.id === "record");

/**
 * The collections belonging to the record.
 *
 * `wide` decides how much a pane's own request is honoured. On the page, a
 * pane that asked to be a tab is one and the rest stack beneath it.
 *
 * The drawer used to stack everything, on the reasoning that a 560px sheet
 * puts tab labels on two lines. That was true of a 560px sheet. It is now
 * wider and the tab strip scrolls horizontally, so the real constraint is
 * different: **tabs are worth their cost only when there are at least two of
 * them.** A one-tab strip is a heading wearing a control's clothes, and it
 * hides nothing — so a lone collection stacks on either surface.
 */
export const relatedPanes = (
  panes: readonly DetailPane[],
  wide: boolean,
): { tabs: DetailPane[]; sections: DetailPane[] } => {
  const rest = panes.filter((pane) => pane.id !== "record" && pane.id !== "header");
  const wanted = rest.filter((pane) => pane.tab === true);
  if (!wide && wanted.length < 2) return { tabs: [], sections: rest };
  return {
    tabs: wanted,
    sections: rest.filter((pane) => pane.tab !== true),
  };
};

/** One step of the sheet's navigation history. */
export interface TrailEntry {
  readonly title: string;
  readonly panes: readonly DetailPane[];
  readonly row: Readonly<Record<string, unknown>>;
}

/**
 * Going deeper, and coming back.
 *
 * One sheet with a trail rather than a stack of sheets: two dialogs means two
 * focus traps and two Escape handlers racing each other, which is an
 * accessibility defect that is fiddly to unpick. A breadcrumb gives the same
 * navigation for less machinery.
 */
export const pushTrail = (trail: readonly TrailEntry[], entry: TrailEntry): TrailEntry[] => [
  ...trail,
  entry,
];

/** Back one step. At the root there is nowhere to go, which the caller reads as "close". */
export const popTrail = (trail: readonly TrailEntry[]): TrailEntry[] | null =>
  trail.length <= 1 ? null : trail.slice(0, -1);

/** Jump straight back to a breadcrumb the user clicked. */
export const truncateTrail = (trail: readonly TrailEntry[], index: number): TrailEntry[] =>
  trail.slice(0, Math.max(1, Math.min(index + 1, trail.length)));
