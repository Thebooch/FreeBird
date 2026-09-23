import { z } from "zod";
import { componentIdSchema } from "./contracts.js";
import { FACET_MAX_PER_WIDGET } from "./facet.js";
import { idSchema } from "./primitives.js";
import { readField } from "./field-path.js";
import { coercionSchema, fieldFormatSchema } from "./coercion.js";
import { aggregationSchema, semanticTypeSchema } from "./semantics.js";

/**
 * A record type, as a person would describe it.
 *
 * The layer this product was missing. Everything user-facing was derived from
 * raw endpoint shapes, per widget, at the moment somebody asked — so the same
 * API was re-read for every question, a field's name was whatever casing
 * produced, and a task's `VendorId` stayed a number because nothing knew that
 * vendors are a thing with a name and a page.
 *
 * An entity is that knowledge, worked out **once per API** and shared: what
 * these records are called, which field identifies one, how to say its name,
 * what each field means in plain language, which of its fields point at other
 * records, and what a list and a page of them should look like. Every part of
 * it is a fact about the *API*, never about an account — so it travels with
 * the catalog entry and a new user inherits readable columns and working links
 * before spending a single request.
 *
 * Three rules hold the whole design together:
 *
 * **Nothing here is about one account.** Which categories a task can have is
 * true of the API and lives in `EntityField.values`; which ones *this* account
 * actually uses is not, and stays in the local stores. The moment an entity
 * records somebody's data it stops being shareable.
 *
 * **References are one-directional and back-references are derived.** A task
 * row carries a vendor's id; that is the only fact recorded. "A vendor has
 * tasks" is the same fact read backwards, and `entityGraph` does the reading —
 * so the two can never disagree, and a link added once shows up on both pages.
 *
 * **A name that is not in `fields` is not a name.** Every path a display, a
 * column, a group or a stat mentions has to be a field this entity declares.
 * The passes that write entities are model-driven, and this is the boundary
 * that keeps an invented field from reaching a widget — the same discipline
 * `mapProposal` applies to a proposal.
 */

/** Dotted for nesting, matching what the shape inferrer and importer produce. */
export const fieldPathSchema = z.string().min(1).max(200);

/**
 * What kind of thing a record is, from a fixed vocabulary.
 *
 * Deliberately small and deliberately not a domain taxonomy. It exists to
 * choose sensible defaults — a list of work sorts by when it is due, a list of
 * people sorts by name — and every one of these shapes recurs on every API
 * there has ever been. Anything that does not obviously fit is `other`, which
 * gets the neutral treatment rather than a guess.
 *
 * - `work`     something to be done: a task, a ticket, a work order.
 * - `party`    someone dealt with: a customer, a tenant, a vendor, a user.
 * - `asset`    a thing owned or tracked: a unit, a device, a product.
 * - `place`    somewhere: a property, a site, a location.
 * - `money`    a movement or obligation: a charge, a bill, an invoice.
 * - `document` a file or record kept: a lease, a contract, an attachment.
 * - `event`    something that happened at a time: a log entry, a payment run.
 * - `note`     something written about another record.
 * - `lookup`   a small closed list other records point at: a category, a status.
 * - `other`    none of the above, treated neutrally.
 */
export const ENTITY_KINDS = [
  "work",
  "party",
  "asset",
  "place",
  "money",
  "document",
  "event",
  "note",
  "lookup",
  "other",
] as const;

export const entityKindSchema = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof entityKindSchema>;

/**
 * Bumped when the entity passes change shape enough to need re-running.
 *
 * Separate from `MAP_VERSION` and `LABEL_VERSION` for the reason those are
 * separate from each other: they cost different money and answer different
 * questions, and folding them together would mark every existing artifact
 * stale to obtain something the other pass does not produce.
 */
export const ENTITY_VERSION = 1;

/**
 * What checking a description against a live account spends by default.
 *
 * Here rather than beside the checking itself because the screen that offers
 * it has to state the cost *before* it is agreed to, and a number the user is
 * shown must be the number that is actually spent. A hundred record types with
 * two links each is three hundred requests, which is not a thing to do to
 * somebody's account on a whim; this gets through roughly twenty record types
 * and their links, and a run reports where it stopped so it can be asked to
 * go on.
 */
export const VERIFY_BUDGET_DEFAULT = 60;

/** The most a single check may be asked for, however it is asked. */
export const VERIFY_BUDGET_MAX = 400;

