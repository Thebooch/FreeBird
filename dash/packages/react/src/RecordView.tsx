import { EmptyState, ErrorState, Message, Skeleton, Tabs, getComponent } from "@freebirdai/dash-components";
import type { Row } from "@freebirdai/dash-runtime";
import type { WidgetSpec } from "@freebirdai/dash-spec";
import { useState } from "react";
import { useDashboard } from "./context.jsx";
import { type DetailPane, headerPane, recordPane, relatedPanes, statPanes } from "./detail.js";
import type { OpenReference } from "./entityDetail.js";
import { type PresentationSources, presentationFor } from "./presentation.js";
import { useWidgetData } from "./useWidgetData.js";

/**
 * A record, and what belongs to it.
 *
 * One implementation behind both surfaces: the drawer that opens on a row
 * click and the full page you can send someone a link to. They differ only in
 * how much room they have, which `wide` says — so a change to how a record
 * reads lands in both rather than in whichever was edited last.
 *
 * Every pane is an ordinary `WidgetSpec` run through the same compile → run →
 * validate path as anything on the board, so pipelines, formatting, empty and
 * error states and the query cache all work here without knowing this is a
 * record view.
 */
export const RecordView = ({
  panes,
  row,
  wide,
  onOpenChild,
  onOpenReference,
}: {
  readonly panes: readonly DetailPane[];
  readonly row: Row;
  /** True on the page, false in the sheet. Decides tabs versus stacking. */
  readonly wide: boolean;
  readonly onOpenChild?: (pane: DetailPane, childRow: Row) => void;
  /**
   * Absent means references inside a record render as plain names.
   *
   * Threaded all the way down rather than stopping at the board, because a
   * record page linking onward to another record page is what removes the
   * old two-level limit on how far a reader could follow a chain.
   */
  readonly onOpenReference?: OpenReference;
}): JSX.Element => {
  const header = headerPane(panes);
  const record = recordPane(panes);
  const stats = statPanes(panes);
  const { tabs, sections } = relatedPanes(panes, wide);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  /*
   * Derived, not stored. A tab id held in state outlives the pane it names —
   * switching records or editing the drill-down would leave it pointing at
   * something that no longer exists and the panel would render blank.
   */
  const current = tabs.find((pane) => pane.id === activeTab) ?? tabs[0];

  return (
    <>
      {header && <PaneBody pane={header} row={row} {...(onOpenReference ? { onOpenReference } : {})} />}
      {/*
       * Between the name and the record itself, which is where a figure is
       * read. Each one counts a collection this page is already loading, so
       * the row costs no request of its own.
       */}
      {stats.length > 0 && (
        <div className="dash-record-page__stats" data-testid="record-stats">
          {stats.map((pane) => (
            <div className="dash-record-page__stat" key={pane.id}>
              <PaneBody pane={pane} row={row} />
            </div>
          ))}
        </div>
      )}
      {record && <PaneBody pane={record} row={row} {...(onOpenReference ? { onOpenReference } : {})} />}

      {tabs.length > 0 && current && (
        <div className="dash-record-tabs">
          <Tabs
            tabs={tabs.map((pane) => ({ id: pane.id, label: pane.title }))}
            activeId={current.id}
            onSelect={setActiveTab}
            label="Related records"
          />
          <div className="dash-record-tabs__panel" role="tabpanel">
            {/*
             * Keyed by pane id so switching tabs remounts the body. Without
             * it a table's sort and page would carry across to a different
             * collection, which reads as the new tab opening pre-filtered.
             */}
            <PaneBody
              key={current.id}
              pane={current}
              row={row}
              {...(onOpenChild ? { onOpenChild } : {})}
              {...(onOpenReference ? { onOpenReference } : {})}
            />
          </div>
        </div>
      )}

      {sections.map((pane) => (
        <section className="dash-sheet__section" key={pane.id}>
          <h4 className="dash-sheet__sub">{pane.title}</h4>
          <PaneBody
            pane={pane}
            row={row}
            {...(onOpenChild ? { onOpenChild } : {})}
            {...(onOpenReference ? { onOpenReference } : {})}
          />
        </section>
      ))}
    </>
  );
};

/**
 * Split out because `useWidgetData` must not run until a row exists — calling
 * it above the guard would fire a request for a drill-down that has not been
 * configured.
 */
const PaneBody = ({
  pane,
  row,
  onOpenChild,
  onOpenReference,
}: {
  readonly pane: DetailPane;
  readonly row: Row;
  readonly onOpenChild?: (pane: DetailPane, childRow: Row) => void;
  readonly onOpenReference?: OpenReference;
}): JSX.Element => {
  const { now, timeZone, presentation: sources } = useDashboard();
  return (
    <PaneRenderer
      spec={pane.spec}
      pane={pane}
      row={row}
      now={now}
      timeZone={timeZone}
      sources={sources}
      {...(onOpenChild ? { onOpenChild } : {})}
      {...(onOpenReference ? { onOpenReference } : {})}
    />
  );
};

