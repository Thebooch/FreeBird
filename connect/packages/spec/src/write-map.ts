import type { EntityField, EntitySpec } from "./entity.js";
import { normaliseName } from "./semantics.js";
import type { WriteField } from "./write.js";

/**
 * Where each value a request takes is shown on the record it changes.
 *
 * The request and the response are two documents, written by the same vendor
 * on different days. Mostly they agree — `Name` is `Name`, `Address.City` is
 * `Address.City` — and every field matched here is one nobody has to think
 * about. Where they do not agree the field is left `readFrom: null`, looked
 * for and not found, which is what the review warns about and what the
 * configuration-time model pass is asked to settle. Guessing across that gap
 * by string similarity would be how an edit writes one person's phone number
 * into another field.
 *
 * Only what a person or the model already decided (`mappedBy` "person" or
 * "model") is kept as it was. Everything else is worked out again every time
 * it is asked, so a record type re-described since cannot leave a stale
 * mapping behind.
 */

const leafIsId = /(?<=[a-z0-9])(Id|ID|_id|_ID)$/;

const scalar = (field: EntityField): boolean =>
  !field.kinds.includes("object") && !field.kinds.includes("array");

/** The object an entity's fields all sit inside, as `unit` in `unit.unitID`. */
const wrapperOfEntity = (entity: EntitySpec): string | undefined => {
  const identity = entity.identity?.field;
  if (!identity || !identity.includes(".")) return undefined;
  return identity.split(".")[0];
};

const findReadField = (entity: EntitySpec, path: string): EntityField | undefined => {
  const fields = entity.fields.filter(scalar);
  const exact = fields.find((field) => field.path === path);
  if (exact) return exact;

  const wanted = normaliseName(path);
  const spelled = fields.find((field) => normaliseName(field.path) === wanted);
  if (spelled) return spelled;

  // A record the API wraps whole: the request says `name`, the record `unit.name`.
  const wrapper = wrapperOfEntity(entity);
  if (wrapper) {
    const inside = fields.find((field) => normaliseName(field.path) === normaliseName(`${wrapper}.${path}`));
    if (inside) return inside;
  }

  // `ContactId` in the request, `Contact.Id` on the record.
  const leaf = path.split(".").pop() ?? path;
  if (leafIsId.test(leaf)) {
    const base = path.replace(leafIsId, "");
    const ref = normaliseName(`${base}.id`);
    const nested = fields.find((field) => normaliseName(field.path) === ref);
    if (nested) return nested;
    if (wrapper) {
      const wrapped = fields.find((field) => normaliseName(field.path) === normaliseName(`${wrapper}.${base}.id`));
      if (wrapped) return wrapped;
    }
  }
  return undefined;
};

/**
 * Every field of a request body, with where its current value is read from
 * and — where the record says so — which record type it names.
 */
export const mapWriteFields = (
  entity: EntitySpec | undefined,
  fields: readonly WriteField[],
): WriteField[] =>
  fields.map((field) => {
    if (field.mappedBy === "person" || field.mappedBy === "model") {
      return withReference(entity, field);
    }
    if (!entity || field.path.includes("[]") || field.type === "object") {
      const { readFrom: _readFrom, mappedBy: _mappedBy, ...rest } = field;
      return rest;
    }
    const read = findReadField(entity, field.path);
    if (!read) {
      const { mappedBy: _mappedBy, ...rest } = field;
      return { ...rest, readFrom: null };
    }
    return withReference(entity, {
      ...field,
      readFrom: read.path,
      mappedBy: "name",
      ...(field.label === undefined && read.label !== undefined ? { label: read.label } : {}),
      ...(field.description === undefined && read.description !== undefined
        ? { description: read.description }
        : {}),
    });
  });

/** The record type a field names, taken from the read field it maps to. */
const withReference = (entity: EntitySpec | undefined, field: WriteField): WriteField => {
  if (field.reference || !entity || !field.readFrom) return field;
  const read = entity.fields.find((candidate) => candidate.path === field.readFrom);
  const reference = read?.reference;
  if (!reference) return field;
  return {
    ...field,
    reference: { entity: reference.entity, holds: reference.holds === "array" ? "array" : "scalar" },
  };
};

/** Fields a replace would send without a value it knows, so may clear. */
export const unmappedFields = (fields: readonly WriteField[]): WriteField[] =>
  fields.filter(
    (field) => !field.hidden && field.readFrom === null && !field.path.includes("[]"),
  );
