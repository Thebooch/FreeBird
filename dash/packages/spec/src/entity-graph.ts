import type { EntityField, EntityKind, EntitySpec, ReferenceSpec } from "./entity.js";
import { entityById, entityForResource, titleModeOf } from "./entity.js";
import { defaultFacets, defaultSort } from "./recipes.js";
import type { FieldGroup } from "./dashboard.js";
import { humanLabel } from "./presentation.js";
import type { SemanticType } from "./semantics.js";
import { looksLikeIdentifier, normaliseName } from "./semantics.js";
import type { GraphOp } from "./relations.js";
import { declaredFilterParam } from "./relations.js";
import type { ResourceSpec } from "./resource.js";
import { pathParamNames } from "./primitives.js";
import { readField } from "./field-path.js";
import type { Coercion } from "./coercion.js";
import { fieldReading, isFlagField } from "./observe.js";
import { type Bundle, bundleOf, bundlesOf } from "./bundles.js";

/**
 * The relationships between record types, read in both directions, once.
 *
 * A reference is recorded on exactly one side: a task row carries a vendor's
 * id, so the link lives on the task. "A vendor has tasks" is the same fact
 * read backwards — and it is the half people actually want, because a vendor's
 * page is where somebody looks to find out what that vendor is doing.
 *
 * Deriving the second from the first is what keeps them honest. Recording both
 * would let them disagree, and a link added on one page but missing from the
 * other is the kind of inconsistency nobody can explain later. Here, one
 * recorded reference produces one link on each page, always.
 *
 * **Every answer carries how it is fetched and what that costs.** A back
 * reference is one request when the far endpoint can be filtered by the id,
 * and a capped read-and-match when it cannot — and the second is *partial* by
 * construction: rows belonging to this record can sit past the last page
 * fetched, so the section renders as though the record has none. That is
 * indistinguishable from the truth unless it is said out loud, which is why
 * `cost` travels with every plan rather than being worked out by each caller.
 */

/**
 * One more id a record's address needs besides its own.
 *
 * A unit is `/properties/{propertyID}/units/{unitID}`: its own id fills
 * `unitID`, and `propertyID` has to come from somewhere else — from a field on
 * the unit, or from the property it was opened under.
 */
export interface AddressPart {
  /** The path parameter it fills on the endpoint returning one record. */
  readonly param: string;
  /** A field on the record itself holding it, where the record carries one. */
  readonly field?: string | undefined;
  /** The record type it identifies: the parent this record lives under. */
  readonly entity?: string | undefined;
}

/** How one record is fetched, and every id that takes. */
export interface RecordAddress {
  readonly op: string;
  /** The parameter the record's own id fills. */
  readonly param: string;
  /** Ids besides its own, in path order. Empty for a top-level record. */
  readonly parents: readonly AddressPart[];
}

/** A parent id read off the *referencing* row, to follow a link to a nested record. */
export interface LinkedPart {
  readonly param: string;
  /** The field on the row holding the link that holds this id too. */
  readonly field: string;
}

/** How the far side of a link is actually reached. */
export type ReachPlan =
  /**
   * One record: `/vendors/{vendorId}`, or `/properties/{propertyID}/units/
   * {unitID}` with the property's id read off the same row as the unit's.
   */
  | {
      readonly mode: "record";
      readonly op: string;
      readonly param: string;
      readonly parents?: readonly LinkedPart[] | undefined;
    }
  /**
   * A collection scoped under this record: `/tasks/{taskId}/history`. Where
   * this record is itself nested, the endpoint names its parents too, and
   * `parents` lists those parameters for the page's own address to fill.
   */
  | {
      readonly mode: "path";
      readonly op: string;
      readonly param: string;
      readonly parents?: readonly string[] | undefined;
    }
  /** A collection the API can narrow by the id — one request for all of them. */
  | { readonly mode: "filter"; readonly op: string; readonly param: string }
  /** Read the collection and match here. Always available, always capped. */
  | {
      readonly mode: "scan";
      readonly op: string;
      readonly field: string;
      readonly holds: "scalar" | "array";
    };

/**
 * What reaching the far side costs, in the only terms that matter to a reader.
 *
 * `cheap` is one request whose answer is complete. `partial` is one request
 * whose answer stops at a page cap, so an empty result does not mean empty.
 * `free` needs no request at all, because the row already carries the name.
 */
export type ReachCost = "free" | "cheap" | "partial";

/** A field on this record that points at another one. */
export interface EntityReference {
  /** Stable within the entity: the field's own path. */
  readonly id: string;
  readonly field: string;
  readonly label: string | undefined;
  /** The entity this points at. For a polymorphic link, the default reading. */
  readonly target: string;
  readonly holds: ReferenceSpec["holds"];
  /** Display fields the row already carries, so no lookup is needed. */
  readonly embedded: readonly string[];
  readonly typeField: ReferenceSpec["typeField"];
  /** How to open the referenced record, or null when nothing can open it. */
  readonly reach: ReachPlan | null;
  readonly cost: ReachCost;
  readonly verified: boolean;
}

/** Another record type whose rows point at this one. */
export interface EntityBackref {
  /**
   * Stable across runs, and the handle a stat or a record override names.
   *
   * Built from the far entity and the field pointing here, because those two
   * are what the relationship *is*: two links from the same entity on
   * different fields — "created by" and "assigned to" both pointing at a
   * person — are two sections and must not collapse into one.
   */
  readonly id: string;
  readonly entity: string;
  /**
   * What to call the section: the far entity's own plural, plus the role the
   * field plays wherever that entity links here more than once.
   */
  readonly title: string;
  /** The field on the far rows holding this record's id. */
  readonly field: string;
  readonly reach: ReachPlan;
  readonly cost: ReachCost;
  readonly verified: boolean;
}

/** A link the entities record that cannot be executed, and why. */
export interface UnreachableLink {
  readonly from: string;
  readonly field: string;
  readonly reason: string;
}

export interface EntityGraphInput {
  readonly entities: readonly EntitySpec[];
  /** The structural half: which endpoint lists a thing, and which returns one. */
  readonly resources: readonly ResourceSpec[];
  readonly ops: readonly GraphOp[];
}

