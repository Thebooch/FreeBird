import type { FetchMeta } from "@freebirdai/dash-adapters";
import type {
  BindingValidation,
  ColumnMeta,
  EntityLinkView,
  FieldLabels,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import {
  drawnColumns,
  interpolateValue,
  parseDuration,
  widgetSources,
} from "@freebirdai/dash-spec";
import type { Row, RowHighlight, RunMeta } from "@freebirdai/dash-runtime";
import { compilePlan, executeWidget, runPipeline } from "@freebirdai/dash-runtime";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDashboard } from "./context.jsx";
import { derivedSources, entityFor, referenceColumns } from "./references.js";
import {
  fetchLookupsInOrder,
  type ReferenceNames,
  referenceLookups,
  referenceNames as resolveNames,
  unnamedLinks,
  isDenied,
  withLinkedValues,
} from "./recordIndex.js";
import { Wave } from "./queue.js";
import type { RecordIndex } from "./recordStore.js";
import { type QueryClient, type QueryEntry, type QueryParams, queryKey } from "./store.js";

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
  links?: Readonly<Record<string, readonly EntityLinkView[]>> | undefined,
): ColumnMeta[] => {
  if (columns.length === 0) return [...columns];

  /*
   * What this widget's own record type calls its fields, which outranks the
   * API-wide lexicon and is the reason that lexicon is on its way out.
   *
   * A lexicon has one entry per bare field name for a whole API, so `Title`
   * gets a single meaning shared by tasks, files and everything else — and on
   * a real API at least one of them is then wrong. A record type answers for
   * its own fields only, so both can be right at once.
   */
  const entity = links ? entityFor(widget, links) : undefined;
  const own = entity?.labels ?? {};
  if (!labels && Object.keys(own).length === 0) return [...columns];

  const merged: Record<string, string> = {};
  for (const source of widgetSources(widget)) {
    for (const [name, label] of Object.entries(labels?.[source.connection] ?? {})) {
      if (merged[name] === undefined) merged[name] = label;
    }
  }

  /*
   * Column name → the API field it was derived from, where one is named.
   *
   * Shared with `referenceColumns`, which needs the identical reading: two
   * copies would drift on exactly the case that matters — a nested field — and
   * the symptom either way is something quietly failing to appear.
   */
  const derivedFrom = derivedSources(widget);

  return columns.map((column) => {
    const path = derivedFrom[column.name] ?? column.name;
    const label =
      own[path] ?? own[column.name] ?? merged[column.name] ?? merged[derivedFrom[column.name] ?? ""];
    return label ? { ...column, label } : column;
  });
};


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

/**
 * How many records of one type it takes before fetching the whole list wins.
 *
 * Just past `maxPages`, whose default is 5: one `/api/query` for a list may
 * cost that many upstream pages, so below this the by-id calls are genuinely
 * cheaper. Above it the list wins twice over — fewer requests now, and every
 * later reference to that type answered from the index for nothing.
 */
const BATCH_LOOKUPS_ABOVE = 6;

export type WidgetState = "loading" | "ok" | "empty" | "error" | "invalid" | "unapproved";

/** A cache entry holds something worth rendering, fresh or kept. */
const usable = (entry: QueryEntry | undefined): boolean => entry?.body !== undefined;

/** Nothing further is coming for this entry. */
const settled = (entry: QueryEntry | undefined): boolean =>
  entry?.status === "ok" || entry?.status === "error";

/**
 * What to show, given what came back.
 *
 * Pure, exported and tested directly, because the interesting behaviour here
 * is a set of rules about partial results and none of it needs React to check.
 *
 * The rule that matters: **a failure is only an empty widget when there is
 * genuinely nothing to draw.** This used to treat every entry alike — one
 * error anywhere, or one of twenty-five fan-out children still in flight, and
 * the whole tile became a spinner or an error card even though the rows it had
 * a moment ago were still sitting in the cache. Sources are therefore split in
 * two:
 *
 * - **required** — the widget's own direct sources. Without a body from every
 *   one of them the pipeline cannot run at all, so these do gate the render.
 * - **optional** — fan-out children and reference lookups. These enrich; they
 *   do not define. One that fails costs a note saying the total is incomplete,
 *   never the tile.
 *
 * Optional sources gate the *first* paint only. Somebody watching a number
 * assemble itself from 3 to 47 has been shown two wrong answers on the way to
 * a right one, so the first render waits for them to settle; after that they
 * can never blank what is already on screen.
 */
