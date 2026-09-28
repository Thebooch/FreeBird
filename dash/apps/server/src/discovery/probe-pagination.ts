import {
  MAX_PAGES,
  type ConnectionSpec,
  type EvidenceLevel,
  type OpSpec,
  type PaginationSpec,
  getOp,
} from "@freebirdai/dash-spec";
import { rowsOf, tryRead, type Attempt, type ReadDeps } from "../integrate/read.js";

/**
 * Confirm how an endpoint pages by reading its second page.
 *
 * A pagination guess from documentation is never installed on trust: a wrong
 * one does not fail, it reads one page and stops, which looks exactly like a
 * complete answer. So each candidate rule is tried for two pages, and one is
 * kept only when the second page came back with records the first did not
 * have. That proves one continuation — the evidence recorded says
 * `advanced`, never `complete`.
 *
 * Where the whole collection is small enough to read within the limits, it is
 * read to the end (`traversed`), and where the API states how many records it
 * holds, the count read is compared with it (`count-reconciled`).
 *
 * Two traps this exists for:
 * - A proposal's cursor path is a guess; the real cursor is looked for in the
 *   first page itself (`meta.next`, `links.next_cursor`, …).
 * - An API that caps the page size answers a request for 100 with 25. Offset
 *   paging reads that short page as the last one and stops, silently. A short
 *   first page is therefore retried at the size the API actually returned.
 */