export interface EntityGraph {
  readonly entityOf: (opId: string) => EntitySpec | undefined;
  /** Fields on this entity's rows that point at other records. */
  readonly referencesOf: (entityId: string) => readonly EntityReference[];
  /** Record types whose rows point at this one, plus scoped collections. */
  readonly backrefsOf: (entityId: string) => readonly EntityBackref[];
  /** How one of these is fetched on its own, or null when nothing returns one. */
  readonly addressOf: (entityId: string) => RecordAddress | null;
  /**
   * What a column on an op's rows refers to, if anything.
   *
   * `sources` maps a rendered column back to the field it came from, because a
   * nested path is not a column until a derive step makes one: a table shows
   * `Vendor_Id` and the entity describes `Vendor.Id`. Without that translation
   * every nested reference would look like a field nothing knows about —
   * exactly the one-layer-later rejection that swallowed nested role bindings
   * before.
   */
  readonly resolveField: (
    opId: string,
    column: string,
    sources?: Readonly<Record<string, string>>,
  ) => { readonly entity: EntitySpec; readonly reference: EntityReference } | undefined;
  readonly unreachable: readonly UnreachableLink[];
}

/**
 * One reference, flattened into what a renderer needs to draw it.
 *
 * Field paths are the API's own, so a consumer still has to translate them
 * into the columns its pipeline produced — the same translation
 * `labelColumns` does for labels.
 */
export interface EntityReferenceView {
  /** The field on this record, as the API spells it. */
  readonly field: string;
  readonly label?: string | undefined;
  readonly target: string;
  /** What one of the far records is called, for the "Vendor 41" fallback. */
  readonly targetName: string;
  readonly holds: ReferenceSpec["holds"];
  readonly embedded: readonly string[];
  readonly typeField?: ReferenceSpec["typeField"];
  /**
   * The endpoint that returns one far record, when anything can open one.
   *
   * `parents` names the fields on this row holding the far record's other ids,
   * where it lives under a parent: a work order's unit is opened with the
   * work order's own property id.
   */
  readonly lookup?:
    | {
        readonly op: string;
        readonly param: string;
        readonly parents?: readonly LinkedPart[] | undefined;
      }
    | undefined;
  /** True when the row already carries the name, so nothing has to be read. */
  readonly free: boolean;
}

/** One record type, reduced to what drawing its links requires. */
export interface EntityLinkView {
  readonly entity: string;
  readonly resource: string;
  readonly name: { readonly one: string; readonly many: string };
  readonly identity?: string | undefined;
  /** The fields whose values are this record's name, in order. */
  readonly title: readonly string[];
  /**
   * Whether those are parts of one name or alternatives for it.
   *
   * Absent means `join`, which is what a reader of this payload should assume:
   * it is a modifier on `title`, and every payload this function builds states
   * it explicitly.
   */
  readonly titleMode?: "join" | "first";
  /**
   * The endpoints whose rows *are* these records.
   *
   * Carried so a browser never has to reason about resources to answer "what
   * kind of record is this widget showing?". It holds the op ids; the widget
   * holds one of them; the join is a lookup rather than a derivation.
   */
  readonly ops: readonly string[];
  /**
   * The endpoint listing these records, when one can be called on its own.
   *
   * Carried so a browser can resolve many of this type at once instead of one
   * at a time. Measured on the real Buildium map: 80 of 121 reference links
   * cost a request each and point at only 24 record types, so a column with
   * twenty distinct vendors is twenty requests that one call to the vendors
   * list would answer — and that one answer then names vendors everywhere
   * else on the board too.
   *
   * Absent when the list endpoint needs a path parameter nobody can supply
   * from a reference alone, because an offer that cannot be executed would
   * spend a request to discover it.
   */
  readonly list?: string | undefined;
  /**
   * The other ids a row of these needs to open its page, where it lives under
   * a parent. Absent for a record fetched by its own id alone.
   */
  readonly address?: { readonly parents: readonly AddressPart[] } | undefined;
  /**
   * Fields that are flags, by path — see `isFlagField`. A column drawn from
   * one reads Active or Inactive, whether the API sends true/false or 1/0.
   */
  readonly flags?: readonly string[] | undefined;
  readonly references: readonly EntityReferenceView[];
  /**
   * What this record type calls its own fields, by the API's own path.
   *
   * Per record type, which is the whole point. A lexicon keyed by bare field
   * name has to give `Title` one meaning for the entire API, so a task's title
   * and a file's title get the same word and at least one of them is wrong.
   * Here a task says what a task's `Title` is called and nothing else is
   * affected.
   *
   * Only the fields whose label differs from the one readable off the path, so
   * the common case costs nothing on the wire: an API where `CompanyName`
   * reads as "Company name" carries no entry at all.
   */
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * The links, without the dictionary.
 *
 * A browser needs very little of an entity to render a reference: what the far
 * record type is called, which field points at it, whether the name is already
 * on the row, and which endpoint returns one. It does **not** need the twelve
 * hundred field descriptions that make the artifact worth sharing — and on a
 * real API that is the difference between tens of kilobytes and well over a
 * megabyte on a payload read at every page load.
 *
 * A trimmed `EntitySpec` is not an option, and that is by design rather than by
 * accident: the schema refuses a display name that points at a field the entity
 * does not list, so an entity stripped of its fields will not parse. Hence a
 * separate, purpose-built shape — small, flat, and impossible to mistake for
 * the whole record type.
 *
 * Computed here because this is where all three inputs meet. The entities are a
 * property of the API, the ops are what one connection may actually call, and
 * the reach plans need both; a client holding only the first could not work out
 * the third.
 */
export const entityLinkViews = (input: EntityGraphInput): EntityLinkView[] => {
  const graph = entityGraph(input);
  const byId = new Map(input.entities.map((entity) => [entity.id, entity]));
  const resourceById = new Map(input.resources.map((resource) => [resource.id, resource]));
  const opById = new Map(input.ops.map((op) => [op.id, op]));

  return input.entities.map((entity) => {
    const references = graph.referencesOf(entity.id).flatMap((reference) => {
      const target = byId.get(reference.target);
      if (!target) return [];
      const view: EntityReferenceView = {
        field: reference.field,
        ...(reference.label ? { label: reference.label } : {}),
        target: reference.target,
        targetName: target.name.one,
        holds: reference.holds,
        embedded: reference.embedded,
        ...(reference.typeField ? { typeField: reference.typeField } : {}),
        ...(reference.reach?.mode === "record"
          ? {
              lookup: {
                op: reference.reach.op,
                param: reference.reach.param,
                ...(reference.reach.parents?.length ? { parents: reference.reach.parents } : {}),
              },
            }
          : {}),
        free: reference.cost === "free",
      };
      return [view];
    });

    const resource = resourceById.get(entity.resource);
    const address = graph.addressOf(entity.id);
    return {
      entity: entity.id,
      resource: entity.resource,
      name: { one: entity.name.one, many: entity.name.many },
      ...(entity.identity ? { identity: entity.identity.field } : {}),
      title: entity.display?.title ?? [],
      titleMode: titleModeOf(entity),
      ops: [resource?.listOp, resource?.detailOp].filter(
        (op): op is string => typeof op === "string",
      ),
      ...(resource?.listOp && bare(opById.get(resource.listOp))
        ? { list: resource.listOp }
        : {}),
      ...(address && address.parents.length > 0 ? { address: { parents: address.parents } } : {}),
      ...(() => {
        const flags = entity.fields.filter(isFlagField).map((field) => field.path);
        return flags.length > 0 ? { flags } : {};
      })(),
      references,
      /*
       * Only what a reader could not work out for themselves. A label equal to
       * the one already readable off the path teaches a browser nothing and
       * still costs bytes on a payload sent with every connection read — and
       * on a real API that is most of them.
       */
      labels: Object.fromEntries(
        entity.fields
          .filter((field) => field.label && field.label !== humanLabel(field.path))
          .map((field) => [field.path, field.label as string]),
      ),
    };
  });
};

/**
 * Every field name this API has a human word for, in one flat map.
 *
 * Derived, never written down and never paid for. There used to be a model
 * pass whose whole job was this — one call per batch of field names, run
 * inside every mapping — and it answered a worse question than the describing
 * pass already answers: one label per bare field name for the entire API, so
 * `Title` had a single meaning shared by every record type that has one.
 *
 * The per-record labels on `EntityLinkView` are the real answer and outrank
 * this wherever a widget knows its record type. This exists for the places
 * that have a field name and nothing else to go on — the setup card offering a
 * column to group by, say — where a shared word is still better than
 * `CurrentNumberOfOccupants`.
 *
 * First writer wins, which is arbitrary and admitted: two record types
 * disagreeing about `Title` cannot both be served by a map with one key, and
 * that is precisely why this is the fallback rather than the answer.
 */
export const fieldLexicon = (
  entities: readonly EntitySpec[],
): Readonly<Record<string, string>> => {
  const lexicon: Record<string, string> = {};
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (!field.label || field.visibility === "hidden") continue;
      if (lexicon[field.path] === undefined) lexicon[field.path] = field.label;
    }
  }
  return lexicon;
};

