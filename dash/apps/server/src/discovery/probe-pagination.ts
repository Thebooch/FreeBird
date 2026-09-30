import {
  MAX_PAGES,
  type ConnectionSpec,
  type EvidenceLevel,
  type OpSpec,
  type PaginationSpec,
  getOp,
} from "@freebirdai/dash-spec";
import { evalPath, parsePath } from "@freebirdai/dash-expr";
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
  /** A value the first request sends so every page is larger: `limit=100` where the next address said 20. */
  readonly query?: Readonly<Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/* A leading `@` is an XML attribute: `<orders total="175" next="…">` reads as `@total`, `@next`. */
const CURSOR_KEY =
  /^@?(next|next_?cursor|next_?page_?token|next_?token|cursor|after|end_?cursor|continuation(_?token)?|starting_?after)$/i;
const TOTAL_KEY =
  /^@?(total|total_?count|total_?results|total_?items|total_?entries|total_?records|count)$/i;
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
      const here = `${path}${step(key)}`;
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
        ? `page ${rule.param}${rule.startsAt === 0 ? " from 0" : ""}${rule.limitParam ? `/${rule.limitParam} by ${rule.pageSize}` : ""}`
        : rule.kind === "next-url"
          ? `the next address at ${rule.path}`
          : rule.kind;

/** Every rule worth trying, most likely first. */
const NEXT_KEY = /^(next|next_?page_?url|next_?url|next_?page|next_?link)$/i;

/**
 * The rules an answer's own "next" address implies: `?page=2` is paging by
 * page, and an offset equal to the records read is paging by offset. Laravel's
 * `next_page_url`, Django's `next`, `info.next` — the address the API itself
 * hands back, where nothing declared the parameter it uses (checkpoint 2: 10
 * of 332 facts, with `next_page_url` right there in the answer).
 */
const fromNextAddress = (body: unknown, rowsRead: number): PaginationSpec[] => {
  const addresses: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (!isRecord(node) || depth > 2) return;
    for (const [key, value] of Object.entries(node)) {
      if (NEXT_KEY.test(key) && typeof value === "string" && value.includes("?")) addresses.push(value);
      else walk(value, depth + 1);
    }
  };
  walk(body, 0);
  const rules: PaginationSpec[] = [];
  for (const address of addresses) {
    let query: URLSearchParams;
    try {
      query = new URL(address, "https://next.invalid/").searchParams;
    } catch {
      continue;
    }
    const limit = [...query.keys()].find((name) => LIMIT_PARAMS.includes(name));
    const size = limit ? Number(query.get(limit)) : undefined;
    for (const [name, value] of query) {
      if (!/^\d+$/.test(value) || name === limit) continue;
      const n = Number(value);
      if (n === 2 || PAGE_PARAMS.includes(name))
        rules.push({
          kind: "page",
          param: name,
          startsAt: 1,
          ...(limit && size && size >= 1 && size <= 1000 ? { limitParam: limit, pageSize: size } : {}),
        });
      else if (rowsRead > 0 && n === rowsRead && rowsRead <= 1000)
        rules.push({ kind: "offset", param: name, limitParam: limit ?? "limit", pageSize: rowsRead });
    }
  }
  return rules;
};

const NEXT_ADDRESS_KEY =
  /^(next|next_?page_?url|next_?url|next_?page|next_?link|next_?href|@?odata\.nextLink|next_?records_?url)$/i;

const looksLikeAddress = (value: unknown): value is string =>
  typeof value === "string" && (/^https?:\/\//i.test(value) || value.startsWith("/") || value.includes("?"));

/** A path step as the path grammar wants it: a plain key, or a quoted one. */
const step = (key: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);

/**
 * Where an answer hands back the next page's address, outside its records:
 * `links.next`, `_links.next.href` (HAL), `@odata.nextLink`, `next_page`.
 * Followed as it is given, so a token the address carries — one no parameter
 * declares, and no number could stand in for — is sent back exactly.
 */
export const nextAddressPaths = (body: unknown): string[] => {
  const found: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (!isRecord(node) || depth > 3) return;
    for (const [key, value] of Object.entries(node)) {
      const here = `${path}${step(key)}`;
      if (NEXT_ADDRESS_KEY.test(key)) {
        if (looksLikeAddress(value)) found.push(here);
        else if (isRecord(value) && looksLikeAddress(value.href)) found.push(here);
      } else if (isRecord(value)) walk(value, here, depth + 1);
    }
  };
  walk(body, "$", 0);
  return found;
};

