import {
  Badge,
  EmptyState,
  ErrorState,
  type FacetSelection,
  type FacetView,
  FilterGlyph,
  Menu,
  type MenuItem,
  Message,
  Skeleton,
  applyFacets,
  buildFacets,
  defaultSelection,
  describeFacets,
  getComponent,
  skeletonShapeFor,
  toggleFacet,
} from "@freebirdai/dash-components";
import type { Row, RowHighlight } from "@freebirdai/dash-runtime";
import {
  formatValue,
  isSlotHidden,
  orderedSlots,
  settingBool,
  settingString,
  slotLabel,
} from "@freebirdai/dash-spec";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { WidgetDetail } from "./WidgetDetail.jsx";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary.jsx";
import { WidgetInspector } from "./WidgetInspector.jsx";
import { useDashboard } from "./context.jsx";
import type { OpenReference } from "./entityDetail.js";
import { entityFor } from "./references.js";
import { chromePresentationFor, presentationFor, presentationStyle } from "./presentation.js";
import type { WidgetData } from "./useWidgetData.js";
import { useWidgetData } from "./useWidgetData.js";
import type { Presentation, WidgetSpec } from "@freebirdai/dash-spec";

/** The header's regions, in the order they are drawn unless told otherwise. */
const CHROME_SLOTS = ["title", "subtitle", "badges", "actions"] as const;
type ChromeSlot = (typeof CHROME_SLOTS)[number];

/**
 * The chrome every widget wears: title, freshness, refresh, the inspector, and
 * an honest state for each way a widget can fail to show a chart.
 *
 * This is most of what a hand-built dashboard is missing. The five states are
 * distinct on purpose — "no rows in this range" and "your key expired" and
 * "this binding no longer matches the data" are three different problems and
 * a spinner that never resolves tells you none of them.
 *
 * The frame is itself customisable: it resolves a presentation for the pseudo
 * component `widget` and one for whatever it is rendering, so hiding a header
 * or thinning the padding is a stored setting rather than a fork of this file.
 */
