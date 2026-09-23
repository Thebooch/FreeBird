import type { OpSpec, RangePreset, ResolvedParams, TimeRange } from "@freebirdai/dash-spec";
import { defaultGrainFor, pathParamNames, queryKey, resolveRange } from "@freebirdai/dash-spec";

type Values = Readonly<Record<string, string | number | boolean>>;

/**
 * Which channel each supplied value belongs in.
 *
 * A caller sends one flat bag and should not have to know that a path segment
 * is filled by a `{{param.x}}` token read from `filters`, while everything
 * else is a query-string override. The op declares which of its parameters
 * live in the path, so the split is made here — the only place with both the
 * values and the endpoint's contract.
 *
 * Extracted because the chat's context harness reads the same endpoints as
 * `POST /api/query` and must produce the same cache key for the same request.
 * Two implementations that disagreed would let one widget be served another's
 * rows, silently and only for some parameter shapes.
 */
export const splitOpInputs = (
  op: OpSpec,
  params: Values,
  filters: Values = {},
): {
  /** Query-string overrides. Part of the cache key. */
  readonly overrides: Record<string, string | number | boolean>;
  /** Path-token inputs, resolved through `params.filters`. */
  readonly inputs: Record<string, string | number | boolean>;
} => {
  const pathBound = new Set([
    ...pathParamNames(op.path),
    ...op.params.filter((param) => param.in === "path").map((param) => param.name),
  ]);

  const overrides: Record<string, string | number | boolean> = {};
  const inputs: Record<string, string | number | boolean> = { ...filters };
  for (const [name, value] of Object.entries(params)) {
    if (pathBound.has(name)) inputs[name] = value;
    else overrides[name] = value;
  }
  return { overrides, inputs };
};

/** A window as a caller states it: a preset, and bounds when it has them. */
export interface RequestedRange {
  readonly preset: RangePreset;
  readonly grain?: TimeRange["grain"] | undefined;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
}

/**
 * The caller's window wins whenever it sent one.
 *
 * `resolveRange` only honours explicit bounds for the "custom" preset; for
 * "30d" it recomputes `end = now`. The browser has already resolved its window
 * against `controls.anchor` — an instant that deliberately only moves when the
 * user acts — so re-resolving here against the server's clock gave two widgets
 * fetched a second apart two different windows, defeating the anchor. It also
 * made every cache key unique, since the window shifted by a millisecond on
 * each request.
 */
export const resolveRequestedRange = (range: RequestedRange, now: number): TimeRange =>
  range.start !== undefined && range.end !== undefined
    ? {
        start: range.start,
        end: range.end,
        grain: range.grain ?? defaultGrainFor(range.start, range.end),
        preset: range.preset,
      }
    : resolveRange({ preset: range.preset, now, ...(range.grain ? { grain: range.grain } : {}) });

export interface QueryRequest {
  /** The cache key this request reads and writes. */
  readonly key: string;
  /** What goes on the query string. */
  readonly overrides: Record<string, string | number | boolean>;
  /** The window, plus the board's filters with the path inputs folded in. */
  readonly resolved: ResolvedParams;
}

/**
 * One request, spelled exactly one way.
 *
 * Every server-side reader of an endpoint — a board's query, the chat
 * harness, the keeper warming the cache, onboarding checking a widget before
 * it is created — goes through this, because each of them has to land on the
 * key the others wrote. The keeper used to build its own and disagreed on
 * path parameters: it put them on the query string, missed the path, fetched
 * a URL with an empty segment, and warmed a key no board ever asked for.
 *
 * `params` is the flat bag a widget's source carries, already interpolated;
 * `resolved.filters` is the board's filter values. The split between query
 * string and path is made here and nowhere else.
 */
export const buildQueryRequest = (input: {
  readonly connection: string;
  readonly op: OpSpec;
  readonly params: Values;
  readonly resolved: ResolvedParams;
}): QueryRequest => {
  const { overrides, inputs } = splitOpInputs(input.op, input.params, input.resolved.filters);
  const resolved: ResolvedParams = { ...input.resolved, filters: inputs };
  return {
    key: queryKey(input.connection, input.op.id, overrides, resolved, input.op.usesRange),
    overrides,
    resolved,
  };
};