/* ── one record type, ready to draw a page of ──────────────────────────── */

/** One field of a record, resolved for somebody reading it. */
export interface EntityPageField {
  readonly path: string;
  /** Always present: the entity's own label, or one read off the path. */
  readonly label: string;
  readonly description?: string | undefined;
  readonly group?: string | undefined;
  /** Never `hidden` — those are dropped rather than carried and ignored. */
  readonly visibility: "primary" | "detail";
  readonly semantic?: SemanticType | undefined;
  /**
   * How to read the values, by the rule a compiled widget follows — see
   * `fieldReading`. A flag Rentvine sends as 0/1 is read as a flag here too.
   */
  readonly coercion?: Coercion | undefined;
  /** What the values are once read, where that needs saying. */
  readonly readAs?: SemanticType | undefined;
}

/** A collection belonging to this record, ready to become a widget. */
export interface EntityPageSection {
  readonly id: string;
  readonly entity: string;
  readonly title: string;
  /** The field on the far rows holding this record's id. */
  readonly field: string;
  readonly reach: ReachPlan;
  readonly cost: ReachCost;
  readonly verified: boolean;
  /**
   * The field identifying one far record, where it has one.
   *
   * What makes a row in this section openable. Without it a reader can see a
   * work order listed under its vendor and have no way to reach the work order
   * itself, which is a dead end in the middle of the one journey this layer
   * exists for. Absent for the record types nobody has identified — 11 of a
   * real API's 108 — and then the rows stay read-only, which is honest rather
   * than a control that goes nowhere.
   */
  readonly identity?: string | undefined;
  /**
   * The far record's other ids, where it lives under a parent.
   *
   * What a row in this section needs besides its identity to open its own
   * page — usually this very record, when the section is the collection the
   * API scopes under it.
   */
  readonly parents?: readonly AddressPart[] | undefined;
  /**
   * How to read the far columns, where any needs it — the far record type's
   * own \`fieldReading\`, keyed by field path.
   */
  readonly readings?:
    | Readonly<Record<string, { readonly coercion?: Coercion; readonly readAs?: SemanticType }>>
    | undefined;
  /**
   * The far fields worth a column, name first.
   *
   * Deliberately no component: a section renders as a table, because the four
   * candidate components bind different roles and getting one wrong fails the
   * binding check rather than merely reading worse. Choosing a record type's
   * natural reading belongs with the widget compiler, which binds roles
   * properly; until then a table of the right columns is the honest version.
   */
  readonly columns: readonly string[];
}

/**
 * A number about this record, read off a collection the page already loads.
 *
 * "Open work orders", "Total billed" — the figures somebody wants before they
 * want a table. Each one names the section it is computed from, and that is
 * what makes it free: the section's rows are fetched once and the cache keys
 * on the request rather than on the pipeline, so counting them costs no
 * request at all.
 *
 * Carries its section's cost, because a number read off a capped scan is an
 * undercount and saying "47" when the answer is "at least 47" is the confident
 * wrongness this layer exists to avoid.
 */
export interface EntityPageStat {
  /** The section this reads, which is also what makes it unique on a page. */
  readonly section: string;
  readonly label: string;
  readonly agg: "count" | "sum";
  /** Required for a sum; a count counts records. */
  readonly field?: string | undefined;
  readonly cost: ReachCost;
}

/** A relationship this page will not show, and why — never dropped silently. */
export interface OmittedSection {
  readonly id: string;
  readonly reason: string;
}

