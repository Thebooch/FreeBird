import type { CompileBriefInput, PipelineStep, WidgetSpec } from "@freebirdai/dash-spec";
import { compileBrief } from "@freebirdai/dash-spec";
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
  if (input.brief.intent !== "records") return { patch: {}, notes: [], errors: [] };

  const compiled = compileBrief(input);
  const widget = compiled.widget;
  if (!widget) return { patch: {}, notes: compiled.notes, errors: compiled.errors };

  const notes = [...compiled.notes];

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
