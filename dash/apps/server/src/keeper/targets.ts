import type {
  ConnectionSpec,
  DashboardSpec,
  EntityLinkView,
  ResolvedParams,
} from "@freebirdai/dash-spec";
import {
  drawnColumns,
  getOp,
  interpolateValue,
  parseDuration,
  resolveRange,
  widgetSources,
} from "@freebirdai/dash-spec";
import { buildQueryRequest } from "../query.js";
import { paramShape, type ViewedRequest } from "./viewed.js";

/**
 * What is worth having in the cache before anybody asks for it.
 *
 * The keeper's half of separating *when data is fetched* from *when it is
 * looked at*. Pure and separate from the scheduling so it can be checked
 * without a clock or a server: given the boards, the connections, what is
 * known about each API's records and what people have actually asked for,
 * this says exactly which queries a warm cache consists of.
 *
 * Three sources, in order of how much they are trusted:
 *
 * 1. **What was viewed.** The request `/api/query` answered, recorded whole —
 *    key, query string, path inputs, window. The keeper asks the API exactly
 *    that, so it cannot disagree with the reader about which key it warmed.
 *    This is what covers a filter somebody changed, a range they picked and a
 *    window anchored to when they opened the page.
 * 2. **Every widget's own sources, at the board's defaults.** Warm-up for a
 *    board nobody has opened since the server started — onboarding's new
 *    boards above all. Skipped for an endpoint that reads the time range:
 *    that window is anchored in the reader's browser and cannot be predicted
 *    here, so a guess would only ever warm a key nobody reads.
 * 3. **The list behind every reference column a widget draws.** A row carries
 *    a vendor's id and not its name, so a table of work orders needs the
 *    vendors before it can show anything but numbers.
 *
 * What is deliberately **not** here: per-record detail, per-record lookups
 * and child collections. Those are unbounded by construction — four hundred
 * work orders times their notes — and almost none of it is ever opened again.
 * A viewed request is only kept when a board reads that endpoint *with the
 * same parameters*, which is what tells a table of vendors apart from a name
 * lookup against the same endpoint.
 *
 * Fan-out sources and drill-downs are skipped for the reason they always
 * were: their parameters come from another source's rows or from a record
 * somebody opened, so their keys cannot be known without fetching first.
 */

export interface WarmTarget {
  readonly connection: string;
  readonly op: string;
  /** The cache key this will occupy — the same one a view reads. */
  readonly key: string;
  /** Query-string values, as the upstream request will send them. */
  readonly overrides: Readonly<Record<string, string | number | boolean>>;
  /** The window, and the filters with path inputs folded in. */
  readonly resolved: ResolvedParams;
  /** Why this is being warmed, for the status panel and the tests. */
  readonly because: "viewed" | "widget" | "reference";
  /** A board that wants it, for reporting. Absent for a viewed request. */
  readonly dashboard?: string | undefined;
  /**
   * The shortest `refresh.every` of any widget reading this endpoint.
   *
   * A widget that says "every minute" is somebody's stated wish, and the
   * keeper is now the only thing that asks the API on a schedule — so the
   * wish has to reach it or it means nothing.
   */
  readonly everyMs?: number | undefined;
}

export interface TargetsInput {
  readonly dashboards: readonly DashboardSpec[];
  readonly connections: readonly ConnectionSpec[];
  /** connection id → its record links, as `publicConnection` derives them. */
  readonly entityLinks: Readonly<Record<string, readonly EntityLinkView[]>>;
  /** What people have actually asked for. See `ViewedRequests`. */
  readonly viewed?: readonly ViewedRequest[];
  readonly now: () => number;
}

/** A widget's own `refresh.every` is honoured, but never faster than this. */
export const WIDGET_EVERY_FLOOR_MS = 60_000;

/**
 * The window a board resolves to, left to itself.
 *
 * The same resolution the browser performs on first load: the board's preset
 * and grain, and its filters at their declared defaults. Only used where the
 * window does not reach the key, so the clock it is resolved against does
 * not matter.
 */
export const boardParams = (dashboard: DashboardSpec, now: number): ResolvedParams => {
  const filters: Record<string, string | number | boolean> = {};
  for (const filter of dashboard.params.filters) {
    if (filter.default !== undefined) filters[filter.key] = filter.default;
  }
  return {
    range: resolveRange({
      preset: dashboard.params.defaultRange,
      now,
      ...(dashboard.params.defaultGrain ? { grain: dashboard.params.defaultGrain } : {}),
    }),
    filters,
  };
};

