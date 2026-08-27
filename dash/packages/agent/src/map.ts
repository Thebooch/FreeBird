import type {
  Coercion,
  GroupByShape,
  MeasureShape,
  PipelineStep,
  SemanticType,
  WidgetShape,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import {
  COMPONENT_IDS,
  coercionSchema,
  parseWidget,
  rolesForShape,
  semanticTypeSchema,
  shapeSteps,
  widgetShapeSchema,
} from "@freebirdai/dash-spec";
import type { InferredShape } from "./infer.js";
import type { Proposal } from "./tool.js";

/** What a plain row count produces, and what the value role then binds to. */
const COUNT_COLUMN = "count";

/**
 * Stage three, and entirely deterministic: the model's flat proposal becomes a
 * real spec by rule, not by generation. The model never writes the pipeline —
 * it says what the fields mean, and this builds the same pipeline every time
 * from the same answer.
 */

const AGGREGATIONS = new Set(["sum", "avg", "count", "countDistinct", "min", "max", "first", "last"]);

const safeCoercion = (value: string): Coercion | null => {
  const parsed = coercionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const safeSemantic = (value: string): SemanticType | null => {
  const parsed = semanticTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** A field name the expression grammar and the row schema both accept. */
const usable = (shape: InferredShape, name: string | undefined): string | undefined => {
  if (!name) return undefined;
  return shape.fields.some((field) => field.name === name) ? name : undefined;
};

/** Dotted paths need flattening into a real column before roles can bind. */
const needsDerive = (name: string | undefined): boolean => Boolean(name?.includes("."));

/** Coercions whose output is a number, so a string field can still be measured. */
const NUMERIC_COERCIONS = new Set<Coercion>([
  "->number",
  "money:cents->major",
  "money:major",
  "percent",
  "percent:fraction->percent",
  "unix_s->datetime",
  "unix_ms->datetime",
  "iso->datetime",
  "auto->datetime",
]);

/**
 * Can this field actually be measured?
 *
 * `sum()` over a column of strings quietly returns 0, which renders a
 * confident, wrong chart — the exact failure this project exists to prevent.
 * A field bound to a numeric role has to be a number, or be coerced into one.
 */
const isMeasurable = (
  shape: InferredShape,
  name: string | undefined,
  coercions: Readonly<Record<string, Coercion>>,
): boolean => {
  if (!name) return false;
  const field = shape.fields.find((candidate) => candidate.name === name);
  if (!field) return false;
  if (field.kinds.includes("number")) return true;
  const coercion = coercions[name];
  return coercion !== undefined && NUMERIC_COERCIONS.has(coercion);
};

const flatName = (name: string): string => name.replace(/\./g, "_");

export interface MappedProposal {
  readonly widget: WidgetSpec | null;
  /**
   * What this widget measures, as a shape rather than as finished steps.
   *
   * Handed back so the draft can store the same decision the preview was built
   * from. Two separate constructions is what the shape exists to end, and
   * returning it here is what makes "the preview and the saved widget agree"
   * true by construction rather than by both being written carefully.
   *
   * Called `measurement` and not `shape` only because `shape` is already the
   * inferred field list in every caller of this function.
   */
  readonly measurement: WidgetShape | null;
  readonly errors: readonly string[];
  readonly ambiguities: ReadonlyArray<{ field: string; question: string; options: string[] }>;
}

export const mapProposal = (input: {
  proposal: Proposal;
  shape: InferredShape;
  connection: string;
  op: string;
  widgetId: string;
}): MappedProposal => {
  const { proposal, shape, connection, op, widgetId } = input;

  if (!(COMPONENT_IDS as readonly string[]).includes(proposal.component)) {
    return {
      widget: null,
      measurement: null,
      errors: [`"${proposal.component}" is not a component (expected one of ${COMPONENT_IDS.join(", ")})`],
      ambiguities: proposal.ambiguities ?? [],
    };
  }
  const component = proposal.component as (typeof COMPONENT_IDS)[number];

  const pipeline: PipelineStep[] = [];
  const rowsPath = proposal.rowsPath?.startsWith("$") ? proposal.rowsPath : shape.rowsPath;
  pipeline.push({ op: "extract", path: rowsPath });

  // ── coercions ───────────────────────────────────────────────────────────
  const coercions: Record<string, Coercion> = {};
  for (const entry of proposal.coercions ?? []) {
    const field = usable(shape, entry.field);
    const coercion = safeCoercion(entry.coercion);
    if (field && coercion && !field.includes(".")) coercions[field] = coercion;
  }
  if (Object.keys(coercions).length > 0) pipeline.push({ op: "coerce", fields: coercions });

  // ── flatten any dotted field the roles need ─────────────────────────────
  const roleSources = [
    proposal.timeField,
    proposal.valueField,
    proposal.categoryField,
    proposal.seriesField,
    proposal.bucketField,
    proposal.labelField,
    proposal.statusField,
    proposal.titleField,
    proposal.subtitleField,
    proposal.metaField,
    proposal.hrefField,
    proposal.maxField,
    proposal.compareField,
    proposal.targetField,
    ...(proposal.columns ?? []),
  ].filter((name): name is string => Boolean(usable(shape, name)));

  const derived: Record<string, string> = {};
  for (const name of roleSources) {
    if (needsDerive(name)) derived[flatName(name)] = name;
  }
  if (Object.keys(derived).length > 0) pipeline.push({ op: "derive", fields: derived });

  const resolve = (name: string | undefined): string | undefined => {
    const found = usable(shape, name);
    if (!found) return undefined;
    return needsDerive(found) ? flatName(found) : found;
  };

  const time = resolve(proposal.timeField);
  const value = resolve(proposal.valueField);
  const category = resolve(proposal.categoryField);
  const series = resolve(proposal.seriesField);
  const bucket = resolve(proposal.bucketField);
  const label = resolve(proposal.labelField);
  const status = resolve(proposal.statusField);
  const title = resolve(proposal.titleField);
  const subtitle = resolve(proposal.subtitleField);
  const meta = resolve(proposal.metaField);
  const href = resolve(proposal.hrefField);
  const max = resolve(proposal.maxField);
  const compare = resolve(proposal.compareField);
  const target = resolve(proposal.targetField);

  const fn = AGGREGATIONS.has(proposal.aggregation ?? "") ? proposal.aggregation! : "sum";

  /**
   * Counting rows, which takes no column — and which used to be impossible to
   * say.
   *
   * The system prompt tells the model, correctly, that "how many" means
   * `aggregation: "count"` with no value field. This function then required a
   * value field for every aggregating component and rejected exactly that. So
   * the only proposals that survived were the ones naming a number to sum,
   * which is how "the number of listings per month" became "the total rent of
   * the listings per month" — a confident, beautiful answer to a question
   * nobody asked.
   *
   * A count produces a column like any other aggregation; it just names itself
   * rather than borrowing a field's name.
   */
  /*
   * The measurement the model described outright, where it did.
   *
   * `aggregation` plus a role field can only ever say one number over one
   * axis. When the model uses the explicit form it can say more, and what it
   * says wins — the per-component defaults below exist to cover the case where
   * nobody said anything, not to overrule somebody who did.
   *
   * Every name is still checked against the real schema, and an aggregation
   * this codebase cannot parse is dropped rather than passed through to fail
   * later.
   */
  const statedMeasures: MeasureShape[] = (proposal.measures ?? []).flatMap((entry) => {
    if (!AGGREGATIONS.has(entry.agg)) return [];
    const field = resolve(entry.field);
    if (entry.agg !== "count" && !field) return [];
    const as = field ?? COUNT_COLUMN;
    return [
      {
        as,
        agg: entry.agg as MeasureShape["agg"],
        ...(field ? { field } : {}),
        ...(entry.label ? { label: entry.label } : {}),
      },
    ];
  });

  const statedGroupBy: GroupByShape[] = (proposal.groupBy ?? []).flatMap((entry) => {
    const field = resolve(entry.field);
    if (!field) return [];
    return [
      {
        field,
        // No bucket named means follow the dashboard's grain, which is what
        // keeps a chart moving with the board's own time control.
        ...(entry.bucket ? { bucket: entry.bucket } : {}),
      },
    ];
  });

  /*
   * One definition of what is being measured, whether the model said it
   * outright or left it to be inferred from `aggregation` and a role field.
   *
   * They have to be one decision. Kept separate, the guards below asked
   * whether a value field had been named and answered no for a proposal that
   * had stated a perfectly good count — refusing the clearer of the two forms.
   */
  const primary = statedMeasures[0];
  const counting = primary ? primary.agg === "count" && !primary.field : fn === "count" && !value;
  /** The column the measurement produces, and what the value role binds to. */
  const measured = primary ? primary.as : counting ? COUNT_COLUMN : value;

  /**
   * What this component measures, filled in per component and emitted once.
   *
   * Built as a `WidgetShape` rather than as pipeline steps so that the preview
   * built here and the widget written on confirm go through the same emitter.
   * They used to be two separate constructions, and they disagreed about
   * whether counting was possible at all.
   */
  const measuring: {
    filter?: string;
    groupBy: GroupByShape[];
    measures: MeasureShape[];
    sort: Array<{ field: string; dir: "asc" | "desc" }>;
  } = {
    ...(proposal.filterWhere ? { filter: proposal.filterWhere } : {}),
    groupBy: [],
    measures: [],
    sort: [],
  };

  /** One measurement over the resolved value column, or a plain row count. */
  const measureOf = (): MeasureShape =>
    primary ??
    (counting
      ? { as: COUNT_COLUMN, agg: "count" }
      : { as: measured!, agg: fn as MeasureShape["agg"], field: value! });

  const roles: Record<string, string | string[]> = {};
  const format: Record<string, { semantic: SemanticType; currency?: string }> = {};
  const errors: string[] = [];

  // Reject a non-numeric field bound to a numeric role up front, rather than
  // letting the pipeline aggregate it into a confident zero.
  const numericRoleComponents = new Set([
    "stat",
    "metricRow",
    "timeseries",
    "bar",
    "gauge",
    "progress",
    "funnel",
  ]);
  if (
    numericRoleComponents.has(component) &&
    proposal.valueField &&
    usable(shape, proposal.valueField) &&
    !isMeasurable(shape, proposal.valueField, coercions)
  ) {
    return {
      widget: null,
      measurement: null,
      errors: [
        `"${proposal.valueField}" is not a number, so it cannot fill the value role of a ${component}. Pick a numeric field, or add a coercion that produces one.`,
      ],
      ambiguities: proposal.ambiguities ?? [],
    };
  }

  switch (component) {
    case "timeseries": {
      if (!time || !measured) {
        errors.push("a timeseries needs a time field, and either a value field or a count");
        break;
      }
      measuring.groupBy = [
        { field: time, bucket: "{{range.grain}}" },
        ...(series ? [{ field: series }] : []),
      ];
      measuring.measures = [measureOf()];
      measuring.sort = [{ field: time, dir: "asc" }];
      roles.time = time;
      roles.value = measured;
      if (series) roles.series = series;
      break;
    }

    case "bar": {
      if (!category || !measured) {
        errors.push("a bar chart needs a category field, and either a value field or a count");
        break;
      }
      measuring.groupBy = [{ field: category }, ...(series ? [{ field: series }] : [])];
      measuring.measures = [measureOf()];
      roles.category = category;
      roles.value = measured;
      if (series) roles.series = series;
      break;
    }

    case "distribution": {
      const key = bucket ?? category;
      if (!key) {
        errors.push("a distribution needs a bucket field");
        break;
      }
      measuring.groupBy = [{ field: key }];
      measuring.measures = [{ as: COUNT_COLUMN, agg: "count" }];
      measuring.sort = [{ field: key, dir: "asc" }];
      roles.bucket = key;
      roles.count = COUNT_COLUMN;
      format[COUNT_COLUMN] = { semantic: "count" };
      break;
    }

    case "stat": {
      if (!measured) {
        errors.push("a stat needs a value field, or a count");
        break;
      }
      // A single-row summary endpoint needs no aggregation; many rows do, and
      // the emitter groups on a constant to total them without a special case.
      if (shape.rowCount > 1) measuring.measures = [measureOf()];
      roles.value = measured;
      if (compare && shape.rowCount <= 1) roles.compare = compare;
      break;
    }

    case "metricRow": {
      if (!label || !measured) {
        errors.push("a metric row needs a label field, and either a value field or a count");
        break;
      }
      /*
       * Grouped by the label, so a row per entity becomes a tile per entity.
       * Without this an endpoint returning many rows per label renders the
       * same name several times with a slice of the number under each.
       */
      measuring.groupBy = [{ field: label }];
      measuring.measures = [measureOf()];
      roles.label = label;
      roles.value = measured;
      if (compare) roles.compare = compare;
      if (target) roles.target = target;
      if (status) roles.status = status;
      if (meta) roles.caption = meta;
      break;
    }

    case "gauge": {
      if (!value) {
        errors.push("a gauge needs a value field");
        break;
      }
      roles.value = value;
      if (max) roles.max = max;
      break;
    }

    case "list": {
      if (!title) {
        errors.push("a list needs a title field");
        break;
      }
      roles.title = title;
      if (subtitle) roles.subtitle = subtitle;
      if (meta) roles.meta = meta;
      if (href) roles.href = href;
      if (status) roles.status = status;
      break;
    }

    case "cards": {
      if (!title) {
        errors.push("a card needs a title field");
        break;
      }
      roles.title = title;
      if (subtitle) roles.subtitle = subtitle;
      // `meta` is a multi role here, unlike on a list, so the single proposed
      // field arrives as a one-element list rather than a bare string.
      if (meta) roles.meta = [meta];
      if (status) roles.status = status;
      if (href) roles.href = href;
      break;
    }

    case "board": {
      const column = category ?? status;
      if (!column || !title) {
        errors.push("a board needs a column to group by and a title field");
        break;
      }
      roles.group = column;
      roles.title = title;
      if (subtitle) roles.subtitle = subtitle;
      if (meta) roles.meta = meta;
      // Only when it says something the column does not already.
      if (status && status !== column) roles.status = status;
      break;
    }

    case "timeline":
    case "feed": {
      if (!time || !title) {
        errors.push(`a ${component} needs a time field and a title field`);
        break;
      }
      /*
       * Newest first. The component sorts too, but doing it here means the
       * inspector's trace shows the order the widget is actually in rather
       * than the order the endpoint happened to return.
       */
      pipeline.push({ op: "sort", by: [{ field: time, dir: "desc" }] });
      roles.time = time;
      roles.title = title;
      if (subtitle) roles.subtitle = subtitle;
      if (status) roles.status = status;
      if (component === "feed") {
        if (label) roles.actor = label;
        if (meta) roles.meta = meta;
        if (href) roles.href = href;
      }
      break;
    }

    case "progress": {
      if (!label || !measured) {
        errors.push("a progress list needs a label field, and either a value field or a count");
        break;
      }
      measuring.groupBy = [{ field: label }];
      measuring.measures = [measureOf()];
      roles.label = label;
      roles.value = measured;
      if (max) roles.max = max;
      if (status) roles.status = status;
      break;
    }

    case "funnel": {
      const stage = category ?? label;
      if (!stage || !measured) {
        errors.push("a funnel needs a stage field, and either a value field or a count");
        break;
      }
      /*
       * Deliberately no sort. A funnel's stages are a sequence the API
       * already knows — sorting by value would reorder them into a shape that
       * always descends, which is exactly the fact the chart exists to show
       * or disprove.
       */
      measuring.groupBy = [{ field: stage }];
      measuring.measures = [measureOf()];
      roles.stage = stage;
      roles.value = measured;
      break;
    }

    case "calendar": {
      if (!time || !title) {
        errors.push("a calendar needs a date field and a title field");
        break;
      }
      roles.start = time;
      roles.title = title;
      if (status) roles.status = status;
      break;
    }

    case "statusGrid": {
      if (!label || !status) {
        errors.push("a status grid needs a label field and a status field");
        break;
      }
      roles.label = label;
      roles.status = status;
      if (meta) roles.meta = meta;
      break;
    }

    case "table": {
      const columns = (proposal.columns ?? [])
        .map((name) => resolve(name))
        .filter((name): name is string => Boolean(name));
      if (columns.length === 0) {
        errors.push("a table needs at least one column");
        break;
      }
      pipeline.push({ op: "select", fields: columns });
      roles.columns = columns;
      break;
    }
  }

  /*
   * The measurement, emitted once, through the one function that does it.
   *
   * Validated on the way out rather than trusted: the caps and the
   * count-only-omits-a-field rule live on the schema, so a mistake in the
   * construction above is a reported error here and not a pipeline that fails
   * to parse three layers later.
   */
  /*
   * What the model stated outright wins — and the role that binds to the
   * measurement has to move with it, or the value axis names a column the
   * pipeline no longer produces.
   */
  if (statedMeasures.length > 0) {
    // More than one measure is only expressible in the stated form, so the
    // per-component default never produced the rest of them.
    measuring.measures = statedMeasures;
  }
  if (counting && measured) format[measured] = { semantic: "count" };

  /*
   * Grouping is deliberately narrower: a stated key supplies the *bucket* for
   * a field the component already grouped on, and replaces the grouping only
   * where the component chose none.
   *
   * Which fields group is already the model's decision — `timeField`,
   * `categoryField` and `seriesField` are its answers. The one thing it could
   * not say was how wide a bucket is, so "per month" had to become whatever
   * the dashboard's grain happened to be. That is the gap this closes, and
   * replacing a component's whole grouping would desync the roles bound above
   * it for no gain.
   */
  for (const stated of statedGroupBy) {
    if (!stated.bucket) continue;
    const existing = measuring.groupBy.find((key) => key.field === stated.field);
    if (existing) existing.bucket = stated.bucket;
  }
  if (measuring.groupBy.length === 0 && statedGroupBy.length > 0) {
    measuring.groupBy = statedGroupBy;
    Object.assign(roles, rolesForShape({ ...measuring, limit: undefined } as never));
  }

  const measuredShape = widgetShapeSchema.safeParse(measuring);
  if (measuredShape.success) {
    pipeline.push(...shapeSteps(measuredShape.data));
  } else {
    errors.push(
      `the measurement did not validate: ${measuredShape.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  for (const entry of proposal.semantics ?? []) {
    const field = resolve(entry.field);
    const semantic = safeSemantic(entry.semantic);
    if (!field || !semantic) continue;
    format[field] = {
      semantic,
      ...(semantic === "currency" && proposal.currency ? { currency: proposal.currency } : {}),
    };
  }

  if (errors.length > 0) {
    return { widget: null, measurement: null, errors, ambiguities: proposal.ambiguities ?? [] };
  }

  const parsed = parseWidget({
    id: widgetId,
    title: proposal.title || "Untitled",
    component,
    source: { connection, op, params: {} },
    pipeline,
    roles,
    format,
    schemaHash: shape.schemaHash,
    states: proposal.emptyMessage ? { empty: proposal.emptyMessage } : {},
  });

  return {
    widget: parsed.value ?? null,
    measurement: measuredShape.success ? measuredShape.data : null,
    errors: parsed.errors,
    ambiguities: proposal.ambiguities ?? [],
  };
};