/**
 * A field that holds another record's identity.
 *
 * `holds` is what stops a link that reads perfectly from matching nothing. The
 * three shapes are the ones every REST API produces, and two of them fail
 * *silently* when treated as the third: an array never equals an id, and an
 * object stringifies to `[object Object]`. Both render as "this record has
 * nothing linked", which is indistinguishable from the truth.
 */
export const referenceSchema = z.object({
  /** The entity on the other end. */
  entity: idSchema,
  holds: z.enum(["scalar", "array", "objectRef"]).default("scalar"),
  /**
   * A sibling field naming *which* kind of record this points at.
   *
   * Polymorphic references are ordinary on real APIs — a task's `Property.Id`
   * with a `Property.Type` of "Rental" or "Association", a parameter pair like
   * `entitytype` + `entityid`. Without the discriminator such a link is a
   * coin toss between two entities, and picking one silently pairs half the
   * rows with the wrong records.
   *
   * `map` is value → entity id. A value the map does not mention is a link
   * nobody can follow, which is reported rather than guessed.
   */
  typeField: z
    .object({ field: fieldPathSchema, map: z.record(z.string(), idSchema) })
    .optional(),
  /**
   * Display fields the row already carries for the referenced record.
   *
   * The cheapest possible link: where a row embeds the vendor's name beside
   * the vendor's id, the name is already on screen and nothing has to be
   * fetched to show it. Recorded because it is the difference between a free
   * link and a request per row.
   */
  embedded: z.array(fieldPathSchema).max(6).default([]),
  /** True once a real id resolved against the target's own endpoint. */
  verified: z.boolean().default(false),
});

export type ReferenceSpec = z.infer<typeof referenceSchema>;

/**
 * One field, described for the person reading it rather than for the API.
 *
 * `label` and `description` are the whole point of the entity pass: the spec
 * usually says what a field is and nobody ever saw it, while the name on
 * screen was whatever mechanical casing produced.
 */
export const entityFieldSchema = z.object({
  path: fieldPathSchema,
  /** What to call it on screen. Absent falls back to `humanLabel`. */
  label: z.string().min(1).max(60).optional(),
  /** One line a non-technical reader can act on. */
  description: z.string().max(300).optional(),
  semantic: semanticTypeSchema.optional(),
  /**
   * The JSON kinds this field's values take.
   *
   * Carried so a consumer can tell a list from a nested record from a plain
   * value without going back to the endpoint that declared it — which is the
   * difference between a link that matches and one that is false for every
   * row, silently. Empty means nobody has read them yet.
   */
  kinds: z
    .array(z.enum(["string", "number", "boolean", "object", "array", "null"]))
    .max(6)
    .default([]),
  /**
   * How prominent this field is.
   *
   * - `primary` worth a column in a list.
   * - `detail`  worth showing on the record page.
   * - `hidden`  exists for the API: a self-link, an internal key, a field
   *             that is null on every record.
   *
   * `detail` is the default because it is the honest one: a field nobody has
   * classified is still real, and hiding it by default would lose data
   * silently, which is the failure this codebase refuses everywhere.
   */
  visibility: z.enum(["primary", "detail", "hidden"]).default("detail"),
  /** Section heading on the record page. Ungrouped fields still render. */
  group: z.string().min(1).max(60).optional(),
  /**
   * The closed set of values this field can hold, where the API declares one.
   *
   * From the specification's own enum, so it is a fact about the API and
   * shareable — which is what lets a filter show every value including the
   * ones this account has none of. What values an account *uses* is not
   * recorded here and never travels.
   */
  values: z.array(z.string().max(120)).max(50).default([]),
  /**
   * How the API itself narrows by this field.
   *
   * `param` is a query parameter the endpoint declares; `via` names the field
   * the parameter actually filters when the two are spelled differently, which
   * is usual — `taskcategoryid` filters `Category.Id`. Its presence is the
   * difference between one filtered request and reading a collection and
   * matching locally, so it is recorded rather than rediscovered.
   */
  filter: z.object({ param: z.string().min(1).max(120), via: fieldPathSchema.optional() }).optional(),
  reference: referenceSchema.optional(),
  /**
   * What the API's own schema says these values are.
   *
   * Carried from the declared field rather than asked of a model, like `kinds`
   * and `values` beside it: whether a string is an ISO date is a fact about
   * the API, true for everyone who connects it, and paying to be told it once
   * per record type would be paying many times for one answer.
   */
  format: fieldFormatSchema.optional(),
  /**
   * How to read these values, where reading them needs saying.
   *
   * Lives on the record type rather than on a widget because it is a property
   * of the data, not of one view of it: "amount is in cents" is true of every
   * widget that ever shows this field, and answering it per widget means
   * answering it again every time somebody builds one — and getting a
   * different answer on the day somebody guesses.
   *
   * Usually absent, because `coercionForFormat` derives the safe cases from
   * `format` and nothing needs to be written down. What lands here is the part
   * that cannot be derived: minor units, which a schema may *claim* and only a
   * person or a look at real values can confirm. Being wrong about it renders
   * beautifully and is off by a hundred.
   */
  coercion: coercionSchema.optional(),
});

