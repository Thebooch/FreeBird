import type { Coercion } from "./coercion.js";
import { COERCION_SEMANTICS, coercionForFormat } from "./coercion.js";
import type { EntityField, EntitySpec } from "./entity.js";
import type { WidgetBrief } from "./brief-schema.js";
import type { SemanticType } from "./semantics.js";
import { guessSemantic, looksLikeFlag } from "./semantics.js";

/**
 * What a record type's fields really hold, learned from a response.
 *
 * Every record type starts as the specification describes it, and the
 * specification can be wrong in ways that render confidently: Rentvine
 * declares its flags boolean and sends `0` and `1`, so "Owner approved: 0";
 * it declares a work order number a string and sends `104868`. Nothing ever
 * compared the two, because the only reading of the account was optional and
 * kept what it learned about identity alone.
 *
 * This compares them, from a field's shape as the account read saw it. Only
 * conclusions are kept — never the values they were drawn from.
 */

/** One field as a real response showed it. The shape `inferShape` produces. */
export interface SeenField {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly nullable: boolean;
  /** Distinct values seen, counting an empty one as a value. */
  readonly distinct: number;
  /** The first few values that were present. */
  readonly samples: readonly unknown[];
}

type Kind = NonNullable<EntityField["observed"]>["kinds"][number];
const KINDS: readonly Kind[] = ["string", "number", "boolean", "object", "array"];

const FLAG_WORDS = new Set(["0", "1", "true", "false"]);

/** A value a flag is sent as, by an API that does not send booleans. */
const isFlagValue = (value: unknown): boolean =>
  typeof value === "boolean" ||
  value === 0 ||
  value === 1 ||
  (typeof value === "string" && FLAG_WORDS.has(value.trim().toLowerCase()));

const numericText = (value: unknown): boolean =>
  typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));

/** Whether the specification declared this and nothing else. */
const declaredOnly = (field: EntityField, kind: string): boolean =>
  field.kinds.includes(kind as never) &&
  field.kinds.every((one) => one === kind || one === "null");

/**
 * How to read one field, given what a response showed.
 *
 * Each rule needs the declaration and the values to disagree *in a known
 * way*: a flag declared boolean and seen only as 0/1; a number declared and
 * seen as numeric text; a date declared and seen as epoch numbers. A field
 * declared boolean and seen as 0, 1, 2 and 3 is not a flag whatever the docs
 * say — Rentvine's `taxFormTypeID` — so it is read as the number it is.
 */
export const observeField = (field: EntityField, seen: SeenField): EntityField["observed"] => {
  const kinds = KINDS.filter((kind) => seen.kinds.includes(kind));
  if (kinds.length === 0) return { kinds: [] };

  const values = seen.samples.filter((value) => value !== null && value !== undefined);
  // `distinct` counts an empty value as one of them.
  const distinctPresent = seen.distinct - (seen.nullable ? 1 : 0);
  const leaf = field.path.split(".").pop() ?? field.path;

  const reading = ((): { coercion?: Coercion; semantic?: SemanticType } => {
    if (
      (declaredOnly(field, "boolean") || looksLikeFlag(field.path)) &&
      !(kinds.length === 1 && kinds[0] === "boolean") &&
      values.length > 0 &&
      values.every(isFlagValue) &&
      distinctPresent <= 2
    ) {
      /*
       * Declared a flag, or named like one — Rentvine declares 86 of its
       * `is…` fields as text and sends "1"/"0" — and only ever sent as one.
       */
      return { coercion: "->boolean" };
    }
    if (
      declaredOnly(field, "number") &&
      kinds.every((kind) => kind === "string") &&
      values.length > 0 &&
      values.every(numericText)
    ) {
      return { coercion: "->number" };
    }
    if (field.format && coercionForFormat(field.format) && kinds.every((kind) => kind === "number")) {
      // Declared a date, sent a count of seconds or milliseconds since 1970.
      const largest = Math.max(...values.filter((value): value is number => typeof value === "number"));
      if (largest > 1e11) return { coercion: "unix_ms->datetime" };
      if (largest > 1e8) return { coercion: "unix_s->datetime" };
    }
    if (declaredOnly(field, "string") && kinds.every((kind) => kind === "number")) {
      // Declared text, sent a number: a reference number reads as one, not a count.
      const semantic = guessSemantic(leaf, values[0]);
      if (semantic === "identifier") return { semantic };
    }
    return {};
  })();

  return { kinds, ...reading };
};