/** Everything needed to draw one record's page, and nothing else. */
export interface EntityPageView {
  readonly entity: string;
  readonly resource: string;
  readonly name: { readonly one: string; readonly many: string };
  readonly kind: EntityKind;
  readonly description?: string | undefined;
  readonly identity?: string | undefined;
  readonly title: readonly string[];
  readonly titleMode?: "join" | "first";
  readonly subtitle?: string | undefined;
  readonly status?: string | undefined;
  /**
   * The endpoint returning one of these, when anything returns one.
   *
   * `parents` lists the other ids it needs, which the page's address has to
   * carry: a unit's page is fetched with its property's id as well as its own.
   */
  readonly detail?:
    | {
        readonly op: string;
        readonly param: string;
        readonly parents?: readonly AddressPart[] | undefined;
      }
    | undefined;
  readonly fields: readonly EntityPageField[];
  /** Up to four facts for the heading, where the entity names any. */
  readonly facts: readonly string[];
  readonly groups: readonly FieldGroup[];
  readonly sections: readonly EntityPageSection[];
  /**
   * How many relationships exist, as opposed to how many are shown.
   *
   * Measured on a real API: one record type has 26 related collections, and a
   * page of 26 tabs is a filing cabinet rather than a page. The cap is stated
   * here so the page can say "8 of 26" instead of implying there are eight.
   */
  readonly sectionsTotal: number;
  readonly omitted: readonly OmittedSection[];
  /**
   * Other records the API sends inside these records' rows. Their fields are
   * left off this page; each one known is a link, and one of unknown type —
   * a Rentvine `contact` could be a tenant, a vendor or an owner — is named
   * here so the page can say it was left off rather than drop it silently.
   */
  readonly bundles?:
    | readonly { readonly path: string; readonly entity?: string; readonly name?: string }[]
    | undefined;
  /**
   * Fields on these records that point at another record.
   *
   * Carried for the builder, which has to answer "what can I follow from
   * here?" before anything is on screen. That is a different question from the
   * one `entityLinkViews` answers — how to *draw* a link on rows already
   * fetched — which is why the page does not otherwise repeat it.
   */
  readonly references: readonly {
    readonly field: string;
    readonly label: string;
    readonly target: string;
    readonly targetName: string;
  }[];
  /**
   * The filter strips a widget over these records gets by default.
   *
   * The same answer the compiler would reach on its own, carried so a builder
   * can show what is already chosen before somebody changes it. A screen that
   * worked this out separately would eventually describe a widget other than
   * the one it makes.
   */
  readonly filters: readonly string[];
  /** How a list of these is ordered by default, where anything fits. */
  readonly sort?: { readonly field: string; readonly dir: "asc" | "desc" } | undefined;
  /** Numbers read off the sections above, in the order they should be shown. */
  readonly stats: readonly EntityPageStat[];
}

/**
 * How many collections a page will show, and how many columns each gets.
 *
 * `MAX_SECTIONS` matches `recordOverrideSchema.sections`, so what a page shows
 * by default and what an override can name cannot disagree.
 */
const MAX_SECTIONS = 8;

/**
 * How many numbers fit above a record before they stop being read.
 *
 * Four is what a row of figures holds at a glance; past that it is a table
 * pretending to be a summary, and a reader scans it rather than taking it in.
 */
const MAX_STATS = 4;

/**
 * The numbers a record page leads with, chosen from what it already loads.
 *
 * Deterministic, and deliberately so: a count of a collection needs no opinion
 * about anything, and paying a model to name "Work orders" when the section is
 * already called that would be paying for a synonym. A record type may state
 * its own in `views.stats` — that is where a sum belongs, since which field is
 * worth totalling genuinely is a judgement — and those win.
 *
 * Complete answers first. A stat over a capped scan is an undercount, and the
 * four slots are better spent on figures that are simply true.
 */
const statsFor = (
  entity: EntitySpec,
  sections: readonly EntityPageSection[],
): EntityPageStat[] => {
  const byId = new Map(sections.map((section) => [section.id, section]));

  const stated = entity.views.stats.flatMap((stat) => {
    const section = byId.get(stat.backref);
    // A stat naming a section this page does not show would render a number
    // with nothing behind it, and no request to compute it from.
    if (!section) return [];
    if (stat.agg !== "count" && stat.agg !== "sum") return [];
    if (stat.agg === "sum" && !stat.field) return [];
    return [
      {
        section: section.id,
        label: stat.label,
        agg: stat.agg,
        ...(stat.field ? { field: stat.field } : {}),
        cost: section.cost,
      } as EntityPageStat,
    ];
  });

  const counted = new Set(stated.map((stat) => stat.section));
  const derived: EntityPageStat[] = sections
    .filter((section) => !counted.has(section.id))
    .map((section) => ({
      section: section.id,
      label: section.title,
      agg: "count" as const,
      cost: section.cost,
    }));

  const order: Record<ReachCost, number> = { free: 0, cheap: 1, partial: 2 };
  return [...stated, ...derived]
    .sort((a, b) => order[a.cost] - order[b.cost])
    .slice(0, MAX_STATS);
};
const MAX_SECTION_COLUMNS = 5;

/** Complete answers before partial ones — a section that is all of it leads. */
const COST_ORDER: Readonly<Record<ReachCost, number>> = { free: 0, cheap: 1, partial: 2 };

/** The far fields a section shows: its name first, then a few more. */
const sectionColumns = (entity: EntitySpec | undefined): readonly string[] => {
  if (!entity) return [];
  if (entity.views.columns.length > 0) {
    return entity.views.columns.slice(0, MAX_SECTION_COLUMNS);
  }
  const visible = entity.fields.filter((field) => field.visibility !== "hidden");
  const primary = visible.filter((field) => field.visibility === "primary");
  const pool = primary.length > 0 ? primary : visible;
  /*
   * The record's own name leads, whatever its visibility says. A section of
   * work orders that opens with an id column is a table of numbers, and the
   * name is the one column somebody reads to find the row they meant.
   */
  const wanted = [...(entity.display?.title ?? []), ...pool.map((field) => field.path)];
  return [...new Set(wanted)].slice(0, MAX_SECTION_COLUMNS);
};

/**
 * Sections read off the field dictionary, when the entity states no layout.
 *
 * The views pass is optional and has not been run on any real entry, so
 * `views.record.groups` is empty everywhere — while 76 of 108 record types
 * already carry a `group` on their fields from the entity pass. Reading the
 * grouping out of the dictionary is the difference between a page organised
 * into sections and one long list, at no cost and with no second pass.
 */
