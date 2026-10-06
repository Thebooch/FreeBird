import { widgetSources, type DashboardSpec } from "@freebirdai/dash-spec";

/**
 * Whether a saved board reads any of these fields of one endpoint: Dash's
 * answer to the engine's drift watch (`DriftWatchDeps.readsFields`).
 */
const stringsIn = (node: unknown, out: string[] = []): string[] => {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const one of node) stringsIn(one, out);
  else if (node !== null && typeof node === "object") for (const value of Object.values(node)) stringsIn(value, out);
  return out;
};

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether any saved widget reads this endpoint and names one of these fields. */
export const savedReads = (
  dashboards: readonly DashboardSpec[],
  connection: string,
  op: string,
  fields: readonly string[],
): boolean => {
  if (fields.length === 0) return false;
  const named = fields.map((field) => new RegExp(`(^|[^A-Za-z0-9_])${escaped(field)}([^A-Za-z0-9_]|$)`));
  for (const dashboard of dashboards)
    for (const widget of dashboard.widgets) {
      if (!widgetSources(widget).some((source) => source.connection === connection && source.op === op)) continue;
      const strings = stringsIn(widget);
      if (named.some((pattern) => strings.some((text) => pattern.test(text)))) return true;
    }
  return false;
};

