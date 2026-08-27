import type { FetchMeta } from "@freebirdai/dash-adapters";
import type { BindingValidation, ColumnMeta, FieldLabels, WidgetSpec } from "@freebirdai/dash-spec";
import { interpolateValue, parseDuration, widgetSources } from "@freebirdai/dash-spec";
import type { Row, RowHighlight, RunMeta } from "@freebirdai/dash-runtime";
import { compilePlan, executeWidget, runPipeline } from "@freebirdai/dash-runtime";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useDashboard } from "./context.jsx";
import { type QueryClient, type QueryParams, queryKey } from "./store.js";

/**
 * The runtime's columns, wearing this API's names for its fields.
 *
 * Pure and separate from the hook because the interesting behaviour is which
 * name each column is looked up under, and that needs no React to check.
 *
 * Two lookups, and the second is what makes nested fields work — the ones that
 * most need a label. A dotted field only becomes a column because a `derive`
 * step renames it, so `Address.AddressLine1` arrives as `Address_AddressLine1`
 * while the lexicon is keyed by the name the API uses. Every nested field
 * missed, and a record of an address read "Address address line1" no matter
 * how good the lexicon was.
 *
 * The mapping is read from the widget's own derive steps rather than by
 * turning underscores back into dots. That would be a guess, and a wrong one
 * on any API that names fields `postal_code`; the spec states it outright.
 *
 * A multi-source widget can span two connections, so their lexicons are merged
 * with the first winning. Two APIs disagreeing about what `Id` is called is
 * not a conflict worth adjudicating — either answer beats `Id`.
 */
export const labelColumns = (
  columns: readonly ColumnMeta[],
  widget: WidgetSpec,
  labels: Readonly<Record<string, FieldLabels>> | undefined,
): ColumnMeta[] => {
  if (!labels || columns.length === 0) return [...columns];

  const merged: Record<string, string> = {};
  for (const source of widgetSources(widget)) {
    for (const [name, label] of Object.entries(labels[source.connection] ?? {})) {
      if (merged[name] === undefined) merged[name] = label;
    }
  }

  /** Column name → the API field it was derived from, where one is named. */
  const derivedFrom: Record<string, string> = {};
  const readPipeline = (steps: WidgetSpec["pipeline"]): void => {
    for (const step of steps) {
      if (step.op !== "derive") continue;
      for (const [name, source] of Object.entries(step.fields)) {
        // Only a plain path names a single field. Anything carrying an
        // operator is a computed value, and no field's label describes it.
        if (PLAIN_PATH.test(source)) derivedFrom[name] = source;
      }
    }
  };
  readPipeline(widget.pipeline);
  for (const source of widget.sources) readPipeline(source.pipeline);

  return columns.map((column) => {
    const label = merged[column.name] ?? merged[derivedFrom[column.name] ?? ""];
    return label ? { ...column, label } : column;
  });
};

const PLAIN_PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;

/**
 * An identity-stable snapshot of a set of cache entries.
 *
 * `useSyncExternalStore` compares snapshots by identity, so returning a
 * fresh array each render would loop forever. Status and fetch time are the
 * only things that can change what this hook produces.
 */
const stampOf = (client: QueryClient, keys: readonly string[]): string =>
  keys
    .map((key) => {
      const entry = client.get(key);
      return `${key}:${entry?.status ?? "-"}:${entry?.fetchedAt ?? 0}`;
    })
    .join("|");

export type WidgetState = "loading" | "ok" | "empty" | "error" | "invalid";

export interface WidgetData {
  readonly widget: WidgetSpec;
  readonly state: WidgetState;
  /** Data older than the widget's `staleAfter`. Shown, but badged. */
  readonly stale: boolean;
  readonly rows: readonly Row[];
  readonly columns: readonly ColumnMeta[];
  /** Index-parallel to `rows`. Absent when the widget declares no highlights. */
  readonly highlights?: readonly (readonly RowHighlight[])[];
  readonly runMeta: RunMeta | null;
  readonly fetchMeta: FetchMeta | null;
  /** The untransformed response. The inspector shows it so "is it us or them?" is answerable. */
  readonly raw: unknown;
  readonly binding: BindingValidation | null;
  readonly errors: readonly string[];
  readonly userMessage: string | null;
  /** HTTP status of the failure, where there was one. See `QueryEntry`. */
  readonly errorStatus: number | null;
  readonly lastFetchedAt: number;
  readonly queryKey: string;
  refetch(): void;
}