const RANGE_TOKEN = /\{\{\s*range\./;
const ROW_TOKEN = /\{\{\s*row\./;

const slot = (connection: string, op: string): string => `${connection}|${op}`;

export const warmTargets = (input: TargetsInput): WarmTarget[] => {
  const byId = new Map(input.connections.map((connection) => [connection.id, connection]));
  const now = input.now();
  const seen = new Set<string>();
  const targets: WarmTarget[] = [];
  /* endpoint → the parameter shapes boards read it with. */
  const shapes = new Map<string, Set<string>>();
  /* endpoint → the shortest cadence any widget on it asked for. */
  const every = new Map<string, number>();
  /* endpoint → a board that reads it, for reporting. */
  const boardOf = new Map<string, string>();

  const allow = (connection: string, op: string, shape: string, dashboard: string): void => {
    const known = shapes.get(slot(connection, op)) ?? new Set<string>();
    known.add(shape);
    shapes.set(slot(connection, op), known);
    if (!boardOf.has(slot(connection, op))) boardOf.set(slot(connection, op), dashboard);
  };

  const add = (target: WarmTarget): void => {
    if (seen.has(target.key)) return;
    seen.add(target.key);
    targets.push(target);
  };

  const board: WarmTarget[] = [];

  for (const dashboard of input.dashboards) {
    const resolved = boardParams(dashboard, now);

    for (const widget of dashboard.widgets) {
      const everyMs = widget.refresh.every ? parseDuration(widget.refresh.every) : null;

      for (const source of widgetSources(widget)) {
        if (source.fanOut) continue;
        const connection = byId.get(source.connection);
        if (!connection) continue;
        const op = getOp(connection, source.op);
        if (!op) continue;

        const raw = Object.values(source.params).map(String);
        /* A drill-down reads one record somebody opened. Not a board query. */
        if (raw.some((value) => ROW_TOKEN.test(value))) continue;

        allow(source.connection, source.op, paramShape(source.params), dashboard.id);
        if (everyMs !== null) {
          const floored = Math.max(WIDGET_EVERY_FLOOR_MS, everyMs);
          const current = every.get(slot(source.connection, source.op));
          every.set(
            slot(source.connection, source.op),
            current === undefined ? floored : Math.min(current, floored),
          );
        }

        /*
         * The window is the reader's, anchored when they opened the page. A
         * guess resolved against this clock would warm a key nobody reads,
         * so these are left to what was viewed.
         */
        if (op.usesRange || raw.some((value) => RANGE_TOKEN.test(value))) continue;

        /*
         * A parameter nothing could fill is not a board query either.
         * `interpolate` resolves a token it cannot fill to an empty string,
         * so what gives it away is a parameter that had a token and came
         * back empty.
         */
        const params: Record<string, string | number | boolean> = {};
        let unfilled = false;
        for (const [name, value] of Object.entries(source.params)) {
          const filled = interpolateValue(value, resolved);
          if (String(value).includes("{{") && String(filled).trim() === "") unfilled = true;
          params[name] = filled;
        }
        if (unfilled) continue;

        const request = buildQueryRequest({
          connection: source.connection,
          op,
          params,
          resolved,
        });
        board.push({
          connection: source.connection,
          op: source.op,
          ...request,
          because: "widget",
          dashboard: dashboard.id,
        });
      }

      /* The lists behind the reference columns this widget draws. */
      const primary = widgetSources(widget)[0];
      const connection = primary ? byId.get(primary.connection) : undefined;
      if (!connection || !widget.entity) continue;
      const views = input.entityLinks[connection.id] ?? [];
      const view = views.find((one) => one.entity === widget.entity);
      if (!view) continue;

      const drawn = drawnColumns(widget);
      for (const reference of view.references) {
        if (!drawn.has(reference.field) && !drawn.has(reference.field.replace(/\./g, "_"))) {
          continue;
        }
        const list = views.find((one) => one.entity === reference.target)?.list;
        if (!list) continue;
        const op = getOp(connection, list);
        if (!op) continue;

        allow(connection.id, list, "", dashboard.id);
        if (op.usesRange) continue;
        const request = buildQueryRequest({
          connection: connection.id,
          op,
          params: {},
          resolved,
        });
        board.push({
          connection: connection.id,
          op: list,
          ...request,
          because: "reference",
          dashboard: dashboard.id,
        });
      }
    }
  }

  const everyOf = (connection: string, op: string): { everyMs?: number } => {
    const found = every.get(slot(connection, op));
    return found === undefined ? {} : { everyMs: found };
  };

  /* What was asked first: it is the real thing, and the rest is a guess. */
  for (const request of input.viewed ?? []) {
    if (!byId.has(request.connection)) continue;
    if (!shapes.get(slot(request.connection, request.op))?.has(request.shape)) continue;
    add({
      connection: request.connection,
      op: request.op,
      key: request.key,
      overrides: request.overrides,
      resolved: request.resolved,
      because: "viewed",
      dashboard: boardOf.get(slot(request.connection, request.op)),
      ...everyOf(request.connection, request.op),
    });
  }
  for (const target of board) add({ ...target, ...everyOf(target.connection, target.op) });

  return targets;
};
