import type { ColumnMeta, ColumnReference, EntityLinkView, WidgetSpec } from "@freebirdai/dash-spec";
import { widgetSources } from "@freebirdai/dash-spec";

/**
 * Columns that hold another record's identity, marked as such.
 *
 * The join between what an API map knows and what a component can draw. The
 * map speaks in the API's own field paths — `Vendor.Id` — and a component only
 * ever sees the columns a pipeline produced, which for a nested field is
 * `Vendor_Id` because a `derive` step made it one. Every reference would miss
 * without that translation, and the ones that would miss are exactly the
 * nested ones: the id inside an object is the commonest shape a foreign key
 * takes.
 *
 * Read from the widget's own derive steps rather than by turning underscores
 * back into dots, for the same reason `labelColumns` does: the second is a
 * guess and wrong on any API that names a field `postal_code`, while the spec
 * states the mapping outright.
 */

/** A dotted path naming exactly one field, rather than a computed expression. */
const PLAIN_PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;

/**
 * Column name → the API field it was derived from.
 *
 * Shared with `labelColumns`, which needs the identical reading. Two copies of
 * this would drift on exactly the case that matters — a nested field — and the
 * symptom would be a label or a link quietly failing to appear.
 */
export const derivedSources = (widget: WidgetSpec): Record<string, string> => {
  const sources: Record<string, string> = {};
  const read = (steps: WidgetSpec["pipeline"]): void => {
    for (const step of steps) {
      if (step.op !== "derive") continue;
      for (const [name, source] of Object.entries(step.fields)) {
        if (PLAIN_PATH.test(source)) sources[name] = source;
      }
    }
  };
  read(widget.pipeline);
  for (const source of widget.sources) read(source.pipeline);
  return sources;
};

/** The inverse: an API field path → the column carrying it, where one does. */
const columnsByPath = (
  columns: readonly ColumnMeta[],
  widget: WidgetSpec,
): Map<string, string> => {
  const byPath = new Map<string, string>();
  // A plain field is its own column, and a derived one wins where both exist:
  // the derive is what actually produced the value being rendered.
  for (const column of columns) byPath.set(column.name, column.name);
  for (const [column, path] of Object.entries(derivedSources(widget))) {
    if (columns.some((candidate) => candidate.name === column)) byPath.set(path, column);
  }
  return byPath;
};

/**
 * Which record type a widget's rows are, from what it reads.
 *
 * `widget.entity` when it says so — a widget built since entities existed
 * names its own. Otherwise matched on the endpoint, which covers every widget
 * saved before that and needs no migration.
 */
export const entityFor = (
  widget: WidgetSpec,
  links: Readonly<Record<string, readonly EntityLinkView[]>>,
): EntityLinkView | undefined => {
  const primary = widgetSources(widget)[0];
  if (!primary) return undefined;
  const forConnection = links[primary.connection] ?? [];
  return widget.entity
    ? forConnection.find((view) => view.entity === widget.entity)
    : forConnection.find((view) => view.ops.includes(primary.op));
};

export const referenceColumns = (
  columns: readonly ColumnMeta[],
  widget: WidgetSpec,
  links: Readonly<Record<string, readonly EntityLinkView[]>> | undefined,
): ColumnMeta[] => {
  if (!links || columns.length === 0) return [...columns];

  /*
   * After a group step there are no records left, only buckets.
   *
   * A reference is a statement about a record — the same reason charts ignore
   * highlights and carry no filter strip. Marking a grouped column as a link
   * would offer to open "the vendor" behind a monthly count, which is not a
   * thing that exists.
   */
  const aggregated =
    widget.pipeline.some((step) => step.op === "group") ||
    widget.sources.some((source) => source.pipeline.some((step) => step.op === "group"));
  if (aggregated) return [...columns];

  const entity = entityFor(widget, links);
  if (!entity) return [...columns];

  const byPath = columnsByPath(columns, widget);
  const marked = new Map<string, ColumnReference>();
  /* How each record type says its own name, for the far side of a link. */
  const titles = new Map(
    (links[widgetSources(widget)[0]?.connection ?? ""] ?? []).map((view) => [
      view.entity,
      { fields: view.title, mode: view.titleMode },
    ]),
  );

  for (const reference of entity.references) {
    const column = byPath.get(reference.field);
    // A reference the widget does not show is not a column to mark.
    if (column === undefined) continue;

    const typeColumn = reference.typeField
      ? byPath.get(reference.typeField.field)
      : undefined;

    marked.set(column, {
      target: reference.target,
      targetName: reference.targetName,
      targetTitle: titles.get(reference.target)?.fields ?? [],
      ...(titles.get(reference.target)?.mode
        ? { targetTitleMode: titles.get(reference.target)!.mode }
        : {}),
      holds: reference.holds,
      /*
       * Only the embedded names this widget actually renders. A name the row
       * carries but the pipeline dropped cannot be read off the row, and
       * claiming it would make a link look free while resolving to nothing.
       */
      embedded: reference.embedded
        .map((path) => byPath.get(path))
        .filter((name): name is string => name !== undefined),
      ...(typeColumn && reference.typeField
        ? { typeColumn, typeMap: reference.typeField.map }
        : {}),
      ...(reference.lookup ? { lookup: reference.lookup } : {}),
    });
  }

  if (marked.size === 0) return [...columns];
  return columns.map((column) => {
    const reference = marked.get(column.name);
    return reference ? { ...column, reference } : column;
  });
};
