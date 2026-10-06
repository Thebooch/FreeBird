import { AdapterError, DependentAdapter, RestAdapter, type FetchMeta, type HttpFetch, type SourceAdapter } from "../adapters/index.js";
import { extractRows, parsePath } from "@freebirdai/expr";
import { getOp, pagingParamNames, resolveRange, type ConnectionSpec, type OpSpec } from "@freebirdai/connect-spec";
import { ENVELOPE_KEY } from "../discovery/openapi.js";

/**
 * One experiment: read an endpoint the way a board would, with no cache, and
 * say what happened in terms a repair can act on.
 *
 * Everything the integration loop learns about an API it learns through
 * here, so the request is exactly the one the product will send later — the
 * same adapter, the same auth, the same guard — and the budget is counted in
 * the requests that actually left, pages included.
 */

export type DiagnosisKind =
  | "ok"
  | "noRows"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "badRequest"
  | "rateLimited"
  | "notJson"
  | "missingInput"
  /** The connection has no sign-in it can send, so nothing left. */
  | "noSignIn"
  /** Somebody has to sign in with the provider (again): the one thing only they can do. */
  | "signInNeeded"
  /** The connection asks for values nobody has pasted yet. */
  | "needsCredentials"
  | "unreachable"
  | "budget"
  | "failed";

export interface Attempt {
  readonly kind: DiagnosisKind;
  /** The API's own status where it answered; 0 when it did not. */
  readonly status: number;
  readonly body?: unknown;
  readonly meta?: FetchMeta;
  /** The records at the endpoint's row path, when there is a list there. */
  readonly rows?: readonly unknown[];
  /** What the API said about a failure: markup and secrets removed. */
  readonly said?: string;
  /** One line, for the log a person can read. */
  readonly message: string;
}

/** The budget ran out: no request was sent. */
export class BudgetSpent extends Error {
  constructor() {
    super("the request budget for this check is spent");
  }
}

export interface Budget {
  /** Requests still allowed. */
  remaining: number;
  /** Requests sent so far. */
  spent: number;
}

export const budgetOf = (requests: number): Budget => ({ remaining: requests, spent: 0 });

export interface ReadDeps {
  readonly http: HttpFetch;
  readonly resolveSecret: (keyRef: string) => Promise<string | null>;
  readonly now: () => number;
  readonly budget: Budget;
  /**
   * Wraps each read: the server's per-connection gate and cooldown, so a
   * check waits its turn and stops at a rate limit like any other reader.
   */
  readonly around?: <T>(run: () => Promise<T>) => Promise<T>;
  /**
   * For an OAuth connection refused for its token: get a new one, without
   * anybody's help, and say whether that worked. The read is then tried once
   * more — the same rule boards follow (`OAuthRetryAdapter`).
   */
  readonly refresh?: (connection: ConnectionSpec) => Promise<boolean>;
  /**
   * What reads the connection. REST by default; the server's connector
   * adapter where connections can carry code, so a check reads exactly as a
   * board will. Handed the counted transport, so its requests are budgeted.
   */
  readonly adapter?: (http: HttpFetch) => SourceAdapter;
  /**
   * Waiting, for a short rate limit: an API that says "try again in 10s" is
   * waited for and the page read again by the reader (`FetchContext.sleep`),
   * rather than the check stopping there (seen with Rick and Morty's API).
   * Absent, a rate limit ends the read.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Told of each read sent, and how it went — for the journal. */
  readonly onRead?: (
    connection: ConnectionSpec,
    op: OpSpec,
    outcome: { status: "succeeded" | "failed"; upstreamStatus?: number; pages?: number },
  ) => void;
}