export type EntityField = z.infer<typeof entityFieldSchema>;

/**
 * How to say a record's name.
 *
 * An array because a name is often two fields — a first and a last, a street
 * and a number — and joining them is the difference between "Acme Plumbing"
 * and a number nobody recognises. Capped at three: past that it is a sentence,
 * not a name.
 */
export const entityDisplaySchema = z.object({
  title: z.array(fieldPathSchema).min(1).max(3),
  /**
   * Whether those fields are parts of one name or alternatives for it.
   *
   * `join` puts them together — a first and a last name, a building and a unit
   * number. `first` takes the first that has a value, which is how a record
   * that can be either a company or a person is named: a supplier row carries
   * a company name *or* a person's, and joining them produces "McKinney
   * Strategic Greg McKinney", which is nobody's name.
   *
   * Deliberately **optional with no default**: absent means "nobody has said",
   * and `titleModeOf` then reads it off the field names. A default here would
   * look harmless and silently defeat that inference, which is the only thing
   * sparing every entity described before this existed a paid re-run.
   */
  mode: z.enum(["join", "first"]).optional(),
  subtitle: fieldPathSchema.optional(),
  status: fieldPathSchema.optional(),
  image: fieldPathSchema.optional(),
});

export type EntityDisplay = z.infer<typeof entityDisplaySchema>;

/**
 * A number worth showing on a record's page, taken from its own children.
 *
 * Free by construction: the page fetches the related collections anyway, so a
 * count or a total over rows already in hand costs nothing. `backref` names
 * which relationship it measures, so a stat can never be computed from
 * something the page did not read.
 */
/**
 * The id of one of a record's related collections.
 *
 * Not `idSchema`, and the difference is load-bearing. A back-reference is
 * identified by `<record type>-by-<field path>`, and a field path legitimately
 * contains dots — on a real API **64 of 130** of them do, because the field
 * holding the link is nested (`Sender.Id`, `LastUpdatedByUser.Id`). Validated
 * as an id, every one of those was unstorable: a stat over them could not be
 * written, and neither could a widget's ordering of the sections they produce.
 *
 * Longer, too. An entity id runs to 64 on its own and a field path to 200, so
 * a 64-character cap refused perfectly ordinary combinations.
 */
const backrefIdSchema = z
  .string()
  .min(1)
  .max(280)
  .regex(/^[a-zA-Z0-9_.-]+$/, "a collection id is [a-zA-Z0-9_.-]");

export const entityStatSchema = z.object({
  label: z.string().min(1).max(60),
  backref: backrefIdSchema,
  agg: aggregationSchema,
  /** Required for everything except a count, which counts records. */
  field: fieldPathSchema.optional(),
});

export type EntityStat = z.infer<typeof entityStatSchema>;

export const fieldGroupSchema = z.object({
  title: z.string().min(1).max(120),
  fields: z.array(fieldPathSchema).min(1),
});

/** What a list and a page of these records look like, before anybody asks. */
export const entityViewsSchema = z.object({
  /** The view a plain list of these reads best as. */
  component: componentIdSchema.optional(),
  columns: z.array(fieldPathSchema).max(12).default([]),
  sort: z
    .object({ field: fieldPathSchema, dir: z.enum(["asc", "desc"]).default("desc") })
    .optional(),
  facets: z.array(fieldPathSchema).max(FACET_MAX_PER_WIDGET).default([]),
  /** The date a timeline or a "per month" question uses by default. */
  timeField: fieldPathSchema.optional(),
  record: z
    .object({
      facts: z.array(fieldPathSchema).max(4).default([]),
      groups: z.array(fieldGroupSchema).max(8).default([]),
    })
    .default({}),
  stats: z.array(entityStatSchema).max(4).default([]),
});

export type EntityViews = z.infer<typeof entityViewsSchema>;

/**
 * A layout change that applies to one widget's copy of a record page.
 *
 * Every key optional, and that is the shape rather than an accident: this
 * stores **only what differs** from the shared page. A widget that wants one
 * extra fact at the top says so in one field and inherits every later
 * improvement to the entity's own layout — where a full copy would freeze the
 * page as it was the day it was written, which is exactly what per-widget
 * drill-downs did.
 */