export const WidgetShell = ({
  widget,
  hero,
  onRemove,
  onCustomise,
  onFrame,
  onOpenPage,
  onOpenReference,
}: {
  widget: WidgetSpec;
  hero?: boolean;
  /** Absent means this dashboard is read-only, and no control is drawn. */
  onRemove?: (widgetId: string) => void;
  /** Absent until an editor exists to open. */
  onCustomise?: (widgetId: string) => void;
  /**
   * Show this widget with others, or stop.
   *
   * Absent where the host has nowhere to arrange them. Which widgets exist and
   * which frame holds what is the board's business, not this file's — so this
   * opens that question rather than answering it here.
   */
  onFrame?: (widgetId: string) => void;
  /** Absent when the host cannot route to a record page. */
  onOpenPage?: (widgetId: string, row: Row) => void;
  /**
   * Open the record a *cell* names, rather than the row's own.
   *
   * Absent when the host has nowhere to send it, and then a reference renders
   * as a name in plain text rather than as a control — the same contract every
   * other affordance in this file follows.
   */
  onOpenReference?: OpenReference;
}): JSX.Element => {
  const data = useWidgetData(widget);
  /*
   * A cell names a record type and an id; *which API* those belong to is a
   * property of this widget's source, so it is injected here rather than
   * carried down to every component that can draw a reference.
   *
   * The first source deliberately, because that is the one `referenceColumns`
   * stamped these columns from — reading it any other way would let the mark
   * and the link disagree about which API they mean.
   */
  const connection = widget.source?.connection ?? widget.sources[0]?.connection;
  const openReference =
    onOpenReference && connection
      ? (target: { entity: string; id: string | number }) =>
          onOpenReference({ ...target, connection })
      : undefined;
  const [inspecting, setInspecting] = useState(false);
  /** The row a drill-down was opened from. Null when the sheet is closed. */
  const [openRow, setOpenRow] = useState<Row | null>(null);
  const {
    now,
    locale,
    timeZone,
    presentation: sources,
    reportFacets,
    entityLinks,
  } = useDashboard();

  /*
   * A row opens the record type's own page wherever these rows are records of
   * one — the page that carries what points *at* the record, so a vendor
   * arrives with its work orders, bills and notes.
   *
   * It outranks the widget's private sheet deliberately, and the sheet's own
   * planner says why: it stops planning one for any widget that names a record
   * type, because such a widget "already has a record page, and it is the
   * shared one". Nothing routed there, so those widgets opened a sheet that
   * was empty by design — and a widget with no sheet at all had rows that did
   * not respond.
   *
   * The sheet stays for rows nothing describes, which is every widget over an
   * API whose records were never read.
   */
  const recordType = entityFor(widget, entityLinks ?? {});
  /*
   * After a group step there are no records left, only buckets — the same
   * reason `referenceColumns` stops marking links on an aggregated widget. A
   * monthly count has no page, and a bar that looks openable and is not is
   * worse than one that plainly is not.
   */
  const aggregated =
    widget.pipeline.some((step) => step.op === "group") ||
    widget.sources.some((source) => source.pipeline.some((step) => step.op === "group"));
  const opensPage = Boolean(onOpenPage) && Boolean(recordType?.identity) && !aggregated;

  /*
   * What the reader has narrowed this widget to.
   *
   * Local to the shell and to this session, exactly like the table's sort and
   * search. It is deliberately absent from the query cache key: a facet
   * filters rows already fetched, so two selections are two views of one
   * response rather than two requests.
   */
  const [selection, setSelection] = useState<FacetSelection>(() => defaultSelection(widget.facets));

  const chrome = chromePresentationFor(sources, widget.presentation);
  const look = presentationFor(sources, widget.component, widget.presentation);

  /*
   * Built from the *unfiltered* rows, which is what lets an unselected tile
   * keep saying how much is behind it. `buildFacets` owns that rule; the
   * shell's job is only to hand it everything and never to pre-filter.
   */
  const views = useMemo<readonly FacetView[]>(
    () =>
      data.state === "ok" && !isSlotHidden(chrome, "facets")
        ? buildFacets({
            facets: widget.facets,
            rows: data.rows,
            columns: data.columns,
            selection,
          })
        : [],
    [data.state, data.rows, data.columns, widget.facets, selection, chrome],
  );

  /*
   * Rows and highlights narrowed together, never separately — they are
   * index-parallel, and filtering one without the other moves every status
   * pill onto a different record.
   */
  const faceted = useMemo(
    () => applyFacets(views, data.rows, data.highlights),
    [views, data.rows, data.highlights],
  );

  const filtering = views.some((view) => view.selected.length > 0);

  /*
   * Tell the board what this widget is narrowed to.
   *
   * In an effect rather than in the click handler, because the selection that
   * matters is the one that survived `buildFacets` — a key whose tile no
   * longer exists is dropped there, and reporting the raw click would tell the
   * chat about a filter the reader cannot see and the rows do not have.
   */
  const summary = useMemo(() => describeFacets(views), [views]);
  useEffect(() => {
    reportFacets(widget.id, summary);
  }, [reportFacets, widget.id, summary]);
  useEffect(() => () => reportFacets(widget.id, []), [reportFacets, widget.id]);

  /**
   * The filter, as the rows a menu can show.
   *
   * One item per value, grouped under the field it belongs to, ticked when it
   * is on and kept open while a run of them is set — narrowing usually means
   * two or three choices, and a menu that shut after each one would make the
   * reader reopen it every time.
   */
  const filterItems: MenuItem[] = views
    .filter((view) => view.tiles.length > 0)
    .flatMap((view) =>
      view.tiles.map((tile) => ({
        id: `${view.field}-${tile.key}`,
        label: tile.label,
        section: view.label,
        ...(settingBool(chrome, "facetCounts", true)
          ? { meta: tile.count.toLocaleString() }
          : {}),
        checked: tile.selected,
        keepOpen: true,
        onSelect: () => setSelection((previous) => toggleFacet(previous, view, tile.key)),
      })),
    );

  const filterCount = views.reduce((total, view) => total + view.selected.length, 0);

  if (filterItems.length > 0 && filterCount > 0) {
    /*
     * A way back to everything, at the end of the list it undoes. Only once
     * something is on: an always-present "Clear" on a menu that filters
     * nothing reads as a control that does nothing.
     */
    filterItems.push({
      id: "clear",
      label: "Clear filters",
      separated: true,
      onSelect: () => setSelection({}),
    });
  }

  const actions: MenuItem[] = [
    { id: "refresh", label: "Refresh", icon: "↻", onSelect: data.refetch },
    {
      id: "inspect",
      label: "Where did this come from?",
      icon: "ⓘ",
      onSelect: () => setInspecting(true),
    },
    ...(onCustomise
      ? [{ id: "customise", label: "Customise", icon: "◫", onSelect: () => onCustomise(widget.id) }]
      : []),
    ...(onFrame
      ? [{ id: "frame", label: "Shown with…", icon: "▤", onSelect: () => onFrame(widget.id) }]
      : []),
    /*
     * Removal lives behind the menu rather than beside Refresh.
     *
     * It used to be a bare ✕ one pixel from the refresh control, with a
     * two-step confirm bolted on to make the misclick survivable. Opening a
     * menu and choosing a red item is already two deliberate acts, so the
     * confirm was doing the menu's job twice.
     */
    ...(onRemove
      ? [
          {
            id: "remove",
            label: "Remove from dashboard",
            icon: "✕",
            tone: "danger" as const,
            separated: true,
            onSelect: () => onRemove(widget.id),
          },
        ]
      : []),
  ];

  const regions: Record<ChromeSlot, ReactNode> = {
    title: (
      <h3 className="dash-widget__title" title={widget.title}>
        {slotLabel(chrome, "title", widget.title)}
      </h3>
    ),
    subtitle: widget.description ? (
      // Promoted out of the title tooltip. A description nobody hovers is a
      // description nobody reads.
      <p className="dash-widget__subtitle">{widget.description}</p>
    ) : null,
    badges: (
      <>
        {data.stale && data.state === "ok" && (
          <Badge tone="stale" title="Older than this widget's freshness window">
            stale · {formatValue(data.lastFetchedAt, { semantic: "relative_time" }, { now })}
          </Badge>
        )}
        {data.state === "ok" && data.binding && data.binding.warnings.length > 0 && (
          <Badge tone="warn" title={data.binding.warnings.map((w) => w.message).join("\n")}>
            {data.binding.warnings.length} note(s)
          </Badge>
        )}
        {/*
         * What the run itself had to say, which until now only the inspector
         * showed.
         *
         * These are the warnings that change what a number *means*: rows a
         * join dropped for want of a match, rows it repeated because one
         * matched several, a page cut short. A widget can be wrong in exactly
         * those ways while looking entirely fine, and the count was already
         * being computed — it just never reached the place somebody reading
         * the number would look.
         */}
        {data.state === "ok" && data.runMeta && data.runMeta.warnings.length > 0 && (
          <Badge tone="danger" title={data.runMeta.warnings.join("\n")}>
            {data.runMeta.warnings.length} caveat(s)
          </Badge>
        )}
      </>
    ),
    actions: (
      <span className="dash-widget__actions">
        {/*
         * The filter, where every other tool is.
         *
         * It used to be a row of buttons above the rows — one per value, sized
         * by whatever the values happened to be called, taking a third of a
         * short widget before a single row was read. A control that is mostly
         * unused most of the time belongs behind the affordance people already
         * look for, and the count on the glyph is what keeps a hidden filter
         * from being a silent one.
         */}
        {filterItems.length > 0 && (
          <Menu
            items={filterItems}
            glyph={<FilterGlyph />}
            badge={filterCount}
            label={
              filterCount > 0
                ? `Filter ${widget.title}, ${filterCount} applied`
                : `Filter ${widget.title}`
            }
            testId={`filters-${widget.id}`}
          />
        )}
        <Menu items={actions} label={`Actions for ${widget.title}`} testId={`actions-${widget.id}`} />
      </span>
    ),
  };

  const visible = orderedSlots(chrome, CHROME_SLOTS).filter((id) => !isSlotHidden(chrome, id));

  // Counted after the filter, so the footer describes what is on screen.
  const showFooter = !isSlotHidden(chrome, "footer") && data.state === "ok";

  return (
    <div
      className="dash-widget"
      data-density={chrome.density ?? "cozy"}
      data-border={settingBool(chrome, "border", true) ? "on" : "off"}
      style={presentationStyle(chrome)}
    >
      {/*
       * The header stays in the tree even when every region is hidden: the
       * grid starts a drag from `.dash-widget__head`, so removing it would
       * quietly take the widget's drag handle with it.
       */}
      <div className="dash-widget__head">
        {/*
         * Fragments, not wrapper elements. `.dash-widget__actions` is pushed
         * to the right by `margin-left: auto`, which only applies to a direct
         * child of the flex header — a wrapper would silently collapse the
         * header back to left-aligned.
         */}
        {visible.map((id) => (
          <Fragment key={id}>{regions[id as ChromeSlot]}</Fragment>
        ))}
      </div>

      {/*
       * Why the reader is looking at something old.
       *
       * Deliberately louder than the stale badge beside the title. That badge
       * says "this is a bit old", which is a normal condition; this says the
       * upstream refused us and these numbers are not current. Someone
       * screenshotting a figure needs to have been told which of those it is.
       */}
      {data.state === "ok" && data.fetchMeta?.staleReason && (
        <p className="dash-widget__stale" role="status">
          <span aria-hidden="true">⚠</span>
          <span>
            {data.fetchMeta.staleReason} Showing data from{" "}
            {formatValue(data.lastFetchedAt, { semantic: "relative_time" }, { now })}.
          </span>
        </p>
      )}

      <div className="dash-widget__body">
        {/*
         * The boundary sits inside the frame, not around it.
         *
         * The grid wraps the whole tile as a last resort, but a crash caught
         * out there replaces the header too — leaving an error card that does
         * not say which widget failed. Catching here keeps the title, the
         * badges and the actions, so the message has something to belong to
         * and Refresh is still reachable.
         */}
        <WidgetErrorBoundary widgetTitle={widget.title}>
          <WidgetBody
            data={data}
            rows={faceted.rows}
            {...(faceted.highlights ? { highlights: faceted.highlights } : {})}
            {...(filtering ? { filteredBy: summary, onClearFilter: () => setSelection({}) } : {})}
            hero={hero}
            locale={locale}
            timeZone={timeZone}
            now={now}
            presentation={look}
            {...(opensPage
              ? { onSelectRow: (row: Row) => onOpenPage?.(widget.id, row) }
              : widget.drilldown
                ? { onSelectRow: setOpenRow }
                : {})}
            {...(openReference ? { onOpenReference: openReference } : {})}
          />
        </WidgetErrorBoundary>
        {openRow && widget.drilldown && (
          <WidgetDetail
            parent={widget}
            row={openRow}
            onClose={() => setOpenRow(null)}
            {...(onOpenPage ? { onOpenPage } : {})}
            {...(onOpenReference ? { onOpenReference } : {})}
          />
        )}
      </div>

      {showFooter && <WidgetFooter data={data} rows={faceted.rows} now={now} />}

      {inspecting && <WidgetInspector data={data} onClose={() => setInspecting(false)} />}
    </div>
  );
};

