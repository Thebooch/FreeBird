import { Button } from "@freebirdai/dash-components";
import type { Row } from "@freebirdai/dash-runtime";
import type { WidgetSpec } from "@freebirdai/dash-spec";
import { useEffect, useMemo, useRef, useState } from "react";
import { RecordView } from "./RecordView.jsx";
import { type DetailPane, type TrailEntry, detailPanes, popTrail, truncateTrail } from "./detail.js";

/**
 * The record behind a row, in a drawer.
 *
 * A thin wrapper now: everything about *what* a record shows lives in
 * `RecordView`, which the full page renders too, so a change to how a record
 * reads lands on both surfaces rather than on whichever was edited last. This
 * file owns only what is particular to being a drawer — the backdrop, Escape,
 * the focus, and the breadcrumb trail.
 *
 * Going deeper does not open a second sheet. Two dialogs means two focus traps
 * and two Escape handlers competing; one sheet with a breadcrumb gives the
 * same navigation for materially less machinery.
 */
export const WidgetDetail = ({
  parent,
  row,
  onClose,
  onOpenPage,
}: {
  parent: WidgetSpec;
  row: Row;
  onClose: () => void;
  /** Absent when the host has no page to open — an embed, say. */
  onOpenPage?: (widgetId: string, row: Row) => void;
}): JSX.Element | null => {
  const closeRef = useRef<HTMLButtonElement>(null);

  const detail = parent.drilldown;
  const panes = useMemo(() => detailPanes(parent), [parent]);

  const [trail, setTrail] = useState<TrailEntry[]>(() => [
    { title: detail?.title ?? parent.title, panes, row },
  ]);
  const current = trail[trail.length - 1];

  // Escape steps back rather than always closing — at the root there is
  // nowhere to go, so it closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setTrail((previous) => {
        const back = popTrail(previous);
        if (!back) {
          onClose();
          return previous;
        }
        return back;
      });
    };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!detail || !current) return null;

  /** Open a child record, keeping the way back. */
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
    <div
      className="dash-sheet-backdrop"
      data-testid="widget-detail"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className="dash-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={detail.title ?? "Record detail"}
        onClick={(event) => event.stopPropagation()}
      >
        {/*
         * Two lines, not one.
         *
         * The trail and the record's own name used to be the same run of text,
         * so a record three levels deep read as one long sentence with no
         * indication which part of it you were looking at. Splitting them puts
         * the way back above and the thing itself below, at the weight it
         * deserves.
         */}
        <header className="dash-sheet__head">
          {trail.length > 1 && (
            <nav className="dash-sheet__trail" aria-label="Record trail">
              {trail.slice(0, -1).map((entry, index) => (
                <span key={index}>
                  {index > 0 && <span className="dash-sheet__crumb-sep">›</span>}
                  <button
                    type="button"
                    className="dash-sheet__crumb"
                    data-testid={`detail-crumb-${index}`}
                    onClick={() => setTrail((previous) => truncateTrail(previous, index))}
                  >
                    {entry.title}
                  </button>
                </span>
              ))}
            </nav>
          )}

          <div className="dash-sheet__bar">
            <h2 className="dash-sheet__title">{current.title}</h2>

            {/*
             * Only at the root of the trail, and only when the drill-down
             * allows a page. A child record reached two steps in has no URL of
             * its own, so a control promising one would be lying.
             */}
            {onOpenPage && detail.layout !== "sheet" && trail.length === 1 && (
              <Button size="sm" onClick={() => onOpenPage(parent.id, row)} testId="detail-open-page">
                Open full page
              </Button>
            )}

            <button
              ref={closeRef}
              className="dash-iconbtn dash-sheet__close"
              onClick={onClose}
              data-testid="detail-close"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="dash-sheet__body">
          {/* Narrow, so every pane stacks rather than hiding behind a tab. */}
          <RecordView
            panes={current.panes}
            row={current.row as Row}
            wide={false}
            onOpenChild={open}
          />
        </div>
      </aside>
    </div>
  );
};
