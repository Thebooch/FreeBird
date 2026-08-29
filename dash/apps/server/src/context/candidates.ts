import type { ConciergeContext } from "@freebirdai/dash-agent";
import type { ResolvedParams } from "@freebirdai/dash-spec";
import { interpolateValue, queryKey, widgetSources } from "@freebirdai/dash-spec";
import type { WidgetHandle } from "../chat/handles.js";
import type { Candidate } from "./types.js";

/**
 * Everywhere an answer could be, ordered by what it costs to look.
 *
 * Three tiers, and the ordering is the design. A widget already on a board is
 * the cheapest and the most likely: somebody built it because they care about
 * exactly this data, and if its rows are still in the query cache reading it
 * costs nothing at all. The endpoint behind a widget comes next — same data,
 * different parameters. Any other readable endpoint comes last, because that
 * is a request against somebody's account for a hunch.
 *
 * Free before priced is not a performance nicety here. On a pay-per-request
 * API it is the difference between a feature somebody leaves switched on and
 * one they turn off.
 */

/** Every request key a widget would issue, so the cache can be asked about it. */
export const widgetKeys = (
  widget: WidgetHandle["widget"],
  resolved: ResolvedParams,
): string[] =>
  widgetSources(widget)
    // A fan-out source is driven by another source's rows, so its keys cannot
    // be known without fetching first. It is not part of what "already cached"
    // can mean.
    .filter((source) => !source.fanOut)
    .map((source) => {
      const params: Record<string, string | number | boolean> = {};
      for (const [name, value] of Object.entries(source.params)) {
        params[name] = interpolateValue(value, resolved);
      }
      return queryKey(source.connection, source.op, params, resolved);
    });

export interface BuildCandidatesInput {
  readonly handles: readonly WidgetHandle[];
  readonly context: ConciergeContext;
  readonly resolved: ResolvedParams;
  /** True when the server's query cache already holds this key. */
  readonly isCached: (key: string) => boolean;
}

export const buildCandidates = (input: BuildCandidatesInput): Candidate[] => {
  const opById = new Map(input.context.ops.map((op) => [op.id, op]));
  const candidates: Candidate[] = [];

  /*
   * Tier 1 and 2 together: the widget, and the endpoint it reads.
   *
   * They are listed as one pass because a widget IS its endpoint plus a shape.
   * Listing the endpoint separately as well would offer the model the same
   * rows twice under two names, and it would sometimes pick the raw one — the
   * version nobody built, filtered by nothing, with none of the shaping the
   * user chose.
   */
  const covered = new Set<string>();
  for (const entry of input.handles) {
    const sources = widgetSources(entry.widget);
    const primary = sources[0];
    if (!primary) continue;
    covered.add(primary.op);

    const shape = input.context.shapes[primary.op];
    const op = opById.get(primary.op);
    const keys = widgetKeys(entry.widget, input.resolved);
    candidates.push({
      kind: "widget",
      id: entry.handle,
      title: entry.widget.title,
      describes:
        op?.description ??
        (sources.length > 1
          ? `a ${entry.widget.component} drawing on ${sources.length} endpoints`
          : `a ${entry.widget.component}`),
      connection: primary.connection,
      op: primary.op,
      fields: shape?.fields.map((field) => field.name) ?? [],
      /*
       * Only when every direct source is held. One missing source means the
       * read spends a request, and calling that free is how a budget quietly
       * becomes a suggestion.
       */
      cached: keys.length > 0 && keys.every((key) => input.isCached(key)),
      tab: entry.dashboardTitle,
    });
  }

  /*
   * Tier 3: endpoints nothing is built on.
   *
   * These are what make the assistant able to answer a question the boards do
   * not already cover — the whole reason the source list is not just "the
   * widgets". Endpoints needing a path parameter are excluded for the same
   * reason they are excluded as widget starting points: nobody has an id yet.
   */
  for (const op of input.context.ops) {
    if (covered.has(op.id)) continue;
    const shape = input.context.shapes[op.id];
    candidates.push({
      kind: "endpoint",
      id: op.id,
      title: op.title,
      describes: op.description ?? op.path ?? "",
      connection: op.connection,
      op: op.id,
      fields: shape?.fields.map((field) => field.name) ?? [],
      cached: false,
    });
  }

  return candidates;
};
