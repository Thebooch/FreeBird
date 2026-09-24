import type {
  EntityPageField,
  EntityPageSection,
  EntityPageView,
  FieldGroup,
  RecordOverride,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import { fnv1a, parseWidget, shapeSteps } from "@freebirdai/dash-spec";
import type { DetailPane } from "./detail.js";

/**
 * Open the record a cell names.
 *
 * Carries the connection because a cell cannot know it: a reference says which
 * record type and which id, and *which API* those belong to is a property of
 * the widget or pane it was drawn in. It is injected at those two places,
 * where the spec naming the connection is in hand.
 *
 * Lives here rather than beside a component because five modules pass it
 * along, and a callback type is not something a grid should be importing out
 * of a view.
 */
export type OpenReference = (target: {
  connection: string;
  entity: string;
  id: string | number;
}) => void;

/**
 * A record type's own page, built from what the API was understood to be.
 *
 * The counterpart to `detailPanes`, and the difference is where the layout
 * comes from. A drill-down is a layout somebody's widget stored: written once
 * by a model at confirm time, private to that widget, and frozen the day it
 * was written. This is built from the record type itself, so every widget over
 * the same records opens the same page, and improving it improves all of them.
 *
 * Every pane is an ordinary `WidgetSpec` carrying the same pane ids
 * `detailPanes` uses — `header`, `record`, then one per collection — so
 * `RecordView` renders these with no idea they came from an entity rather than
 * from a drill-down.
 *
 * **The id is a literal, not a token.** A drill-down interpolates `{{row.Id}}`
 * out of the row it was opened from, which is why a cold link can fail to
 * supply what a pane needs. A page is addressed *by* its id, so the id goes
 * straight into the request parameters — nothing to interpolate, and nothing a
 * link can fail to carry.
 */

/**
 * A column name the pipeline can produce, from a field path that may nest.
 *
 * `fieldNameSchema` forbids dots, so `Category.Name` cannot be a column until
 * a `derive` step makes `Category_Name`. Naming it this way is not arbitrary:
 * it is the exact mapping `derivedSources` reads back, so a reference on a
 * nested field still resolves to the record it points at.
 */
const columnFor = (path: string): string => path.replace(/\./g, "_");

/**
 * The `derive` step a set of field paths needs, if any of them nest.
 *
 * Returned as a list so it can be spread: a pipeline carrying an empty derive
 * step is a step that does nothing, and every reader of the spec would have to
 * know to ignore it.
 */
const deriveFor = (paths: readonly string[]): WidgetSpec["pipeline"] => {
  const nested = [...new Set(paths.filter((path) => path.includes(".")))];
  if (nested.length === 0) return [];
  return [{ op: "derive", fields: Object.fromEntries(nested.map((p) => [columnFor(p), p])) }];
};

/**
 * Whether an id can be written into an expression without breaking it.
 *
 * Only a `scan` section puts the id inside parsed code rather than inside a
 * request parameter, and interpolation happens *after* the expression was
 * checked — so an id carrying a quote produces a parse error at run time, in a
 * pane that nothing wraps in an error boundary. The guard is narrow because
 * the hazard is: every other part of a page tolerates any id at all.
 */
export const canEmbedInExpression = (id: string): boolean => /^[A-Za-z0-9_.:@+-]+$/.test(id);

/**
 * The filter narrowing a scanned collection to one record's rows.
 *
 * Both sides are made strings deliberately. Equality in this language is
 * strict — `'0' == 0` is false, on purpose — so comparing a quoted id against
 * a numeric column matches nothing at all, and the section renders empty for a
 * record that does have rows. That is the one failure indistinguishable from
 * the truth, so neither side is left to chance: `'' + Field` stringifies the
 * column, and a null column yields null, which correctly matches no id.
 */
const scanWhere = (field: string, id: string): string => `'' + ${field} == '${id}'`;

/**
 * What the record type's dictionary says about the columns a pane produces.
 *
 * Keyed by column name, so a component reads it without knowing that
 * `Category_Name` was `Category.Name` an hour ago. This is where the entity
 * pass's work finally reaches a reader: the labels it wrote, and the sentences
 * the specification supplied for nearly every field and which nothing has ever
 * shown anybody.
 */
const fieldsOf = (
  fields: readonly EntityPageField[],
  paths: readonly string[],
): Readonly<Record<string, { label?: string; description?: string }>> => {
  const wanted = new Set(paths);
  const known: Record<string, { label?: string; description?: string }> = {};
  for (const field of fields) {
    if (!wanted.has(field.path)) continue;
    known[columnFor(field.path)] = {
      label: field.label,
      ...(field.description ? { description: field.description } : {}),
    };
  }
  return known;
};

/** A pane spec, or nothing when the shape would not validate as a widget. */
const paneSpec = (input: Record<string, unknown>): WidgetSpec | null =>
  parseWidget(input).value ?? null;

/** The longest id a widget may carry — `idSchema`. */
const MAX_WIDGET_ID = 64;

/**
 * A pane's widget id, from parts that need not be ids themselves.
 *
 * A related collection is keyed `<record type>-by-<field path>`, and the field
 * path nests on plenty of APIs — Rentvine's `invoice.workOrderID` — while a
 * widget id is `[a-zA-Z0-9_-]`, 64 at most. Joined as they were, every section
 * over a nested field, and every section whose names were simply long, failed
 * `paneSpec` and was dropped without a word: "Showing 0 of 3 related
 * collections" on a record that had all three.
 *
 * An id that is already valid is kept exactly, so nothing that works today
 * changes. Anything else is made safe and suffixed with a hash of the whole,
 * so two sections that differ only in a dot, or only past the cut, stay two
 * panes.
 */
const paneWidgetId = (...parts: readonly string[]): string => {
  const whole = parts.join("__");
  if (/^[a-zA-Z0-9_-]+$/.test(whole) && whole.length <= MAX_WIDGET_ID) return whole;
  const hash = fnv1a(whole);
  const safe = whole.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_WIDGET_ID - hash.length - 1);
  return `${safe}_${hash}`;
};

