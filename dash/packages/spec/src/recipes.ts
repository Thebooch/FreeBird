import type { BuiltinComponentId } from "./contracts.js";
import type { EntityKind, EntitySpec } from "./entity.js";
import type { SemanticType } from "./semantics.js";

/**
 * What a list of each kind of record should look like before anybody asks.
 *
 * The safe assumptions, written down once. Most dashboard choices are not
 * interesting: a list of work sorts by when it is due and filters by status, a
 * list of people sorts by name, money sorts newest first and totals. Asking
 * somebody to make those decisions for every widget is the interrogation this
 * product is trying to stop, and asking a model to invent them per API pays
 * repeatedly for an answer that never changes.
 *
 * **These are code, not data.** They are true of the *kind*, on every API, so
 * they ship with the product and the per-API pass only fills in which field
 * plays each part. A recipe is therefore a guardrail rather than a decision:
 * where an entity's own `views` names a field, that wins; where it does not,
 * this says what to reach for.
 *
 * Nothing here names a domain. `work` is not "maintenance" and `party` is not
 * "tenant" — the words are shapes, and the hints below are English naming
 * conventions of the same kind `guessSemantic` and `statusTone` already read.
 */

export interface EntityRecipe {
  readonly kind: EntityKind;
  /** What this kind is, for a person choosing between two readings. */
  readonly description: string;
  /** The view a plain list of these reads best as. */
  readonly component: BuiltinComponentId;
  /**
   * What to sort by, most wanted first, as semantics rather than field names.
   *
   * Resolved against the entity's own fields, so an API that calls it
   * `DueDate` and one that calls it `target_completion` both land on the same
   * column without either name appearing here.
   */
  readonly sortBy: readonly SemanticType[];
  readonly sortDir: "asc" | "desc";
  /**
   * Fields worth offering as filters, by naming convention, best first.
   *
   * A fallback ranking only: the per-API pass records the real answer in
   * `views.facets`, and this is what a widget gets when nobody has. Matched
   * against the leaf of a field path, case-insensitively.
   */
  readonly facetHints: readonly RegExp[];
  /**
   * Whether somebody would start a widget from these.
   *
   * False for the kinds that only make sense underneath another record: a
   * category is a word other records point at, and a list of categories is a
   * glossary rather than a dashboard. Those stay reachable as links and as
   * filters, which is where they are useful.
   */
  readonly starting: boolean;
  /** What a chart of these measures by default. */
  readonly measure: "count" | "sum";
}

const STATUS = /^(status|state|stage|phase)$/i;
const TYPE = /^(type|kind|category|categoryname|class|group)$/i;
const PRIORITY = /^(priority|severity|urgency)$/i;
const ASSIGNEE = /^(assignedto|assignee|owner|manager|responsible)$/i;
const ACTIVE = /^(isactive|active|enabled|archived|closed|completed)$/i;

export const RECIPES: Readonly<Record<EntityKind, EntityRecipe>> = {
  work: {
    kind: "work",
    description: "Something to be done, with a state and usually a date it is wanted by.",
    component: "table",
    // Soonest first: the useful end of a list of work is the near end.
    sortBy: ["timestamp"],
    sortDir: "asc",
    facetHints: [STATUS, TYPE, PRIORITY, ASSIGNEE],
    starting: true,
    measure: "count",
  },
  party: {
    kind: "party",
    description: "Someone dealt with — a customer, a resident, a supplier, a colleague.",
    component: "table",
    sortBy: ["text"],
    sortDir: "asc",
    facetHints: [STATUS, TYPE, ACTIVE],
    starting: true,
    measure: "count",
  },
  asset: {
    kind: "asset",
    description: "A thing owned or tracked, which usually belongs to somewhere or someone.",
    component: "table",
    sortBy: ["text"],
    sortDir: "asc",
    facetHints: [STATUS, TYPE, ACTIVE],
    starting: true,
    measure: "count",
  },
  place: {
    kind: "place",
    description: "Somewhere — a property, a site, a location other records hang off.",
    component: "cards",
    sortBy: ["text"],
    sortDir: "asc",
    facetHints: [STATUS, TYPE, ACTIVE],
    starting: true,
    measure: "count",
  },
  money: {
    kind: "money",
    description: "A movement or an obligation: a charge, a bill, a payment, an invoice.",
    component: "table",
    // Newest first, and the total is usually the point rather than the count.
    sortBy: ["timestamp"],
    sortDir: "desc",
    facetHints: [STATUS, TYPE],
    starting: true,
    measure: "sum",
  },
  document: {
    kind: "document",
    description: "Something kept on file — an agreement, a contract, an attachment.",
    component: "table",
    sortBy: ["timestamp"],
    sortDir: "desc",
    facetHints: [STATUS, TYPE],
    starting: true,
    measure: "count",
  },
  event: {
    kind: "event",
    description: "Something that happened at a moment, read newest first.",
    component: "feed",
    sortBy: ["timestamp", "relative_time"],
    sortDir: "desc",
    facetHints: [TYPE, STATUS],
    starting: true,
    measure: "count",
  },
  note: {
    kind: "note",
    description: "Something written about another record, and read in order.",
    component: "feed",
    sortBy: ["timestamp", "relative_time"],
    sortDir: "desc",
    facetHints: [TYPE],
    /*
     * Reachable under the record it is about, and not a starting point. A list
     * of every note in an account, detached from what each one is about, is
     * not something anybody asked for.
     */
    starting: false,
    measure: "count",
  },
  lookup: {
    kind: "lookup",
    description: "A small closed list other records point at — a category, a status, a type.",
    component: "list",
    sortBy: ["text"],
    sortDir: "asc",
    facetHints: [],
    starting: false,
    measure: "count",
  },
  other: {
    kind: "other",
    description: "Records that fit none of the usual shapes, treated neutrally.",
    component: "table",
    sortBy: ["timestamp", "text"],
    sortDir: "desc",
    facetHints: [STATUS, TYPE],
    starting: true,
    measure: "count",
  },
};

