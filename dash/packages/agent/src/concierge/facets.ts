import type { ComponentContract } from "@freebirdai/dash-spec";
import { FACET_MAX_VALUES } from "@freebirdai/dash-spec";
import type { FieldInfo } from "../infer.js";

/**
 * Whether a widget should be built with a filter strip, and over which field.
 *
 * The cheap half of the feature. Which field carries the distinction on an
 * endpoint is already mapped — `facet` on the catalog's op entry, put there
 * because it is true of the API for everybody and worth mapping once. So a
 * strip can be offered with no model call at all: the answer was bought when
 * the API was mapped, and asking again would be paying twice for a fact that
 * has not changed.
 *
 * Conservative on purpose. Every condition here rules out a strip that would
 * be drawn and be wrong or useless, and the cost of ruling one out is that
 * somebody adds it by hand — against the cost of a widget that ships with a
 * row of tiles nobody wants above it.
 */

/** A date or an amount is a range; two tiles per row is not a filter. */
const CATEGORICAL_KINDS = new Set(["string", "boolean", "number"]);

export interface DeriveFacetInput {
  /** The field the map recorded for this endpoint, dotted as the API spells it. */
  readonly facetField: string | undefined;
  /** What the endpoint was seen to return. */
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
 * The field to facet on, or null to build the widget exactly as before.
 *
 * Null is the common answer and costs nothing: `facets` defaults to empty, so
 * a widget that gets none is byte-for-byte the widget this produced before
 * any of it existed.
 */
export const deriveFacet = (input: DeriveFacetInput): string | null => {
  const name = input.facetField;
  if (!name || input.aggregated) return null;

  /*
   * Only components whose marks are records.
   *
   * `opensRecord` is the existing statement of exactly that — it decides
   * whether clicking a mark can open the thing behind it, and a mark with a
   * record behind it is a mark a facet can filter. A contract declaring no
   * detail at all says nothing either way, and guessing "yes" would put a
   * strip over a chart.
   */
  if (input.contract.detail?.opensRecord !== true) return null;

  const field = input.fields.find((candidate) => candidate.name === name);
  if (!field) return null;

  // Objects and arrays stringify to "[object Object]", which makes one tile
  // standing for everything.
  if (!field.kinds.every((kind) => CATEGORICAL_KINDS.has(kind) || kind === "null")) return null;

  // A date wearing a string kind is still a date. The format says so.
  if (field.format === "iso8601") return null;

  /*
   * One value is not a choice, and too many is an identifier.
   *
   * The lower bound matters as much as the upper: a strip with a single tile
   * offers a filter that removes nothing, which reads as broken rather than
   * as complete.
   */
  if (field.distinct < 2 || field.distinct > FACET_MAX_VALUES) return null;

  return name;
};
