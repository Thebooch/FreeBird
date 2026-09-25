import { Message } from "@freebirdai/dash-components";
import type { EntityPageView, RecordOverride } from "@freebirdai/dash-spec";
import { humanLabel } from "@freebirdai/dash-spec";
import type { Row } from "@freebirdai/dash-runtime";
import { useMemo } from "react";
import { RecordView } from "./RecordView.jsx";
import { entityPanes, missingParents, type OpenReference } from "./entityDetail.js";

/**
 * One record's own page, addressed by what it is.
 *
 * The counterpart to `RecordPage`, and the difference is whose page it is. A
 * `RecordPage` belongs to a widget: its layout came from that widget's
 * drill-down, and the same record opened from a different widget is a
 * different page. This one belongs to the *record type*, so every route into
 * it — a link from a task's vendor column, a shared URL, a widget's row —
 * arrives at the same page, and improving it improves all of them at once.
 *
 * Rendered through `RecordView`, which knows nothing about entities: the panes
 * are ordinary widget specs, so the compile → run → validate path, the query
 * cache, formatting and the empty and error states all work here unchanged.
 */
export const EntityRecordPage = ({
  page,
  connection,
  recordId,
  recordParents,
  onBack,
  backLabel,
  override,
  onOpenReference,
  onEditLayout,
}: {
  readonly page: EntityPageView;
  readonly connection: string;
  readonly recordId: string;
  /**
   * Its other ids, where it lives under a parent: a unit's page is fetched
   * with its property's id as well as its own.
   */
  readonly recordParents?: Readonly<Record<string, string>> | undefined;
  readonly onBack: () => void;
  /** What going back returns to — the board, usually. */
  readonly backLabel?: string;
  /** One widget's changes to this layout, when its row is what opened it. */
  readonly override?: RecordOverride | undefined;
  readonly onOpenReference?: OpenReference;
  /**
   * Offer to rearrange this page.
   *
   * A callback rather than an editor, because the editor has to write — to a
   * board or to the record type itself — and this package has no opinion about
   * where anything is stored. Absent in a host that has nowhere to put it, and
   * then nothing is offered.
   */
  readonly onEditLayout?: () => void;
}): JSX.Element => {
  const panes = useMemo(
    () =>
      entityPanes({
        page,
        connection,
        id: recordId,
        ...(recordParents ? { parents: recordParents } : {}),
        ...(override ? { override } : {}),
      }),
    [page, connection, recordId, recordParents, override],
  );
  const missing = useMemo(() => missingParents(page, recordParents), [page, recordParents]);

  /*
   * The row exists for the shape `RecordView` takes, not because a pane needs
   * it: every request here carries the id as a literal parameter, so there is
   * nothing to interpolate out of a row and nothing a cold link can fail to
   * supply.
   */
  const row = useMemo<Row>(
    () => ({ [page.identity ?? "Id"]: recordId }),
    [page.identity, recordId],
  );

  const shown = panes.filter((pane) => pane.tab === true).length;
  const unknownBundles = (page.bundles ?? []).filter((bundle) => !bundle.entity);
  const hiddenSections = page.sectionsTotal - shown;

  return (
    <div className="dash-record-page">
      <nav className="dash-record-page__crumbs" aria-label="Breadcrumb">
        <button
          type="button"
          className="dash-sheet__crumb"
          onClick={onBack}
          data-testid="record-back"
        >
          ‹ {backLabel ?? "Back"}
        </button>
        <span className="dash-sheet__crumb-sep"> › </span>
        <span className="dash-record-page__here">{page.name.one}</span>
        {onEditLayout && panes.length > 0 && (
          <button
            type="button"
            className="dash-sheet__crumb"
            style={{ marginLeft: "auto" }}
            onClick={onEditLayout}
            data-testid="record-edit-layout"
          >
            Edit layout
          </button>
        )}
      </nav>

      {missing.length > 0 && (
        /*
         * Said rather than shown as an empty record. A bare link to a record
         * that lives under a parent cannot say which parent, and the endpoint
         * cannot be asked without it; the way in is through the parent.
         */
        <Message>
          This {page.name.one.toLowerCase()} can only be fetched together with the{" "}
          {missing.map((part) => part.entity ?? part.param).join(" and ")} it belongs to, and this
          link did not say which. Open it from there instead.
        </Message>
      )}
      {panes.length === 0 && missing.length === 0 ? (
        /*
         * An honest dead end rather than a blank page.
         *
         * On a real API this is 26 of 108 record types: the specification
         * describes them, but no endpoint returns one on its own and nothing
         * else points at them, so there is genuinely nothing to show. Saying
         * which of those two it is beats an empty box, because only one of
         * them is worth anybody's time to chase.
         */
        <Message>
          This API has no endpoint that returns one {page.name.one.toLowerCase()} on its own, and
          nothing else links to {page.name.many.toLowerCase()} — so there is nothing to show here
          yet.
        </Message>
      ) : panes.length === 0 ? null : (
        <>
          <RecordView
            panes={panes}
            row={row}
            wide
            {...(onOpenReference ? { onOpenReference } : {})}
          />
          {unknownBundles.length > 0 && (
            /*
             * Said rather than dropped. These arrive inside every row, but
             * nothing says which kind of record they are — a Rentvine
             * `contact` may be a tenant, a vendor or an owner — so they cannot
             * be linked, and listing their fields as this record's own is what
             * this page stopped doing.
             */
            <p className="dash-pane__partial" role="status">
              Also sent with each {page.name.one.toLowerCase()}:{" "}
              {unknownBundles.map((bundle) => humanLabel(bundle.path).toLowerCase()).join(", ")} —
              not shown here, because nothing says what kind of record{" "}
              {unknownBundles.length > 1 ? "they are" : "it is"}.
            </p>
          )}
          {hiddenSections > 0 && (
            /*
             * Said out loud rather than implied. One real record type has 26
             * related collections; a page showing eight of them without saying
             * so reads as a record with eight.
             */
            <p className="dash-pane__partial" role="status">
              Showing {shown} of {page.sectionsTotal} related collections.
            </p>
          )}
        </>
      )}
    </div>
  );
};