export const recordOverrideSchema = z.object({
  facts: z.array(fieldPathSchema).max(4).optional(),
  groups: z.array(fieldGroupSchema).max(8).optional(),
  /** Related collections to show, by back-reference id, in this order. */
  sections: z.array(backrefIdSchema).max(8).optional(),
  /** Fields to leave off that the shared page would show. */
  hide: z.array(fieldPathSchema).max(40).optional(),
});

export type RecordOverride = z.infer<typeof recordOverrideSchema>;

const entityBodySchema = z.object({
  /**
   * Human, stable, and unique within the API.
   *
   * Not the resource id, which comes from a URL and reads like one:
   * Buildium's properties live at `/v1/rentals`, so the resource is `rental`
   * and the second units collection is `unit-2`. Those are fine as internal
   * handles and wrong as names — an entity is what the chat, the tools and the
   * address bar say, so `-2` is not an acceptable answer and a real
   * disambiguation like `association-unit` is.
   */
  id: idSchema,
  /** The structural resource this sits on, which owns the list and detail ops. */
  resource: idSchema,
  name: z.object({
    one: z.string().min(1).max(60),
    many: z.string().min(1).max(60),
  }),
  description: z.string().max(400).optional(),
  kind: entityKindSchema.default("other"),
  /**
   * A collection that only exists inside another record.
   *
   * A property's notes cannot be listed on their own — the endpoint needs a
   * property. Recorded so nothing offers them as a starting point, which is an
   * offer that cannot be executed.
   */
  scope: z.object({ parent: idSchema, param: z.string().min(1).max(120) }).optional(),
  /**
   * The field holding a record's own identity, and whether it was seen.
   *
   * Optional because it genuinely may not be known: a path says `{unitId}`
   * and the response says `Id`, and no specification states the
   * correspondence. `observed` distinguishes "a real response carried this"
   * from "the convention says this", and only the first is evidence.
   */
  identity: z.object({ field: fieldPathSchema, observed: z.boolean().default(false) }).optional(),
  display: entityDisplaySchema.optional(),
  fields: z.array(entityFieldSchema).max(300).default([]),
  views: entityViewsSchema.default({}),
  /** Which model wrote this and when, so a bad reading can be traced. */
  provenance: z
    .object({
      model: z.string().min(1).max(120),
      at: z.string().min(1).max(40),
      version: z.number().int().min(1),
    })
    .optional(),
  /** True once a real response confirmed the identity field. */
  verified: z.boolean().default(false),
});

export const entitySchema = entityBodySchema.superRefine((entity, ctx) => {
  const declared = new Set(entity.fields.map((field) => field.path));
  const known = (path: string): boolean => declared.size === 0 || declared.has(path);

  const seen = new Set<string>();
  entity.fields.forEach((field, index) => {
    if (seen.has(field.path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${field.path}" is described twice`,
        path: ["fields", index, "path"],
      });
    }
    seen.add(field.path);
  });

  /*
   * Every path something points at has to be a field this entity declares.
   *
   * The boundary that keeps a model's invented field name from reaching a
   * widget. Skipped entirely while `fields` is empty, because a stub that
   * names only what it is called is a legitimate intermediate state — and
   * validating against nothing would reject it for mentioning a field it has
   * not got round to describing.
   */
  const check = (path: string, at: (string | number)[]): void => {
    if (known(path)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"${path}" is not a field this record has`,
      path: at,
    });
  };

  if (entity.identity) check(entity.identity.field, ["identity", "field"]);
  entity.display?.title.forEach((path, index) => check(path, ["display", "title", index]));
  if (entity.display?.subtitle) check(entity.display.subtitle, ["display", "subtitle"]);
  if (entity.display?.status) check(entity.display.status, ["display", "status"]);
  if (entity.display?.image) check(entity.display.image, ["display", "image"]);
  entity.views.columns.forEach((path, index) => check(path, ["views", "columns", index]));
  entity.views.facets.forEach((path, index) => check(path, ["views", "facets", index]));
  if (entity.views.sort) check(entity.views.sort.field, ["views", "sort", "field"]);
  if (entity.views.timeField) check(entity.views.timeField, ["views", "timeField"]);
  entity.views.record.facts.forEach((path, index) =>
    check(path, ["views", "record", "facts", index]),
  );
  entity.views.record.groups.forEach((group, at) =>
    group.fields.forEach((path, index) =>
      check(path, ["views", "record", "groups", at, "fields", index]),
    ),
  );
  entity.fields.forEach((field, index) => {
    if (field.reference?.typeField) {
      check(field.reference.typeField.field, ["fields", index, "reference", "typeField", "field"]);
    }
    for (const [at, path] of (field.reference?.embedded ?? []).entries()) {
      check(path, ["fields", index, "reference", "embedded", at]);
    }
    if (field.filter?.via) check(field.filter.via, ["fields", index, "filter", "via"]);
  });

  /*
   * A stat that is not a count needs something to add up. The aggregation
   * vocabulary is shared with the pipeline, where the same rule holds — and a
   * `sum` over nothing silently produces zero, which renders as a confident
   * answer to a question nobody asked.
   */
  entity.views.stats.forEach((stat, index) => {
    if (stat.agg !== "count" && !stat.field) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${stat.label}" is a ${stat.agg}, so it needs a field to work on`,
        path: ["views", "stats", index, "field"],
      });
    }
  });
});

