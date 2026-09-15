import type { ComponentContract } from "@freebirdai/dash-spec";
import {
  FACET_MAX_PER_WIDGET,
  FACET_MAX_VALUES,
  guessSemantic,
  looksLikeIdentifier,
} from "@freebirdai/dash-spec";
import type { FieldInfo } from "../infer.js";

/**
 * Whether a widget should be built with a filter strip, and over which fields.
 *
 * Two ways one arrives, and they are held to different bars.
 *
 * **Asked for.** Somebody said "tasks with a filter by category". That is a
 * request, and honouring it needs no cardinality evidence: the field has to
 * exist, hold something tileable, and not be a date or an identifier. If its
 * values turn out to be too many to tile, `validateFacets` says so and the
 * strip is simply not drawn — a facet is chrome, and the worst it can do is
 * fail to appear.
 *
 * **Offered.** Nobody asked, and the map already recorded which field carries
 * the distinction on this endpoint — put there because it is true of the API
 * for everybody and worth mapping once. So a strip can be proposed with no
 * model call at all, and the bar is higher: every condition here rules out a
 * strip that would be drawn and be useless, because the cost of ruling one out
 * is that somebody adds it by hand.
 *
 * Cardinality is the difference. A sampled endpoint knows how many distinct
 * values a field holds; one described only by its specification does not, and
 * `distinct` is `0` there rather than unknown-as-a-number. Gating an asked-for
 * filter on that would refuse every filter on every API nobody has read yet,
 * which is most of them.
 */

/** A date or an amount is a range; two tiles per row is not a filter. */
const CATEGORICAL_KINDS = new Set(["string", "boolean", "number"]);

/**
 * Semantics that are never a category, read from the field's own name.
 *
 * Only consulted where cardinality is unknown, and only to refuse. An
 * identifier tiles once per row, a URL is unreadable as a tile, and a date or
 * an amount is a range — none of which a count beside a value can express.
 */
const NEVER_A_CATEGORY = new Set([
  "identifier",
  "url",
  "timestamp",
  "relative_time",
  "currency",
  "percent",
  "bytes",
  "duration",
  "count",
]);

export interface FacetableInput {
  /** What the endpoint was seen — or declared — to return. */
  readonly fields: readonly FieldInfo[];
  readonly contract: ComponentContract;
  /**
   * True when the widget aggregates.
   *
   * After a group step there are no records left, only buckets — the same
   * reason charts ignore highlights. A strip counting statuses above a chart
   * of monthly totals would be filtering rows that no longer exist.
   */
  readonly aggregated: boolean;
}

/**
 * Whether a strip can sit above this widget at all.
 *
 * `opensRecord` is the existing statement of exactly that — it decides whether
 * clicking a mark can open the thing behind it, and a mark with a record
 * behind it is a mark a facet can filter. A contract declaring no detail at
 * all says nothing either way, and guessing "yes" would put a strip over a
 * chart.
 */
const stripsApply = (contract: ComponentContract, aggregated: boolean): boolean =>
  !aggregated && contract.detail?.opensRecord === true;

/** Objects and arrays stringify to "[object Object]": one tile for everything. */
const drawable = (field: FieldInfo): boolean =>
  field.kinds.every((kind) => CATEGORICAL_KINDS.has(kind) || kind === "null");

/** A date wearing a string kind is still a date. The format says so. */
const dated = (field: FieldInfo): boolean =>
  field.format === "iso8601" || field.format === "unix_seconds" || field.format === "unix_millis";

/** Whether this field's cardinality has actually been observed. */
const counted = (field: FieldInfo): boolean => field.distinct > 0;

/**
 * Can this field carry a filter strip?
 *
 * `requested` lowers the bar to what the runtime can execute, because the
 * person asking has already said this is the distinction they care about.
 * Without it the field also has to look like a category rather than merely be
 * capable of holding one.
 */
export const canFacet = (
  field: FieldInfo | undefined,
  options: { readonly requested?: boolean } = {},
): boolean => {
  if (!field) return false;
  if (!drawable(field)) return false;
  if (dated(field)) return false;

  /*
   * What the name rules out, whatever the values turn out to be.
   *
   * Read from the leaf of a dotted path, because that is where the meaning is:
   * `Property.Href` is a link and `Category.Name` is a name, and the object
   * they hang off says nothing either way. An identifier tiles once per row, a
   * URL is unreadable as a tile, and a date or an amount is a range — none of
   * which a value with a count beside it can express. Applied even where the
   * cardinality *is* known, because a four-row sample makes every id look like
   * a tidy closed set.
   */
  const leaf = field.name.split(".").pop() ?? field.name;
  if (looksLikeIdentifier(leaf)) return false;
  if (NEVER_A_CATEGORY.has(guessSemantic(leaf, null))) return false;

  if (counted(field)) {
    /*
     * One value is not a choice, and too many is an identifier.
     *
     * The lower bound matters as much as the upper: a strip with a single tile
     * offers a filter that removes nothing, which reads as broken rather than
     * as complete. An asked-for filter keeps the upper bound only as a
     * render-time concern — `validateFacets` drops the strip and says why —
     * but a single-valued field cannot become a filter however it arrived.
     */
    if (field.distinct < 2) return false;
    if (!options.requested && field.distinct > FACET_MAX_VALUES) return false;
    return true;
  }

  /*
   * Nothing has been read, so the name was the only evidence — and it has
   * already been consulted above.
   *
   * One rule left, and numbers are where it bites: with no cardinality to
   * check, a status code and a row id are the same shape, and a strip of four
   * hundred tiles is the failure this is avoiding. A number that really does
   * hold a small closed set becomes available the moment anything is read.
   */
  return !field.kinds.includes("number");
};

/**
 * The fields worth offering as filters, best first.
 *
 * Small closed sets lead where they are known, because those are the ones that
 * read well as tiles. Where nothing has been read, the fields whose own names
 * say they hold a state lead instead — which is a ranking, never a gate.
 */
export const facetableFields = (input: FacetableInput): readonly FieldInfo[] => {
  if (!stripsApply(input.contract, input.aggregated)) return [];

  const usable = input.fields.filter((field) => canFacet(field, { requested: true }));
  const rank = (field: FieldInfo): number => {
    if (counted(field)) return field.distinct;
    // A name that says "state" outranks one that merely could be a category.
    return guessSemantic(field.name, null) === "status_enum" ? FACET_MAX_VALUES : 1_000;
  };
  return [...usable].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
};

export interface FacetChoiceInput extends FacetableInput {
  /** Fields somebody asked to filter by, in their own order of preference. */
  readonly requested: readonly string[];
}

/**
 * The filters a widget is built with: exactly what was asked for.
 *
 * There used to be a second source — a field the mapping pass recorded per
 * endpoint — for the case where nobody asked. It was populated on none of a
 * real API's two hundred and thirty endpoints, so in practice it only ever
 * meant "no strips", which is the reason asking for a list filtered by
 * something could not be answered with one. What a widget gets filtered by is
 * now decided from the record type, and arrives here already asked for.
 */
export const facetFields = (input: FacetChoiceInput): readonly string[] => {
  if (!stripsApply(input.contract, input.aggregated)) return [];

  const byName = new Map(input.fields.map((field) => [field.name, field]));
  const asked = input.requested.filter((name) =>
    canFacet(byName.get(name), { requested: true }),
  );
  return [...new Set(asked)].slice(0, FACET_MAX_PER_WIDGET);
};