export const useWidgetData = (widget: WidgetSpec, row?: Row): WidgetData => {
  /**
   * How stale this widget will tolerate, from its own spec.
   *
   * Doubles as the badge threshold and as the freshness the server's cache is
   * asked for, so a widget cannot badge itself stale over data the cache still
   * considers fresh — one number, one meaning.
   */
  const staleAfterMs = parseDuration(widget.refresh.staleAfter) ?? 900_000;

  const { client, params: baseParams, now, timeZone, labels } = useDashboard();

  /**
   * A drill-down runs the same machinery with one extra scope: the row it was
   * opened from, which `{{row.<field>}}` reads. Those tokens are interpolated
   * into `requestParams` below *before* the cache key is built, so two rows
   * naturally get two entries and neither can serve the other's record.
   */
  const params = useMemo(
    () => (row ? { ...baseParams, row } : baseParams),
    [baseParams, row],
  );

  const sources = useMemo(() => widgetSources(widget), [widget]);

  /**
   * Sources that can be fetched straight away.
   *
   * A fan-out source cannot: it needs the rows of another source first, so it
   * is resolved in a second wave below once its driver has landed.
   */
  const direct = useMemo(
    () =>
      sources
        .filter((source) => !source.fanOut)
        .map((source) => {
          const resolved: Record<string, string | number | boolean> = {};
          for (const [name, value] of Object.entries(source.params)) {
            resolved[name] = interpolateValue(value, params);
          }
          return {
            as: source.as,
            connection: source.connection,
            op: source.op,
            params: resolved,
            key: queryKey(source.connection, source.op, resolved, params),
          };
        }),
    [sources, params],
  );

  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);

  const directKeys = useMemo(() => direct.map((request) => request.key), [direct]);
  const directStamp = useSyncExternalStore(
    subscribe,
    useCallback(() => stampOf(client, directKeys), [client, directKeys]),
    useCallback(() => stampOf(client, directKeys), [client, directKeys]),
  );

  useEffect(() => {
    for (const request of direct) {
      void client.ensure({
        key: request.key,
        connection: request.connection,
        op: request.op,
        params: request.params,
        resolved: params,
        now,
        maxAgeMs: staleAfterMs,
      });
    }
    // `now` is deliberately excluded: the ticking clock must not re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, direct, params, staleAfterMs]);

  const plan = useMemo(
    () => (widget.sources.length > 0 ? compilePlan(widget) : null),
    [widget],
  );

  /**
   * Second wave: one request per row of the driver source, bounded.
   *
   * The cap is the whole point. An uncapped fan-out turns a 500-row list into
   * 500 API calls, and the honest failure is a stated limit rather than a
   * silent one — the same contract pagination already follows.
   */
  const fanned = useMemo(() => {
    const requests: Array<{
      as: string;
      connection: string;
      op: string;
      params: QueryParams;
      key: string;
    }> = [];
    let truncated = false;
    let driverRows = 0;

    for (const source of sources) {
      const fanOut = source.fanOut;
      if (!fanOut || !plan || !plan.ok) continue;

      const driver = direct.find((request) => request.as === fanOut.from);
      const entry = driver ? client.get(driver.key) : undefined;
      if (!entry || entry.status !== "ok" || entry.body === undefined) continue;

      const compiledDriver = plan.plan.sources.find((item) => item.as === fanOut.from);
      if (!compiledDriver) continue;

      const rows = runPipeline(compiledDriver.compiled, entry.body, { now, params, timeZone }).rows;
      driverRows = rows.length;
      const capped = rows.slice(0, fanOut.maxRows);
      if (rows.length > capped.length) truncated = true;

      const inputName = fanOut.as ?? fanOut.field;
      const seen = new Set<string>();
      for (const driverRow of capped) {
        const value = driverRow[fanOut.field];
        if (value === undefined || value === null || value === "") continue;
        const resolved: Record<string, string | number | boolean> = {
          [inputName]: value as string | number | boolean,
        };
        for (const [name, raw] of Object.entries(source.params)) {
          resolved[name] = interpolateValue(raw, params);
        }
        const key = queryKey(source.connection, source.op, resolved, params);
        // Two driver rows pointing at the same record are one request.
        if (seen.has(key)) continue;
        seen.add(key);
        requests.push({
          as: source.as,
          connection: source.connection,
          op: source.op,
          params: resolved,
          key,
        });
      }
    }
    return { requests, truncated, driverRows };
  }, [sources, direct, plan, client, now, params, timeZone]);

  const fannedKeys = useMemo(
    () => fanned.requests.map((request) => request.key),
    [fanned],
  );
  const fannedStamp = useSyncExternalStore(
    subscribe,
    useCallback(() => stampOf(client, fannedKeys), [client, fannedKeys]),
    useCallback(() => stampOf(client, fannedKeys), [client, fannedKeys]),
  );

  useEffect(() => {
    for (const request of fanned.requests) {
      void client.ensure({
        key: request.key,
        connection: request.connection,
        op: request.op,
        params: request.params,
        resolved: params,
        now,
        maxAgeMs: staleAfterMs,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, fanned, params, staleAfterMs]);

  const allRequests = useMemo(() => [...direct, ...fanned.requests], [direct, fanned]);

  const entries = useMemo(
    () => allRequests.map((request) => ({ request, entry: client.get(request.key) })),
    // Recomputed when any watched entry changes status or fetch time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRequests, client, directStamp, fannedStamp],
  );

  /** The single-source path keeps its original one-entry semantics exactly. */
  const primary = entries[0]?.entry;
  const key = direct[0]?.key ?? "";

  const refetch = useCallback(() => {
    for (const request of allRequests) {
      void client.ensure({
        key: request.key,
        connection: request.connection,
        op: request.op,
        params: request.params,
        resolved: params,
        now: Date.now(),
        force: true,
      });
    }
  }, [client, allRequests, params]);

  // Polling is opt-in per widget; without `every` a dashboard is manual-refresh,
  // which is the honest default when every request costs someone's rate limit.
  const everyMs = widget.refresh.every ? parseDuration(widget.refresh.every) : null;
  useEffect(() => {
    if (!everyMs) return;
    const timer = setInterval(refetch, everyMs);
    return () => clearInterval(timer);
  }, [everyMs, refetch]);

  /** One body per source; fan-out responses are concatenated into theirs. */
  const bodies = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const item of entries) {
      const entry = item.entry;
      if (!entry || entry.status !== "ok" || entry.body === undefined) continue;
      const existing = out[item.request.as];
      if (existing === undefined) {
        out[item.request.as] = entry.body;
        continue;
      }
      out[item.request.as] = [
        ...(Array.isArray(existing) ? existing : [existing]),
        ...(Array.isArray(entry.body) ? entry.body : [entry.body]),
      ];
    }
    return out;
  }, [entries]);

  const anyError = entries.find((item) => item.entry?.status === "error")?.entry;
  const allLoaded =
    entries.length > 0 && entries.every((item) => item.entry?.status === "ok");

  const executed = useMemo(() => {
    if (!allLoaded) return null;
    if (widget.sources.length > 0) {
      return executeWidget(widget, bodies, { now, params, timeZone });
    }
    return primary?.body === undefined
      ? null
      : executeWidget(widget, primary.body, { now, params, timeZone });
  }, [allLoaded, widget, bodies, primary, now, params, timeZone]);


  const lastFetchedAt = entries.reduce(
    (oldest, item) =>
      item.entry?.fetchedAt ? Math.min(oldest || item.entry.fetchedAt, item.entry.fetchedAt) : oldest,
    0,
  );
  const stale = lastFetchedAt > 0 && now - lastFetchedAt > staleAfterMs;

  let state: WidgetState = "loading";
  if (anyError) state = "error";
  else if (executed) {
    if (executed.errors.length > 0) state = "invalid";
    else if (executed.rows.length === 0) state = "empty";
    else if (!executed.ok) state = "invalid";
    else state = "ok";
  }

  const labelled = useMemo<ColumnMeta[]>(
    () => labelColumns(executed?.columns ?? [], widget, labels),
    [executed?.columns, labels, widget],
  );

  return {
    widget,
    state,
    stale,
    rows: executed?.rows ?? [],
    /*
     * The runtime's columns, wearing this API's names for its fields.
     *
     * Stamped here rather than resolved in each component, because this is the
     * one place that knows both the widget's connection and the columns its
     * pipeline produced — a component knows neither. Every renderer already
     * receives `columns`, so one line here reaches all of them.
     *
     * Nothing is lost when there is no lexicon: `labelOf` falls back to the
     * mechanical label, which is what the whole library showed before this.
     */
    columns: labelled,
    ...(executed?.highlights ? { highlights: executed.highlights } : {}),
    runMeta: executed?.meta ?? null,
    fetchMeta: primary?.meta ?? null,
    raw: widget.sources.length > 0 ? bodies : primary?.body,
    binding: executed?.binding ?? null,
    errors: [
      ...(fanned.truncated
        ? [
            `Only the first ${fanned.requests.length} of ${fanned.driverRows} record(s) were expanded, so this total is incomplete.`,
          ]
        : []),
      ...(executed?.errors ?? []),
      ...(executed?.binding?.errors ?? []).map((issue) => issue.message),
    ],
    userMessage: anyError?.error?.userMessage ?? null,
    errorStatus: anyError?.error?.status ?? null,
    lastFetchedAt,
    queryKey: key,
    refetch,
  };
};