export type EntitySpec = z.infer<typeof entitySchema>;

/* ── reading one ───────────────────────────────────────────────────────── */

/** The entity sitting on a structural resource, if one has been described. */
export const entityForResource = (
  entities: readonly EntitySpec[],
  resource: string | undefined,
): EntitySpec | undefined =>
  resource === undefined ? undefined : entities.find((entity) => entity.resource === resource);

export const entityById = (
  entities: readonly EntitySpec[],
  id: string | undefined,
): EntitySpec | undefined =>
  id === undefined ? undefined : entities.find((entity) => entity.id === id);

/** Every field that points at another record, with the reference itself. */
export const referenceFields = (
  entity: EntitySpec | undefined,
): ReadonlyArray<{ readonly field: EntityField; readonly reference: ReferenceSpec }> =>
  (entity?.fields ?? []).flatMap((field) =>
    field.reference ? [{ field, reference: field.reference }] : [],
  );

/** A name for an organisation, as opposed to for a person. */
const COMPANY_FIELD = /company|organisation|organization|business|trade/i;
/** One part of a person's name, which is meaningless on its own. */
const PERSON_FIELD = /first|last|given|surname|middle|fore/i;

/**
 * Whether a set of title fields are parts or alternatives, read off the names.
 *
 * The fallback for entities described before `display.mode` existed, so they
 * get the right answer without paying for the pass again. The rule is narrow
 * on purpose: **only** a title mixing a company-style name with parts of a
 * person's name is alternatives, because that is the shape that cannot be
 * joined — every other multi-field title measured on a real API is genuinely
 * parts, and guessing `first` for those would silently drop half a name.
 *
 * A naming-convention rule, in the same class as `guessSemantic` and
 * `statusTone`: it reads English field names, not any vendor's vocabulary.
 */
export const inferTitleMode = (title: readonly string[]): "join" | "first" => {
  if (title.length < 2) return "join";
  const leaf = (path: string): string => path.split(".").pop() ?? path;
  const company = title.some((path) => COMPANY_FIELD.test(leaf(path)));
  const person = title.some((path) => PERSON_FIELD.test(leaf(path)));
  return company && person ? "first" : "join";
};

/** How this record's name is assembled, stated or inferred. */
export const titleModeOf = (entity: EntitySpec | undefined): "join" | "first" =>
  entity?.display?.mode ?? inferTitleMode(entity?.display?.title ?? []);

/** The fields a record's own name is built from, display order preserved. */
export const displayFields = (entity: EntitySpec | undefined): readonly string[] => {
  if (!entity?.display) return [];
  const { title, subtitle, status } = entity.display;
  return [...title, ...(subtitle ? [subtitle] : []), ...(status ? [status] : [])];
};

/**
 * A record's name, from whatever the row happens to carry.
 *
 * Falls back rather than failing: a row missing the display fields still gets
 * something a person can recognise, and a record with nothing readable at all
 * is named by its identity — which is exactly when an id *is* the useful
 * answer. Returns null only when there is nothing at all, so a caller can tell
 * "no name" from "named by its id".
 */
export const displayName = (
  entity: EntitySpec | undefined,
  row: Readonly<Record<string, unknown>>,
): string | null => {
  const read = (path: string): string => {
    const value = readField(row, path);
    return value === null || value === undefined ? "" : String(value);
  };

  const parts = (entity?.display?.title ?? []).map(read).filter((part) => part !== "");
  if (parts.length > 0) {
    return titleModeOf(entity) === "first" ? parts[0]! : parts.join(" ");
  }

  const id = entity?.identity ? read(entity.identity.field) : "";
  if (id !== "") return `${entity?.name.one ?? "Record"} ${id}`;
  return null;
};