const MORE_KEY = /^@?(has_?more|more|has_?next|has_?next_?page|more_?records)$/i;

/** The answer itself says there are records past this page. */
export const saysMore = (body: unknown): boolean => {
  let more = false;
  const walk = (node: unknown, depth: number): void => {
    if (!isRecord(node) || depth > 2 || more) return;
    for (const [key, value] of Object.entries(node)) {
      if (MORE_KEY.test(key) && value === true) more = true;
      else if (isRecord(value)) walk(value, depth + 1);
    }
  };
  walk(body, 0);
  return more;
};

/** The field a record is known by, where the last record's id is the next cursor. */
const idFieldOf = (row: unknown): string | undefined =>
  isRecord(row) ? ["id", "uuid", "key", "Id", "ID"].find((name) => ["string", "number"].includes(typeof row[name])) : undefined;

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
  /*
   * A cursor parameter and no cursor in the answer: the cursor is the last
   * record's own id (`starting_after`, `after`), as the path grammar's
   * `[last]` exists for.
   */
  const idField = idFieldOf(first.rows?.[first.rows.length - 1]);
  if (cursorParam && cursors.length === 0 && idField && op.rowsPath)
    rules.push({ kind: "cursor", param: cursorParam.name, cursorPath: `${op.rowsPath}[last].${idField}`, ...where(cursorParam) });
  /* A GET's own "next" address, where the answer gives one. */
  if (op.method === "GET") {
    const declaredLimit = paramNamed(op, LIMIT_PARAMS);
    for (const rule of fromNextAddress(first.body, first.rows?.length ?? 0)) {
      /*
       * With the page size the endpoint declares, first: 332 records are 4
       * pages of 100 rather than 34 of 10, and an API that limits how fast it
       * is asked refuses fewer of them (checkpoint 2).
       */
      if (rule.kind === "page" && !rule.limitParam && declaredLimit?.in === "query")
        rules.push({ ...rule, limitParam: declaredLimit.name, pageSize: 100 });
      /*
       * The same for an offset the address carries with its own limit: 1,351
       * records are 14 pages of 100, and 68 of 20 — past the most pages a read
       * takes, so the last 351 were left out (2026-09-30). An API that caps the
       * size answers with fewer, and the rule is tried again at that size.
       */
      if (rule.kind === "offset" && rule.pageSize < 100) rules.push({ ...rule, pageSize: 100 });
      rules.push(rule);
    }
    /* The address itself, followed: for a token no parameter declares. */
    for (const path of nextAddressPaths(first.body)) rules.push({ kind: "next-url", path });
  }

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

  /*
   * The answer says there is more — a count above what came back, or a flag —
   * and nothing declared says how to ask for it. The parameters most APIs
   * use are tried by name, last: a rule is only ever kept when its second
   * page returns records the first did not have, so a name the API ignores
   * costs two requests and installs nothing.
   */
  const rowsRead = first.rows?.length ?? 0;
  const stated = reportedTotal(first.body);
  if (op.method === "GET" && rowsRead > 0 && ((stated !== undefined && stated > rowsRead) || saysMore(first.body))) {
    if (!page) rules.push({ kind: "page", param: "page", startsAt: 1 });
    if (!together && rowsRead <= 1000)
      rules.push({ kind: "offset", param: "offset", limitParam: limit?.in === "query" ? limit.name : "limit", pageSize: rowsRead });
    if (!page) rules.push({ kind: "page", param: "page[number]", startsAt: 1 });
  }

  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = JSON.stringify(rule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * The size a next address asks for, where it names one smaller than a
 * hundred: the first request can ask for a hundred instead, and every address
 * after it carries that on.
 */
const widerFirstPage = (body: unknown, rule: PaginationSpec): { readonly name: string; readonly size: number } | null => {
  if (rule.kind !== "next-url") return null;
  let found: unknown;
  try {
    found = evalPath(parsePath(rule.path), body)[0];
  } catch {
    return null;
  }
  const address = isRecord(found) ? found.href : found;
  if (typeof address !== "string") return null;
  let query: URLSearchParams;
  try {
    query = new URL(address, "https://next.invalid/").searchParams;
  } catch {
    return null;
  }
  const name = [...query.keys()].find((key) => LIMIT_PARAMS.includes(key));
  const size = name ? Number(query.get(name)) : NaN;
  return name && Number.isInteger(size) && size > 0 && size < 100 ? { name, size: 100 } : null;
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
  /*
   * How many pages a read may take, from what this check read — except where
   * the endpoint reads a time range: the check reads the board's, and a widget
   * may read a wider one, every record where its request named no time. Sized
   * from 46 payments in thirty days, a count over all 1,840 stopped at three
   * pages (2026-09-30).
   */
  const ceiling = (sized: number): number => (op.usesRange ? MAX_PAGES : sized);

  const first =
    options.first ?? (await tryRead(connection, opId, deps, { op: { pagination: { kind: "none" }, maxPages: 1 } }));
  if (first.kind !== "ok") {
    return { pagination: null, level: null, rows: 0, pages: 0, note: `The first page could not be read: ${first.message}`, tried };
  }
  const firstRows = first.rows ?? [];
  /*
   * One object read as one record has no pages: "reading on" would count each
   * later answer as a record of its own. Eight pages of thirty vehicles were
   * confirmed as eight records that way (2026-09-30).
   */
  if (isRecord(first.body) && (!op.rowsPath || op.rowsPath === "$"))
    return { pagination: null, level: "accepted", rows: firstRows.length, pages: 1, note: "The answer is one record, so there is nothing to page through.", tried };
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
  ): Promise<{ advanced: boolean; attempt: Attempt; firstCount: number; shifted?: boolean }> => {
    tried.push(describe(rule));
    const sized = (rule.kind === "offset") || (rule.kind === "page" && !!rule.limitParam);
    let pageOne: readonly unknown[] = firstRows;
    if (sized) {
      const alone = await tryRead(connection, opId, deps, { op: { pagination: rule, maxPages: 1 } });
      if (alone.kind !== "ok") return { advanced: false, attempt: alone, firstCount: 0 };
      pageOne = alone.rows ?? [];
    }
    /*
     * A rule's first page has to be the first page. Pages numbered from 0
     * answer `page=1` with the second: reading on from there advances, and
     * leaves the first page's records out of every number, silently. So the
     * rule's own first record is held against the plain read's.
     */
    const startsElsewhere = (rows: readonly unknown[]): boolean =>
      rule.kind === "page" && rows.length > 0 && firstRows.length > 0 && fingerprint(rows[0]) !== fingerprint(firstRows[0]);
    if (sized && startsElsewhere(pageOne)) return { advanced: false, attempt: first, firstCount: pageOne.length, shifted: true };
    const attempt = await tryRead(connection, opId, deps, { op: { pagination: rule, maxPages: 2 } });
    const rows = attempt.kind === "ok" ? (attempt.rows ?? []) : [];
    if (!sized && startsElsewhere(rows)) return { advanced: false, attempt, firstCount: pageOne.length, shifted: true };
    const seen = new Set(pageOne.map(fingerprint));
    const later = rows.slice(pageOne.length);
    const advanced =
      attempt.kind === "ok" &&
      (attempt.meta?.pages ?? 0) >= 2 &&
      later.length > 0 &&
      later.every((row) => !seen.has(fingerprint(row)));
    return { advanced, attempt, firstCount: pageOne.length };
  };

  for (const candidate of candidates(op, first, options.proposal)) {
    let chosen: PaginationSpec | null = null;
    let rule = candidate;
    let result = await advances(rule);
    if (result.attempt.kind === "budget") break;
    /* Its first page was not the first page: the same rule, numbered from 0, or not at all. */
    if (result.shifted) {
      if (rule.kind !== "page" || rule.startsAt !== 1) continue;
      rule = { ...rule, startsAt: 0 };
      result = await advances(rule);
      if (result.attempt.kind === "budget") break;
      if (result.shifted) continue;
    }
    const { advanced, attempt, firstCount } = result;
    /*
     * A larger page held every record the API says it has: nothing is left
     * to page through, and the rule is what read them all. Sixty-eight
     * berries at a hundred a page were reported as unreadable past twenty
     * (checkpoint 2).
     */
    if (!advanced && total !== undefined && firstCount === total && firstCount > firstRows.length) {
      return {
        pagination: rule,
        maxPages: ceiling(Math.min(MAX_PAGES, 3)),
        level: "count-reconciled",
        rows: firstCount,
        pages: 1,
        ...withTotal,
        note: `All ${total} records came back in one page (${describe(rule)}), as many as the API says it holds.`,
        tried,
      };
    }
    if (advanced) chosen = rule;
    else if (attempt.kind === "ok") {
      /* A short first page may be the API's own cap, not the end: try its size. */
      const smaller = resized(rule, firstCount);
      if (smaller && (await advances(smaller)).advanced) chosen = smaller;
    }
    if (!chosen) continue;

    const confirmed = chosen;
    const limit = Math.min(options.traverseUpTo ?? 0, MAX_PAGES);
    /*
     * Larger pages, where the next address says how large and the API will
     * give more: 1,351 records followed 20 at a time took 68 pages, past the
     * most a read takes, and 351 were left out (2026-09-30). Kept only when the
     * first page really did come back larger, and the next still advanced.
     */
    let widened: { readonly name: string; readonly size: number } | null = null;
    const wider = total !== undefined && total > firstRows.length ? widerFirstPage(first.body, confirmed) : null;
    if (wider) {
      tried.push(`${describe(confirmed)}, asking for ${wider.size} a page`);
      const larger = await tryRead(connection, opId, deps, {
        op: { pagination: confirmed, maxPages: 2, query: { ...op.query, [wider.name]: String(wider.size) } },
      });
      const rows = larger.kind === "ok" ? (larger.rows ?? []) : [];
      if (larger.kind === "ok" && (larger.meta?.pages ?? 0) >= 2 && rows.length > 2 * firstRows.length) widened = wider;
    }
    const widenedQuery = widened ? { ...op.query, [widened.name]: String(widened.size) } : undefined;
    const pageSize = widened?.size ?? (firstRows.length || 1);
    const needed = total !== undefined ? Math.ceil(total / (("pageSize" in confirmed && confirmed.pageSize) || pageSize)) : undefined;
    if (limit > 2 && (needed === undefined || needed <= limit)) {
      const whole = await tryRead(connection, opId, deps, {
        op: { pagination: confirmed, maxPages: limit, ...(widenedQuery ? { query: widenedQuery } : {}) },
      });
      if (whole.kind === "ok" && whole.meta && !whole.meta.truncated && whole.meta.warnings.length === 0) {
        const read = whole.rows?.length ?? 0;
        const pages = whole.meta.pages;
        const reconciled = total !== undefined && total === read;
        return {
          pagination: confirmed,
          maxPages: ceiling(Math.min(MAX_PAGES, pages + Math.max(2, Math.ceil(pages / 2)))),
          level: reconciled ? "count-reconciled" : "traversed",
          rows: read,
          pages,
          ...withTotal,
          note: reconciled
            ? `Read all ${read} records over ${pages} page(s), as many as the API says it holds.`
            : `Read to the last page: ${read} records over ${pages} page(s).`,
          tried,
          ...(widened ? { query: { [widened.name]: String(widened.size) } } : {}),
        };
      }
    }
    /*
     * Too many pages for a check to read. Where the API says how many there
     * are, the endpoint may read as many pages as that takes; where it does
     * not, up to the ceiling — a number needs every record, and boards read
     * in the background, paced by the connection's gate. Left at the default
     * of five, 826 records were read 100 at a time, and 3,929 brewpubs 500 at
     * a time; the tile said so (checkpoint 2).
     */
    const enough = needed !== undefined && needed <= MAX_PAGES ? Math.min(MAX_PAGES, needed + 2) : MAX_PAGES;
    return {
      pagination: confirmed,
      maxPages: ceiling(enough),
      level: "advanced",
      rows: firstRows.length,
      pages: 2,
      ...withTotal,
      note: `Reading on to the next page returned different records (${describe(confirmed)}).${
        needed !== undefined && needed > limit ? ` All ${total} records would take about ${needed} pages, more than a check reads.` : ""
      }`,
      tried,
      ...(widened ? { query: { [widened.name]: String(widened.size) } } : {}),
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