/**
 * How much is on screen, and how old it is.
 *
 * A row count is the cheapest way to notice that a filter did something
 * unintended, and it is the first thing missing from a chart that renders
 * beautifully over the wrong twelve records.
 */
const WidgetFooter = ({
  data,
  rows,
  now,
}: {
  data: WidgetData;
  /** After the facets, so the count describes what is actually on screen. */
  rows: readonly Row[];
  now: number;
}): JSX.Element => {
  const truncated = data.fetchMeta?.truncated === true;
  return (
    <div className="dash-widget__foot">
      <span className="dash-widget__count">
        {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}
        {truncated && (
          <span className="dash-widget__more" title="More records exist upstream than were fetched">
            {" "}
            · partial
          </span>
        )}
      </span>
      <span className="dash-widget__updated">
        {formatValue(data.lastFetchedAt, { semantic: "relative_time" }, { now })}
      </span>
    </div>
  );
};

/**
 * What a failed fetch means, and whether trying again could possibly help.
 *
 * These were one message — "the connection may be down or the key may have
 * expired" — for every kind of failure, and that sentence is actively wrong
 * about the two most common ones. A **403 is proof the key works**: you cannot
 * be forbidden without first being identified, so telling somebody their
 * credential may have expired sends them to re-enter a key that was never the
 * problem, and the real cause — a module they are not licensed for — goes
 * unmentioned. A 401 is the opposite and deserves the opposite advice.
 *
 * The retry button follows the same logic. Offering "Try again" on a 403 is an
 * invitation to click it forever; the answer will not change until somebody
 * changes a permission somewhere else.
 *
 * This is the visible half of "keys and go". Endpoints stay offerable whether
 * or not this particular account can read them, which is only honest if the
 * tile explains itself when one of them cannot be.
 */
