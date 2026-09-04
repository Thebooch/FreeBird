import type { Presentation, WidgetGroup as GroupSpec, WidgetSpec } from "@freebirdai/dash-spec";
import { Tabs, useMeasure } from "@freebirdai/dash-components";
import { useState } from "react";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary.jsx";
import { WidgetShell } from "./WidgetShell.jsx";

/**
 * Several widgets drawn inside one frame.
 *
 * The frame is the whole of what a group is. Its members are ordinary
 * `WidgetSpec`s rendered through the ordinary `WidgetShell`, so each keeps its
 * own dataset, its own query cache entry, its own refresh clock and its own
 * stale badge — nothing here knows what any of them contain, and nothing about
 * being grouped changes how one is fetched or validated.
 *
 * That is the reason composition landed in the layout rather than in the
 * widget schema. A `panes` array on a widget would have made this a data
 * concern, and every role contract, every binding check and the whole runtime
 * would have had to learn what a sub-widget was to draw an arrangement.
 *
 * The record sheet has done exactly this for a while — `RecordView` renders a
 * `Tabs` strip over N synthesised specs — so the pattern is not new, only newly
 * available on the board.
 */

/** Below this much room per member, a row is slivers rather than columns. */
const MIN_ROW_MEMBER_PX = 260;

export type Arrangement = "tabs" | "row" | "stack";

/**
 * What the frame can actually do, as opposed to what it asked for.
 *
 * `display` is a preference: only the renderer knows how much room there is,
 * and three tables side by side in 300 pixels is not a row, it is three
 * columns of ellipsis. Mirrors the arbitration `relatedPanes` makes for a
 * record sheet rather than inventing a second rule — a narrow surface stacks.
 *
 * Tabs need no room at all, so they are never downgraded. A width of zero
 * means nothing has been measured yet, which must not be read as "narrow" —
 * that would flash a stack on first paint before settling into a row.
 */
export const arrangementFor = (
  display: Arrangement,
  memberCount: number,
  width: number,
): Arrangement => {
  if (display !== "row") return display;
  if (width === 0) return "row";
  return width >= MIN_ROW_MEMBER_PX * memberCount ? "row" : "stack";
};

/**
 * A member's own chrome, quieted so the group reads as one thing.
 *
 * Done by merging presentation rather than by adding a prop to `WidgetShell`,
 * because the shell already resolves exactly these settings from the spec —
 * a `frameless` prop would be a second way to say something the presentation
 * system already says, and the two would drift.
 *
 * The title goes only behind tabs, where the tab label already carries it.
 * A row or a stack needs every title, or the members are unlabelled.
 */
const quieted = (widget: WidgetSpec, hideTitle: boolean): WidgetSpec => {
  const presentation: Presentation = {
    slots: {
      ...(widget.presentation?.slots ?? {}),
      ...(hideTitle ? { title: { hidden: true, settings: {} } } : {}),
    },
    tokens: widget.presentation?.tokens ?? {},
    settings: { ...(widget.presentation?.settings ?? {}), border: false },
    ...(widget.presentation?.variant ? { variant: widget.presentation.variant } : {}),
    ...(widget.presentation?.density ? { density: widget.presentation.density } : {}),
  };
  return { ...widget, presentation };
};

export interface WidgetGroupProps {
  readonly group: GroupSpec;
  /** In the order they are drawn. Always two or more; the spec enforces it. */
  readonly members: readonly WidgetSpec[];
  readonly onRemoveWidget?: (widgetId: string) => void;
  readonly onCustomiseWidget?: (widgetId: string) => void;
  readonly onOpenRecordPage?: (widgetId: string, row: Record<string, unknown>) => void;
}

export const WidgetGroup = ({
  group,
  members,
  onRemoveWidget,
  onCustomiseWidget,
  onOpenRecordPage,
}: WidgetGroupProps): JSX.Element => {
  const [frameRef, size] = useMeasure<HTMLDivElement>();
  const [activeId, setActiveId] = useState<string | null>(null);

  const arrangement = arrangementFor(group.display, members.length, size.width);

  /*
   * Derived, never stored raw. A member id held in state outlives the member
   * it names — removing a widget, or editing the group, would leave it
   * pointing at nothing and the panel would render blank. The same reasoning,
   * and the same fallback, as the record sheet's active tab.
   */
  const active = members.find((member) => member.id === activeId) ?? members[0];

  const body = (widget: WidgetSpec, hideTitle: boolean): JSX.Element => (
    <WidgetErrorBoundary widgetTitle={widget.title}>
      <WidgetShell
        widget={quieted(widget, hideTitle)}
        {...(onRemoveWidget ? { onRemove: onRemoveWidget } : {})}
        {...(onCustomiseWidget ? { onCustomise: onCustomiseWidget } : {})}
        {...(onOpenRecordPage ? { onOpenPage: onOpenRecordPage } : {})}
      />
    </WidgetErrorBoundary>
  );

  return (
    <section
      className="dash-group"
      ref={frameRef}
      data-arrangement={arrangement}
      aria-label={group.title}
    >
      <header className="dash-group__head">
        <h3 className="dash-group__title">{group.title}</h3>
      </header>

      {arrangement === "tabs" && active ? (
        <div className="dash-group__tabs">
          <Tabs
            tabs={members.map((member) => ({ id: member.id, label: member.title }))}
            activeId={active.id}
            onSelect={setActiveId}
            label={group.title}
          />
          {/*
           * Only the active member is mounted, and that is a cost decision
           * rather than a tidiness one.
           *
           * `useWidgetData` fetches on mount with no way to suspend it, and
           * `LazyWidget` cannot help: its `nearViewport` check reads
           * `getBoundingClientRect`, and a `display:none` element reports a
           * zero rect at the origin — which passes the near-viewport test. So
           * a group that hid its inactive members with CSS would fetch every
           * one of them on open, and keep polling any that declare
           * `refresh.every`, on a tab nobody is looking at.
           *
           * Keyed by member id so switching remounts rather than reusing the
           * previous member's sort and page — the same reason the record
           * sheet keys its panel.
           */}
          <div className="dash-group__panel" role="tabpanel">
            {body(active, true)}
          </div>
        </div>
      ) : (
        <div className="dash-group__lane">
          {members.map((member) => (
            <div className="dash-group__member" key={member.id}>
              {body(member, false)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
