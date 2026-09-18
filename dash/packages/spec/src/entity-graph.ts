import type { EntityField, EntityKind, EntitySpec, ReferenceSpec } from "./entity.js";
import { entityById, entityForResource, titleModeOf } from "./entity.js";
import { defaultFacets, defaultSort } from "./recipes.js";
import type { FieldGroup } from "./dashboard.js";
import { humanLabel } from "./presentation.js";
import type { SemanticType } from "./semantics.js";
import type { GraphOp } from "./relations.js";
import { declaredFilterParam } from "./relations.js";
import type { ResourceSpec } from "./resource.js";
import { pathParamNames } from "./primitives.js";

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

/** How the far side of a link is actually reached. */
export type ReachPlan =
  /** One record, by its own id: `/vendors/{vendorId}`. */
  | { readonly mode: "record"; readonly op: string; readonly param: string }
  /** A collection scoped under this record: `/tasks/{taskId}/history`. */
  | { readonly mode: "path"; readonly op: string; readonly param: string }
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
  /** What to call the section, from the far entity's own plural. */
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
  /** The endpoint that returns one far record, when anything can open one. */
  readonly lookup?: { readonly op: string; readonly param: string } | undefined;
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
          ? { lookup: { op: reference.reach.op, param: reference.reach.param } }
          : {}),
        free: reference.cost === "free",
      };
      return [view];
    });

    const resource = resourceById.get(entity.resource);
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
  /** The endpoint returning one of these, when anything returns one. */
  readonly detail?: { readonly op: string; readonly param: string } | undefined;
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

  const fields: EntityPageField[] = entity.fields
    // Everything else `hidden` covers — internal keys and fields that are null
    // on every record — stays dropped. Carrying those for a client to
    // re-filter would be shipping the noise this layer exists to remove.
    .filter((field) => field.visibility !== "hidden" || linkable.has(field.path))
    .map((field) => ({
      path: field.path,
      label: field.label ?? humanLabel(field.path),
      ...(field.description ? { description: field.description } : {}),
      ...(field.group ? { group: field.group } : {}),
      visibility: field.visibility === "primary" ? ("primary" as const) : ("detail" as const),
      ...(field.semantic ? { semantic: field.semantic } : {}),
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
    sections.push({
      id: backref.id,
      entity: backref.entity,
      title: backref.title,
      field: backref.field,
      reach: backref.reach,
      cost: backref.cost,
      verified: backref.verified,
      ...(far?.identity ? { identity: far.identity.field } : {}),
      columns: sectionColumns(far),
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
    ...(resource?.detailOp && resource.detailParam
      ? { detail: { op: resource.detailOp, param: resource.detailParam } }
      : {}),
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
  const raw = row[selector.field] ?? row[selector.field.replace(/\./g, "_")];
  if (raw === null || raw === undefined) return reference.entity;
  return selector.map[String(raw)] ?? reference.entity;
};

const bare = (op: GraphOp | undefined): boolean =>
  op !== undefined && pathParamNames(op.path).length === 0;

/**
 * The field on a reference that actually holds a comparable id.
 *
 * A reference may be recorded against the object rather than against the id
 * inside it — a task's `Vendor` rather than its `Vendor.Id` — and the object
 * is not something two rows can be matched on. Exported because a back
 * reference and a join have to reach for the same column: two spellings of
 * this rule would agree today and disagree the day one of them changed.
 */
export const linkColumn = (field: EntityField, reference: ReferenceSpec): string =>
  reference.holds === "objectRef" && !/\.(id)$/i.test(field.path)
    ? `${field.path}.Id`
    : field.path;

export const entityGraph = (input: EntityGraphInput): EntityGraph => {
  const opById = new Map(input.ops.map((op) => [op.id, op]));
  const resourceById = new Map(input.resources.map((resource) => [resource.id, resource]));
  const unreachable: UnreachableLink[] = [];

  const resourceOf = (entity: EntitySpec): ResourceSpec | undefined =>
    resourceById.get(entity.resource);

  const references = new Map<string, EntityReference[]>();
  const backrefs = new Map<string, EntityBackref[]>();
  const push = <T>(into: Map<string, T[]>, key: string, value: T): void => {
    const held = into.get(key);
    if (held) held.push(value);
    else into.set(key, [value]);
  };

  for (const entity of input.entities) {
    for (const field of entity.fields) {
      const reference = field.reference;
      if (!reference) continue;

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

      const targetResource = resourceOf(target);
      const reach: ReachPlan | null =
        targetResource?.detailOp && targetResource.detailParam
          ? { mode: "record", op: targetResource.detailOp, param: targetResource.detailParam }
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
          reason: `${target.name.one} has no by-id endpoint and the row carries no name for it`,
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

      const column = linkColumn(field, reference);
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
        push(backrefs, entity.scope.parent, {
          id: `${entity.id}-under-${entity.scope.parent}`,
          entity: entity.id,
          title: entity.name.many,
          field: entity.scope.param,
          reach: { mode: "path", op: listOp, param: entity.scope.param },
          cost: "cheap",
          verified: true,
        });
      }
    }
  }

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