const groupsFromFields = (fields: readonly EntityPageField[]): FieldGroup[] => {
  const order: string[] = [];
  const byTitle = new Map<string, string[]>();
  for (const field of fields) {
    if (!field.group) continue;
    const held = byTitle.get(field.group);
    if (held) held.push(field.path);
    else {
      byTitle.set(field.group, [field.path]);
      order.push(field.group);
    }
  }
  return order.map((title) => ({ title, fields: byTitle.get(title) ?? [] }));
};

/**
 * One record type, projected into what drawing its page needs.
 *
 * Fetched when a page opens rather than carried on every connection read, and
 * that is a measurement rather than a preference: everything pages need for a
 * real API's 108 record types is 132 KB on a payload read at *every* page
 * load, against 8.3 KB for the largest single record type on demand. The
 * links projection stays where it is, because references are drawn on the
 * board where no page has been opened at all.
 *
 * Deliberately carries no references: a widget naming its entity already gets
 * reference cells from `entityLinkViews`, which the client holds before any
 * page is opened. Sending them twice would make one of the two copies wrong
 * eventually.
 */
export const entityPageView = (
  input: EntityGraphInput,
  entityId: string,
): EntityPageView | null => {
  const entity = entityById(input.entities, entityId);
  if (!entity) return null;

  const graph = entityGraph(input);
  const resource = input.resources.find((one) => one.id === entity.resource);

  /*
   * A hidden field that holds another record's identity is kept.
   *
   * `hidden` is the entity pass's verdict on a field's *value*, and for a
   * foreign key that verdict is right: nobody wants to read `VendorId: 55`.
   * But the id is also the only way into that record — a renderer turns it
   * into the vendor's name and a link — so dropping it here removed the link
   * along with the number. On a real API every foreign key is hidden, which is
   * how a record page came to have no way to reach anything it pointed at.
   *
   * Only where the far record can actually be opened. A reference nothing can
   * fetch would come back as the bare id this rule exists to keep off a page.
   */
  const linkable = new Set(
    graph
      .referencesOf(entity.id)
      .filter((reference) => reference.reach !== null)
      .map((reference) => reference.field),
  );

  /*
   * The records sent inside this one's rows are theirs, not its: a work
   * order page listed its contact's thirty fields as the work order's own.
   * Each keeps one field here — its id, which the reference above turns into
   * a named link — and the rest stay on the bundled record's own page.
   */
  const bundles = bundlesOf(entity, input.entities);
  /** A bundled record's link reads as that record, not as its id. */
  const bundleLabel = (path: string): string | undefined => {
    const bundle = bundleOf(bundles, path);
    const target = bundle?.entity ? entityById(input.entities, bundle.entity) : undefined;
    return target?.identity?.field === path ? target.name.one : undefined;
  };
  const kept = entity.fields.filter((field) => {
    // The bundled record's link stays, openable or not: its name is on the row.
    if (bundleLabel(field.path) !== undefined) return true;
    if (bundleOf(bundles, field.path)) return false;
    // Everything else `hidden` covers — internal keys and fields that are null
    // on every record — stays dropped. Carrying those for a client to
    // re-filter would be shipping the noise this layer exists to remove.
    return field.visibility !== "hidden" || linkable.has(field.path);
  });

  /*
   * Containers whose parts are listed separately.
   *
   * A nested field arrives both as the object and as each of its leaves, and
   * showing both puts a row on a record page that reads
   * `{Provider, PolicyNumber, …}` directly above the rows spelling out the
   * provider and the policy number. The summary form is right in a table cell,
   * where a row has to stay one line — on a record page, where every leaf is
   * already given its own labelled row, it is noise wearing a field's clothes.
   *
   * Dropped only when a leaf actually survived the filter above: a container
   * whose parts are all hidden is the only evidence that data exists at all,
   * and removing it there would hide the information rather than tidy it.
   */
  const spelledOut = new Set<string>();
  for (const field of kept) {
    const parts = field.path.split(".");
    for (let depth = 1; depth < parts.length; depth++) {
      spelledOut.add(parts.slice(0, depth).join("."));
    }
  }

  const fields: EntityPageField[] = kept
    // A reference recorded against the object rather than the id inside it is
    // kept regardless: it carries the link, which no leaf of it does.
    .filter((field) => !spelledOut.has(field.path) || linkable.has(field.path))
    .map((field) => ({
      path: field.path,
      label: bundleLabel(field.path) ?? field.label ?? humanLabel(field.path),
      ...(field.description ? { description: field.description } : {}),
      ...(field.group ? { group: field.group } : {}),
      visibility: field.visibility === "primary" ? ("primary" as const) : ("detail" as const),
      ...(field.semantic ? { semantic: field.semantic } : {}),
      ...(() => {
        const reading = fieldReading(field);
        const readAs = reading.semantic ?? (isFlagField(field) ? ("boolean" as const) : undefined);
        return {
          ...(reading.coercion ? { coercion: reading.coercion } : {}),
          ...(readAs ? { readAs } : {}),
        };
      })(),
    }));

  const shown = new Set(fields.map((field) => field.path));
  const stated = entity.views.record.groups
    .map((group) => ({ title: group.title, fields: group.fields.filter((path) => shown.has(path)) }))
    .filter((group) => group.fields.length > 0);

  const sections: EntityPageSection[] = [];
  const omitted: OmittedSection[] = [];

  for (const backref of graph.backrefsOf(entity.id)) {
    /*
     * A list-valued scan is the one relationship that cannot be asked for
     * honestly. Narrowing it means testing whether this record's id is *in*
     * a list on each far row, and the expression language compares strictly —
     * so `'41' in [41]` is false, and the section would render empty for a
     * record that has rows. Two of a real API's 148 relationships are this
     * shape: few enough to name, and far too wrong to show.
     */
    if (backref.reach.mode === "scan" && backref.reach.holds === "array") {
      omitted.push({
        id: backref.id,
        reason: `${backref.title} hold a list of ids and this endpoint cannot be asked for one record's rows, so the section could not be narrowed without being wrong`,
      });
      continue;
    }

    const far = entityById(input.entities, backref.entity);
    const farParents = graph.addressOf(backref.entity)?.parents ?? [];
    const columns = sectionColumns(far);
    const readings: Record<string, { coercion?: Coercion; readAs?: SemanticType }> = {};
    for (const path of columns) {
      const field = far?.fields.find((one) => one.path === path);
      if (!field) continue;
      const reading = fieldReading(field);
      const readAs = reading.semantic ?? (isFlagField(field) ? ("boolean" as const) : undefined);
      if (reading.coercion || readAs) {
        readings[path] = {
          ...(reading.coercion ? { coercion: reading.coercion } : {}),
          ...(readAs ? { readAs } : {}),
        };
      }
    }
    sections.push({
      id: backref.id,
      entity: backref.entity,
      title: backref.title,
      field: backref.field,
      reach: backref.reach,
      cost: backref.cost,
      verified: backref.verified,
      ...(far?.identity ? { identity: far.identity.field } : {}),
      ...(farParents.length > 0 ? { parents: farParents } : {}),
      ...(Object.keys(readings).length > 0 ? { readings } : {}),
      columns,
    });
  }

  sections.sort(
    (a, b) => COST_ORDER[a.cost] - COST_ORDER[b.cost] || a.title.localeCompare(b.title),
  );

  return {
    entity: entity.id,
    resource: entity.resource,
    name: { one: entity.name.one, many: entity.name.many },
    kind: entity.kind,
    ...(entity.description ? { description: entity.description } : {}),
    ...(entity.identity ? { identity: entity.identity.field } : {}),
    title: entity.display?.title ?? [],
    titleMode: titleModeOf(entity),
    ...(entity.display?.subtitle ? { subtitle: entity.display.subtitle } : {}),
    ...(entity.display?.status ? { status: entity.display.status } : {}),
    ...(() => {
      const address = graph.addressOf(entity.id);
      if (!address) return {};
      return {
        detail: {
          op: address.op,
          param: address.param,
          ...(address.parents.length > 0 ? { parents: address.parents } : {}),
        },
      };
    })(),
    fields,
    facts: entity.views.record.facts.filter((path) => shown.has(path)),
    groups: stated.length > 0 ? stated : groupsFromFields(fields),
    sections: sections.slice(0, MAX_SECTIONS),
    // Only over sections the page actually shows: a number computed from rows
    // nothing fetched would need a request of its own, which is the one thing
    // these are supposed not to cost.
    stats: statsFor(entity, sections.slice(0, MAX_SECTIONS)),
    sectionsTotal: sections.length,
    omitted,
    ...(bundles.length > 0
      ? {
          bundles: bundles.map((bundle) => {
            const target = bundle.entity ? entityById(input.entities, bundle.entity) : undefined;
            return {
              path: bundle.path,
              ...(target ? { entity: target.id, name: target.name.one } : {}),
            };
          }),
        }
      : {}),
    references: graph.referencesOf(entity.id).flatMap((reference) => {
      const target = entityById(input.entities, reference.target);
      if (!target) return [];
      return [
        {
          field: reference.field,
          label: reference.label ?? humanLabel(reference.field),
          target: target.id,
          targetName: target.name.one,
        },
      ];
    }),
    // Only the strips that name a field this page actually shows: offering one
    // over a field the describing pass called noise would offer a strip the
    // reader cannot see the effect of.
    filters: defaultFacets(entity).filter((path) => shown.has(path)),
    ...(() => {
      const chosen = defaultSort(entity);
      return chosen && shown.has(chosen.field) ? { sort: chosen } : {};
    })(),
  };
};