/** Where a section's rows come from, and how they are narrowed to this record. */
const sectionRequest = (
  section: EntityPageSection,
  connection: string,
  id: string,
): { source: Record<string, unknown>; narrow: WidgetSpec["pipeline"] } | null => {
  const reach = section.reach;
  if (reach.mode === "filter" || reach.mode === "path") {
    // The endpoint takes this record's id, so one request returns its rows and
    // nothing else.
    return { source: { connection, op: reach.op, params: { [reach.param]: id } }, narrow: [] };
  }
  if (reach.mode === "scan") {
    // Refused rather than mangled — see `canEmbedInExpression`.
    if (!canEmbedInExpression(id)) return null;
    return {
      source: { connection, op: reach.op, params: {} },
      narrow: [{ op: "filter", where: scanWhere(reach.field, id) }],
    };
  }
  // `record` reaches one far record: that is a link, not a collection.
  return null;
};

export interface EntityPaneInput {
  readonly page: EntityPageView;
  readonly connection: string;
  /** The record's identifier, exactly as the address bar carried it. */
  readonly id: string;
  /** One widget's changes to this page, when its row is what opened it. */
  readonly override?: RecordOverride | undefined;
}

/**
 * One record's page, as panes.
 *
 * Each part is emitted only when it can actually be bound: a header needs a
 * name to show, a record pane needs an endpoint that returns one record, and a
 * section needs at least one column. A pane emitted without those fails the
 * binding check and renders as "this view no longer matches its data" — which
 * blames the reader's data for a defect in this function.
 */
