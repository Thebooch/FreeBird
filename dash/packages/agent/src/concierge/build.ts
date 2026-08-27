import type { FilterDecl, HighlightSpec, WidgetShape, WidgetSpec } from "@freebirdai/dash-spec";
import type { SeriesDraft } from "./draft.js";
import {
  COMPONENT_CONTRACTS,
  fieldLabel,
  humanLabel,
  groupColumn,
  parseWidget,
  rolesForShape,
  shapeSteps,
  statusTone,
} from "@freebirdai/dash-spec";
import { coercionsFor, widgetId, type RoleBinding } from "../bind.js";
import type { FieldInfo } from "../infer.js";
import type { Ambiguity } from "../propose.js";
import { flatten, highlightCandidates, pane } from "../suggest.js";
import type { AuthoredWidget } from "../suggest.js";
import type { ConciergeDraft } from "./draft.js";
import {
  SERIES_BUCKET,
  SERIES_COUNT,
  SERIES_LABEL,
  extrasRole,
  fieldPool,
  labelsFor,
  settle,
  type ConciergeContext,
} from "./steps.js";

/**
 * The answers, turned into a widget.
 *
 * Nothing here decides anything: every value it writes came from a step whose
 * options were derived from the endpoint's own shape, and the result goes
 * through `parseWidget` exactly as a model's proposal does. A draft that
 * cannot produce a valid widget produces errors, never a half-built one that
 * fails at render time in front of somebody.
 */

/**
 * A string literal for the expression grammar, escaped.
 *
 * Field names need no such treatment: the lexer reads a dotted identifier as
 * one token, so `Category.Name` is already a single field reference and
 * quoting it would break it.
 */