/** The entity ids a reference could resolve to, default first. */
export const targetsOf = (reference: ReferenceSpec): readonly string[] => [
  ...new Set([reference.entity, ...Object.values(reference.typeField?.map ?? {})]),
];

/**
 * Which entity a polymorphic reference means for one row.
 *
 * Falls back to the declared default rather than guessing among the map's
 * values: a type nobody recorded is a link that cannot be followed, and
 * following it to the wrong record type is worse than not offering it.
 */
export const targetFor = (
  reference: ReferenceSpec,
  row: Readonly<Record<string, unknown>>,
): string => {
  const selector = reference.typeField;
  if (!selector) return reference.entity;
  const raw = readField(row, selector.field);
  if (raw === null || raw === undefined) return reference.entity;
  return selector.map[String(raw)] ?? reference.entity;
};

/**
 * What a link is *for*, read off the field that holds it.
 *
 * `CreatedByUser.Id` is "Created by user", `AssignedToUserId` is "Assigned
 * to user", `predictedWorkOrderID` is "Predicted work order": the id part is
 * dropped, because it says what the value is and not which link it is.
 */
const linkRole = (field: string): string => {
  const parts = field.split(".").filter((part) => part.length > 0);
  const leaf = parts[parts.length - 1] ?? field;
  const stripped = looksLikeIdentifier(leaf) ? leaf.replace(/[_-]?(Id|ID|id)$/, "") : leaf;
  const named = stripped !== "" ? stripped : (parts[parts.length - 2] ?? leaf);
  return humanLabel(named);
};

/**
 * Titles for the sections one record type contributes to another's page.
 *
 * Several fields on one record type can point at the same target — a task's
 * creator, assignee and last editor are all users — and each is its own
 * section, deliberately. Titled only by the far record's plural, they read as
 * one section three times: "Task histories", "Task histories", "Task
 * histories" on a user's page. The field labels do not separate them either;
 * the description pass calls all three "User ID". So each gets the role its
 * field plays, and where two roles still read the same, the field's own path.
 *
 * A section the API scopes under this record keeps the plain title: it is the
 * collection that record owns, and the others are the ones that need saying.
 */
const titledBackrefs = (list: readonly EntityBackref[]): EntityBackref[] => {
  const byEntity = new Map<string, EntityBackref[]>();
  for (const backref of list) {
    const group = byEntity.get(backref.entity);
    if (group) group.push(backref);
    else byEntity.set(backref.entity, [backref]);
  }

  const titles = new Map<EntityBackref, string>();
  for (const group of byEntity.values()) {
    if (group.length < 2) continue;
    const linked = group.filter((backref) => backref.reach.mode !== "path");
    const roles = linked.map((backref) => linkRole(backref.field));
    linked.forEach((backref, index) => {
      const role = roles[index]!;
      const clash = roles.filter((one) => one === role).length > 1;
      titles.set(backref, `${backref.title} · ${clash ? humanLabel(backref.field) : role}`);
    });
  }
  return list.map((backref) => {
    const title = titles.get(backref);
    return title ? { ...backref, title } : backref;
  });
};

