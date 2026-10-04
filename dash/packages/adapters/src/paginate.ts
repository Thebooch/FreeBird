import { INCOMPLETE } from "./incomplete.js";
import { evalPath, parsePath } from "@freebirdai/dash-expr";
import type { PaginationSpec } from "@freebirdai/dash-spec";

/**
 * Deciding whether there is another page, without knowing how to ask for it.
 *
 * The REST adapter's page loop is mostly HTTP: status codes, conditional
 * validators, URL redaction, repeat-URL detection. None of that has an MCP
 * counterpart, so a shared *driver* would have meant threading transport
 * specifics through a generic interface until it fit neither.
 *
 * What genuinely is shared is the decision itself. `paginationSchema` says
 * where the next-page token goes — `param`, `cursorPath`, `pageSize` — and
 * never that it goes in a query string. For REST it becomes a query
 * parameter; for MCP the same value becomes a tool-call argument. This module
 * owns that calculation and the merge that follows; each adapter keeps its own
 * mechanics.
 */

export const truthy = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== false && value !== "" && value !== 0;

export const readPath = (body: unknown, path: string): unknown => {
  try {
    return evalPath(parsePath(path), body)[0];
  } catch {
    return undefined;
  }
};

export const rowsAt = (body: unknown, rowsPath: string | undefined): unknown[] | null => {
  if (!rowsPath) return Array.isArray(body) ? body : null;
  try {
    const matches = evalPath(parsePath(rowsPath), body);
    if (matches.length === 1 && Array.isArray(matches[0])) return matches[0];
    return matches.length > 0 ? matches : null;
  } catch {
    return null;
  }
};

/**
 * Write the merged rows back where they came from, so the pipeline's
 * `extract` path works identically for one page or ten.
 */
export const withRows = (body: unknown, rowsPath: string | undefined, rows: unknown[]): unknown => {
  if (!rowsPath) return rows;
  const segments = parsePath(rowsPath).segments;
  if (segments.length === 0) return rows;

  const clone = structuredClone(body) as Record<string, unknown>;
  let cursor: unknown = clone;
  for (const segment of segments.slice(0, -1)) {
    if (segment.kind === "key" && cursor && typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[segment.key];
    } else if (segment.kind === "index" && Array.isArray(cursor)) {
      cursor = cursor[segment.index];
    } else {
      return rows; // Structure changed under us; hand back a plain array.
    }
  }
  const last = segments[segments.length - 1]!;
  if (last.kind === "key" && cursor && typeof cursor === "object") {
    (cursor as Record<string, unknown>)[last.key] = rows;
    return clone;
  }
  return rows;
};

/** Why there is no next page: the end a read records it reached (`ReadCompletion`). */
export type EndOfPages = "single-response" | "empty-page" | "short-page" | "no-cursor" | "has-more-false" | "no-next";

export type NextPage =
  /** No further pages, and why. */
  | { readonly kind: "none"; readonly why: EndOfPages }
  /** Merge these into the next request's params or arguments. */
  | { readonly kind: "params"; readonly params: Record<string, string> }
  /** The next page lives in a response header; only HTTP can answer this. */
  | { readonly kind: "link-header" }
  /** The answer gave the next page's address; only HTTP can follow one. */
  | { readonly kind: "url"; readonly url: string };

/** The declared page size must also be requested on page one. */
export const firstPageParams = (pagination: PaginationSpec): Record<string, string> => {
  if (pagination.kind === "offset")
    return { [pagination.param]: "0", [pagination.limitParam]: String(pagination.pageSize) };
  if (pagination.kind === "page")
    return {
      [pagination.param]: String(pagination.startsAt),
      ...(pagination.limitParam && pagination.pageSize
        ? { [pagination.limitParam]: String(pagination.pageSize) }
        : {}),
    };
  return {};
};

/**
 * What the next page needs, given what the last one returned.
 *
 * `pageIndex` is the count of pages already fetched, so the first call after
 * page one receives 1.
 */
export const nextPageParams = (input: {
  readonly pagination: PaginationSpec;
  readonly body: unknown;
  readonly rowsPath: string | undefined;
  readonly pageIndex: number;
  /** How many records the first page held: the page size, where none is declared. */
  readonly firstPageRows?: number | undefined;
  /** Records read so far, this page included, and how many the API said it holds. */
  readonly collected?: number | undefined;
  readonly reportedTotal?: number | undefined;
}): NextPage => {
  const { pagination, body, rowsPath, pageIndex } = input;
  const rows = rowsAt(body, rowsPath);

  switch (pagination.kind) {
    case "none":
      return { kind: "none", why: "single-response" };

    case "link-header":
      return { kind: "link-header" };

    case "next-url": {
      /* An empty page is the end, whatever address it still offers. */
      if (rows !== null && rows.length === 0) return { kind: "none", why: "empty-page" };
      const found = readPath(body, pagination.path);
      /* HAL writes it as an object: `{ "href": "…" }`. */
      const address =
        found !== null && typeof found === "object" ? (found as { href?: unknown }).href : found;
      return typeof address === "string" && address.trim() !== ""
        ? { kind: "url", url: address.trim() }
        : { kind: "none", why: "no-next" };
    }

    case "cursor": {
      if (pagination.hasMorePath && !truthy(readPath(body, pagination.hasMorePath))) {
        return { kind: "none", why: "has-more-false" };
      }
      const cursor = readPath(body, pagination.cursorPath);
      if (!truthy(cursor)) return { kind: "none", why: "no-cursor" };
      return { kind: "params", params: { [pagination.param]: String(cursor) } };
    }

    case "offset": {
      // Without a row count there is no honest termination condition, so stop
      // rather than loop forever or guess.
      if (rows === null) return { kind: "none", why: "empty-page" };
      if (rows.length < pagination.pageSize) return { kind: "none", why: rows.length === 0 ? "empty-page" : "short-page" };
      return {
        kind: "params",
        params: {
          [pagination.param]: String(pageIndex * pagination.pageSize),
          [pagination.limitParam]: String(pagination.pageSize),
        },
      };
    }

    case "page": {
      if (rows === null || rows.length === 0) return { kind: "none", why: "empty-page" };
      if (pagination.limitParam && pagination.pageSize && rows.length < pagination.pageSize)
        return { kind: "none", why: "short-page" };
      /*
       * No page size declared: the first page shows it. A page shorter than
       * the first is the last, unless the API's own count says there is more.
       * Asking past it met a 404 on an API that answers that way, which failed
       * the whole read (seen with Rick and Morty's API).
       */
      if (
        !pagination.pageSize &&
        input.firstPageRows !== undefined &&
        pageIndex > 1 &&
        rows.length < input.firstPageRows &&
        (input.reportedTotal === undefined || (input.collected ?? 0) >= input.reportedTotal)
      )
        return { kind: "none", why: "short-page" };
      const params: Record<string, string> = {
        [pagination.param]: String(pagination.startsAt + pageIndex),
      };
      if (pagination.limitParam && pagination.pageSize) {
        params[pagination.limitParam] = String(pagination.pageSize);
      }
      return { kind: "params", params };
    }
  }
};

export const mergePages = (
  pages: readonly unknown[],
  rowsPath: string | undefined,
  warnings: string[],
): unknown => {
  const collected: unknown[] = [];
  for (const page of pages) {
    const rows = rowsAt(page, rowsPath);
    if (rows === null) {
      warnings.push(INCOMPLETE.unmerged);
      return pages[0];
    }
    collected.push(...rows);
  }
  return withRows(pages[0], rowsPath, collected);
};