/** The transport, counted: each request spends one, and none leaves once it is spent. */
const counted = (http: HttpFetch, budget: Budget): HttpFetch => async (url, init, host) => {
  if (budget.remaining <= 0) throw new BudgetSpent();
  budget.remaining--;
  budget.spent++;
  return http(url, init, host);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const listOfRecords = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && isRecord(value[0]);

/**
 * A single object that holds a list of records: an envelope nobody unwrapped.
 * One level down, or two where the key between names a wrapper
 * (`_embedded.vehicles`, `d.results`).
 */
const looksLikeEnvelope = (rows: readonly unknown[]): boolean => {
  if (rows.length !== 1 || !isRecord(rows[0])) return false;
  const entries = Object.entries(rows[0]);
  /* An XML document's one top element is packaging too: `{ orders: { order: [...] } }`. */
  const soleWrapper = entries.length === 1 && isRecord(entries[0]![1]) && Object.values(entries[0]![1]).some(listOfRecords);
  return (
    soleWrapper ||
    entries.some(
      ([key, value]) =>
        listOfRecords(value) || (ENVELOPE_KEY.test(key) && isRecord(value) && Object.values(value).some(listOfRecords)),
    )
  );
};

export const rowsOf = (body: unknown, rowsPath: string | undefined): unknown[] => {
  try {
    return extractRows(parsePath(rowsPath ?? "$"), body);
  } catch {
    return [];
  }
};

const ERROR_ROOT = /^(error|errors|fault|exception)$|(error|fault|exception)(_?response|_?result)?$/i;
const MESSAGE_KEY = /^(message|text|description|detail|details|reason|error|faultstring|title)$/i;
const FAILED_VALUE = /^(error|errors|fail|failed|failure)$/i;

/** The first sentence an error answer says about itself, a few levels down. */
const messageIn = (node: unknown, depth = 0): string | null => {
  if (typeof node === "string") return node.trim() === "" ? null : node.trim();
  if (depth > 4 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.length > 0 ? messageIn(node[0], depth + 1) : null;
  const entries = Object.entries(node);
  for (const [key, value] of entries) if (MESSAGE_KEY.test(key) && typeof value === "string" && value.trim() !== "") return value.trim();
  for (const [, value] of entries) {
    const found = typeof value === "string" ? null : messageIn(value, depth + 1);
    if (found) return found;
  }
  return null;
};

const holdsRecords = (node: unknown, depth = 0): boolean => {
  if (listOfRecords(node)) return true;
  if (depth > 3 || !isRecord(node)) return false;
  return Object.values(node).some((value) => holdsRecords(value, depth + 1));
};

/**
 * What an answer that is only an error says, whatever its status — or null
 * when it is not one.
 *
 * - GraphQL: `{ errors: [...] }` with no `data`.
 * - One top element named for an error (`ErrorResponse`, `error`, `Fault`):
 *   what an XML API answers with a 200, once XML is read at all.
 * - An answer that says of itself that it failed (`success: false`,
 *   `status: "error"`, `resultCode: "Error"`) and holds no records.
 *
 * Read as one record, each of these made an endpoint nothing had read look
 * ready: a record type of "error responses" was described and offered
 * (2026-09-30).
 */
const onlyErrors = (body: unknown): string | null => {
  if (!isRecord(body)) return null;
  const answer = body as { errors?: unknown; data?: unknown };
  if (Array.isArray(answer.errors) && answer.errors.length > 0 && (answer.data === undefined || answer.data === null)) {
    const first = answer.errors[0] as { message?: unknown } | string;
    const said = typeof first === "string" ? first : typeof first?.message === "string" ? first.message : JSON.stringify(first);
    return said.slice(0, 300);
  }
  if (holdsRecords(body)) return null;
  const entries = Object.entries(body);
  const sole = entries.length === 1 ? entries[0]![1] : undefined;
  const named =
    entries.length === 1 &&
    ERROR_ROOT.test(entries[0]![0]) &&
    sole !== null &&
    sole !== false &&
    sole !== "" &&
    !(Array.isArray(sole) && sole.length === 0);
  const failed = (node: unknown, depth: number): boolean =>
    isRecord(node) &&
    (node.success === false ||
      node.ok === false ||
      ["status", "resultCode", "result", "result_code"].some((key) => typeof node[key] === "string" && FAILED_VALUE.test(node[key] as string)) ||
      (depth < 2 && Object.values(node).some((value) => failed(value, depth + 1))));
  if (named) return (messageIn(body) ?? "The API answered with an error.").slice(0, 300);
  /*
   * A record can have failed without the answer being a failure: a payment
   * whose status is "failed" is a record. So only an answer that is small,
   * names no record, and says why.
   */
  const aRecord = entries.length > 8 || entries.some(([key]) => /^(id|uuid)$|_id$|Id$/.test(key));
  const said = messageIn(body);
  return !aRecord && said && failed(body, 0) ? said.slice(0, 300) : null;
};

export const tryRead = async (
  connection: ConnectionSpec,
  opId: string,
  deps: ReadDeps,
  change: {
    readonly op?: Partial<OpSpec>;
    /** Values sent as a widget sends its own: where the endpoint takes each, and in connector code's `ctx.inputs`. */
    readonly overrides?: Readonly<Record<string, string | number | boolean>>;
  } = {},
): Promise<Attempt> => {
  const base = getOp(connection, opId);
  if (!base) return { kind: "failed", status: 0, message: `no endpoint "${opId}"` };
  /*
   * A paging rule tried in place of the endpoint's own sets its own
   * parameters; whatever the endpoint sends for them by default steps aside,
   * as it does once the rule is installed (see `resolveOp`).
   */
  const owned = new Set(change.op?.pagination ? pagingParamNames(change.op.pagination) : []);
  const query = Object.fromEntries(Object.entries(base.query).filter(([name]) => !owned.has(name)));
  const op: OpSpec = { ...base, query, ...change.op };
  const now = deps.now();
  /* Values a connector's sign-in needs that nobody has given: nothing to send yet. */
  if (connection.auth.type === "connector") {
    const missing: string[] = [];
    for (const credential of connection.auth.credentials)
      if (!(await deps.resolveSecret(credential.keyRef))) missing.push(credential.label ?? credential.name);
    if (missing.length > 0)
      return {
        kind: "needsCredentials",
        status: 0,
        message: `${op.title}: waiting for ${missing.join(" and ")}`,
      };
  }
  try {
    const refresh = deps.refresh;
    const counting = counted(deps.http, deps.budget);
    /* An input another endpoint's records supply is read as a board will read it (`ParamDef.valueFrom`). */
    const adapter = new DependentAdapter(deps.adapter ? deps.adapter(counting) : new RestAdapter(counting));
    const send = () =>
      adapter.fetch(connection, op, change.overrides ?? {}, {
        params: { range: resolveRange({ preset: "30d", now }), filters: {} },
        now,
        resolveSecret: deps.resolveSecret,
        /* A short rate limit part-way through is waited out, as boards do. */
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        /* A token refused part-way through is renewed and the page read again, as boards do. */
        ...(refresh && connection.auth.type === "oauth2" ? { renew: () => refresh(connection) } : {}),
      });
    const result = await (deps.around ? deps.around(send) : send());
    deps.onRead?.(connection, op, { status: "succeeded", upstreamStatus: result.meta.status, pages: result.meta.pages });
    /*
     * An answer that is only an error, whatever its status: GraphQL answers
     * 200 with `errors` and no `data`. Read as one record, it made a check of
     * an endpoint nothing had read say "ready" (2026-09-30).
     */
    const refused = onlyErrors(result.body);
    if (refused)
      return {
        kind: "failed",
        status: result.meta.status,
        body: result.body,
        message: `${op.title}: the API answered with an error: ${refused}`,
        said: refused,
      };
    const rows = rowsOf(result.body, op.rowsPath);
    return {
      kind: looksLikeEnvelope(rows) ? "noRows" : "ok",
      status: result.meta.status,
      body: result.body,
      meta: result.meta,
      rows,
      message: `${op.title}: ${rows.length} record(s) on ${result.meta.pages} page(s)`,
    };
  } catch (error) {
    if (error instanceof BudgetSpent) return { kind: "budget", status: 0, message: error.message };
    if (!(error instanceof AdapterError)) {
      const text = error instanceof Error ? error.message : String(error);
      return { kind: "unreachable", status: 0, message: `${op.title}: could not reach the API (${text})` };
    }
    const upstream = error.upstreamStatus ?? 0;
    if (upstream > 0) deps.onRead?.(connection, op, { status: "failed", upstreamStatus: upstream });
    const said = error.detail;
    const kind: DiagnosisKind =
      /authentication configured/i.test(error.message)
        ? "noSignIn"
        : /sign-in needed/i.test(error.message) || (error.status === 401 && connection.auth.type === "oauth2")
          ? "signInNeeded"
        : error.status === 401
        ? "unauthorized"
        : error.status === 403
          ? "forbidden"
          : error.status === 429
            ? "rateLimited"
            : upstream === 404 || upstream === 405 || upstream === 410
              ? "notFound"
              : upstream === 400 || upstream === 422
                ? "badRequest"
                : /not JSON/i.test(error.message)
                  ? "notJson"
                  : /unresolved|needs a value|needs its address/i.test(error.message)
                    ? "missingInput"
                    : "failed";
    return {
      kind,
      status: upstream,
      ...(said ? { said } : {}),
      message: `${op.title}: ${error.userMessage}${said ? ` — the API said: ${said}` : ""}`,
    };
  }
};