const bare = (op: GraphOp | undefined): boolean =>
  op !== undefined && pathParamNames(op.path).length === 0;

const leafOf = (path: string): string => path.split(".").pop() ?? path;
const rootOf = (path: string): string => (path.includes(".") ? (path.split(".")[0] ?? "") : "");

/**
 * Of several candidate fields, the one sitting beside `near`.
 *
 * A Rentvine work order row carries `workOrder.propertyID` and also the
 * bundled `property.propertyID`; for the work order's own link, its own
 * wrapper's copy is the one that belongs to it. Then the shallowest.
 */
const closestTo = (paths: readonly string[], near: string | undefined): string | undefined => {
  const nearRoot = near ? rootOf(near) : "";
  return [...paths].sort(
    (a, b) =>
      Number(rootOf(a) !== nearRoot) - Number(rootOf(b) !== nearRoot) ||
      a.split(".").length - b.split(".").length,
  )[0];
};
/**
 * The field on a reference that actually holds a comparable id.
 *
 * A reference may be recorded against the object rather than against the id
 * inside it — a task's `Vendor` rather than its `Vendor.Id` — and the object
 * is not something two rows can be matched on. Exported because a back
 * reference and a join have to reach for the same column: two spellings of
 * this rule would agree today and disagree the day one of them changed.
 */
export const linkColumn = (
  field: EntityField,
  reference: ReferenceSpec,
  target?: EntitySpec | undefined,
): string => {
  if (reference.holds !== "objectRef" || /\.(id)$/i.test(field.path)) return field.path;
  /*
   * The id inside the object is the target's own identity field, read from
   * inside its wrapper: a Rentvine `workOrder` holds `workOrderID`, a Buildium
   * `Vendor` holds `Id`. Assuming `Id` everywhere matched nothing on every
   * API that does not happen to spell it that way.
   */
  const identity = target?.identity?.field;
  const inner = identity
    ? identity.includes(".")
      ? identity.split(".").slice(1).join(".")
      : identity
    : "Id";
  return `${field.path}.${inner}`;
};

/**
 * The links a record type's rows carry, including the records sent inside
 * them.
 *
 * A record bundled into a row (see `bundlesOf`) is linked through its own id,
 * and its name is already on the row, so the link is free — nothing has to be
 * fetched to say "Work order 104842". Everything else inside the bundle is the
 * bundled record's, including the links *it* carries, so none of it is
 * treated as this record's own.
 */
const linksOf = (
  entity: EntitySpec,
  entities: readonly EntitySpec[],
  bundles: readonly Bundle[],
): { field: EntityField; reference: ReferenceSpec }[] =>
  entity.fields.flatMap((field) => {
    const bundle = bundleOf(bundles, field.path);
    if (!bundle) return field.reference ? [{ field, reference: field.reference }] : [];
    const target = bundle.entity ? entityById(entities, bundle.entity) : undefined;
    if (!target?.identity || field.path !== target.identity.field) return [];
    const onRow = new Set(entity.fields.map((one) => one.path));
    return [
      {
        field,
        reference: {
          entity: target.id,
          holds: "scalar" as const,
          embedded: (target.display?.title ?? []).filter((path) => onRow.has(path)),
          verified: field.reference?.verified ?? false,
        },
      },
    ];
  });

