import { pathParamNames, readField, type ConnectionSpec } from "@freebirdai/connect-spec";

type OpDef = ConnectionSpec["ops"][number];

/**
 * Endpoints that might say how many records a list holds, and the number in
 * their answer. Only candidates: nothing here is installed until a read
 * reconciles the number with the list (`confirmCount` in `agent.ts`).
 */

/** What such an endpoint is called under its list: `/breweries/meta`, `/orders/count.json`. */
const COUNT_SEGMENT = /^(count|meta|total|totals|stats)$/i;

/** Where the number usually is, most specific first. */
const COUNT_FIELDS = [
  "count",
  "total",
  "total_count",
  "totalCount",
  "count.value",
  "meta.total",
  "meta.count",
  "data.count",
  "data.total",
  "value",
] as const;

const bare = (path: string): string => path.replace(/\.json$/i, "").replace(/\/+$/, "");

/** Endpoints one segment under a list, named like a count, that need no more inputs than it. */
export const countCandidates = (
  connection: ConnectionSpec,
  list: { readonly id: string; readonly path: string },
): OpDef[] => {
  const base = bare(list.path);
  const inputs = pathParamNames(list.path).length;
  return connection.ops.filter((op) => {
    if (op.id === list.id || (op.method ?? "GET") !== "GET" || op.servedBy) return false;
    if (pathParamNames(op.path).length !== inputs) return false;
    const path = bare(op.path);
    return path.startsWith(`${base}/`) && COUNT_SEGMENT.test(path.slice(base.length + 1));
  });
};

/** The count in an answer — a whole number, or one written as text — and where it was. */
export const countIn = (body: unknown): { readonly field: string; readonly value: number } | null => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  for (const field of COUNT_FIELDS) {
    const raw = readField(body as Record<string, unknown>, field);
    const value =
      typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,12}$/.test(raw.trim()) ? Number(raw) : NaN;
    if (Number.isInteger(value) && value >= 0) return { field, value };
  }
  return null;
};