/**
 * The object a record's fields really sit inside, where the docs put them one
 * level up.
 *
 * Rentvine's documentation describes a unit as \`{ unitID, name, isActive, … }\`
 * and the API sends \`{ unit: { unitID, name, isActive, … } }\` — the way it
 * sends every other record. A record type built from the docs then asks every
 * response for \`name\` and finds nothing, and its page reads "this view no
 * longer matches its data".
 *
 * Only on clear evidence: most of what the docs declared is present one level
 * down inside a single object, and little of it is where the docs said. A
 * record that genuinely has an object field somewhere is not mistaken for one
 * wrapped whole.
 */
export const wrapperOf = (entity: EntitySpec, seen: readonly SeenField[]): string | null => {
  const names = new Set(seen.map((field) => field.name));
  const declared = entity.fields.map((field) => field.path);
  if (declared.length === 0) return null;
  const direct = declared.filter((path) => names.has(path)).length;

  let best: { wrapper: string; hits: number } | null = null;
  for (const field of seen) {
    if (field.name.includes(".") || !field.kinds.includes("object")) continue;
    const hits = declared.filter((path) => names.has(`${field.name}.${path}`)).length;
    if (!best || hits > best.hits) best = { wrapper: field.name, hits };
  }
  if (!best) return null;
  const most = Math.max(2, Math.ceil(declared.length * 0.5));
  return best.hits >= most && best.hits > direct * 2 ? best.wrapper : null;
};

/** A path moved inside \`wrapper\`, unless it already is there. */
const inside =
  (wrapper: string) =>
  (path: string): string =>
    path === wrapper || path.startsWith(`${wrapper}.`) ? path : `${wrapper}.${path}`;

/**
 * A record type with every path it holds moved inside \`wrapper\`.
 *
 * Every one, because they have to agree: a title naming \`name\` over fields
 * named \`unit.name\` fails the entity's own schema, and a facet left behind
 * filters on a column no row has.
 */
export const rerootEntity = (entity: EntitySpec, wrapper: string): EntitySpec => {
  const to = inside(wrapper);
  const { views, display, identity } = entity;
  return {
    ...entity,
    ...(identity ? { identity: { ...identity, field: to(identity.field) } } : {}),
    ...(display
      ? {
          display: {
            ...display,
            title: display.title.map(to),
            ...(display.subtitle ? { subtitle: to(display.subtitle) } : {}),
            ...(display.status ? { status: to(display.status) } : {}),
            ...(display.image ? { image: to(display.image) } : {}),
          },
        }
      : {}),
    fields: entity.fields.map((field) => ({
      ...field,
      path: to(field.path),
      ...(field.filter
        ? { filter: { ...field.filter, ...(field.filter.via ? { via: to(field.filter.via) } : {}) } }
        : {}),
      ...(field.reference
        ? {
            reference: {
              ...field.reference,
              embedded: field.reference.embedded.map(to),
              ...(field.reference.typeField
                ? { typeField: { ...field.reference.typeField, field: to(field.reference.typeField.field) } }
                : {}),
            },
          }
        : {}),
    })),
    views: {
      ...views,
      columns: views.columns.map(to),
      facets: views.facets.map(to),
      ...(views.sort ? { sort: { ...views.sort, field: to(views.sort.field) } } : {}),
      ...(views.timeField ? { timeField: to(views.timeField) } : {}),
      record: {
        ...views.record,
        facts: views.record.facts.map(to),
        groups: views.record.groups.map((group) => ({ ...group, fields: group.fields.map(to) })),
      },
      stats: views.stats.map((stat) => (stat.field ? { ...stat, field: to(stat.field) } : stat)),
    },
  };
};

/**
 * A widget's request, with its paths on one record type moved as that record
 * type was: see \`rerootEntity\`. Only this record type's own paths move — a
 * linked field is named on the far record, which did not.
 */
export const rerootBrief = (brief: WidgetBrief, wrapper: string): WidgetBrief => {
  const to = inside(wrapper);
  return {
    ...brief,
    ...(brief.columns ? { columns: brief.columns.map(to) } : {}),
    ...(brief.filters
      ? { filters: brief.filters.map((filter) => ({ ...filter, field: to(filter.field) })) }
      : {}),
    ...(brief.linked
      ? { linked: brief.linked.map((one) => ({ ...one, through: to(one.through) })) }
      : {}),
    ...(brief.sort ? { sort: { ...brief.sort, field: to(brief.sort.field) } } : {}),
    ...(brief.groupBy ? { groupBy: to(brief.groupBy) } : {}),
    ...(brief.measure?.field ? { measure: { ...brief.measure, field: to(brief.measure.field) } } : {}),
  };
};

