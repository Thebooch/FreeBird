import type { Completeness, PaginationSpec } from "@freebirdai/dash-spec";
import { readPath, rowsAt } from "./paginate.js";
import type { FetchMeta } from "./types.js";

/** A complete primary request cannot conceal an incomplete enrichment source. */
export const combineFetchMeta = (sources: readonly (FetchMeta | null | undefined)[], limited = false): FetchMeta | null => {
  const first = sources.find((source): source is FetchMeta => Boolean(source));
  if (!first) return null;
  const present = sources.filter((source): source is FetchMeta => Boolean(source));
  const partial = limited || present.some(source => source.truncated || source.completeness?.status === "partial");
  const unknown = sources.some(source => !source || !source.completeness || source.completeness.status === "unknown");
  const status = partial ? "partial" : unknown ? "unknown" : "complete";
  return {
    ...first,
    truncated: partial,
    warnings: [...new Set(present.flatMap(source => [...source.warnings]))],
    completeness: {
      status, scope: status === "complete" ? "query" : "loaded-records",
      reason: partial ? "At least one source or reference expansion is incomplete."
        : unknown ? "Completeness is not established for every source." : "All declared source queries were exhausted.",
    },
  };
};

/** Exhaustion is scoped to this query, never to the entire account. */
export const queryCompleteness = (input: {
  pagination: PaginationSpec; lastBody: unknown; rowsPath?: string;
  truncated: boolean; paginationPending?: boolean; warnings: readonly string[];
}): Completeness => {
  if (input.truncated) return { status: "partial", scope: "loaded-records", reason: input.warnings[0] ?? "The request stopped before its declared continuation was exhausted." };
  if (input.paginationPending) return { status: "unknown", scope: "loaded-records", reason: "Pagination has not been confirmed." };
  if (input.pagination.kind === "none") return { status: "unknown", scope: "loaded-records", reason: "The response has no verified exhaustion contract." };
  if (rowsAt(input.lastBody, input.rowsPath) === null) return { status: "unknown", scope: "loaded-records", reason: "The declared record list was not found." };
  if (input.pagination.kind === "cursor" && input.pagination.hasMorePath) {
    const more = readPath(input.lastBody, input.pagination.hasMorePath);
    if (more === undefined || more === null) return { status: "unknown", scope: "loaded-records", reason: "The API omitted its declared continuation indicator." };
    if (more !== false && more !== 0 && more !== "false" && more !== "0") return { status: "partial", scope: "loaded-records", reason: "The API indicates more records but no usable continuation was followed." };
  }
  return { status: "complete", scope: "query", reason: "The declared pagination contract was exhausted for this query." };
};
