import { Button, Message } from "@freebirdai/dash-components";
import type { Row } from "@freebirdai/dash-runtime";
import { useMemo, useState } from "react";
import { RecordView } from "./RecordView.jsx";
import { useDashboard } from "./context.jsx";
import { type DetailPane, type TrailEntry, detailPanes, popTrail, truncateTrail } from "./detail.js";

/**
 * A record, full width, with a URL.
 *
 * The same `RecordView` the drawer renders, given room: related collections
 * become tabs instead of a stack, and the field list has space to run in
 * columns. What makes it worth having separately is the address — a record you
 * can link a colleague to, and come back to with the browser's own Back.
 */
export const RecordPage = ({
  widgetId,
  row,
  onBack,
}: {
  readonly widgetId: string;
  /**
   * The row the record was opened from.
   *
   * On a cold load this is synthesised from the URL and holds only the
   * identifier, which is why `missingTokens` exists: a drill-down that needs
   * some other field cannot be served from a link and has to say so.
   */
  readonly row: Row;
  readonly onBack: () => void;
}): JSX.Element => {
  const { dashboard } = useDashboard();
  const widget = dashboard.widgets.find((entry) => entry.id === widgetId);
  const panes = useMemo(() => (widget ? detailPanes(widget) : []), [widget]);

  const [trail, setTrail] = useState<TrailEntry[]>([]);
  const root: TrailEntry | undefined = widget
    ? { title: widget.drilldown?.title ?? widget.title, panes, row }
    : undefined;
  const steps = root ? [root, ...trail] : [];
  const current = steps[steps.length - 1];

  if (!widget || !widget.drilldown) {
    return (
      <div className="dash-record-page">
        <Button size="sm" onClick={onBack}>
          ‹ Back
        </Button>
        <Message>
          This board has no widget called “{widgetId}”, or it no longer opens records.
        </Message>
      </div>
    );
  }

  const missing = missingTokens(widget.drilldown.params, row);
  if (missing.length > 0) {
    return (
      <div className="dash-record-page">
        <Button size="sm" onClick={onBack}>
          ‹ Back
        </Button>
        {/*
         * An honest dead end rather than a request that will 404.
         *
         * A link carries the record's id and nothing else, so a drill-down
         * keyed on some other field cannot be rebuilt from it. Firing the
         * request anyway produces a 404 that reads like a broken credential,
         * which is a far worse thing to hand somebody.
         */}
        <Message>
          This link needs {missing.map((name) => `“${name}”`).join(" and ")} from the row it was
          opened from, which a link cannot carry. Open it from the list instead.
        </Message>
      </div>
    );
  }

  const open = (pane: DetailPane, childRow: Row): void => {
    if (!pane.opens) return;
    setTrail((previous) => [
      ...previous,
      {
        title: pane.title,
        panes: [{ id: "record", title: pane.title, spec: pane.opens! }],
        row: childRow,
      },
    ]);
  };

  return (
    <div className="dash-record-page">
      <nav className="dash-record-page__crumbs" aria-label="Breadcrumb">
        <button type="button" className="dash-sheet__crumb" onClick={onBack} data-testid="record-back">
          ‹ {dashboard.title}
        </button>
        {steps.map((entry, index) => (
          <span key={index}>
            <span className="dash-sheet__crumb-sep"> › </span>
            {index < steps.length - 1 ? (
              <button
                type="button"
                className="dash-sheet__crumb"
                data-testid={`page-crumb-${index}`}
                onClick={() => setTrail((previous) => truncateTrail(previous, index - 1))}
              >
                {entry.title}
              </button>
            ) : (
              <span className="dash-record-page__here">{entry.title}</span>
            )}
          </span>
        ))}
      </nav>

      {current && (
        <RecordView
          panes={current.panes}
          row={current.row as Row}
          wide
          onOpenChild={open}
        />
      )}
    </div>
  );
};

const TOKEN = /\{\{\s*row\.([^}\s|]+)/g;

/**
 * Which `{{row.*}}` fields the drill-down needs that this row does not have.
 *
 * Only reachable from a cold link: an in-session click hands over the real
 * row, which has everything.
 */
export const missingTokens = (
  params: Readonly<Record<string, string>>,
  row: Row,
): readonly string[] => {
  const needed = new Set<string>();
  for (const value of Object.values(params)) {
    for (const match of value.matchAll(TOKEN)) {
      const field = match[1];
      if (field) needed.add(field);
    }
  }
  return [...needed].filter((field) => row[field] === undefined || row[field] === null);
};

/** Step back one level of a record page's own trail. */
export const stepBack = (trail: readonly TrailEntry[]): TrailEntry[] | null => popTrail(trail);