export const deriveWidgetState = (input: {
  readonly required: readonly (QueryEntry | undefined)[];
  readonly optional: readonly (QueryEntry | undefined)[];
  /** Whether this widget has already drawn rows for these same sources. */
  readonly rendered: boolean;
}): {
  /** Every required source has something to run the pipeline over. */
  readonly ready: boolean;
  /** A required source failed and left nothing behind. The only empty case. */
  readonly blocked: boolean;
  /** The failure worth reporting, a required source's first. */
  readonly failure: QueryEntry["error"] | null;
  /** Showing a kept copy because a refresh was refused, not because it is fresh. */
  readonly servingLastKnownGood: boolean;
  /** Optional sources that failed with nothing to fall back on. */
  readonly missingOptional: number;
} => {
  const { required, optional, rendered } = input;

  const blocked = required.some((entry) => entry?.status === "error" && !usable(entry));
  const ready =
    required.length > 0 &&
    required.every(usable) &&
    (rendered || optional.every(settled));

  const failure =
    required.find((entry) => entry?.status === "error")?.error ??
    optional.find((entry) => entry?.status === "error")?.error ??
    null;

  return {
    ready,
    blocked,
    failure,
    servingLastKnownGood: required.some((entry) => entry?.status === "error" && usable(entry)),
    missingOptional: optional.filter((entry) => entry?.status === "error" && !usable(entry)).length,
  };
};

/**
 * This very record, if anything already fetched it.
 *
 * Pure and exported for the same reason `deriveWidgetState` is: the rule is
 * what matters and none of it needs React to check.
 *
 * A record page's panes read a by-id endpoint nobody has called before, so
 * they are cold by definition and last-known-good has nothing to fall back on.
 * But the record is very often already here — in the list the reader clicked,
 * resolved by a reference column, or shown by another pane — just filed under
 * a different request. The index is keyed by what a record *is*, which is the
 * question being asked.
 *
 * Only consulted when there is otherwise nothing to draw. It must never stand
 * in for a response that did arrive: the held copy may have fewer fields, and
 * quietly preferring it would make a complete record look incomplete.
 */
export const heldRecordFor = (input: {
  readonly blocked: boolean;
  readonly widget: WidgetSpec;
  readonly row: Row | undefined;
  readonly links: Readonly<Record<string, readonly EntityLinkView[]>> | undefined;
  readonly connection: string | undefined;
  readonly records: Pick<RecordIndex, "get">;
}): unknown => {
  const { blocked, widget, row, links, connection, records } = input;
  if (!blocked || !row || !links || !connection) return undefined;

  const view = entityFor(widget, links);
  if (!view?.identity) return undefined;

  const id = row[view.identity];
  if (id === null || id === undefined || id === "") return undefined;
  return records.get(connection, view.entity, id as string | number);
};

/**
 * Whether a saved binding is still covered by the approval it was given.
 *
 * Mirrors `GrantVerdict` in `@freebirdai/core` rather than importing it: this
 * package renders dashboards and has no Guide dependency, and gaining one for
 * a four-member string union would be the wrong trade. The host resolves the
 * verdict server-side and passes it in, the same way it passes labels.
 */
export type ApprovalVerdict = "valid" | "digest-changed" | "widened" | "absent";

export interface WidgetData {
  readonly previewReceipts: readonly { as: string; receipt: string }[];
  readonly widget: WidgetSpec;
  readonly state: WidgetState;
  /** Why the widget is or is not allowed to run. "valid" when ungated. */
  readonly approval: ApprovalVerdict;
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
  /**
   * When retrying could work, for a failure that said so.
   *
   * The tile counts down to it and disables its own Retry until it passes —
   * a retry inside a cooldown meets the cooldown, and a button that cannot
   * work is worse than no button.
   */
  readonly retryAt: number | null;
  readonly lastFetchedAt: number;
  readonly queryKey: string;
  /**
   * Names for the records this view's reference columns point at.
   *
   * Empty until they resolve, and empty forever for an API nobody has
   * described — which is why a cell's fallback has to be legible on its own.
   */
  readonly referenceNames: ReferenceNames;
  /**
   * How many link cells are showing an id instead of a name, and why.
   *
   * Null when every name resolved, and null when nothing was refused — see
   * the comment where it is built.
   */
  readonly unnamed: { readonly count: number; readonly reason: string } | null;
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