/**
 * A record type, with what one response showed about each of its fields.
 *
 * Where the response shows the record wrapped in an object the docs left out,
 * the record type moves inside it first — see \`wrapperOf\` — and \`wrapped\`
 * says so, because everything built on the old paths has to move too.
 *
 * Fields the response did not carry keep whatever they had: a detail-only
 * field is not evidence of anything in a list response.
 */
export const observeEntity = (
  entity: EntitySpec,
  seen: readonly SeenField[],
  at: string,
): EntitySpec & { readonly wrapped?: string } => {
  const wrapper = wrapperOf(entity, seen);
  const base = wrapper ? rerootEntity(entity, wrapper) : entity;
  const byName = new Map(seen.map((field) => [field.name, field]));
  let touched = wrapper !== null;
  const fields = base.fields.map((field) => {
    const shown = byName.get(field.path);
    if (!shown) return field;
    touched = true;
    return { ...field, observed: observeField(field, shown) };
  });
  if (!touched) return entity;
  return { ...base, fields, readAt: at, ...(wrapper ? { wrapped: wrapper } : {}) };
};

/**
 * How to read a field's values: what somebody stated, then what a response
 * showed, then what the declared format implies. Null when nothing needs doing.
 */
export const fieldCoercion = (field: EntityField): Coercion | null =>
  field.coercion ?? field.observed?.coercion ?? coercionForFormat(field.format);

/**
 * Whether a field is a flag — two states, shown as Active or Inactive.
 *
 * What an account read saw decides where there is one: seen as 0/1 or as
 * true/false, it is; seen as other numbers, it is not, whatever the docs say
 * (Rentvine's \`taxFormTypeID\` is declared boolean and sent as 1–4). Where
 * nothing has been read, the declaration is taken at its word.
 */
export const isFlagField = (field: EntityField): boolean => {
  if (field.observed?.coercion === "->boolean") return true;
  /*
   * A name that asks a yes/no question — `isSharedWithTenant`, `hasPets` —
   * over plain values. Rentvine declares most of its flags as text and sends
   * "1"/"0"; a value that is not a flag still prints as itself.
   */
  const named = looksLikeFlag(field.path);
  const plain = (kinds: readonly string[]): boolean =>
    kinds.length > 0 &&
    kinds.every((kind) => kind === "boolean" || kind === "number" || kind === "string" || kind === "null");
  if (field.observed && field.observed.kinds.length > 0) {
    return (
      field.observed.kinds.every((kind) => kind === "boolean") ||
      (named && plain(field.observed.kinds))
    );
  }
  return (
    (field.kinds.length > 0 && field.kinds.every((kind) => kind === "boolean" || kind === "null")) ||
    (named && plain(field.kinds))
  );
};

/** What a field's values are, where anything says: stated first, then seen. */
export const fieldSemantic = (field: EntityField): SemanticType | undefined =>
  field.semantic ?? field.observed?.semantic;

/**
 * How one field is read on any surface: the coercion to apply, and what the
 * values are then.
 *
 * The one rule a compiled widget and a record page both follow, so a flag
 * cannot read "Yes" on a board and "1" on the record it opens. The semantic
 * is the one the coercion implies, else what a response showed — a model's
 * guess at a field's semantic is left out, because it never had a say in how
 * a widget was compiled and giving it one now would change every figure on
 * boards somebody already approved.
 */
export const fieldReading = (
  field: EntityField,
): { readonly coercion?: Coercion; readonly semantic?: SemanticType } => {
  const coercion = fieldCoercion(field);
  const semantic = (coercion ? COERCION_SEMANTICS[coercion] : undefined) ?? field.observed?.semantic;
  return { ...(coercion ? { coercion } : {}), ...(semantic ? { semantic } : {}) };
};

/** Whether two readings of a record type would read its values differently. */
export const readingsDiffer = (before: EntitySpec, after: EntitySpec): boolean => {
  const was = new Map(before.fields.map((field) => [field.path, field]));
  return after.fields.some((field) => {
    const old = was.get(field.path);
    return (
      !old ||
      fieldCoercion(old) !== fieldCoercion(field) ||
      old.observed?.semantic !== field.observed?.semantic
    );
  });
};
