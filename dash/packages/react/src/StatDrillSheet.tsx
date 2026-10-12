import { EmptyState, ErrorState, Skeleton, getComponent, skeletonShapeFor } from "@freebirdai/dash-components";
import type { Row } from "@freebirdai/dash-runtime";
import type { EntityLinkView, WidgetSpec } from "@freebirdai/dash-spec";
import { formatValue } from "@freebirdai/dash-spec";
import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { describeFailure } from "./WidgetShell.jsx";
import { useDashboard } from "./context.jsx";
import { type StatDrill, drillColumns } from "./drill.js";
import { useWidgetData } from "./useWidgetData.js";

/**
 * The records behind a number tile, in the same drawer a row opens.
 *
 * The list is the tile's own request with the counting taken off, so it is
 * the cache's answer rather than a second read, and what it lists is exactly
 * what was counted. A row opens its record the way a row on any table does.
 */
export const StatDrillSheet = ({
  widget,
  drill,
  link,
  onClose,
  onOpenPage,
  onOpenReference,
  container,
}: {
  widget: WidgetSpec;
  drill: StatDrill;
  link: EntityLinkView | undefined;
  onClose: () => void;
  onOpenPage?: (widgetId: string, row: Row) => void;
  onOpenReference?: (target: { entity: string; id: string | number }) => void;
  /**
   * Where the drawer is drawn: the board's root. Never inside the tile, whose
   * grid cell is moved with a transform — and a fixed drawer inside a
   * transformed box is fixed to that box, so it opened the size of the tile.
   */
  container?: Element | null;
}): JSX.Element => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const data = useWidgetData(drill.spec);
  const { now, locale, timeZone } = useDashboard();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const columns = useMemo(
    () => drillColumns(data.columns, link, drill.measure),
    [data.columns, link, drill.measure],
  );

  const valueColumn = typeof widget.roles["value"] === "string" ? widget.roles["value"] : undefined;
  const totalFormat =
    (valueColumn ? widget.format[valueColumn] : undefined) ??
    (drill.measure.fn === "sum" ? drill.spec.format[drill.measure.field] : undefined);
  const total =
    drill.measure.fn === "sum"
      ? data.rows.reduce((sum, row) => {
          const value = row[(drill.measure as { field: string }).field];
          return typeof value === "number" && Number.isFinite(value) ? sum + value : sum;
        }, 0)
      : null;

  const noun = (link?.name.many ?? "records").toLowerCase();
  const Table = getComponent("table")?.render;
  /*
   * Rows arrive whether or not the placeholder binding names a column the
   * rows have — the columns are picked after they land — so a binding note
   * is not a failure here.
   */
  const drawable = (data.state === "ok" || data.state === "invalid") && data.rows.length > 0;

  return createPortal(
    <div className="dash-sheet-backdrop" data-testid="stat-drill" onClick={onClose} role="presentation">
      <aside
        className="dash-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${widget.title}: ${noun}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dash-sheet__head">
          <div className="dash-sheet__bar">
            <h2 className="dash-sheet__title">
              {widget.title}
              {drawable && (
                <span className="dash-drill__count">
                  {" "}
                  · {data.rows.length.toLocaleString()} {data.rows.length === 1 ? (link?.name.one ?? "record").toLowerCase() : noun}
                </span>
              )}
            </h2>
            <button
              ref={closeRef}
              className="dash-iconbtn dash-sheet__close"
              onClick={onClose}
              data-testid="stat-drill-close"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="dash-sheet__body dash-drill">
          {data.state === "loading" && <Skeleton shape={skeletonShapeFor("table")} />}
          {data.state === "error" && (
            <ErrorState
              message={describeFailure(data.errorStatus, data.userMessage).message}
              onRetry={data.refetch}
            />
          )}
          {data.state === "unapproved" && <EmptyState glyph="⏸" title="This widget is waiting for approval." />}
          {(data.state === "empty" || ((data.state === "ok" || data.state === "invalid") && data.rows.length === 0)) && (
            <EmptyState glyph="○" title={`No ${noun} behind this number.`} />
          )}
          {drawable && Table && (
            <>
              <div className="dash-drill__table">
                <Table
                  rows={data.rows}
                  columns={data.columns}
                  roles={{ columns }}
                  format={drill.spec.format}
                  title={widget.title}
                  now={now}
                  {...(locale ? { locale } : {})}
                  timeZone={timeZone}
                  {...(onOpenPage
                    ? {
                        onSelectRow: (row: Row) => {
                          onClose();
                          onOpenPage(widget.id, row);
                        },
                      }
                    : {})}
                  {...(onOpenReference ? { onOpenReference } : {})}
                  {...(Object.keys(data.referenceNames).length > 0 ? { referenceNames: data.referenceNames } : {})}
                />
              </div>
              {total !== null && (
                <p className="dash-drill__total" data-testid="stat-drill-total">
                  <span>Total</span>
                  <span>{formatValue(total, totalFormat ?? { semantic: "number" }, { ...(locale ? { locale } : {}), now, timeZone })}</span>
                </p>
              )}
            </>
          )}
        </div>
      </aside>
    </div>,
    container ?? document.body,
  );
};
