import { executeWidget } from "@freebirdai/dash-runtime";
import {
  getOp,
  interpolateValue,
  paramsForWidget,
  type ConnectionSpec,
  type DashboardSpec,
  type ResolvedParams,
} from "@freebirdai/dash-spec";
import { buildQueryRequest } from "../query.js";

/** A refreshed read, as the keeper holds it. */
export interface Refreshed {
  readonly connection: string;
  readonly op: string;
  readonly key: string;
  readonly resolved: ResolvedParams;
}

export interface NumberNow {
  readonly dashboard: string;
  readonly widget: string;
  readonly value: number;
}

/**
 * The number each tile shows, worked out from a read the keeper just
 * refreshed: every one-number widget whose own request is exactly this read
 * — same endpoint, same inputs, same window — run through its own pipeline,
 * as the board would run it. A widget whose request differs is not this
 * read's to speak for, and is left for its own.
 */
export const numbersFrom = (input: {
  readonly dashboards: readonly DashboardSpec[];
  readonly connections: ReadonlyMap<string, ConnectionSpec>;
  readonly read: Refreshed;
  readonly body: unknown;
  readonly now: number;
}): NumberNow[] => {
  const out: NumberNow[] = [];
  for (const dashboard of input.dashboards) {
    for (const widget of dashboard.widgets) {
      const source = widget.source;
      if (widget.component !== "stat" || !source || (widget.sources?.length ?? 0) > 0) continue;
      if (source.connection !== input.read.connection || source.op !== input.read.op) continue;
      const connection = input.connections.get(source.connection);
      const op = connection ? getOp(connection, source.op) : undefined;
      if (!op) continue;
      const resolved = paramsForWidget(widget, input.read.resolved, input.now);
      const params: Record<string, string | number | boolean> = {};
      for (const [name, value] of Object.entries(source.params)) params[name] = interpolateValue(value, resolved);
      const request = buildQueryRequest({ connection: source.connection, op, params, resolved });
      if (request.key !== input.read.key) continue;
      const executed = executeWidget(widget, input.body, { now: input.now, params: request.resolved });
      const column = typeof widget.roles.value === "string" ? widget.roles.value : "value";
      const value = executed.rows[0]?.[column];
      if (typeof value === "number" && Number.isFinite(value)) out.push({ dashboard: dashboard.id, widget: widget.id, value });
    }
  }
  return out;
};

/** The day a value is kept under, in UTC. */
export const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);
