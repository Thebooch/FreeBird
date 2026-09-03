import type { AdapterRegistry } from "@freebirdai/dash-adapters";
import type { DashboardSpec, FieldLabels, Grain, RangePreset, ResolvedParams } from "@freebirdai/dash-spec";
import { resolveRange } from "@freebirdai/dash-spec";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { PresentationSources } from "./presentation.js";
import type { ApprovalVerdict } from "./useWidgetData.js";
import { QueryClient } from "./store.js";

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
   * Whether each widget is still covered by the approval it was given, keyed
   * by widget id, from `GET /api/dashboards/:id`.
   *
   * Host-supplied for the same reason the labels are, and absent means the
   * host runs no approval gate — every widget renders, which is what every
   * deployment did before approvals existed.
   */
  readonly approvals: Readonly<Record<string, ApprovalVerdict>> | undefined;
  setPreset(preset: RangePreset, custom?: { start: number; end: number }): void;
  setGrain(grain: Grain | undefined): void;
  setFilter(key: string, value: string | number | boolean): void;
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
  /** widget id → approval verdict, from `GET /api/dashboards/:id`. */
  readonly approvals?: Readonly<Record<string, ApprovalVerdict>>;
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
  approvals,
  children,
}: DashboardProviderProps): JSX.Element => {
  const [client] = useState(() => new QueryClient(registry));
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
    client.invalidate();
  }, [client, freshAnchor]);

  const value = useMemo<DashboardContextValue>(
    () => ({
      dashboard,
      registry,
      client,
      params,
      controls,
      now,
      locale,
      timeZone: dashboard.params.timeZone,
      presentation,
      labels,
      approvals,
      setPreset,
      setGrain,
      setFilter,
      refreshAll,
    }),
    [
      dashboard,
      registry,
      client,
      params,
      controls,
      now,
      locale,
      presentation,
      labels,
      approvals,
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
