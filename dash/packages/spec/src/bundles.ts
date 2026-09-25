import type { EntityField, EntitySpec } from "./entity.js";

/**
 * Other records an API sends inside this record's rows.
 *
 * Some APIs answer with each record wrapped in an object named after its type,
 * and put the records it relates to beside it: a Rentvine invoice row is
 * `{ invoice: {…}, workOrder: {…}, contact: {…}, property: {…} }`. Described
 * field by field, all of that became the invoice's own — fourteen objects'
 * worth — so an invoice page listed its work order's fields as if they were
 * the invoice's, and the work order's own id became a second invoice→work
 * order link beside the real one.
 *
 * A sibling object is recognised as another record by the same convention
 * that wraps this one: it is named exactly as another record type's identity
 * is wrapped. Derived rather than stored, so it is always consistent with the
 * record types as they now are and nothing written before needs migrating.
 * An API whose records are not wrapped — Buildium's identities are a plain
 * `Id` — has no bundles, and nothing about it changes.
 */
export interface Bundle {
  /** The object on the row holding the other record, e.g. `workOrder`. */
  readonly path: string;
  /**
   * The record type it is. Absent where several share the wrapper — a
   * Rentvine `contact` may be a tenant, a vendor or an owner — and nothing on
   * the row says which.
   */
  readonly entity?: string | undefined;
}

const rootOf = (path: string): string => (path.includes(".") ? (path.split(".")[0] ?? "") : "");

/** The records bundled into this record type's rows. */
export const bundlesOf = (entity: EntitySpec, entities: readonly EntitySpec[]): Bundle[] => {
  const own = entity.identity ? rootOf(entity.identity.field) : "";
  if (!own) return [];

  const wrappers = [...new Set(entity.fields.map((field) => rootOf(field.path)))].filter(
    (wrapper) => wrapper !== "" && wrapper !== own,
  );

  const bundles: Bundle[] = [];
  for (const wrapper of wrappers) {
    const candidates = entities.filter(
      (other) => other.id !== entity.id && other.identity && rootOf(other.identity.field) === wrapper,
    );
    // Named like no record type: a part of this record, not another one.
    if (candidates.length === 0) continue;
    if (candidates.length === 1) {
      bundles.push({ path: wrapper, entity: candidates[0]!.id });
      continue;
    }
    /*
     * Several record types share the wrapper. The row can still say which, if
     * the describing pass recorded where the bundled record's own id points.
     */
    const named = entity.fields.find(
      (field) =>
        field.path.startsWith(`${wrapper}.`) &&
        field.reference &&
        candidates.some(
          (candidate) =>
            candidate.id === field.reference!.entity && candidate.identity?.field === field.path,
        ),
    );
    bundles.push(named ? { path: wrapper, entity: named.reference!.entity } : { path: wrapper });
  }
  return bundles;
};

/** The bundle a field belongs to, if it is not the record's own. */
export const bundleOf = (bundles: readonly Bundle[], path: string): Bundle | undefined =>
  bundles.find((bundle) => path === bundle.path || path.startsWith(`${bundle.path}.`));

/** The fields that are this record's own, without the records sent beside it. */
export const ownFields = (
  entity: EntitySpec,
  entities: readonly EntitySpec[],
): readonly EntityField[] => {
  const bundles = bundlesOf(entity, entities);
  return bundles.length === 0
    ? entity.fields
    : entity.fields.filter((field) => !bundleOf(bundles, field.path));
};