export const entityGraph = (input: EntityGraphInput): EntityGraph => {
  const opById = new Map(input.ops.map((op) => [op.id, op]));
  const resourceById = new Map(input.resources.map((resource) => [resource.id, resource]));
  const unreachable: UnreachableLink[] = [];

  const resourceOf = (entity: EntitySpec): ResourceSpec | undefined =>
    resourceById.get(entity.resource);

  /** A field on `entity` holding `param`, by name with the convention removed. */
  const fieldNamed = (entity: EntitySpec, param: string, near?: string): string | undefined => {
    const wanted = normaliseName(param);
    return closestTo(
      entity.fields
        .filter((field) => !field.kinds.includes("object") && !field.kinds.includes("array"))
        .map((field) => field.path)
        .filter((path) => normaliseName(leafOf(path)) === wanted),
      near,
    );
  };

  /** A field on `entity` pointing at a record of type `targetId`. */
  const fieldPointingAt = (
    entity: EntitySpec,
    targetId: string,
    near: string,
  ): string | undefined =>
    closestTo(
      entity.fields
        .filter((field) => field.reference?.entity === targetId && field.reference.holds !== "array")
        .map((field) =>
          field.reference
            ? linkColumn(field, field.reference, entityById(input.entities, targetId))
            : field.path,
        ),
      near,
    );

  /**
   * The record type a parent parameter identifies.
   *
   * The API's own statement first: a scoped collection says which parent it
   * lives under. Otherwise the record type whose one-record endpoint this
   * path begins with, by the same parameter — `/properties/{propertyID}` is
   * the start of `/properties/{propertyID}/units/{unitID}`.
   */
  const parentEntityOf = (entity: EntitySpec, op: GraphOp, param: string): string | undefined => {
    const wanted = normaliseName(param);
    if (entity.scope && normaliseName(entity.scope.param) === wanted) return entity.scope.parent;
    for (const resource of input.resources) {
      if (!resource.detailOp || !resource.detailParam) continue;
      if (normaliseName(resource.detailParam) !== wanted) continue;
      const parentOp = opById.get(resource.detailOp);
      if (!parentOp || !op.path.startsWith(`${parentOp.path}/`)) continue;
      const parent = entityForResource(input.entities, resource.id);
      if (parent && parent.id !== entity.id) return parent.id;
    }
    return undefined;
  };

  /**
   * How one record of this type is fetched: its endpoint, and every id that
   * endpoint's path needs.
   *
   * Most need only their own. One that lives under a parent needs the
   * parent's as well, and each is found where it can be — on the record, or
   * from the parent it was opened under — so the ones that can be opened are,
   * and the ones that cannot say why rather than sending a request with a hole
   * in it. An endpoint this connection does not list is taken at its word:
   * there is no path to read parents from.
   */
  const addresses = new Map<string, RecordAddress | null>();
  const addressOf = (entityId: string): RecordAddress | null => {
    if (addresses.has(entityId)) return addresses.get(entityId) ?? null;
    const entity = entityById(input.entities, entityId);
    const resource = entity ? resourceOf(entity) : undefined;
    let address: RecordAddress | null = null;
    if (entity && resource?.detailOp && resource.detailParam) {
      const op = opById.get(resource.detailOp);
      const parents = op
        ? pathParamNames(op.path)
            .filter((param) => param !== resource.detailParam)
            .map((param): AddressPart => {
              const field = fieldNamed(entity, param, entity.identity?.field);
              const parent = parentEntityOf(entity, op, param);
              return { param, ...(field ? { field } : {}), ...(parent ? { entity: parent } : {}) };
            })
        : [];
      address = { op: resource.detailOp, param: resource.detailParam, parents };
    }
    addresses.set(entityId, address);
    return address;
  };

  const references = new Map<string, EntityReference[]>();
  const backrefs = new Map<string, EntityBackref[]>();
  const push = <T>(into: Map<string, T[]>, key: string, value: T): void => {
    const held = into.get(key);
    if (held) held.push(value);
    else into.set(key, [value]);
  };

  for (const entity of input.entities) {
    for (const { field, reference } of linksOf(entity, input.entities, bundlesOf(entity, input.entities))) {
      const target = entityById(input.entities, reference.entity);
      if (!target) {
        unreachable.push({
          from: entity.id,
          field: field.path,
          reason: `it points at "${reference.entity}", which this API does not describe`,
        });
        continue;
      }

      /* ── outgoing: open the record this field names ───────────────────── */

      /*
       * A nested target is opened with the ids of what it lives under, read
       * off this same row: a work order names its unit *and* its property, and
       * the unit is `/properties/{propertyID}/units/{unitID}`. The field is the
       * one pointing at that parent where the row has one, else one named for
       * the parameter — the closest to this link either way.
       */
      const address = addressOf(target.id);
      const linked = address?.parents.map((part) => {
        const onRow =
          (part.entity ? fieldPointingAt(entity, part.entity, field.path) : undefined) ??
          fieldNamed(entity, part.param, field.path);
        return onRow ? { param: part.param, field: onRow } : null;
      });
      const reach: ReachPlan | null =
        address && linked && linked.every((part) => part !== null)
          ? {
              mode: "record",
              op: address.op,
              param: address.param,
              ...(linked.length > 0 ? { parents: linked as LinkedPart[] } : {}),
            }
          : null;

      if (!reach && reference.embedded.length === 0) {
        /*
         * Nothing to open and no name carried on the row, so the link would
         * render as the number it already is. Reported rather than offered:
         * a link that goes nowhere is worse than a plain value, because it
         * looks like something worth clicking.
         */
        unreachable.push({
          from: entity.id,
          field: field.path,
          reason: address
            ? `${target.name.one} can only be fetched through the record it belongs to, and this row does not say which`
            : `${target.name.one} has no by-id endpoint and the row carries no name for it`,
        });
      }

      push(references, entity.id, {
        id: field.path,
        field: field.path,
        label: field.label,
        target: target.id,
        holds: reference.holds,
        embedded: reference.embedded,
        typeField: reference.typeField,
        reach,
        cost: reference.embedded.length > 0 ? "free" : "cheap",
        verified: reference.verified,
      });

      /* ── incoming: this entity's rows become a section on the target ─── */

      const listOp = resourceOf(entity)?.listOp;
      const op = listOp ? opById.get(listOp) : undefined;
      if (!listOp || !op) continue;

      /*
       * A collection that needs an id in its URL is reachable only through the
       * parent that supplies one, and that is handled by `scope` below. Listed
       * here it would send `{{param.x}}` unresolved.
       */
      if (!bare(op)) continue;

      const column = linkColumn(field, reference, target);
      const declared = field.filter?.param ?? declaredFilterParam(op, field.filter?.via ?? column);

      for (const targetId of targetsOf(reference)) {
        if (!entityById(input.entities, targetId)) continue;
        push(backrefs, targetId, {
          id: `${entity.id}-by-${field.path}`,
          entity: entity.id,
          title: entity.name.many,
          field: column,
          reach: declared
            ? { mode: "filter", op: listOp, param: declared }
            : {
                mode: "scan",
                op: listOp,
                field: column,
                holds: reference.holds === "array" ? "array" : "scalar",
              },
          /*
           * The honest half. A filtered request answers completely; a scan
           * stops at the page cap, so rows belonging to this record can sit
           * past the last page fetched and the section renders empty for a
           * record that does have some.
           */
          cost: declared ? "cheap" : "partial",
          verified: reference.verified,
        });
      }
    }

    /*
     * A collection that only exists inside another record is a section on that
     * record, and the strongest kind: the API put the parent in the URL, so
     * nothing was inferred from a name.
     */
    if (entity.scope) {
      const listOp = resourceOf(entity)?.listOp;
      if (listOp && entityById(input.entities, entity.scope.parent)) {
        /*
         * The endpoint's other parameters, which only a parent that is itself
         * nested has: the page's own address fills them.
         */
        const listed = opById.get(listOp);
        const others = listed
          ? pathParamNames(listed.path).filter((param) => param !== entity.scope!.param)
          : [];
        push(backrefs, entity.scope.parent, {
          id: `${entity.id}-under-${entity.scope.parent}`,
          entity: entity.id,
          title: entity.name.many,
          field: entity.scope.param,
          reach: {
            mode: "path",
            op: listOp,
            param: entity.scope.param,
            ...(others.length > 0 ? { parents: others } : {}),
          },
          cost: "cheap",
          verified: true,
        });
      }
    }
  }

  for (const [target, list] of backrefs) backrefs.set(target, titledBackrefs(list));

  const byOp = new Map<string, EntitySpec>();
  for (const resource of input.resources) {
    const entity = entityForResource(input.entities, resource.id);
    if (!entity) continue;
    if (resource.listOp) byOp.set(resource.listOp, entity);
    if (resource.detailOp) byOp.set(resource.detailOp, entity);
  }

  return {
    entityOf: (opId) => byOp.get(opId),
    referencesOf: (entityId) => references.get(entityId) ?? [],
    backrefsOf: (entityId) => backrefs.get(entityId) ?? [],
    addressOf,
    resolveField: (opId, column, sources) => {
      const entity = byOp.get(opId);
      if (!entity) return undefined;
      const path = sources?.[column] ?? column;
      const found = (references.get(entity.id) ?? []).find(
        (reference) => reference.field === path,
      );
      return found ? { entity, reference: found } : undefined;
    },
    unreachable,
  };
};