export const entityPanes = (input: EntityPaneInput): DetailPane[] => {
  const { page, connection, id, override } = input;
  const panes: DetailPane[] = [];

  const hidden = new Set(override?.hide ?? []);
  const visible = page.fields.filter((field) => !hidden.has(field.path));
  const shown = new Set(visible.map((field) => field.path));
  const keep = (paths: readonly string[]): string[] => paths.filter((path) => shown.has(path));
  /** A display field is only bindable if the pipeline will produce it. */
  const displayed = (path: string | undefined): string | undefined =>
    path !== undefined && shown.has(path) ? path : undefined;

  const title = keep(page.title);
  const facts = keep(override?.facts ?? page.facts).slice(0, 4);
  const subtitle = displayed(page.subtitle);
  const status = displayed(page.status);
  const detail = page.detail;

  /*
   * The identity block, over the same endpoint as the record.
   *
   * One request serves both panes: the query cache keys on connection, op and
   * params, and these two agree on all three.
   */
  const leading = title[0];
  if (detail && leading) {
    const paths = [
      leading,
      ...(subtitle ? [subtitle] : []),
      ...(status ? [status] : []),
      ...facts,
    ];
    const header = paneSpec({
      id: paneWidgetId(page.entity, "header"),
      title: page.name.one,
      component: "recordHeader",
      entity: page.entity,
      source: { connection, op: detail.op, params: { [detail.param]: id } },
      pipeline: [{ op: "extract", path: "$" }, ...deriveFor(paths)],
      roles: {
        /*
         * One field, not the whole title. `recordHeader` binds a single title
         * column while a record type may name up to three, so the leading
         * field is what identifies it here.
         */
        title: columnFor(leading),
        ...(subtitle ? { subtitle: columnFor(subtitle) } : {}),
        ...(status ? { status: columnFor(status) } : {}),
        ...(facts.length > 0 ? { facts: facts.map(columnFor) } : {}),
      },
    });
    if (header) {
      panes.push({
        id: "header",
        title: page.name.one,
        spec: header,
        fields: fieldsOf(visible, paths),
      });
    }
  }

  /*
   * The record itself.
   *
   * Every field the dictionary did not hide, uncapped: deciding which fields
   * belong to a person is the entity pass's job and it already did it, so a
   * second cap here would drop real fields for no stated reason.
   */
  if (detail && visible.length > 0) {
    const paths = visible.map((field) => field.path);
    const groups: FieldGroup[] = (override?.groups ?? page.groups)
      .map((group) => ({ title: group.title, fields: keep(group.fields).map(columnFor) }))
      .filter((group) => group.fields.length > 0);

    const record = paneSpec({
      id: paneWidgetId(page.entity, "record"),
      title: page.name.one,
      component: "record",
      entity: page.entity,
      source: { connection, op: detail.op, params: { [detail.param]: id } },
      pipeline: [{ op: "extract", path: "$" }, ...deriveFor(paths)],
      roles: {
        fields: paths.map(columnFor),
        ...(leading ? { title: columnFor(leading) } : {}),
      },
    });
    if (record) {
      panes.push({
        id: "record",
        title: page.name.one,
        spec: record,
        fields: fieldsOf(visible, paths),
        ...(groups.length > 0 ? { groups } : {}),
      });
    }
  }

  /*
   * The collections belonging to this record.
   *
   * A widget may name which ones and in what order; anything it does not name
   * keeps the page's own order, which puts complete answers before partial
   * ones.
   */
  const wanted = override?.sections
    ? override.sections.flatMap((wantedId) => page.sections.filter((one) => one.id === wantedId))
    : page.sections;

  for (const section of wanted) {
    // A table must bind at least one column, so a record type nobody has
    // described yet shows nothing rather than something broken.
    if (section.columns.length === 0) continue;
    const request = sectionRequest(section, connection, id);
    if (!request) continue;

    const spec = paneSpec({
      id: paneWidgetId(page.entity, "rel", section.id),
      title: section.title,
      component: "table",
      entity: section.entity,
      source: request.source,
      // Narrowed before deriving, so the flattening runs over this record's
      // rows rather than over every page that was read to find them.
      pipeline: [
        { op: "extract", path: "$" },
        ...request.narrow,
        /*
         * The identity is derived alongside the columns even though no column
         * shows it: a row is opened by its id, and an identity that nests is
         * not readable off the row until a derive step flattens it.
         */
        ...deriveFor([...section.columns, ...(section.identity ? [section.identity] : [])]),
      ],
      roles: { columns: section.columns.map(columnFor) },
    });
    if (!spec) continue;

    panes.push({
      id: section.id,
      title: section.title,
      spec,
      tab: true,
      ...(section.identity
        ? { opensEntity: { entity: section.entity, column: columnFor(section.identity) } }
        : {}),
    });
  }

  /*
   * The numbers above the record, each read off a section this page already
   * loads.
   *
   * Free, and that is the whole design: the cache keys on the request rather
   * than on the pipeline, so a stat over the same endpoint with the same
   * parameters shares the section's fetch and only runs a different pipeline
   * over the rows already in hand. A stat whose section was dropped — by a
   * widget override, or because it bound no columns — is dropped with it,
   * since there would be nothing fetched to count.
   */
  const drawn = new Set(panes.map((pane) => pane.id));
  for (const stat of page.stats) {
    if (!drawn.has(stat.section)) continue;
    const section = page.sections.find((one) => one.id === stat.section);
    if (!section) continue;
    const request = sectionRequest(section, connection, id);
    if (!request) continue;

    const spec = paneSpec({
      id: paneWidgetId(page.entity, "stat", stat.section),
      title: stat.label,
      component: "stat",
      entity: section.entity,
      source: request.source,
      pipeline: [
        { op: "extract", path: "$" },
        ...request.narrow,
        ...(stat.agg === "sum" && stat.field ? deriveFor([stat.field]) : []),
        ...shapeSteps({
          groupBy: [],
          measures: [
            stat.agg === "sum" && stat.field
              ? { as: "total", agg: "sum" as const, field: columnFor(stat.field) }
              : { as: "total", agg: "count" as const },
          ],
          sort: [],
        }),
      ],
      roles: { value: "total" },
    });
    if (!spec) continue;

    panes.push({
      id: `stat__${stat.section}`,
      title: stat.label,
      spec,
      /*
       * Never a tab. These are the figures somebody reads before deciding
       * whether to open anything, so they belong above the record rather than
       * behind a control.
       *
       * Nothing is stamped here about the number being an undercount, even
       * though a `partial` section is read by a capped scan. Whether the cap
       * was actually reached is a fact about the response, not about the plan
       * — `PaneBody` already says so when the fetch truncated — and a scan
       * that completed is exact. Claiming "at least" on one that did not would
       * be hedging a number that is simply right.
       */
      tab: false,
    });
  }

  return panes;
};
