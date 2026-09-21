import type {
  Coercion,
  CompileBriefInput,
  PipelineStep,
  WidgetShape,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import { ALL_ROWS, compileBrief, parseAggregation } from "@freebirdai/dash-spec";
import type { DraftPatch } from "./revise.js";

/**
 * A brief, as an answer the existing setup already understands.
 *
 * The bridge that lets the chat decide entity-first without rewriting the card
 * it decides into. A draft patch already speaks this vocabulary — an endpoint,
 * a component, a role for each field, strips to filter by, something to group
 * on, something to measure — so what changes is *who decides*, not what a
 * decision looks like.
 *
 * That distinction is the whole point. The failure worth fixing was never the
 * card or its questions; it was that "show me X filtered by Y" could only be
 * expressed as a grouping, and so came back as a chart. The brief settles that
 * before a patch is written, and everything downstream is untouched.
 *
 * **Read back out of the compiled widget rather than decided again.** The
 * compiler already chose the component, the columns and the roles, and
 * deciding them a second time here is how two paths that agree today disagree
 * in a year. The one translation needed is backwards: a widget binds columns
 * (`Category_Name`) and a draft names the API's own fields (`Category.Name`),
 * and the widget's own `derive` step is the record of which became which — so
 * inverting it is exact rather than a guess about underscores.
 */

/** The columns a widget binds that came from the far side of a join. */
const farColumnsOf = (
  roles: Readonly<Record<string, string | readonly string[]>>,
  prefix: string,
): string[] =>
  Object.values(roles)
    .flatMap((bound) => (Array.isArray(bound) ? bound : [bound as string]))
    .filter((column) => column.startsWith(`${prefix}_`))
    .map((column) => column.slice(prefix.length + 1));

/** column → the field it was derived from, straight off a pipeline. */
const fieldsOf = (pipeline: readonly PipelineStep[]): ((column: string) => string) => {
  const step = pipeline.find((one) => one.op === "derive");
  const derived = new Map(
    Object.entries(step && step.op === "derive" ? step.fields : {}).map(
      ([column, field]) => [column, field] as const,
    ),
  );
  return (column: string): string => derived.get(column) ?? column;
};

/**
 * A source's conversions, in the API's own spelling.
 *
 * The compiler wrote them into the source's pipeline from what the record
 * type declares; the draft carries them as `coercions`, keyed by field rather
 * than by the column a derive step made of it. Carried so the widget the card
 * builds converts what the compiled one would have — a conversion decided once
 * and lost in translation is a value that renders differently depending on
 * which door the widget came in by.
 */
const coercionsOf = (
  pipeline: readonly PipelineStep[],
): { coercions?: Record<string, Coercion> } => {
  const step = pipeline.find((one) => one.op === "coerce");
  if (!step || step.op !== "coerce") return {};
  const fieldOf = fieldsOf(pipeline);
  const coercions = Object.fromEntries(
    Object.entries(step.fields).map(([column, coercion]) => [fieldOf(column), coercion]),
  ) as Record<string, Coercion>;
  return Object.keys(coercions).length > 0 ? { coercions } : {};
};

/**
 * A measurement, as the shape a draft already understands.
 *
 * The other half of the same translation. A patch cannot describe a count the
 * way it describes a column — `measure` and `groupBy` are steps that *change*
 * a shape, and a `value` role bound to an aggregate names a column the
 * endpoint does not have. `shape` is the key that carries one whole, and
 * `buildFromDraft` binds the roles from it rather than from anything sent
 * here: `rolesForShape` overrides whatever a patch bound, because after a
 * group step the endpoint's own columns are gone.
 *
 * Read off the compiled widget's own pipeline, in the API's spelling — the
 * same inversion `proposalPatch` performs, and for the same reason: the widget
 * carries the flattened column and the step that validates this offers the
 * field the API declares.
 *
 * Without this, asking the assistant for a chart or a count produced an empty
 * patch and a sentence saying the widget could not be built — of a brief that
 * had compiled perfectly well.
 */
const shapeOf = (
  widget: WidgetSpec,
  fieldOf: (column: string) => string,
): WidgetShape | null => {
  const group = widget.pipeline.find((step) => step.op === "group");
  if (!group || group.op !== "group") return null;

  const measures: WidgetShape["measures"] = [];
  for (const [as, expression] of Object.entries(group.agg)) {
    const parsed = parseAggregation(expression);
    if (!parsed) return null;
    measures.push({
      as,
      agg: parsed.fn,
      ...(parsed.field ? { field: fieldOf(parsed.field) } : {}),
    });
  }

  const sort = widget.pipeline.find((step) => step.op === "sort");
  const limit = widget.pipeline.find((step) => step.op === "limit");

  return {
    /*
     * The constant grouping is dropped rather than carried.
     *
     * Totalling every row is grouping on a literal `1`, which is how the
     * pipeline says "all of them" — but it is a detail of the emitted steps,
     * not of what was asked. `shapeSteps` puts it back on the way out, so
     * carrying it here would ask the draft to name a column the endpoint has
     * never heard of.
     */
    groupBy: group.by
      .filter((key) => key.field !== ALL_ROWS)
      .map((key) => ({
        field: fieldOf(key.field),
        ...(key.bucket ? { bucket: key.bucket } : {}),
        ...(key.as ? { as: key.as } : {}),
      })),
    measures,
    sort:
      sort && sort.op === "sort"
        ? sort.by.map((key) => ({ field: fieldOf(key.field), dir: key.dir ?? "asc" }))
        : [],
    ...(limit && limit.op === "limit" ? { limit: limit.count } : {}),
  };
};

export const patchFromBrief = (
  input: CompileBriefInput,
): { patch: DraftPatch; notes: readonly string[]; errors: readonly string[] } => {
  /*
   * A list of records, and deliberately nothing else.
   *
   * A measurement cannot be expressed as a patch at all: the draft derives its
   * shape from the component and the roles bound to it, and its `measure` and
   * `groupBy` steps exist only to *change* a shape that already exists — so a
   * patch naming either is rejected as not applying to the widget, and a
   * `value` role bound to an aggregate column names a field the endpoint does
   * not have. That is a structural difference between the two models, not an
   * oversight to paper over.
   *
   * It also costs nothing worth having. The older path builds charts correctly
   * and always has; the reading it got wrong was the one where somebody asked
   * to *see* records and was handed a chart instead. That is the reading this
   * replaces, and a measurement is left where it already works.
   */
  const compiled = compileBrief(input);
  const widget = compiled.widget;
  if (!widget) return { patch: {}, notes: compiled.notes, errors: compiled.errors };

  const notes = [...compiled.notes];

  /*
   * A number, or a number broken down — carried as a shape rather than as
   * roles.
   *
   * These used to be handed back as an empty patch on the reasoning that a
   * draft cannot express a measurement. It can: `shape` is a first-class patch
   * key, `applyShape` validates it against the endpoint's own field names, and
   * `buildFromDraft` binds the roles from it. What a patch cannot express is a
   * measurement described as *steps* — `measure` and `groupBy` change a shape
   * that already exists — which is a different thing.
   *
   * Sending nothing was not neutral. With the endpoint-first planner retired
   * there is nothing behind this to catch it, so asking for a chart produced a
   * refusal to build a brief that had compiled perfectly well.
   */
  if (input.brief.intent !== "records") {
    const shape = shapeOf(widget, fieldsOf(widget.pipeline));
    /*
     * Two measurements stacked on one axis.
     *
     * Each side does its own grouping inside its own source, so the widget's
     * pipeline has none to read back — the shapes are read off each source's
     * pipeline instead, and the second arrives as `seriesWith`, which is how a
     * draft has always carried a comparison. That machinery sat complete and
     * unreachable once the endpoint-first planner that wrote it was retired,
     * and this request was refused at the card for want of a writer.
     *
     * The column names each side groups into are deliberately not carried:
     * `buildFromDraft` aligns every side onto its own names at the moment they
     * are stacked, so sending the compiler's would be sending a convention the
     * builder immediately replaces.
     */
    const union = !shape && widget.combine?.op === "union";
    const sides = union ? widget.sources.filter((source) => !source.hidden) : [];
    const sideShapes = sides.map((source) => ({
      source,
      shape: shapeOf({ ...widget, pipeline: source.pipeline }, fieldsOf(source.pipeline)),
    }));
    const [first, ...rest] = sideShapes;
    if (union && first?.shape && rest.length > 0 && rest.every((side) => side.shape)) {
      return {
        patch: {
          connection: input.connection,
          entity: input.entity.id,
          brief: widget.brief,
          endpoint: first.source.op,
          component: widget.component,
          shape: first.shape,
          ...coercionsOf(first.source.pipeline),
          seriesWith: rest.map((side) => ({
            endpoint: side.source.op,
            label: (side.source.label ?? side.source.op).slice(0, 80),
            shape: side.shape!,
            ...coercionsOf(side.source.pipeline),
            ...(side.source.fanOut
              ? {
                  fanOut: {
                    // The draft names a driver by its endpoint; the widget by its source.
                    from:
                      widget.sources.find((one) => one.as === side.source.fanOut!.from)?.op ??
                      side.source.fanOut.from,
                    field: side.source.fanOut.field,
                    ...(side.source.fanOut.as ? { as: side.source.fanOut.as } : {}),
                    maxRows: side.source.fanOut.maxRows,
                  },
                }
              : {}),
          })),
          ...(Object.keys(widget.format).length > 0 ? { format: widget.format } : {}),
        },
        notes,
        errors: compiled.errors,
      };
    }
    if (!shape) {
      notes.push(
        widget.sources.length > 1
          ? "This compares two kinds of record in a way the setup card cannot carry — ask for one of them and add the other afterwards."
          : `${input.entity.name.many} could not be measured from what this API offers.`,
      );
      return { patch: {}, notes, errors: compiled.errors };
    }
    return {
      patch: {
        connection: input.connection,
        entity: input.entity.id,
        brief: widget.brief,
        ...(widget.source?.op ? { endpoint: widget.source.op } : {}),
        component: widget.component,
        shape,
        /*
         * Deliberately no `roles`. After a group step the endpoint's own
         * columns are gone, and `buildFromDraft` replaces whatever a patch
         * bound with `rolesForShape(shape)` for exactly that reason — so
         * sending them would be sending something guaranteed to be discarded.
         */
        ...(Object.keys(widget.format).length > 0 ? { format: widget.format } : {}),
      },
      notes,
      errors: compiled.errors,
    };
  }

  /*
   * The two sides of a join, where the brief asked for one.
   *
   * A joined widget has no single `source`: the primary endpoint is the first
   * of two, and the second arrives as `joinWith` — which the card applies
   * before it binds anything, so the questions are asked against the columns
   * the joined rows will really carry.
   */
  const joined: (WidgetSpec["combine"] & { op: "join" }) | null =
    widget.combine?.op === "join" ? widget.combine : null;
  const left = joined ? widget.sources.find((one) => one.as === joined.left) : undefined;
  const right = joined ? widget.sources.find((one) => one.as === joined.right) : undefined;

  const fieldOf = fieldsOf(left?.pipeline ?? widget.pipeline);
  const farFieldOf = fieldsOf(right?.pipeline ?? []);

  /*
   * The two sides are named in the API's own spelling, nested fields and all.
   *
   * `buildFromDraft` flattens a dotted key into the source it belongs to
   * before the match, so this hands over what the record types recorded rather
   * than a column name only the compiled widget would have produced.
   */
  const leftField = joined ? fieldOf(joined.on.left) : "";
  const rightField = joined ? farFieldOf(joined.on.right) : "";
  const joinable = joined !== null && right !== undefined;
  /*
   * The far record's own columns come through where they are columns.
   *
   * Only the join key is flattened on the far side, because it is the only
   * field `buildFromDraft` knows it needs before the match. A nested one among
   * the columns would arrive as a prefixed object, so it is dropped here and
   * said out loud — the join itself is unaffected.
   */
  const nestedFar =
    joinable && right
      ? farColumnsOf(widget.roles, right.as).filter((name) => farFieldOf(name).includes("."))
      : [];
  if (nestedFar.length > 0 && right) {
    notes.push(
      `${nestedFar.length === 1 ? "One field" : `${nestedFar.length} fields`} of ${right.label ?? right.op} could not be shown beside these: ${nestedFar.length === 1 ? "it sits" : "they sit"} inside another record, which this view cannot read.`,
    );
  }

  /**
   * A column, as the card will name it.
   *
   * Both prefix the far side's columns with the source that produced them, and
   * they disagree about what that source is called: the compiled widget names
   * it after the record type, and the card after the endpoint. One translation
   * here beats teaching either of them the other's convention.
   */
  const columnOf = (column: string): string | null => {
    if (!right || !column.startsWith(`${right.as}_`)) return fieldOf(column);
    /*
     * A column of the far record's, where the join that produces it survived.
     * Where it did not, the column goes with it: binding a role to one the
     * rows will never carry is the "this view no longer matches its data"
     * failure, arrived at deliberately.
     */
    if (!joinable) return null;
    const far = farFieldOf(column.slice(right.as.length + 1));
    return far.includes(".") ? null : `${right.op}_${far}`;
  };

  const roles: Record<string, string[]> = {};
  for (const [role, bound] of Object.entries(widget.roles)) {
    const columns = Array.isArray(bound) ? bound : [bound];
    roles[role] = columns.flatMap((column) => columnOf(column) ?? []);
  }

  return {
    patch: {
      connection: input.connection,
      /*
       * The request itself, so the finished widget stays editable. Everything
       * below is derived from it; storing only the derivation is what made a
       * widget's decisions die the moment it reached a board.
       */
      brief: widget.brief,
      /*
       * Carried, because it is what lets the finished widget's rows open the
       * *shared* page for this record type — and so the one thing that stops
       * the confirm step spending a model call on a private record view for
       * every widget, frozen as it was the day it was written.
       */
      entity: input.entity.id,
      ...(widget.source?.op ?? left?.op ? { endpoint: widget.source?.op ?? left?.op } : {}),
      ...(joinable && joined && right
        ? { joinWith: { endpoint: right.op, leftField, rightField, kind: joined.kind } }
        : {}),
      component: widget.component,
      roles,
      /*
       * A strip above the rows, never a pipeline filter — which is the whole
       * distinction the brief exists to keep: this narrows what somebody is
       * looking at and can be put back.
       */
      ...(widget.facets.length > 0
        ? { filters: widget.facets.map((facet) => fieldOf(facet.field)) }
        : {}),
    },
    notes,
    errors: compiled.errors,
  };
};