export const describeFailure = (
  status: number | null,
  userMessage: string | null,
): { message: string; detail?: string; retryable: boolean } => {
  const fallback = "That request did not come back.";

  switch (status) {
    case 401:
      return {
        message: userMessage ?? "The key was not accepted.",
        detail: "It may be wrong, expired, or revoked. Re-entering it under Connections fixes this.",
        retryable: false,
      };
    case 403:
      return {
        message: userMessage ?? "The key works, but is not allowed to read this.",
        detail:
          "Nothing is wrong with the connection — this account does not have access to these " +
          "records. Everything else on the dashboard is unaffected.",
        retryable: false,
      };
    case 429:
      return {
        message: userMessage ?? "The API asked for fewer requests.",
        detail: "This is temporary — a rate limit, not a failure.",
        retryable: true,
      };
    default:
      /*
       * Everything else, deliberately. The REST adapter maps every other 4xx
       * and 5xx to 502 — the upstream's problem, or the request's, and neither
       * is something the person looking at the tile can act on. A 5xx often
       * passes on a second attempt and anything unlabelled could be the
       * network, so both are worth one more try.
       */
      return { message: userMessage ?? fallback, retryable: true };
  }
};

const WidgetBody = ({
  data,
  rows,
  highlights,
  filteredBy,
  onClearFilter,
  hero,
  locale,
  timeZone,
  now,
  presentation,
  onSelectRow,
  onOpenReference,
}: {
  data: WidgetData;
  /**
   * The rows to draw, after the facets. Passed rather than read off `data`
   * because `data.rows` is the whole set the strip counts against, and a
   * component handed those would ignore the filter above it.
   */
  rows: readonly Row[];
  highlights?: readonly (readonly RowHighlight[])[];
  /** What the reader picked, in words. Absent when nothing is filtering. */
  filteredBy?: readonly string[];
  onClearFilter?: () => void;
  hero?: boolean;
  locale: string | undefined;
  timeZone: string;
  now: number;
  presentation?: Presentation;
  onSelectRow?: (row: Row) => void;
  onOpenReference?: (target: { entity: string; id: string | number }) => void;
}): JSX.Element => {
  switch (data.state) {
    case "loading":
      // The skeleton takes the shape of whatever is about to arrive, so the
      // tile does not visibly change form when the data lands.
      return <Skeleton shape={skeletonShapeFor(data.widget.component)} />;

    case "error": {
      const failure = describeFailure(data.errorStatus, data.userMessage);
      return (
        <ErrorState
          message={failure.message}
          {...(failure.detail ? { detail: [failure.detail] } : {})}
          {...(failure.retryable ? { onRetry: data.refetch } : {})}
        />
      );
    }

    case "invalid":
      return (
        <ErrorState
          // Naming the mismatch is the whole point — the data arrived, the
          // binding no longer fits it, and that is a fixable, specific thing.
          message="This widget no longer matches its data."
          detail={data.errors}
        />
      );

    case "empty":
      return (
        <EmptyState
          glyph="○"
          title={data.widget.states.empty ?? "Nothing to show for this time range."}
        />
      );

    case "unapproved":
      /*
       * Not an error: nothing is broken and nothing was fetched. The two
       * reasons are worth telling apart — never approved is a setup step,
       * while changed-since-approved means someone should look at what moved
       * before it goes back on the board.
       */
      return (
        <EmptyState
          glyph="⏸"
          title={
            data.approval === "absent"
              ? "This widget is waiting for approval."
              : "This widget changed since it was approved."
          }
        />
      );

    case "ok": {
      /*
       * Filtered to nothing is its own state, and it is not the widget's
       * empty state.
       *
       * The component's own message says something like "no rows in this
       * range", which here would be actively misleading — the range is fine
       * and the reader's own filter is what emptied the screen. Saying which
       * filter, and offering the way out, is the difference between a dead end
       * and a click.
       */
      if (rows.length === 0 && filteredBy && filteredBy.length > 0) {
        return (
          <EmptyState
            glyph="○"
            title="Nothing matches this filter."
            body={filteredBy.join(" · ")}
            {...(onClearFilter ? { action: { label: "Clear filter", onClick: onClearFilter } } : {})}
          />
        );
      }

      const registered = getComponent(data.widget.component);
      // An open component id can name something this build does not ship.
      if (!registered) {
        return <Message>No component named “{data.widget.component}” is available here.</Message>;
      }
      const Component = registered.render;
      // Highlights and resolved reference names are read off `data` rather
      // than threaded down as props: this is the only place that renders the
      // component, and one fewer hop is one fewer place to forget.
      return (
        <Component
          rows={rows}
          columns={data.columns}
          roles={data.widget.roles}
          format={data.widget.format}
          title={data.widget.title}
          now={now}
          {...(locale ? { locale } : {})}
          timeZone={timeZone}
          {...(hero ? { hero } : {})}
          {...(onSelectRow ? { onSelectRow } : {})}
          {...(onOpenReference ? { onOpenReference } : {})}
          {...(Object.keys(data.referenceNames).length > 0
            ? { referenceNames: data.referenceNames }
            : {})}
          {...(highlights ? { highlights } : {})}
          {...(presentation ? { presentation } : {})}
        />
      );
    }
  }
};