  const {
    client,
    params: baseParams,
    now,
    timeZone,
    labels,
    entityLinks,
    usesRange,
    approvals,
    records,
  } = useDashboard();

  /**
   * Whether this binding may run at all.
   *
   * Absent approvals means the host runs no gate, so everything is allowed —
   * the state before this existed. The check gates the fetch rather than only
   * the render: an unapproved widget must not reach the API in the first
   * place, or the approval would be a label rather than a control.
   */
  const approval = approvals?.[widget.id] ?? "valid";
  const approved = approval === "valid";

  /**
   * A drill-down runs the same machinery with one extra scope: the row it was
   * opened from, which `{{row.<field>}}` reads. Those tokens are interpolated
   * into `requestParams` below *before* the cache key is built, so two rows
   * naturally get two entries and neither can serve the other's record.
   */
  const params = useMemo(() => (row ? { ...baseParams, row } : baseParams), [baseParams, row]);

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
            key: queryKey(
              source.connection,
              source.op,
              resolved,
              params,
              usesRange(source.connection, source.op),
            ),
          };
        }),
    [sources, params, usesRange],
  );

  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);

  /*
   * Changes when the record index learns something.
   *
   * A version counter rather than a size: this is read on every render of
   * every widget, and walking the index that often would cost more than the
   * requests it saves.
   */
  const subscribeRecords = useCallback(
    (listener: () => void) => records.subscribe(listener),
    [records],
  );
  const recordVersion = useCallback(() => records.version, [records]);
  const recordStamp = useSyncExternalStore(subscribeRecords, recordVersion, recordVersion);

  const directKeys = useMemo(() => direct.map((request) => request.key), [direct]);
  const directStamp = useSyncExternalStore(
    subscribe,
    useCallback(() => stampOf(client, directKeys), [client, directKeys]),
    useCallback(() => stampOf(client, directKeys), [client, directKeys]),
  );

  useEffect(() => {
    if (!approved) return;
    for (const request of direct) {
      void client.ensure({
        key: request.key,
        connection: request.connection,
        op: request.op,
        params: request.params,
        resolved: params,
        now,
        maxAgeMs: staleAfterMs,
        // First wave: this tile is blank until these land.
        wave: Wave.Widget,
      });
    }
    // `now` is deliberately excluded: the ticking clock must not re-fetch.
  }, [client, direct, params, staleAfterMs, approved]);

  const plan = useMemo(() => (widget.sources.length > 0 ? compilePlan(widget) : null), [widget]);

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
        const key = queryKey(
          source.connection,
          source.op,
          resolved,
          params,
          usesRange(source.connection, source.op),
        );
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

  const fannedKeys = useMemo(() => fanned.requests.map((request) => request.key), [fanned]);
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
        /*
         * Second wave. The tile these belong to can already draw from its
         * driver rows, so twenty-five of them must not queue ahead of a widget
         * that still has nothing on screen.
         */
        wave: Wave.FanOut,
      });
    }
  }, [client, fanned, params, staleAfterMs]);

  const allRequests = useMemo(() => [...direct, ...fanned.requests], [direct, fanned]);

  const entries = useMemo(
    () => allRequests.map((request) => ({ request, entry: client.get(request.key) })),
    // Recomputed when any watched entry changes status or fetch time.
    [allRequests, client, directStamp, fannedStamp],
  );

  /** The single-source path keeps its original one-entry semantics exactly. */
  const primary = entries[0]?.entry;
  const key = direct[0]?.key ?? "";

  /*
   * The current entries, readable from inside the poll timer.
   *
   * The timer is created once per interval and would otherwise close over the
   * entries as they were when it was set up — so a widget that started polling
   * while healthy would never notice it had since been rate-limited.
   */
  const entriesRef = useRef<readonly (QueryEntry | undefined)[]>([]);
  entriesRef.current = entries.map((item) => item.entry);

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

  /*
   * A poll re-reads the server, never the API.
   *
   * The keeper keeps the server's copy current on the endpoint's own cadence,
   * so a poll asking upstream was a second schedule on top of it — one per
   * open tab. Re-reading in view mode is free, and it is what lets a board
   * left open pick up what the keeper fetched since.
   */
  const reread = useCallback(() => {
    for (const request of allRequests) {
      void client.ensure({
        key: request.key,
        connection: request.connection,
        op: request.op,
        params: request.params,
        resolved: params,
        now: Date.now(),
        force: true,
        mode: "view",
        maxAgeMs: staleAfterMs,
      });
    }
  }, [client, allRequests, params, staleAfterMs]);

  // Polling is opt-in per widget; without `every` a dashboard is manual-refresh,
  // which is the honest default when every request costs someone's rate limit.
  const everyMs = widget.refresh.every ? parseDuration(widget.refresh.every) : null;
  useEffect(() => {
    if (!everyMs) return;
    const timer = setInterval(() => {
      /*
       * Two reasons to skip a tick, both of them requests nobody wanted.
       *
       * A board left open in a background tab polled all night and spent
       * somebody's whole rate limit on numbers no one was looking at. And a
       * poll during a cooldown is guaranteed to be refused, so it buys
       * nothing and — on an API that counts refusals — makes the wait longer.
       *
       * `document` is guarded because this package renders on a server too.
       */
      if (typeof document !== "undefined" && document.hidden) return;
      const waiting = entriesRef.current.some(
        (entry) => entry?.error?.retryAt !== undefined && entry.error.retryAt > Date.now(),
      );
      if (waiting) return;
      reread();
    }, everyMs);
    return () => clearInterval(timer);
  }, [everyMs, reread]);

  /**
   * One body per source; fan-out responses are concatenated into theirs.
   *
   * Keyed on having a body rather than on having succeeded. A refused refresh
   * leaves the previous body in place, and that body is exactly what keeps the
   * widget showing numbers instead of an apology.
   */
  const bodies = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const item of entries) {
      const entry = item.entry;
      if (!entry || entry.body === undefined) continue;
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

  /**
   * Has this widget already drawn rows for this exact set of sources?
   *
   * Keyed on the direct keys so a param change, a new time range or a
   * different drill-down row starts over — the previous row's data must never
   * appear under the new row's heading, which is the one thing worse than a
   * blank tile.
   */
  const renderSignature = useMemo(() => directKeys.join("|"), [directKeys]);
  const rendered = useRef<string | null>(null);

  const requiredEntries = useMemo(
    () => direct.map((request) => client.get(request.key)),
    [direct, client, directStamp],
  );
  const optionalEntries = useMemo(
    () => fanned.requests.map((request) => client.get(request.key)),
    [fanned, client, fannedStamp],
  );

  const derived = deriveWidgetState({
    required: requiredEntries,
    optional: optionalEntries,
    rendered: rendered.current === renderSignature,
  });

  /*
   * One retry, when the wait the API asked for is over.
   *
   * A tile that was refused with nothing to show is the case this whole area
   * exists to remove, and leaving it dead until somebody notices and clicks is
   * only half a fix. It fires once per failure rather than on a loop, because
   * a second refusal sets a new `retryAt` and this re-arms against that —
   * which is a back-off, not a retry storm.
   *
   * The jitter matters as much as the delay: twenty tiles refused by one API
   * share one `Retry-After`, so without it they would all come back in the
   * same millisecond and rebuild the burst that caused the rate limit.
   */
  const retryAt = derived.failure?.retryAt ?? null;
  useEffect(() => {
    if (retryAt === null || !approved) return;
    const wait = retryAt - Date.now() + Math.random() * 5_000;
    if (wait > 600_000) return;

    const timer = setTimeout(
      () => {
        // Nobody is looking; the next mount or focus can pay for it instead.
        if (typeof document !== "undefined" && document.hidden) return;
        refetch();
      },
      Math.max(0, wait),
    );
    return () => clearTimeout(timer);
  }, [retryAt, approved, refetch]);

  /**
   * This very record, if anything already fetched it.
   *
   * A record page's panes read a by-id endpoint nobody has called before, so
   * they are cold by definition and the usual last-known-good has nothing to
   * fall back on. But the row is very often already here — it was in the list
   * the reader clicked, or a reference column resolved it, or another pane
   * showed it — just filed under a different request. The index is keyed by
   * what a record *is*, which is exactly the question being asked.
   *
   * Only consulted when there is otherwise nothing to draw, and the pipeline
   * runs over it unchanged: the index holds records in the API's own shape,
   * which is the shape a detail response has.
   */
  const heldRecord = useMemo(
    () =>
      heldRecordFor({
        blocked: derived.blocked,
        widget,
        row,
        links: entityLinks,
        connection: direct[0]?.connection,
        records,
      }),
    [derived.blocked, row, entityLinks, widget, direct, records, recordStamp],
  );

  const executed = useMemo(() => {
    /*
     * The held copy stands in for the response that could not be made. It is
     * genuinely this record — fetched from this API, for this id — so the only
     * thing it needs is to say where it came from, which the caller does.
     */
    if (heldRecord !== undefined) {
      return executeWidget(widget, heldRecord, { now, params, timeZone });
    }
    if (!derived.ready) return null;
    if (widget.sources.length > 0) {
      return executeWidget(widget, bodies, { now, params, timeZone });
    }
    return primary?.body === undefined
      ? null
      : executeWidget(widget, primary.body, { now, params, timeZone });
  }, [heldRecord, derived.ready, widget, bodies, primary, now, params, timeZone]);

  const lastFetchedAt = entries.reduce(
    (oldest, item) =>
      item.entry?.fetchedAt
        ? Math.min(oldest || item.entry.fetchedAt, item.entry.fetchedAt)
        : oldest,
    0,
  );
  const stale = lastFetchedAt > 0 && now - lastFetchedAt > staleAfterMs;

  let state: WidgetState = "loading";
  // Ahead of everything else: nothing was fetched, so "loading" would be a
  // spinner that never resolves.
  if (!approved) state = "unapproved";
  /*
   * `blocked`, not "anything failed". A required source that failed but left a
   * body behind is not an error state — it is old rows plus a banner saying
   * so, which is strictly more use to the reader than an apology. Only a
   * required source with nothing at all earns the error card.
   */
  else if (derived.blocked && heldRecord === undefined) state = "error";
  else if (executed) {
    if (executed.errors.length > 0) state = "invalid";
    else if (executed.rows.length === 0) state = "empty";
    else if (!executed.ok) state = "invalid";
    else state = "ok";
  }

  /*
   * Latch the first paint, so optional sources stop gating from here on.
   * During render rather than in an effect: an effect would run a frame late
   * and let one intermediate half-total through, which is the thing the gate
   * exists to prevent.
   */
  if (executed && rendered.current !== renderSignature) rendered.current = renderSignature;

  const fetchMeta = useMemo<FetchMeta | null>(() => {
    /*
     * A held copy has no fetch of its own to describe, so one is composed for
     * it — the reader still has to be told these fields came from somewhere
     * else and may be fewer than the record really has.
     */
    if (heldRecord !== undefined) {
      const reason =
        `${derived.failure?.userMessage ?? "This record could not be read just now."} ` +
        "Showing the copy already loaded, which may not have every field.";
      return {
        url: "",
        status: 0,
        fetchedAt: lastFetchedAt,
        durationMs: 0,
        pages: 1,
        truncated: false,
        warnings: [],
        ...(primary?.meta ?? {}),
        staleReason: reason,
      };
    }
    if (!primary?.meta) return null;
    if (primary.meta.staleReason || !derived.servingLastKnownGood || !derived.failure) {
      return primary.meta;
    }
    return { ...primary.meta, staleReason: derived.failure.userMessage };
  }, [heldRecord, primary?.meta, lastFetchedAt, derived.servingLastKnownGood, derived.failure]);

  /*
   * The columns, wearing this API's names and carrying its links.
   *
   * Both stamped in one place for the same reason: this is the only spot that
   * knows the widget's connection *and* the columns its pipeline produced, and
   * a component knows neither. Every renderer already receives `columns`, so
   * one line here reaches all of them.
   */
  const labelled = useMemo<ColumnMeta[]>(
    () =>
      referenceColumns(
        labelColumns(executed?.columns ?? [], widget, labels, entityLinks),
        widget,
        entityLinks,
      ),
    [executed?.columns, labels, entityLinks, widget],
  );

  /*
   * Third wave: the names behind this view's reference columns.
   *
   * After the rows exist, because which records are needed depends on which
   * ids are actually in them — and only the visible ones, capped, because this
   * is the one wave that spends requests in proportion to what is on screen.
   *
   * Skipped entirely for a widget with no reference columns, which is every
   * widget over an API nobody has described and every chart.
   */
  /** Columns this widget reads *through* a reference, where it declares any. */
  const linkedFields = useMemo(() => widget.linked ?? [], [widget]);

  /**
   * Record types this account has been refused outright.
   *
   * Grows and never shrinks within a session, deliberately: a 403 is a fact
   * about the credential rather than about the moment, so re-discovering it
   * every render would mean paying for it every render. It is also what keeps
   * this from flapping — the evidence is the failed request, and once nothing
   * asks again there is nothing new to read it from.
   */
  /** The columns this widget's component actually draws. See `drawnColumns`. */
  const shown = useMemo(() => drawnColumns(widget), [widget]);

  const [denied, setDenied] = useState<ReadonlySet<string>>(() => new Set());
  const noteDenied = useCallback((targets: readonly string[]) => {
    if (targets.length === 0) return;
    setDenied((current) => {
      const missing = targets.filter((target) => !current.has(target));
      if (missing.length === 0) return current;
      return new Set([...current, ...missing]);
    });
  }, []);

  const lookups = useMemo(
    () =>
      executed && executed.rows.length > 0 && direct[0]
        ? referenceLookups({
            rows: executed.rows,
            columns: labelled,
            connection: direct[0].connection,
            params,
            /*
             * A reference that already carries its name is free to draw and
             * still has to be fetched when a column reads some other field off
             * that record.
             */
            ...(linkedFields.length > 0
              ? { alsoFetch: new Set(linkedFields.map((one) => one.through)) }
              : {}),
            /*
             * Anything the index already holds is free, so it neither costs a
             * request nor uses up the budget for the ones that do. This is
             * where a board stops paying per id for names it fetched earlier.
             */
            known: ({ target, id }) => records.has(direct[0]!.connection, target, id),
            /*
             * A record type the account cannot read costs nothing further: no
             * request, and no slice of a budget that belongs to the types it
             * can. Its cells still say why.
             */
            denied: (target) => denied.has(target),
            usesRange,
            ...(shown.size > 0 ? { shown } : {}),
          })
        : [],
    [executed, labelled, direct, params, linkedFields, records, recordStamp, denied, shown, usesRange],
  );

  const lookupKeys = useMemo(() => lookups.map((lookup) => lookup.key), [lookups]);
  const lookupStamp = useSyncExternalStore(
    subscribe,
    useCallback(() => stampOf(client, lookupKeys), [client, lookupKeys]),
    useCallback(() => stampOf(client, lookupKeys), [client, lookupKeys]),
  );

  /**
   * Record types worth fetching whole rather than one record at a time.
   *
   * A by-id call answers for one record; the type's list answers for all of
   * them, and every other widget and record page gets those names for free
   * afterwards through the index. The trade only works above a threshold,
   * because one `/api/query` may itself be several upstream pages — so the
   * bar is set just past the default page cap. Below it, asking by id really
   * is cheaper.
   *
   * Only where the list endpoint can be called on its own: one that needs a
   * path parameter nobody can supply from a reference is not an option, and
   * spending a request to discover that is the mistake this avoids.
   */
  const batches = useMemo(() => {
    const connection = direct[0]?.connection;
    if (!connection || !entityLinks) return [];
    const views = entityLinks[connection] ?? [];

    const owed = new Map<string, number>();
    for (const lookup of lookups) {
      if (lookup.held || lookup.denied) continue;
      owed.set(lookup.target, (owed.get(lookup.target) ?? 0) + 1);
    }

    const plans: { target: string; op: string; key: string }[] = [];
    for (const [target, count] of owed) {
      if (count < BATCH_LOOKUPS_ABOVE) continue;
      const list = views.find((view) => view.entity === target)?.list;
      if (!list) continue;
      plans.push({
        target,
        op: list,
        key: queryKey(connection, list, {}, params, usesRange(connection, list)),
      });
    }
    return plans;
  }, [lookups, direct, entityLinks, params, usesRange]);

  useEffect(() => {
    if (!approved || batches.length === 0) return;
    const connection = direct[0]?.connection;
    if (!connection) return;
    for (const batch of batches) {
      void client.ensure({
        key: batch.key,
        connection,
        op: batch.op,
        params: {},
        resolved: params,
        now,
        maxAgeMs: staleAfterMs,
        // Still last: nothing on screen is blank waiting for a name.
        wave: Wave.Lookup,
      });
    }
  }, [client, batches, direct, params, staleAfterMs, approved]);

  /** Targets whose list is on its way, so their ids need no call of their own. */
  const pending = useMemo(() => {
    const held = new Set<string>();
    for (const batch of batches) {
      const entry = client.get(batch.key);
      if (entry?.status === "loading" || entry?.status === "ok") held.add(batch.target);
    }
    return held;
  }, [batches, client, lookupStamp, recordStamp]);

  /*
   * A list the account is not allowed to read denies its whole record type.
   *
   * Caught here as well as in the serial pass because the list is tried first:
   * without this, a denied type would fail its one list call and then fall
   * through to twenty-five by-id calls that were always going to fail the same
   * way.
   */
  useEffect(() => {
    const refused = batches
      .filter((batch) => isDenied(client.get(batch.key)?.error?.status))
      .map((batch) => batch.target);
    noteDenied(refused);
  }, [batches, client, lookupStamp, noteDenied]);

  useEffect(() => {
    if (!approved || lookups.length === 0) return;
    let cancelled = false;

    /*
     * One at a time, stopping the moment the API refuses.
     *
     * These are embellishments — names for ids that would otherwise read as
     * numbers — so they are the last traffic that should cost somebody their
     * rate limit. Measured against a real account: a collection endpoint
     * answered and a by-id call seconds later came back 429, which is exactly
     * the shape a parallel burst of twenty-five would run into.
     *
     * A refusal ends the pass rather than being retried per id: the next call
     * would be refused too, and the cells fall back to naming the kind of
     * record, which is what that fallback is for.
     */
    void fetchLookupsInOrder({
      /*
       * What is left after the index and the batches.
       *
       * Held records are in `lookups` so their names resolve and must not be
       * asked for again. A target being batched is skipped while its list is
       * still in flight; once it lands, anything it did not contain — a record
       * past the page cap — is no longer batched and falls back to by-id here,
       * which is the mop-up that keeps the saving honest.
       */
      lookups: lookups.filter(
        (lookup) => !lookup.held && !lookup.denied && !pending.has(lookup.target),
      ),
      fetch: (lookup) =>
        client.ensure({
          key: lookup.key,
          connection: lookup.connection,
          op: lookup.op,
          params: { [lookup.param]: lookup.id },
          resolved: params,
          now,
          maxAgeMs: staleAfterMs,
          /*
           * Third and last wave. Serial within one widget already, but a board
           * of eight tables runs eight such chains at once — so they also take
           * the lowest place in the shared queue, behind every widget and
           * fan-out request that still has something blank on screen.
           */
          wave: Wave.Lookup,
        }),
      statusOf: (lookup) => client.get(lookup.key)?.error?.status,
      stopped: () => cancelled,
    }).then((result) => {
      if (!cancelled) noteDenied(result.denied ?? []);
    });

    return () => {
      cancelled = true;
    };
    // `now` excluded deliberately, as above: the ticking clock must not refetch.
  }, [client, lookups, pending, params, staleAfterMs, approved, noteDenied]);

  /**
   * One record, from wherever we already have it.
   *
   * The cache answers for records this widget asked for; the index answers for
   * records anything else did — another widget, a record page, an earlier
   * board. A body kept through a failed refresh counts too, which is why this
   * tests for a body rather than for success.
   */
  const recordOf = useCallback(
    (lookup: (typeof lookups)[number]): unknown => {
      const entry = client.get(lookup.key);
      if (entry?.body !== undefined) return entry.body;
      return records.get(lookup.connection, lookup.target, lookup.id);
    },
    // `lookupStamp` changes when a fetch lands, `recordStamp` when the index does.
    [client, records, lookupStamp, recordStamp],
  );

  const resolvedNames = useMemo<ReferenceNames>(
    () => (lookups.length === 0 ? {} : resolveNames(lookups, recordOf, labelled)),
    [lookups, recordOf, labelled],
  );

  /** Link cells left showing an id, and why. See `unnamedLinks`. */
  const unnamed = useMemo<WidgetData["unnamed"]>(
    () =>
      unnamedLinks({
        lookups,
        names: resolvedNames,
        batchKeys: batches.map((batch) => batch.key),
        failureOf: (key) => {
          const entry = client.get(key);
          return entry?.status === "error"
            ? (entry.error?.userMessage ?? entry.error?.message)
            : undefined;
        },
      }),
    [lookups, batches, resolvedNames, client, lookupStamp, recordStamp],
  );

  /*
   * The rows, with anything read through a reference filled in.
   *
   * From the same fetch the reference cell uses for its name, so following a
   * link and reading a field through it cost one request between them.
   */
  const rows = useMemo(
    () =>
      withLinkedValues({
        rows: executed?.rows ?? [],
        linked: linkedFields,
        lookups,
        recordOf,
      }),
    [executed, linkedFields, lookups, recordOf],
  );

  /** Those columns wear the name somebody gave them when they added one. */
  const columns = useMemo(() => {
    const named = new Map(
      linkedFields.flatMap((one) => (one.label ? [[one.as, one.label] as const] : [])),
    );
    return named.size === 0
      ? labelled
      : labelled.map((column) => {
          const label = named.get(column.name);
          return label ? { ...column, label } : column;
        });
  }, [labelled, linkedFields]);

  return {
    widget,
    referenceNames: resolvedNames,
    unnamed,
    previewReceipts: entries.flatMap(({ request, entry }) =>
      entry?.meta?.receipt ? [{ as: request.as, receipt: entry.meta.receipt }] : [],
    ),
    state,
    approval,
    stale,
    rows,
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
    columns,
    ...(executed?.highlights ? { highlights: executed.highlights } : {}),
    runMeta: executed?.meta ?? null,
    /*
     * The server labels its own stale answers with a `staleReason`; when the
     * browser is the one holding the last good copy, it has to say so in the
     * same field so the same banner picks it up. One contract, wherever the
     * old rows came from — never stale data without a label on it.
     */
    fetchMeta: fetchMeta,
    raw: widget.sources.length > 0 ? bodies : primary?.body,
    binding: executed?.binding ?? null,
    errors: [
      ...(fanned.truncated
        ? [
            `Only the first ${fanned.requests.length} of ${fanned.driverRows} record(s) were expanded, so this total is incomplete.`,
          ]
        : []),
      /*
       * A fan-out child that could not be read is stated rather than absorbed.
       * The tile still draws — that is the whole point of treating these as
       * optional — but a total quietly missing three of its twenty-five parts
       * is a number somebody would act on, so it says which it is.
       */
      ...(derived.missingOptional > 0
        ? [
            `${derived.missingOptional} of ${fanned.requests.length} related record(s) could not be read, so this total is incomplete.`,
          ]
        : []),
      ...(executed?.errors ?? []),
      ...(executed?.binding?.errors ?? []).map((issue) => issue.message),
    ],
    userMessage: derived.failure?.userMessage ?? null,
    errorStatus: derived.failure?.status ?? null,
    retryAt: derived.failure?.retryAt ?? null,
    lastFetchedAt,
    queryKey: key,
    refetch,
  };
};