const PaneRenderer = ({
  spec,
  pane,
  row,
  now,
  timeZone,
  sources,
  onOpenChild,
  onOpenReference,
}: {
  readonly spec: WidgetSpec;
  readonly pane: DetailPane;
  readonly row: Row;
  readonly now: number;
  readonly timeZone: string | undefined;
  readonly sources: PresentationSources | undefined;
  readonly onOpenChild?: (pane: DetailPane, childRow: Row) => void;
  readonly onOpenReference?: OpenReference;
}): JSX.Element => {
  const data = useWidgetData(spec, row);

  /*
   * Whether what is on screen is all of it.
   *
   * A related collection is fetched under a page cap and, where the endpoint
   * declares no filter for the parent's id, narrowed afterwards by a pipeline
   * filter. Those two together are the one combination that can be confidently
   * wrong: the rows belonging to this record may sit past the last page
   * fetched, so the filter matches none of what arrived and the section
   * renders as though the record has no children.
   *
   * `WidgetShell` reports truncation for a top-level widget; a pane renders its
   * component directly and so had no path to the same fact. Here it is the
   * difference between "no units" and "we did not look far enough", which are
   * not the same answer and lead to different next steps.
   */
  const partial = data.fetchMeta?.truncated === true;
  const narrowed = spec.pipeline.some((step) => step.op === "filter");

  if (data.state === "loading") return <Skeleton shape="list" count={3} />;
  if (data.state === "error") {
    return <ErrorState message={data.userMessage ?? "That request did not come back."} />;
  }
  if (data.state === "invalid") {
    return (
      <ErrorState message="This view no longer matches its data." detail={data.errors} />
    );
  }
  if (data.state === "empty") {
    if (partial) {
      return (
        <EmptyState
          glyph="◐"
          title={narrowed ? "Nothing found for this record yet." : "Nothing here yet."}
          body={
            narrowed
              ? "This endpoint cannot be asked for one record's rows, so the collection is read a page at a time and matched here. The reading stopped at the page cap before anything matched — there may be more further in."
              : "The reading stopped at the page cap, so this may not be everything."
          }
        />
      );
    }
    return <EmptyState glyph="○" title="Nothing here." />;
  }

  const registered = getComponent(spec.component);
  if (!registered) {
    return <Message>No component named “{spec.component}” is available here.</Message>;
  }

  const Component = registered.render;
  /*
   * Shown above the rows rather than in a footer: a partial list looks
   * complete, and the caveat is worth reading before the data rather than
   * after it.
   */
  const notice = partial ? (
    <p className="dash-pane__partial" role="status">
      Stopped at the page cap{narrowed ? " before matching every row" : ""} — there may be more.
    </p>
  ) : null;
  // `onSelectRow` is passed only where a child record actually exists. A
  // cursor that promises an interaction which will not happen is worse than
  // no affordance at all — the same contract WidgetShell follows.
  const opens = pane.opens && onOpenChild;
  /*
   * The connection is injected here rather than carried by the cell: a
   * reference names a record type and an id, and which API those belong to is
   * a property of the pane's own source.
   */
  const connection = spec.source?.connection;
  const openReference =
    onOpenReference && connection
      ? (target: { entity: string; id: string | number }) =>
          onOpenReference({ ...target, connection })
      : undefined;

  /*
   * What a row click does, and only ever one of them.
   *
   * A drill-down's child opens another pane inside this view; a record with
   * its own address is navigated to instead. Both are `onSelectRow` to the
   * component, which should not have to know the difference — and the cursor
   * appears only when one of them is actually wired, so a clickable-looking
   * row always does something.
   */
  const openEntityRow =
    pane.opensEntity && openReference
      ? (childRow: Row): void => {
          const id = childRow[pane.opensEntity!.column];
          if (id === null || id === undefined || id === "") return;
          openReference({ entity: pane.opensEntity!.entity, id: id as string | number });
        }
      : undefined;
  const selectRow = opens
    ? (childRow: Row): void => onOpenChild(pane, childRow)
    : openEntityRow;

  /*
   * The record type's own words, stamped over the API-wide lexicon.
   *
   * `labelColumns` fills a column's label from a lexicon holding one entry per
   * bare field name for a whole API, so a task's `Title` and a file's `Title`
   * share it and one of them is always wrong. A record type's dictionary knows
   * which record it is describing, and it carries the field descriptions too —
   * which the specification supplied for nearly every field and which nothing
   * has ever shown a reader.
   */
  const columns = pane.fields
    ? data.columns.map((column) => {
        const known = pane.fields?.[column.name];
        if (!known) return column;
        return {
          ...column,
          ...(known.label ? { label: known.label } : {}),
          ...(known.description ? { description: known.description } : {}),
        };
      })
    : data.columns;
  /*
   * `referenceNames` is spread in below rather than threaded as a prop from
   * above. A record pane is an ordinary widget over the detail endpoint, so it
   * resolves to the same record type as its collection and gets the same
   * treatment — which is what turns a bare VendorId on an opened record into
   * the vendor's name.
   */
  return (
    <>
      {notice}
      <Component
      rows={data.rows}
      columns={columns}
      roles={spec.roles}
      format={spec.format}
      title={spec.title}
      now={now}
      {...(timeZone ? { timeZone } : {})}
      {...(data.highlights ? { highlights: data.highlights } : {})}
      {...(Object.keys(data.referenceNames).length > 0
        ? { referenceNames: data.referenceNames }
        : {})}
      {...(selectRow ? { onSelectRow: selectRow } : {})}
        {...(openReference ? { onOpenReference: openReference } : {})}
        {...(pane.groups ? { groups: pane.groups } : {})}
        presentation={presentationFor(sources, spec.component, spec.presentation)}
      />
    </>
  );
};
