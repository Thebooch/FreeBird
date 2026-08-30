import type { ConciergeContext } from "@freebirdai/dash-agent";
import type { ResolvedParams } from "@freebirdai/dash-spec";
import { interpolateValue, queryKey, widgetSources } from "@freebirdai/dash-spec";
import type { WidgetHandle } from "../chat/handles.js";
import { identityFor } from "./related.js";
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

/**
 * Connections that cannot be read at all, and why.
 *
 * A connection whose credential is not stored will answer 401 to every request
 * it is given. Offering its endpoints to the ranker spends a source slot — a
 * quarter of the whole turn — proving something the server already knew, and
 * the user learns it as "I could not find that" rather than as "reconnect this
 * account".
 *
 * Read off `readPlans`, which the concierge already computes from the server's
 * own `connectionHasKey`. Nothing new is derived here and no vault is touched.
 *
 * ⚠️ `needsKey` is false when the caller supplied no `hasKey` at all — the
 * concierge documents that as "assume it is fine", on the grounds that
 * refusing on a guess is worse than trying. That default is what keeps this
 * from changing behaviour for callers, including the eval harness, that are
 * not in a position to know.
 */
export const unreadableConnections = (
  context: ConciergeContext,
): ReadonlyArray<{ connection: string; title: string; reason: string }> => {
  const titleOf = new Map(context.connections.map((entry) => [entry.id, entry.title]));
  return context.readPlans
    .filter((plan) => plan.needsKey)
    .map((plan) => ({
      connection: plan.connection,
      title: titleOf.get(plan.connection) ?? plan.connection,
      reason: "it has no key stored yet, so every request would be refused",
    }));
};

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
   * Left out before ranking rather than discovered by reading. See
   * `unreadableConnections` — the reply reports these from there, so they are
   * not silently dropped, just not paid for twice.
   */
  const unreadable = new Set(
    unreadableConnections(input.context).map((entry) => entry.connection),
  );

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
    const cached = keys.length > 0 && keys.every((key) => input.isCached(key));
    /*
     * A keyless connection is skipped — unless its rows are already held.
     *
     * Cached rows were fetched when the key still worked, and reading them
     * makes no request, so they are as good a source as any and free besides.
     * Dropping them along with the connection would refuse to answer from data
     * already in hand, which is a worse failure than the one being fixed.
     */
    if (unreadable.has(primary.connection) && !cached) continue;
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
      cached,
      idField: identityFor(input.context, primary.op),
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
    // Never cached — nothing has read it — so there is no free version of this
    // one to keep, and a keyless connection can only refuse.
    if (unreadable.has(op.connection)) continue;
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
      idField: identityFor(input.context, op.id),
    });
  }

  return candidates;
};

/**
 * Restrict the search to where somebody said to look.
 *
 * "In my platform X conversations, has anyone mentioned running late?" names a
 * place, and reading anywhere else spends their API quota to answer a question
 * they did not ask. Matched loosely on purpose — people name a connection, a
 * tab or a widget interchangeably, and by title far more often than by id.
 *
 * Returns the full list when nothing matches, rather than nothing. A named
 * place that cannot be resolved is a reason to search normally and say where
 * it looked; refusing outright would turn a slightly-off name into a dead end.
 */
export const narrowTo = (
  candidates: readonly Candidate[],
  named: string,
  connections: ReadonlyArray<{ readonly id: string; readonly title: string }>,
): readonly Candidate[] => {
  const wanted = named.trim().toLowerCase();
  if (!wanted) return candidates;

  const connection = connections.find(
    (entry) =>
      entry.id.toLowerCase() === wanted ||
      entry.title.toLowerCase() === wanted ||
      entry.title.toLowerCase().includes(wanted) ||
      wanted.includes(entry.title.toLowerCase()),
  );

  const matches = candidates.filter(
    (candidate) =>
      (connection && candidate.connection === connection.id) ||
      candidate.id.toLowerCase() === wanted ||
      candidate.title.toLowerCase() === wanted ||
      candidate.title.toLowerCase().includes(wanted) ||
      (candidate.tab ?? "").toLowerCase() === wanted,
  );

  return matches.length > 0 ? matches : candidates;
};