export interface ProbeResult {
  /** The rule to install on the endpoint, when one advanced. */
  readonly pagination: PaginationSpec | null;
  /** Suggested page cap, when the collection was read to the end. */
  readonly maxPages?: number;
  /** The strongest thing observed. */
  readonly level: EvidenceLevel | null;
  readonly rows: number;
  readonly pages: number;
  readonly reportedTotal?: number;
  /** What happened, in a sentence a person can read. */
  readonly note: string;
  /** Every rule tried, for the log. */
  readonly tried: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const CURSOR_KEY =
  /^(next|next_?cursor|next_?page_?token|next_?token|cursor|after|end_?cursor|continuation(_?token)?|starting_?after)$/i;
const TOTAL_KEY =
  /^(total|total_?count|total_?results|total_?items|total_?entries|total_?records|count)$/i;
const CURSOR_PARAMS = ["cursor", "after", "page_token", "pageToken", "next", "starting_after", "continuation"];
const OFFSET_PARAMS = ["offset", "skip", "start"];
const PAGE_PARAMS = ["page", "page_number", "pageNumber"];
const LIMIT_PARAMS = ["limit", "per_page", "perPage", "page_size", "pageSize", "size", "count"];

/**
 * Paths outside the records that hold a value shaped like a cursor.
 *
 * A URL is left out: this vocabulary sends a cursor as a parameter, and a
 * next-page address is a different contract.
 */
export const cursorPaths = (body: unknown): string[] => {
  const found: string[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (!isRecord(node) || depth > 3) return;
    for (const [key, value] of Object.entries(node)) {
      const here = `${path}.${key}`;
      if (
        CURSOR_KEY.test(key) &&
        (typeof value === "number" || (typeof value === "string" && value !== "" && !/^https?:\/\//.test(value)))
      )
        found.push(here);
      if (isRecord(value)) walk(value, here, depth + 1);
    }
  };
  walk(body, "$", 0);
  return found;
};

/** A count the API states for the whole collection, outside the records. */
export const reportedTotal = (body: unknown): number | undefined => {
  let found: number | undefined;
  const walk = (node: unknown, depth: number) => {
    if (!isRecord(node) || depth > 2 || found !== undefined) return;
    for (const [key, value] of Object.entries(node)) {
      if (TOTAL_KEY.test(key) && typeof value === "number" && Number.isInteger(value) && value >= 0) {
        found = value;
        return;
      }
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(body, 0);
  return found;
};

/**
 * A declared parameter answering to one of these names, and where it goes.
 *
 * A body parameter is matched on its last step (`page.after` is an `after`),
 * because a read sent with POST pages inside its body.
 */
const paramNamed = (
  op: OpSpec,
  names: readonly string[],
): { name: string; in: "query" | "body" } | undefined => {
  for (const param of op.params) {
    if (param.in !== "query" && param.in !== "body") continue;
    const last = param.in === "body" ? (param.name.split(".").pop() ?? param.name) : param.name;
    if (names.some((one) => one.toLowerCase() === last.toLowerCase()))
      return { name: param.name, in: param.in };
  }
  return undefined;
};

/** A rule's location, written only when it is not the query string. */
const where = (found: { in: "query" | "body" }): { in?: "body" } => (found.in === "body" ? { in: "body" } : {});

const describe = (rule: PaginationSpec): string =>
  rule.kind === "cursor"
    ? `cursor ${rule.param} from ${rule.cursorPath}`
    : rule.kind === "offset"
      ? `offset ${rule.param}/${rule.limitParam} by ${rule.pageSize}`
      : rule.kind === "page"
        ? `page ${rule.param}${rule.limitParam ? `/${rule.limitParam} by ${rule.pageSize}` : ""}`
        : rule.kind;

/** Every rule worth trying, most likely first. */
const candidates = (
  op: OpSpec,
  first: Attempt,
  proposal: PaginationSpec | undefined,
): PaginationSpec[] => {
  const rules: PaginationSpec[] = [];
  const declaredCursor = paramNamed(op, CURSOR_PARAMS);
  const cursorParam: { name: string; in: "query" | "body" } | undefined =
    proposal?.kind === "cursor"
      ? { name: proposal.param, in: proposal.in === "body" ? "body" : "query" }
      : declaredCursor;
  const cursors = cursorPaths(first.body);

  if (proposal && proposal.kind !== "none") {
    // A proposed cursor path that is not in the response is swapped for one that is.
    if (proposal.kind === "cursor" && !cursors.includes(proposal.cursorPath) && cursors.length > 0) {
      for (const path of cursors) rules.push({ ...proposal, cursorPath: path });
    }
    rules.push(proposal);
  }
  if (cursorParam)
    for (const path of cursors)
      rules.push({ kind: "cursor", param: cursorParam.name, cursorPath: path, ...where(cursorParam) });

  const offset = paramNamed(op, OFFSET_PARAMS);
  const limit = paramNamed(op, LIMIT_PARAMS);
  const together = offset && limit && offset.in === limit.in;
  if (together)
    rules.push({ kind: "offset", param: offset.name, limitParam: limit.name, pageSize: 100, ...where(offset) });
  const page = paramNamed(op, PAGE_PARAMS);
  if (page)
    rules.push({
      kind: "page",
      param: page.name,
      startsAt: 1,
      ...(limit && limit.in === page.in ? { limitParam: limit.name, pageSize: 100 } : {}),
      ...where(page),
    });
  /* A read sent with POST keeps its address; only a GET can page by a Link header. */
  if (op.method === "GET") rules.push({ kind: "link-header" });

  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = JSON.stringify(rule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The size the API used, when it answered a request with fewer than asked. */
const resized = (rule: PaginationSpec, returned: number): PaginationSpec | null => {
  if (returned <= 0) return null;
  if (rule.kind === "offset" && returned < rule.pageSize) return { ...rule, pageSize: returned };
  if (rule.kind === "page" && rule.pageSize && returned < rule.pageSize) return { ...rule, pageSize: returned };
  return null;
};

const fingerprint = (row: unknown): string => JSON.stringify(row);

export const probePagination = async (
  connection: ConnectionSpec,
  opId: string,
  deps: ReadDeps,
  options: {
    /** The documentation's guess, when there is one. */
    readonly proposal?: PaginationSpec | undefined;
    /** Read to the end when it takes no more pages than this. */
    readonly traverseUpTo?: number;
    /** A first page already read with no paging, to save a request. */
    readonly first?: Attempt;
  } = {},
): Promise<ProbeResult> => {
  const op = getOp(connection, opId);
  const tried: string[] = [];
  if (!op) return { pagination: null, level: null, rows: 0, pages: 0, note: "No such endpoint.", tried };

  const first =
    options.first ?? (await tryRead(connection, opId, deps, { op: { pagination: { kind: "none" }, maxPages: 1 } }));
  if (first.kind !== "ok") {
    return { pagination: null, level: null, rows: 0, pages: 0, note: `The first page could not be read: ${first.message}`, tried };
  }
  const firstRows = first.rows ?? [];
  const total = reportedTotal(first.body);
  const withTotal = total !== undefined ? { reportedTotal: total } : {};

  /* Everything came back at once, and the API says so. */
  if (total !== undefined && total === firstRows.length) {
    return {
      pagination: { kind: "none" },
      level: "count-reconciled",
      rows: firstRows.length,
      pages: 1,
      ...withTotal,
      note: `All ${total} records came back in one response, as many as the API says it holds.`,
      tried,
    };
  }

  /*
   * A rule advances when its second page holds records its first did not.
   * Its first page is read on its own when the rule asks for a page size —
   * that page can differ from the plain read's — and otherwise is the plain
   * read, which is the same request.
   */
  const advances = async (
    rule: PaginationSpec,
  ): Promise<{ advanced: boolean; attempt: Attempt; firstCount: number }> => {
    tried.push(describe(rule));
    const sized = (rule.kind === "offset") || (rule.kind === "page" && !!rule.limitParam);
    let pageOne: readonly unknown[] = firstRows;
    if (sized) {
      const alone = await tryRead(connection, opId, deps, { op: { pagination: rule, maxPages: 1 } });
      if (alone.kind !== "ok") return { advanced: false, attempt: alone, firstCount: 0 };
      pageOne = alone.rows ?? [];
    }
    const attempt = await tryRead(connection, opId, deps, { op: { pagination: rule, maxPages: 2 } });
    const rows = attempt.kind === "ok" ? (attempt.rows ?? []) : [];
    const seen = new Set(pageOne.map(fingerprint));
    const later = rows.slice(pageOne.length);
    const advanced =
      attempt.kind === "ok" &&
      (attempt.meta?.pages ?? 0) >= 2 &&
      later.length > 0 &&
      later.every((row) => !seen.has(fingerprint(row)));
    return { advanced, attempt, firstCount: pageOne.length };
  };

  for (const rule of candidates(op, first, options.proposal)) {
    let chosen: PaginationSpec | null = null;
    const { advanced, attempt, firstCount } = await advances(rule);
    if (attempt.kind === "budget") break;
    if (advanced) chosen = rule;
    else if (attempt.kind === "ok") {
      /* A short first page may be the API's own cap, not the end: try its size. */
      const smaller = resized(rule, firstCount);
      if (smaller && (await advances(smaller)).advanced) chosen = smaller;
    }
    if (!chosen) continue;

    const confirmed = chosen;
    const limit = Math.min(options.traverseUpTo ?? 0, MAX_PAGES);
    const pageSize = firstRows.length || 1;
    const needed = total !== undefined ? Math.ceil(total / (("pageSize" in confirmed && confirmed.pageSize) || pageSize)) : undefined;
    if (limit > 2 && (needed === undefined || needed <= limit)) {
      const whole = await tryRead(connection, opId, deps, { op: { pagination: confirmed, maxPages: limit } });
      if (whole.kind === "ok" && whole.meta && !whole.meta.truncated && whole.meta.warnings.length === 0) {
        const read = whole.rows?.length ?? 0;
        const pages = whole.meta.pages;
        const reconciled = total !== undefined && total === read;
        return {
          pagination: confirmed,
          maxPages: Math.min(MAX_PAGES, pages + Math.max(2, Math.ceil(pages / 2))),
          level: reconciled ? "count-reconciled" : "traversed",
          rows: read,
          pages,
          ...withTotal,
          note: reconciled
            ? `Read all ${read} records over ${pages} page(s), as many as the API says it holds.`
            : `Read to the last page: ${read} records over ${pages} page(s).`,
          tried,
        };
      }
    }
    return {
      pagination: confirmed,
      level: "advanced",
      rows: firstRows.length,
      pages: 2,
      ...withTotal,
      note: `Reading on to the next page returned different records (${describe(confirmed)}).${
        needed !== undefined && needed > limit ? ` All ${total} records would take about ${needed} pages, more than a check reads.` : ""
      }`,
      tried,
    };
  }

  return {
    pagination: null,
    level: "accepted",
    rows: firstRows.length,
    pages: 1,
    ...withTotal,
    note:
      total !== undefined && total > firstRows.length
        ? `The API says it holds ${total} records, but no way of reading past the first ${firstRows.length} worked.`
        : `Only one page could be read; no way of reading a second page worked.`,
    tried,
  };
};