export const recipeFor = (kind: EntityKind | undefined): EntityRecipe =>
  RECIPES[kind ?? "other"] ?? RECIPES.other;

/**
 * The readings of a path a hint is tested against.
 *
 * The leaf alone is not enough, and `Category.Name` is why: its leaf is
 * `Name`, which says nothing, while the field plainly holds a category. For a
 * nested reference the meaning sits in the **parent** segment — the same
 * reason `humanLabel` speaks root-and-leaf past two levels ("Property city"
 * rather than "City").
 *
 * So three readings: the leaf, its parent, and the two joined. Separators come
 * out first, so `assigned_to` and `AssignedTo` are one word either way.
 */
const readingsOf = (path: string): readonly string[] => {
  const parts = path.split(".").map((part) => part.replace(/[_\s-]/g, ""));
  const leaf = parts[parts.length - 1] ?? path;
  const parent = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return parent ? [leaf, parent, `${parent}${leaf}`] : [leaf];
};

/**
 * Which of these fields a recipe would reach for as filters, best first.
 *
 * Ranked by the hint that matched rather than by the order the fields arrived,
 * so a status leads a type wherever both exist. Fields matching nothing are
 * left out entirely: a fallback that offers everything is not a fallback.
 */
export const facetsFromRecipe = (
  recipe: EntityRecipe,
  paths: readonly string[],
): readonly string[] => {
  const ranked: Array<{ path: string; rank: number }> = [];
  for (const path of paths) {
    const readings = readingsOf(path);
    const rank = recipe.facetHints.findIndex((hint) =>
      readings.some((reading) => hint.test(reading)),
    );
    if (rank >= 0) ranked.push({ path, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
};

/**
 * The filter strips a record type gets when nobody has said otherwise.
 *
 * One definition, because two callers need the same answer for different
 * reasons: the compiler uses it to build a widget, and the builder uses it to
 * show which strips are already ticked before somebody changes them. If those
 * disagreed, the screen would be describing a widget other than the one it is
 * about to make.
 */
/**
 * How a list of these records is ordered when nobody has said otherwise.
 *
 * Shared with the compiler for the same reason `defaultFacets` is: the builder
 * shows this as the chosen option before anybody changes it, and a screen
 * working it out separately would eventually describe a widget other than the
 * one it makes.
 *
 * Null where the record type carries nothing worth ordering by — which is a
 * real answer, not a failure. A list of lookups has no date and no amount, and
 * imposing an order on one would be inventing a meaning for it.
 */
export const defaultSort = (
  entity: EntitySpec,
): { readonly field: string; readonly dir: "asc" | "desc" } | null => {
  if (entity.views.sort) return { field: entity.views.sort.field, dir: entity.views.sort.dir };
  const recipe = recipeFor(entity.kind);
  const visible = entity.fields.filter((field) => field.visibility !== "hidden");
  for (const semantic of recipe.sortBy) {
    const found = visible.find((field) => field.semantic === semantic);
    if (found) return { field: found.path, dir: recipe.sortDir };
  }
  return null;
};

export const defaultFacets = (entity: EntitySpec): readonly string[] => {
  if (entity.views.facets.length > 0) return entity.views.facets;
  return facetsFromRecipe(
    recipeFor(entity.kind),
    entity.fields.filter((field) => field.visibility !== "hidden").map((field) => field.path),
  );
};
