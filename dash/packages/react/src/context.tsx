import type { AdapterRegistry } from "@freebirdai/dash-adapters";
import type {
  DashboardSpec,
  EntityLinkView,
  FieldLabels,
  Grain,
  RangePreset,
  ResolvedParams,
} from "@freebirdai/dash-spec";
import { resolveRange } from "@freebirdai/dash-spec";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PresentationSources } from "./presentation.js";
import type { ApprovalVerdict } from "./useWidgetData.js";
import { QueryClient } from "./store.js";
import { RecordIndex, indexPlan } from "./recordStore.js";

export interface DashboardControls {
  readonly preset: RangePreset;
  readonly grain: Grain | undefined;
  readonly custom: { start: number; end: number } | undefined;
  readonly filters: Readonly<Record<string, string | number | boolean>>;
  /**
   * The instant "now" the range is measured back from.
   *
   * Deliberately not the ticking clock: a range that ends at `Date.now()`
   * changes every tick, which would churn the query key and re-fetch the whole
   * dashboard on a timer. The anchor only moves when the user acts — changes a
   * control, or asks for a refresh.
   */
  readonly anchor: number;
}

export interface DashboardContextValue {
  readonly dashboard: DashboardSpec;
  readonly registry: AdapterRegistry;
  readonly client: QueryClient;
  /**
   * Every record seen this session, by record type and id.
   *
   * Beside the query cache rather than inside it because they answer different
   * questions: that one knows whether to repeat a request, this one knows
   * whether we already hold a record whatever request brought it. Reference
   * names and a record page opened from a row on screen both read it.
   */
  readonly records: RecordIndex;
  readonly params: ResolvedParams;
  readonly controls: DashboardControls;
  readonly now: number;
  readonly locale: string | undefined;
  readonly timeZone: string;
  /**
   * Stored and board-level looks, supplied by the host.
   *
   * The host owns it for the same reason it owns the spec: this component
   * renders a dashboard and never edits one, and where the overrides are kept
   * is the host's business.
   */
  readonly presentation: PresentationSources | undefined;
  /**
   * What each connection calls its fields, keyed by connection id.
   *
   * Host-supplied for the same reason the presentation is: this component
   * renders a dashboard, and where the labels are kept — a catalog entry on a
   * server, in this case — is the host's business. Absent, or missing an
   * entry, means every field wears the label its name implies.
   */
  readonly labels: Readonly<Record<string, FieldLabels>> | undefined;
  /**
   * Which of each connection's fields point at other records, keyed by
   * connection id.
   *
   * Host-supplied for the same reason the labels are, and deliberately the
   * *links* rather than the record types themselves: a browser needs to know
   * that a column holds a vendor's id and which endpoint returns one, not the
   * twelve hundred field descriptions that make the shared artifact worth
   * having. Absent means no column is marked, which is what every renderer did
   * before this existed.
   */
  readonly entityLinks: Readonly<Record<string, readonly EntityLinkView[]>> | undefined;
  /**
   * Whether each widget is still covered by the approval it was given, keyed
   * by widget id, from `GET /api/dashboards/:id`.
   *
   * Host-supplied for the same reason the labels are, and absent means the
   * host runs no approval gate — every widget renders, which is what every
   * deployment did before approvals existed.
   */
  readonly approvals: Readonly<Record<string, ApprovalVerdict>> | undefined;
  /**
   * What each widget's filter strip is currently narrowed to, in words.
   *
   * Reader state rather than spec, and the only reader state the board keeps
   * centrally. It earns that because it changes what a widget *says*: a chat
   * answering over four hundred records while the person asking can see
   * twelve is confidently wrong in the way this codebase refuses everywhere
   * else, and nothing outside the widget could otherwise know.
   *
   * Empty for every widget with nothing selected, so the common case adds no
   * entries at all.
   */
  readonly facetSummaries: Readonly<Record<string, readonly string[]>>;
  setPreset(preset: RangePreset, custom?: { start: number; end: number }): void;
  setGrain(grain: Grain | undefined): void;
  setFilter(key: string, value: string | number | boolean): void;
  /** Called by a widget when its own strip changes. Empty removes the entry. */
  reportFacets(widgetId: string, summary: readonly string[]): void;
  refreshAll(): void;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export interface DashboardProviderProps {
  readonly dashboard: DashboardSpec;
  readonly registry: AdapterRegistry;
  /** Pin the clock. Left unset, it ticks so staleness and relative times stay honest. */
  readonly now?: number;
  readonly locale?: string;
  readonly presentation?: PresentationSources;
  /** connection id → its field lexicon, from `GET /api/connections`. */
  readonly labels?: Readonly<Record<string, FieldLabels>>;
  /** connection id → its record links, from `GET /api/connections`. */
  readonly entityLinks?: Readonly<Record<string, readonly EntityLinkView[]>>;
  /** widget id → approval verdict, from `GET /api/dashboards/:id`. */
  readonly approvals?: Readonly<Record<string, ApprovalVerdict>>;
  /**
   * connection id → its `credentialsRevision`, from `GET /api/connections`.
   *
   * Watched rather than stored: when one changes, that connection's cached
   * rows belong to an account we are no longer using and are dropped. The
   * server does the same on its side; this is the half that stops the browser
   * displaying them afterwards.
   */
  readonly credentialRevisions?: Readonly<Record<string, number>>;
  readonly children: ReactNode;
}

/** How often the shared clock advances — drives stale badges and "3 min ago". */
const CLOCK_INTERVAL_MS = 30_000;

export const DashboardProvider = ({
  dashboard,
  registry,
  now: pinnedNow,
  locale,
  presentation,
  labels,
  entityLinks,
  approvals,
  credentialRevisions,
  children,
}: DashboardProviderProps): JSX.Element => {
  const [client] = useState(() => new QueryClient(registry));
  const [records] = useState(() => new RecordIndex());

  /*
   * Which endpoints' rows are which record type.
   *
   * Derived from `entityLinks`, which already carries `ops` for exactly this —
   * so indexing costs no extra request and no extra payload.
   */
  const plan = useMemo(() => indexPlan(entityLinks), [entityLinks]);

  useEffect(() => {
    client.onFetched = ({ connection, op, body }) => {
      records.ingest({ connection, op, body, plan });
    };
    return () => {
      client.onFetched = undefined;
    };
  }, [client, records, plan]);

  /*
   * The client outlives any one registry.
   *
   * It is created once so the cache survives a board re-render, but the host
   * builds a fresh `AdapterRegistry` whenever a connection spec changes. The
   * initialiser above captures only the first one, so without this an edited
   * connection never reached the fetch path at all.
   */
  useEffect(() => {
    client.setRegistry(registry);
  }, [client, registry]);

  /*
   * Rows belonging to an account whose credentials changed must go.
   *
   * The server drops them from its own cache on the same signal. This side
   * became load-bearing the moment a failed refresh started leaving the
   * previous body in place: without it the server correctly forgets the old
   * account's data and the browser goes on drawing it. Scoped by connection,
   * so one key change does not blank every other board.
   */
  const revisions = credentialRevisions;
  const previousRevisions = useRef(revisions);
  useEffect(() => {
    const before = previousRevisions.current;
    previousRevisions.current = revisions;
    if (!revisions || !before) return;
    for (const [connection, revision] of Object.entries(revisions)) {
      if (before[connection] !== undefined && before[connection] !== revision) {
        client.invalidateConnection(connection);
        // The index holds the same rows under a different key, so forgetting
        // one without the other would leave the old account's names on screen.
        records.forget(connection);
      }
    }
  }, [client, records, revisions]);

  const [tick, setTick] = useState(() => pinnedNow ?? Date.now());

  useEffect(() => {
    if (pinnedNow !== undefined) return;
    const timer = setInterval(() => setTick(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pinnedNow]);

  const now = pinnedNow ?? tick;

  const [controls, setControls] = useState<DashboardControls>(() => ({
    preset: dashboard.params.defaultRange,
    grain: dashboard.params.defaultGrain,
    custom: undefined,
    anchor: pinnedNow ?? Date.now(),
    filters: Object.fromEntries(
      dashboard.params.filters
        .filter((filter) => filter.default !== undefined)
        .map((filter) => [filter.key, filter.default!]),
    ),
  }));

  const params = useMemo<ResolvedParams>(
    () => ({
      range: resolveRange({
        preset: controls.preset,
        now: controls.anchor,
        grain: controls.grain,
        custom: controls.custom,
      }),
      filters: controls.filters,
    }),
    [controls],
  );

  const freshAnchor = useCallback(() => pinnedNow ?? Date.now(), [pinnedNow]);

  const setPreset = useCallback(
    (preset: RangePreset, custom?: { start: number; end: number }) => {
      // Re-anchor: asking for "the last 7 days" means from right now, not from
      // whenever the page happened to be opened.
      setControls((previous) => ({ ...previous, preset, custom, anchor: freshAnchor() }));
    },
    [freshAnchor],
  );

  const setGrain = useCallback((grain: Grain | undefined) => {
    setControls((previous) => ({ ...previous, grain }));
  }, []);

  const setFilter = useCallback((key: string, value: string | number | boolean) => {
    setControls((previous) => ({ ...previous, filters: { ...previous.filters, [key]: value } }));
  }, []);

  const refreshAll = useCallback(() => {
    setControls((previous) => ({ ...previous, anchor: freshAnchor() }));
    /*
     * Re-run everything, keeping the rows on screen while it happens.
     *
     * This used to `invalidate()` first, which emptied the cache and blanked
     * the whole board — and then, when the refresh was refused, left it blank.
     * Refreshing is a request for newer numbers, not a request to stop showing
     * the ones already there.
     */
    client.refreshAll(freshAnchor());
  }, [client, freshAnchor]);

  const [facetSummaries, setFacetSummaries] = useState<Readonly<Record<string, readonly string[]>>>(
    {},
  );

  const reportFacets = useCallback((widgetId: string, summary: readonly string[]): void => {
    setFacetSummaries((previous) => {
      const current = previous[widgetId];
      /*
       * Identity-compared before writing, because this is called from an
       * effect on every render of every widget. Setting state unconditionally
       * would schedule a re-render of the whole board each time, which each
       * widget would then answer with another report — a loop that only stops
       * because React bails out on identical values, which these are not.
       */
      const same =
        current !== undefined &&
        current.length === summary.length &&
        current.every((entry, index) => entry === summary[index]);
      if (same) return previous;
      if (summary.length === 0) {
        if (current === undefined) return previous;
        const next = { ...previous };
        delete next[widgetId];
        return next;
      }
      return { ...previous, [widgetId]: summary };
    });
  }, []);

  const value = useMemo<DashboardContextValue>(
    () => ({
      dashboard,
      registry,
      client,
      records,
      params,
      controls,
      now,
      locale,
      timeZone: dashboard.params.timeZone,
      presentation,
      labels,
      entityLinks,
      approvals,
      facetSummaries,
      setPreset,
      setGrain,
      setFilter,
      reportFacets,
      refreshAll,
    }),
    [
      dashboard,
      registry,
      client,
      records,
      params,
      controls,
      now,
      locale,
      presentation,
      labels,
      entityLinks,
      approvals,
      facetSummaries,
      reportFacets,
      setPreset,
      setGrain,
      setFilter,
      refreshAll,
    ],
  );

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
};

export const useDashboard = (): DashboardContextValue => {
  const value = useContext(DashboardContext);
  if (!value) throw new Error("useDashboard must be used inside a <DashboardProvider>");
  return value;
};

/**
 * The same context, for things that render both inside and outside a board.
 *
 * `useDashboard` throwing is right for a widget — one outside a provider is a
 * wiring mistake. It is wrong for chrome that legitimately outlives the board:
 * the assistant panel is mounted on an empty workspace too, where there is no
 * dashboard to have a time range. Returning null lets that caller degrade
 * instead of taking the app down with it.
 */
export const useOptionalDashboard = (): DashboardContextValue | null =>
  useContext(DashboardContext);