const quoteText = (value: string): string =>
  `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export interface BuildResult {
  readonly widget: WidgetSpec | null;
  readonly authored: AuthoredWidget | null;
  readonly errors: readonly string[];
  /** True of the built widget, not of the build — things worth reading first. */
  readonly warnings: readonly string[];
  /**
   * Dashboard-level filters this widget needs declared.
   *
   * A `{{param.x}}` the dashboard has not declared is a parse error by design,
   * so a widget that wants a search box has to be saved together with the
   * filter that feeds it. Returned rather than silently added, because writing
   * to the dashboard's own params is the caller's decision.
   */
  readonly requiresFilters: readonly FilterDecl[];
}

const SEARCH_FILTER_KEY = "search";

const fail = (...errors: string[]): BuildResult => ({
  widget: null,
  authored: null,
  errors,
  warnings: [],
  requiresFilters: [],
});

/** Role bindings with the accepted extras appended to whichever role takes a list. */
const withExtras = (draft: ConciergeDraft, component: string): RoleBinding => {
  const roles: Record<string, string | readonly string[]> = { ...draft.roles };
  if (draft.extras.length === 0) return roles;

  const contract = COMPONENT_CONTRACTS[component as keyof typeof COMPONENT_CONTRACTS];
  const target = contract ? extrasRole(contract) : undefined;
  if (!target) return roles;

  const existing = roles[target.role];
  const already = Array.isArray(existing) ? [...existing] : existing ? [existing as string] : [];
  // Order matters and duplicates are visible, so the chosen columns stay first
  // and an extra already bound is not appended twice.
  const merged = [...already, ...draft.extras.filter((name) => !already.includes(name))];
  return { ...roles, [target.role]: merged };
};

/**
 * The status marks the draft accepted, resolved back to real predicates.
 *
 * The step offered candidate *ids*; the specs are recomputed from the same
 * fields so nothing about a predicate has to survive a round trip through
 * storage. An id that no longer matches anything is dropped rather than
 * guessed at.
 */
const highlightsFor = (
  draft: ConciergeDraft,
  fields: readonly FieldInfo[],
): { specs: HighlightSpec[]; confirm: Ambiguity[] } => {
  if (draft.highlights.length === 0) return { specs: [], confirm: [] };

  const used = new Set(
    Object.values(draft.roles).flatMap((value) => (Array.isArray(value) ? value : [value])),
  );
  const candidates = highlightCandidates(fields, statusTone, { exclude: [...used] });

  const specs: HighlightSpec[] = [];
  const confirm: Ambiguity[] = [];
  for (const id of draft.highlights) {
    const found = candidates.find((candidate) => candidate.highlight.id === id);
    if (!found) continue;
    specs.push(found.highlight);
    // A tone the vocabulary did not recognise is a guess, and a colour that
    // says the wrong thing is worse than no colour at all.
    if (!found.confident) {
      confirm.push({
        field: found.highlight.label,
        question: `Should “${found.highlight.label}” be highlighted, and how urgent is it?`,
        options: ["Good", "Needs attention", "Urgent", "Don't highlight"],
      });
    }
  }
  return { specs: specs.slice(0, 8), confirm };
};

export const buildFromDraft = (
  input: ConciergeDraft,
  context: ConciergeContext,
  options: { readonly taken?: ReadonlySet<string>; readonly now?: () => Date } = {},
): BuildResult => {
  // The same fill-in the questions use, so a connection that was never asked
  // about because there was only one is still the connection this builds on.
  const draft = settle(input, context);
  if (!draft.connection) return fail("no API chosen yet");
  /*
   * What this API calls its fields. The offer's own prose reads to the user,
   * so it has to speak the same names the widget will show them.
   */
  const labels = labelsFor(draft, context);
  if (!draft.op) return fail("no endpoint chosen yet");
  if (!draft.component) return fail("no view chosen yet");

  const contract = COMPONENT_CONTRACTS[draft.component as keyof typeof COMPONENT_CONTRACTS];
  if (!contract) return fail(`"${draft.component}" is not a component this build knows`);

  const fields = fieldPool(draft, context);
  if (fields.length === 0) return fail(`nothing has been read from "${draft.op}" yet`);

  const title = draft.title?.trim() || context.ops.find((op) => op.id === draft.op)?.title || "Widget";
  const id = widgetId(title, options.taken ?? new Set());
  const bound = withExtras(draft, draft.component);

  /*
   * A nested field, made into a column the widget can actually bind to.
   *
   * `Unit.UnitNumber` is not a column — the runtime flattens exactly one level
   * into a *name*, and a role pointing at that name binds to nothing until a
   * derive step produces it. Record views already knew this: `pane()` has
   * flattened its fields since drill-downs shipped. The main widget did not,
   * which is why every question upstream had to hide nested fields to stay
   * honest — and why a listing could be grouped by `Property` (an object,
   * rendering as "[object Object]") but not by the name inside it.
   *
   * Doing it here is what lets the pool stop lying by omission.
   */
  const derived: Record<string, string> = {};
  const rename = (name: string): string => {
    if (!name.includes(".")) return name;
    const [flat] = flatten([name]).bound;
    if (flat) derived[flat] = name;
    return flat ?? name;
  };

  const roles: RoleBinding = Object.fromEntries(
    Object.entries(bound).map(([role, value]) => [
      role,
      Array.isArray(value) ? value.map(rename) : rename(value as string),
    ]),
  );

  const warnings: string[] = [];
  const why: string[] = [];
  const requiresFilters: FilterDecl[] = [];

  /* ── what the endpoint itself is asked for ───────────────────────────── */

  const params: Record<string, string> = {};
  if (draft.options.includes("endpointSearch")) {
    const searchable = context.searchable.find((entry) => entry.op === draft.op);
    if (searchable) {
      params[searchable.param] = `{{param.${SEARCH_FILTER_KEY}}}`;
      requiresFilters.push({ key: SEARCH_FILTER_KEY, label: "Search", type: "text" });
      why.push(`the endpoint accepts "${searchable.param}", so the search narrows it at the source`);
    }
  }
  if (draft.options.includes("endpointRange")) {
    const ranged = context.rangeFilterable.find((entry) => entry.op === draft.op);
    if (ranged) {
      params[ranged.start] = "{{range.start | date}}";
      if (ranged.end) params[ranged.end] = "{{range.end | date}}";
      why.push("the endpoint takes a date range, so the board's time control reaches it");
    }
  }

  /* ── presentation, from the component's own manifest ─────────────────── */

  const settings: Record<string, boolean> = {};
  for (const chosen of draft.options) {
    if (chosen === "endpointSearch" || chosen === "endpointRange") continue;
    settings[chosen] = true;
  }

  /* ── the shape of the rows ───────────────────────────────────────────── */

  const coercions = coercionsFor(roles, fields);
  const format: Record<string, { semantic: string }> = {};
  for (const name of Object.keys(coercions)) format[name] = { semantic: "timestamp" };

  const { specs: highlights, confirm } = highlightsFor(draft, fields);

  /*
   * The measurement, on the columns that will exist.
   *
   * Grouping by `Unit.UnitNumber` means grouping by the column the derive
   * above produces, not by a dotted name no row carries. Renamed through the
   * same function the roles went through, so the two cannot disagree about
   * what a flattened field is called.
   */
  const shape = draft.shape
    ? {
        ...draft.shape,
        groupBy: draft.shape.groupBy.map((key) => ({ ...key, field: rename(key.field) })),
        measures: draft.shape.measures.map((measure) =>
          measure.field ? { ...measure, field: rename(measure.field) } : measure,
        ),
      }
    : undefined;

  /* ── clicking a row ──────────────────────────────────────────────────── */

  let drilldown: Record<string, unknown> | undefined;
  if (draft.drilldown) {
    const detail = (context.shapes[draft.drilldown.op]?.fields ?? []).map((field) => field.name);
    // Skipping the field question means "show me everything", which is the
    // right default for a record: a detail response is one thing, and hiding
    // part of it is a decision somebody should make deliberately.
    const names = draft.drilldown.fields.length > 0 ? draft.drilldown.fields : detail.slice(0, 40);
    if (names.length > 0) {
      /*
       * The collections shown beside the record. Each is fetched the way its
       * endpoint allows: narrowed upstream where a parameter is declared, and
       * matched on the rows where one is not. Never both, and never an
       * invented parameter — an API that ignores one answers 200 with the
       * whole collection, so the section looks healthy while showing every
       * record in the account.
       */
      const related = draft.drilldown.sections.map((section) => ({
        ...pane({
          op: section.op,
          params: section.filterParam
            ? { [section.filterParam]: `{{row.${draft.drilldown!.idField}}}` }
            : {},
          /*
           * Narrowed upstream, or matched on the rows — never both, and never
           * neither silently. A section with no parameter and no link field
           * has nothing tying it to this record, so it is left unfiltered
           * rather than filtered on a name that does not exist.
           */
          ...(section.filterParam || !section.linkField
            ? {}
            : {
                matchOn: {
                  field: section.linkField,
                  parentIdField: draft.drilldown!.idField,
                  rowsPath: section.rowsPath,
                  ...(section.linkKind ? { kind: section.linkKind } : {}),
                },
              }),
          component: "table",
          role: "columns",
          names: section.columns,
        }),
        id: section.id,
        title: section.title,
      }));

      drilldown = pane({
        op: draft.drilldown.op,
        params: { [draft.drilldown.param]: `{{row.${draft.drilldown.idField}}}` },
        component: "record",
        role: "fields",
        names,
        /*
         * The heading and the sections, when a record view was planned.
         *
         * Both are what turn a record from a wall of label-and-value pairs
         * into something with a shape — and both were defined in the widget
         * schema and rendered by the components long before anything produced
         * one. This is the producer.
         */
        ...(draft.drilldown.header ? { header: draft.drilldown.header } : {}),
        ...(draft.drilldown.groups.length > 0 ? { groups: draft.drilldown.groups } : {}),
        ...(related.length > 0 ? { related } : {}),
      });
      why.push(`clicking a row opens it by ${fieldLabel(draft.drilldown.idField, labels)}`);
      if (related.length > 0) {
        why.push(
          `and shows ${related.map((section) => humanLabel(String(section.title))).join(", ")} beside it`,
        );
      }
    }
  }

  /* ── one endpoint, or two ────────────────────────────────────────────── */

  /*
   * Every nested field the widget touches, made into a real column.
   *
   * Collected by `rename` above as the roles and the measurement were walked,
   * so there is one place deciding what a flattened field is called and no
   * second list to keep in step.
   */
  const deriveStep =
    Object.keys(derived).length > 0 ? [{ op: "derive", fields: derived }] : [];

  const coerceStep = Object.keys(coercions).length > 0 ? [{ op: "coerce", fields: coercions }] : [];

  /*
   * The narrowing a person confirmed, as a filter over the rows.
   *
   * Written as an `in (...)` comparison rather than one predicate per value so
   * the expression stays readable when somebody picked six categories, and so
   * the values keep their own types — `"1688"` and `1688` are different things
   * and a filter that conflated them would match nothing while looking
   * perfectly reasonable.
   *
   * Applied here even when the endpoint declares a query parameter for it.
   * The parameter narrows the request, which is a saving; this narrows the
   * rows, which is the guarantee. An API free to ignore a parameter it does
   * not recognise would otherwise return everything and the widget would show
   * it — the same trap the join code documents about invented filter params.
   */
  const narrowStep =
    draft.narrow && draft.narrow.values.length > 0
      ? [
          {
            op: "filter",
            where: `${draft.narrow.field} in [${draft.narrow.values
              .map((value) => (typeof value === "number" ? String(value) : quoteText(value)))
              .join(", ")}]`,
          },
        ]
      : [];

  /*
   * A measured widget binds to the columns the measurement produces, not to
   * the raw ones.
   *
   * After a group step the endpoint's own columns are gone — a count is not a
   * column until the group creates it — so a role still pointing at a raw
   * field would name something the rows no longer carry. `rolesForShape` is
   * the same function the step machine consults to decide which questions it
   * no longer needs to ask.
   */
  const measuredRoles = rolesForShape(shape);
  const boundRoles = Object.keys(measuredRoles).length > 0 ? { ...roles, ...measuredRoles } : roles;

  const shared = {
    id,
    title,
    component: draft.component,
    roles: boundRoles,
    format,
    highlights,
    ...(Object.keys(settings).length > 0 ? { presentation: { settings } } : {}),
    ...(drilldown ? { drilldown } : {}),
    ...(context.shapes[draft.op]?.schemaHash
      ? { schemaHash: context.shapes[draft.op]!.schemaHash }
      : {}),
    /*
     * Who designed this, when one of the models did.
     *
     * Absent on a draft answered entirely by hand, and that is the honest
     * answer rather than a gap — the actions route to different models now,
     * and a widget nobody's model chose the fields for should not claim one.
     */
    ...(draft.model
      ? { producedBy: { model: draft.model, at: (options.now ?? (() => new Date()))().toISOString() } }
      : {}),
  };

  let spec: Record<string, unknown>;

  if (draft.series.length > 0) {
    /*
     * Several measurements over one axis, stacked into the long form charts
     * want: one row per bucket per series, with a column naming which.
     *
     * Each side is shaped by its own pipeline before anything is combined, so
     * what gets stacked is already reduced — the widget's own pipeline then
     * only has to sort, and re-grouping the union would collapse the series
     * back into one.
     *
     * This replaced a form that could express exactly one thing: two
     * endpoints, counted, over a date. Nothing about the union ever required
     * any of those three, and the runtime needed no change to drop them —
     * `sources` already allows four and the union already stacks all of them.
     */
    const sideSpec = (
      as: string,
      label: string,
      op: string,
      path: string,
      sideShape: WidgetShape,
      sideParams: Record<string, string>,
      fanOut?: SeriesDraft["fanOut"],
    ) => {
      /*
       * Each side flattens its own.
       *
       * The sides are different endpoints with different field names, and one
       * may measure a nested field where another does not — so the derive
       * belongs in the source's own pipeline rather than being collected
       * across all of them into a step that would name columns half of them
       * never carry.
       */
      const sideDerived: Record<string, string> = {};
      const flat = (name: string): string => {
        if (!name.includes(".")) return name;
        const [only] = flatten([name]).bound;
        if (only) sideDerived[only] = name;
        return only ?? name;
      };
      const measured: WidgetShape = {
        ...sideShape,
        groupBy: sideShape.groupBy.map((key) => ({ ...key, field: flat(key.field) })),
        measures: sideShape.measures.map((measure) =>
          measure.field ? { ...measure, field: flat(measure.field) } : measure,
        ),
      };

      return {
      as,
      label,
      connection: draft.connection,
      op,
      params: sideParams,
      pipeline: [
        { op: "extract", path: path || "$" },
        ...(Object.keys(sideDerived).length > 0
          ? [{ op: "derive", fields: sideDerived }]
          : []),
        ...shapeSteps(measured),
      ],
      ...(fanOut
        ? {
            fanOut: {
              from: fanOut.from,
              field: fanOut.field,
              ...(fanOut.as ? { as: fanOut.as } : {}),
              maxRows: fanOut.maxRows,
            },
          }
        : {}),
      };
    };

    /*
     * Every side made to group into the same column names.
     *
     * Stacking only produces a chart if the sides agree on what their columns
     * are called, and they are different endpoints with different field names
     * — one groups `ListingDate`, another `SubmittedOn`. Aligning here means
     * each side keeps its own names right up until the moment they are
     * combined, and no caller has to know the convention.
     */
    const aligned = (input: WidgetShape | undefined): WidgetShape => {
      const source = input ?? { groupBy: [], measures: [], sort: [] };
      return {
        ...source,
        groupBy: source.groupBy.map((key, index) =>
          index === 0 ? { ...key, as: SERIES_BUCKET } : key,
        ),
        measures: source.measures.map((measure, index) =>
          index === 0 ? { ...measure, as: SERIES_COUNT } : measure,
        ),
        // Sorting happens once, on the stacked rows, not per side.
        sort: [],
      };
    };

    const primaryShape = aligned(shape);
    /*
     * The primary side's label is the endpoint's own title, not the widget's.
     *
     * The widget's title names the whole comparison — "Listings vs
     * applications" — so putting it in a legend beside "Applications" reads as
     * nonsense. And an op id is not a label at all: it is the thing every
     * other part of this codebase works to keep off the screen.
     */
    const primaryLabel =
      context.ops.find((candidate) => candidate.id === draft.op)?.title ?? draft.op;

    /*
     * The endpoints fetched only to reach another one.
     *
     * A nested collection is reachable only through its parent's ids, so
     * counting applications across an account means fetching the applicants
     * they hang off — and applicants are not one of the things being measured.
     * They are added as hidden sources: paid for, reported in the cost, and
     * not drawn.
     *
     * Deduplicated, because two series can legitimately hang off the same
     * parent and fetching it twice would double the bill for one answer.
     */
    const drivers = new Map<string, string>();
    for (const side of draft.series) {
      const from = side.fanOut?.from;
      if (!from || from === draft.op || drivers.has(from)) continue;
      drivers.set(from, `d${drivers.size + 1}`);
    }

    const sources = [
      sideSpec(draft.op, primaryLabel, draft.op, draft.rowsPath, primaryShape, params),
      ...[...drivers.entries()].map(([op, as]) => ({
        as,
        connection: draft.connection,
        op,
        params: {},
        // Unshaped: the fan-out reads the ids off these rows, and any grouping
        // would destroy the very field it needs.
        pipeline: [{ op: "extract", path: context.shapes[op]?.rowsPath || "$" }],
        hidden: true,
      })),
      ...draft.series.map((side, index) =>
        sideSpec(
          // Two sides can be the same endpoint measured two ways, so the index
          // rather than the op id is what keeps the names distinct.
          `s${index + 1}`,
          side.label,
          side.op,
          side.rowsPath,
          aligned(side.shape),
          {},
          side.fanOut
            ? {
                ...side.fanOut,
                // The driver was named by endpoint; sources are named by `as`.
                from: side.fanOut.from === draft.op ? draft.op : drivers.get(side.fanOut.from)!,
              }
            : undefined,
        ),
      ),
    ];

    /*
     * The axis, taken from the primary side. Every side has been made to group
     * into the same column names by the time they are stacked, so one reading
     * describes all of them.
     */
    const axis = primaryShape.groupBy[0];
    spec = {
      ...shared,
      sources,
      combine: { op: "union", as: SERIES_LABEL },
      pipeline: axis ? [{ op: "sort", by: [{ field: groupColumn(axis), dir: "asc" }] }] : [],
      roles: rolesForShape(primaryShape, SERIES_LABEL),
    };

    why.push(
      `${[draft.title ?? draft.op, ...draft.series.map((side) => side.label)].join(" and ")} ` +
        "are measured separately and drawn as one series each",
    );
    /*
     * Said before it is saved, because it is the one thing a stacked
     * comparison quietly gets wrong: a bucket with none of one kind is absent
     * rather than zero, so a gap in a line means "nothing happened", not "no
     * data".
     */
    warnings.push("a period with none of one kind has no point on that line rather than a zero");
    for (const side of draft.series) {
      if (!side.fanOut) continue;
      warnings.push(
        `${side.label} is only listed per record, so it is read once per row up to ` +
          `${side.fanOut.maxRows} — past that the number is a sample rather than a total`,
      );
    }
  } else if (draft.join) {
    const leftAs = draft.op;
    const rightAs = draft.join.op;

    spec = {
      ...shared,
      sources: [
        {
          as: leftAs,
          connection: draft.connection,
          op: draft.op,
          params,
          pipeline: [{ op: "extract", path: draft.rowsPath || "$" }],
        },
        {
          as: rightAs,
          connection: draft.connection,
          op: draft.join.op,
          params: {},
          pipeline: [{ op: "extract", path: draft.join.rowsPath || "$" }],
          ...(draft.join.needsFanOut && draft.join.fanOutParam
            ? {
                fanOut: {
                  from: leftAs,
                  field: draft.join.leftField,
                  as: draft.join.fanOutParam,
                  maxRows: draft.join.maxRows,
                },
              }
            : {}),
        },
      ],
      combine: {
        op: "join",
        left: leftAs,
        right: rightAs,
        on: { left: draft.join.leftField, right: draft.join.rightField },
        kind: draft.join.kind,
      },
      // The rows arrive already extracted by each source, so the widget's own
      // pipeline starts at whatever shaping the joined set needs.
      pipeline: [...coerceStep, ...narrowStep],
    };

    why.push(
      `the two endpoints match on ${fieldLabel(draft.join.leftField, labels)} and ${fieldLabel(draft.join.rightField, labels)}`,
    );
    /*
     * The warning a join earns before it is saved, not after.
     *
     * A left join keeps rows that matched nothing, and a one-to-many match
     * repeats the left row — which turns a count into a number that is wrong
     * and looks right. `joinRows` reports both against the real rows; this
     * says the shape is capable of it, so nobody reads the first total in
     * good faith.
     */
    warnings.push(
      draft.join.kind === "left"
        ? `rows with no match on ${fieldLabel(draft.join.rightField, labels)} are kept with the second endpoint's columns empty`
        : `rows with no match on ${fieldLabel(draft.join.rightField, labels)} are dropped`,
      `if one row matches several, it appears several times — check any total before trusting it`,
    );
    if (draft.join.needsFanOut) {
      warnings.push(
        `the second endpoint is called once per row, up to ${draft.join.maxRows} — beyond that the join stops rather than silently truncating`,
      );
    }
  } else {
    spec = {
      ...shared,
      source: { connection: draft.connection, op: draft.op, params },
      pipeline: [
        { op: "extract", path: draft.rowsPath || "$" },
        /*
         * Before everything else that names a column. A coercion, a filter and
         * a group all refer to the flattened name, and none of them can while
         * it is still a dotted path nothing produced.
         */
        ...deriveStep,
        ...coerceStep,
        ...narrowStep,
        /*
         * What the widget measures, through the one emitter.
         *
         * This branch used to stop at the narrowing, which is why every
         * single-endpoint widget was raw rows bound to roles and why counting
         * anything was impossible here. Absent, it emits nothing and the
         * widget is exactly what it was before.
         */
        ...shapeSteps(shape),
      ],
    };
  }

  const parsed = parseWidget(spec);
  if (!parsed.value) return { ...fail(...(parsed.errors ?? ["the widget did not validate"])) };

  /* ── the offer ───────────────────────────────────────────────────────── */

  for (const role of contract.roles) {
    if (!role.required) continue;
    const bound = roles[role.role];
    const names = Array.isArray(bound) ? bound : bound ? [bound as string] : [];
    if (names.length > 0) {
      why.push(
        `${humanLabel(role.role)}: ${names.map((name) => fieldLabel(name, labels)).join(", ")}`,
      );
    }
  }
  if (draft.extras.length > 0) {
    why.push(
      `you also asked for ${draft.extras.map((name) => fieldLabel(name, labels)).join(", ")}`,
    );
  }

  const requests = 1 + (draft.join ? (draft.join.needsFanOut ? draft.join.maxRows : 1) : 0);

  return {
    widget: parsed.value,
    authored: {
      id,
      source: "chat",
      widget: parsed.value,
      headline: `${contract.title.toLowerCase()} of ${title.toLowerCase()}, built from your answers.`,
      why,
      confirm,
      // Everything here was chosen by a person against a real sample, which is
      // a stronger claim than either of the existing two — but the vocabulary
      // is fixed and "declared" is the honest half of it: nothing was guessed.
      confidence: "declared",
      cost: { requests, onOpen: drilldown ? 1 : 0 },
      // Ranking is meaningless for a widget somebody asked for by name; it
      // sorts above every suggestion because it is not one.
      score: 1_000,
    },
    errors: [],
    warnings,
    requiresFilters,
  };
};
