import { Button, Menu, type MenuItem, Message, type RowAction } from "@freebirdai/dash-components";
import type { EntityPageSection, EntityPageView, RecordOverride } from "@freebirdai/dash-spec";
import { humanLabel, parentsFrom } from "@freebirdai/dash-spec";
import type { Row } from "@freebirdai/dash-runtime";
import { useMemo } from "react";
import type { DetailPane } from "./detail.js";
import { RecordView } from "./RecordView.jsx";
import { entityPanes, missingParents, type OpenReference } from "./entityDetail.js";
import { changeRowActions, recordChangeRequests, recordToolbar, type ToolbarEntry } from "./writes/requests.js";

/**
 * A change somebody asked for from a page: which record, and what to do to it.
 *
 * Only a request. The host opens the form and the review; nothing here talks
 * to a server or sends anything.
 */
export interface RecordChangeRequest {
  readonly connection: string;
  readonly entity: string;
  /** What one of these is called, for a heading. */
  readonly entityName?: string | undefined;
  readonly kind: "create" | "update" | "delete" | "action";
  readonly action?:
    | {
        readonly id: string;
        readonly title: string;
        readonly danger: boolean;
        /** Makes a new record under this one, so it is offered under "Add". */
        readonly creates?: boolean | undefined;
      }
    | undefined;
  /** The record's own id; absent for a create and for one addressed by its parent. */
  readonly id?: string | undefined;
  readonly parents?: Readonly<Record<string, string>> | undefined;
  /** What to call it: "Edit", "Inactivate a property", "Delete a listing". */
  readonly title: string;
  /** How the request came about: this record, or one of its sections. */
  readonly singleton?: boolean | undefined;
}

/**
 * The changes one section offers, from inside the record it belongs to: add
 * one under it, or — for something that exists once under it, a unit's
 * listing — add or change it and remove it in place. Only for a section the
 * API scopes under this record, whose address this record's id completes.
 */
const sectionRequests = (
  section: EntityPageSection,
  connection: string,
  recordId: string,
  recordParents: Readonly<Record<string, string>> | undefined,
): RecordChangeRequest[] => {
  const writes = section.writes;
  if (!writes || section.reach.mode !== "path") return [];
  const parents = { ...(recordParents ?? {}), [section.reach.param]: recordId };
  const base = { connection, entity: section.entity, parents, ...(section.singleton ? { singleton: true } : {}) };
  const out: RecordChangeRequest[] = [];
  if (section.singleton) {
    const change = writes.update ?? writes.create;
    if (change) out.push({ ...base, kind: "update", title: change.title });
  } else if (writes.create) {
    out.push({ ...base, kind: "create", title: writes.create.title });
  }
  if (section.singleton && writes.remove) out.push({ ...base, kind: "delete", title: writes.remove.title });
  return out;
};

const menuItem = (entry: ToolbarEntry, open: (request: RecordChangeRequest) => void): MenuItem => ({
  id: entry.id,
  label: entry.label,
  onSelect: () => open(entry.request),
  ...(entry.tone === "danger" ? { tone: "danger" as const } : {}),
  ...(entry.separated ? { separated: true } : {}),
});

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
  onChangeRecord,
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
  /**
   * Offer the changes this page allows — edit, delete, the record's actions,
   * and adding to its sections. The page says which the account allows and
   * the person may make; the host does the rest. Absent, nothing is offered.
   */
  readonly onChangeRecord?: (request: RecordChangeRequest) => void;
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

  const own = page.writes;
  const base = {
    connection,
    entity: page.entity,
    entityName: page.name.one,
    id: recordId,
    ...(recordParents ? { parents: recordParents } : {}),
  };
  const ownRequests: RecordChangeRequest[] =
    own && onChangeRecord && missing.length === 0 ? recordChangeRequests(base, own) : [];

  /*
   * A row of a related collection is a record too — one of this property's
   * units — and can be changed from here like any other, with the section's
   * own record type and the row's own address. Not a singleton section: that
   * one is changed from the toolbar, where it is added when missing.
   */
  const sectionRowActions = onChangeRecord
    ? (pane: DetailPane, childRow: Row): readonly RowAction[] => {
        const section = page.sections.find((one) => one.id === pane.id);
        const opens = pane.opensEntity;
        if (!section?.writes || section.singleton || !opens) return [];
        const id = childRow[opens.column];
        if (id === null || id === undefined || id === "") return [];
        const parents = opens.parents?.length ? parentsFrom(opens.parents, childRow, opens.known) : undefined;
        if (parents === null) return [];
        const requests = recordChangeRequests(
          {
            connection,
            entity: section.entity,
            id: String(id),
            ...(parents ? { parents } : {}),
          },
          section.writes,
        );
        return changeRowActions(requests, onChangeRecord);
      }
    : undefined;
  const sectionOffers =
    onChangeRecord && missing.length === 0
      ? page.sections
          .map((section) => ({ section, requests: sectionRequests(section, connection, recordId, recordParents) }))
          .filter((offer) => offer.requests.length > 0)
      : [];

  const toolbar = onChangeRecord ? recordToolbar(ownRequests, sectionOffers) : undefined;

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

      {toolbar && onChangeRecord && (
        /*
         * What can be changed here, as the page reports it: only what the
         * person may. Edit on its own; everything that makes something new
         * — a payment on this lease, a note, a renewal — under one "Add";
         * the rest of the changes, the one that cannot be undone last, under
         * one menu beside it. Each opens a form or a review: nothing here
         * sends a change by itself.
         */
        <div className="dash-record-changes" role="toolbar" aria-label="Changes" data-testid="record-changes">
          {toolbar.edit && (
            <Button size="sm" onClick={() => onChangeRecord(toolbar.edit!)} testId="record-change-update">
              {toolbar.edit.title}
            </Button>
          )}
          {toolbar.add.length > 0 && (
            <Menu
              text="Add"
              align="start"
              label={`Add to this ${page.name.one.toLowerCase()}`}
              testId="record-add"
              items={toolbar.add.map((entry) => menuItem(entry, onChangeRecord))}
            />
          )}
          {toolbar.more.length > 0 && (
            <Menu
              align="start"
              label={`More changes to this ${page.name.one.toLowerCase()}`}
              testId="record-more"
              items={toolbar.more.map((entry) => menuItem(entry, onChangeRecord))}
            />
          )}
        </div>
      )}

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
            {...(sectionRowActions ? { rowActions: sectionRowActions } : {})}
          />
          {unknownBundles.length > 0 && (
            /*
             * Said rather than dropped. These arrive inside every row, but
             * nothing says which kind of record they are — a wrapped
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
