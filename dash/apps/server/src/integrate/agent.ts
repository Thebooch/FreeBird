import { McpAdapter, type HttpFetch } from "@freebirdai/dash-adapters";
import { proposeRepair, type LlmAdapter } from "@freebirdai/dash-agent";
import {
  authCredentials,
  connectionNeedsAddress,
  evidenceSchema,
  fingerprintConnection,
  getOp,
  opUsesRange,
  pagingParamNames,
  pathParamNames,
  readField,
  type AuthCredential,
  type AuthSpec,
  type CatalogEntry,
  type ConnectionSpec,
  type Evidence,
  type EvidenceLevel,
  type PaginationSpec,
  type ResourceSpec,
} from "@freebirdai/dash-spec";
import {
  INTROSPECTION_QUERY,
  SHALLOW_INTROSPECTION_QUERY,
  graphqlReads,
  introspectByType,
  parseIntrospection,
} from "../discovery/graphql.js";
import { signInGapNotes } from "../discovery/openapi.js";
import { cursorPaths, nextAddressPaths, probePagination, reportedTotal, saysMore } from "../discovery/probe-pagination.js";
import { authorConnector, connectorReader, stoppedShort, type ConnectorKit } from "./connector.js";
import { countCandidates, countIn } from "./count.js";
import { docsKnowledge } from "./docs.js";
import { observedShape, type ObservedShape } from "./observed.js";
import { seenValues, uniqueFields, type SeenSet } from "./values.js";
import { applyPatch, describePatch, sameSite, type ConnectionPatch } from "./patch.js";
import { BudgetSpent, budgetOf, rowsOf, tryRead, type Attempt, type DiagnosisKind, type ReadDeps } from "./read.js";
import { McpError, openMcpClient } from "../mcp/client.js";
import { toolOps } from "../mcp/discover.js";
import { DEFAULT_STRATEGIES, type RepairStrategy } from "./strategies.js";

/** Pages a list is read to its end under one filter, to check a count against. */
const COUNT_CHECK_PAGES = 10;

/**
 * The integration loop: discover → propose → execute → inspect → repair →
 * verify, over one connection.
 *
 * Given a connection made from documentation and the credentials somebody
 * pasted, it reads the endpoints that matter the way a board will, and when a
 * read fails it does what a developer would: tries the address the docs
 * name, the other ways a key is sent, the header the API asked for, where the
 * records really are — keeping a change only when a real request then gets
 * further. When nothing built-in works it asks a model for one change, with
 * the same rule. Then it confirms how each endpoint pages by reading its
 * second page, and records what was observed as evidence.
 *
 * It asks a person nothing; what only a person can give — an account address,
 * consent, what a word means to them — is not its to guess, and a connection
 * that needs one is reported as blocked, with the reason in plain words.
 * Every request counts against a budget, every change is logged, and nothing
 * is written anywhere: the caller decides whether to keep the result.
 */

export interface IntegrateDeps {
  readonly http: HttpFetch;
  readonly resolveSecret: (keyRef: string) => Promise<string | null>;
  readonly fetchDocument: (url: string) => Promise<{ status: number; text: string; url: string }>;
  readonly now: () => number;
  /** For the last-resort repair. Absent means built-in repairs only. */
  readonly llm?: LlmAdapter | null | undefined;
  /** Replaces the built-in repairs. See `strategies.ts`. */
  readonly strategies?: readonly RepairStrategy[] | undefined;
  readonly workspace?: string | undefined;
  /** Wraps each read — the server's gate and cooldown. See `ReadDeps.around`. */
  readonly around?: (<T>(run: () => Promise<T>) => Promise<T>) | undefined;
  /** Told of each read the check sends. See `ReadDeps.onRead`. */
  readonly onRead?: ReadDeps["onRead"];
  /** A new token after a refusal. See `ReadDeps.refresh`. */
  readonly refresh?: ReadDeps["refresh"];
  /** Waiting out a short rate limit. Absent, a rate limit ends a read. */
  readonly sleep?: ReadDeps["sleep"];
  /**
   * Running connector code: the sandbox and where its tokens are kept. With it,
   * every read goes through the connector adapter — as a board's does — and an
   * API no repair can express gets connector code written for it. Without it,
   * the loop repairs within the connection's own vocabulary only.
   */
  readonly connectors?: ConnectorKit | undefined;
  /** The model that writes connector code, when it is not `llm`. */
  readonly connectorLlm?: LlmAdapter | null | undefined;
}

export interface IntegrateOptions {
  /** Endpoints to settle, the most important first. The first decides whether the connection works. */
  readonly targets: readonly string[];
  readonly entry?: CatalogEntry | null | undefined;
  readonly docsUrl?: string | undefined;
  /** Requests to the API, pages included. */
  readonly requests?: number | undefined;
  readonly modelCalls?: number | undefined;
  /** Read a collection to its end to confirm it when it takes no more pages than this. */
  readonly traverseUpTo?: number | undefined;
  /** Times connector code may be written and tried for the first endpoint. */
  readonly connectorAttempts?: number | undefined;
  /**
   * More collections to read one first page of — no repairs, no paging —
   * for the fields their documentation never declared, with a budget of
   * their own (`sampleRequests`). The check settles a handful of endpoints;
   * an API documented in prose may have fifty collections, and one never
   * read is one no request can ever reach (checkpoint 2).
   */
  readonly sample?: readonly string[] | undefined;
  readonly sampleRequests?: number | undefined;
}

export interface OpOutcome {
  readonly op: string;
  readonly title: string;
  readonly outcome: "ready" | "blocked" | "skipped";
  readonly level?: EvidenceLevel;
  readonly note: string;
}

export interface IntegrationReport {
  readonly connection: ConnectionSpec;
  readonly changed: boolean;
  /** Each change kept, in words. */
  readonly changes: readonly string[];
  readonly ops: readonly OpOutcome[];
  readonly evidence: readonly Evidence[];
  readonly outcome: "ready" | "partial" | "blocked";
  /** Why the connection does not work yet, when it does not. */
  readonly blocked?: string;
  /** Everything tried, in order. */
  readonly log: readonly string[];
  readonly requests: number;
  readonly modelCalls: number;
  /**
   * Values the connection now asks for that nobody has pasted: set when
   * connector code declared a sign-in the connection did not have. The
   * person is asked for these, and the next check tries the code.
   */
  readonly needsCredentials?: readonly AuthCredential[];
  /**
   * What each endpoint that read showed of its records: where they are and
   * the name and kind of each field — never their values. For endpoints the
   * documentation declared no fields for, the only account there is.
   */
  readonly observed: Readonly<Record<string, ObservedShape>>;
  /**
   * The values each endpoint's records held, where a field holds a small set
   * (`values.ts`), and whether the read saw every record. This account's
   * data: kept per connection, never on the catalog entry the shapes above go to.
   */
  readonly values: Readonly<Record<string, SeenSet>>;
  /**
   * Reads written from a GraphQL schema the API answered with, and the
   * endpoint each set replaced: for the catalog entry, where record types are
   * described from its reads (plan, track A).
   */
  readonly added?: {
    readonly ops: readonly CatalogEntry["ops"][number][];
    readonly resources: readonly ResourceSpec[];
    readonly replaced: readonly string[];
  };
}

/** Filter parameters tried per endpoint: each is one request. */
const MAX_FILTER_TRIES = 6;

/** Fields a filter by never narrows to a kind of record: identities and names. */
const FILTER_NEVER = /(^|[._])(id|ids|uuid|guid|name|title|description|email|phone|url|slug|sku)$|Ids?$/i;

/** What sampling other collections' first pages may spend, apart from the check's own requests. */
const SAMPLE_REQUESTS = 40;

const squash = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whether a parameter's name says it narrows by a field — `by_state` and
 * `state`, `filter[status]` and `status`, `by_type` and `brewery_type`. Only
 * what to try: a read decides.
 */
const filtersByName = (param: string, field: string): boolean => {
  const core = squash(param).replace(/^(filterby|filter|where|by)/, "").replace(/(equals|eq)$/, "");
  if (core.length < 2) return false;
  const whole = squash(field);
  const last = squash(field.split(/[._]/).pop() ?? field);
  return [whole, last, `${whole}s`, `${last}s`].includes(core);
};

const sameWord = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const mostCommon = (values: readonly string[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
};

/** How much further a read got. A change is kept only when it moves a read up this list. */
const PROGRESS: Record<DiagnosisKind, number> = {
  ok: 7,
  noRows: 6,
  forbidden: 5,
  badRequest: 4,
  missingInput: 4,
  rateLimited: 3,
  noSignIn: 0,
  signInNeeded: 0,
  needsCredentials: 0,
  unauthorized: 3,
  notFound: 1,
  notJson: 1,
  unreachable: 1,
  failed: 0,
  budget: -1,
};

/** Page sizes APIs default to; a first page of exactly this many is probably not all of it. */
const ROUND_SIZES = new Set([10, 20, 25, 30, 50, 100, 200, 250, 500, 1000]);
/** A parameter that pages, by any of its usual names. */
const PAGING_NAME = /^(page|page_?(number|size|token)|per_?page|offset|skip|limit|cursor|after|starting_?after|next|start|size|count|continuation)$/i;

const BLOCKED_WORDS: Partial<Record<DiagnosisKind, string>> = {
  unauthorized: "The API refused the key, whichever way it was sent. Check the key, and how its documentation says to send it.",
  forbidden: "The API recognised the key but will not allow this endpoint. The account may not have access to it.",
  notFound: "No address tried answered for this endpoint.",
  notJson: "The API answered with something other than data.",
  unreachable: "The API could not be reached.",
  rateLimited: "The API asked us to wait. Try again later.",
  missingInput: "This endpoint needs a value a board cannot supply by itself.",
  noSignIn: "The documentation does not describe a sign-in Dash can send, so no request was made.",
  signInNeeded: "Sign in with the service to finish connecting it. The check runs again by itself once you have.",
  budget: "The check used up its requests before finishing.",
};

/** A model's proposal, as a change: only fields the connection already has, only to the same organisation. */
const patchFromProposal = (
  proposal: {
    baseUrl?: string | undefined;
    authStyle?: string | undefined;
    authName?: string | undefined;
    authPrefix?: string | undefined;
    headerName?: string | undefined;
    headerValue?: string | undefined;
    rowsPath?: string | undefined;
    inputs?: readonly { readonly name: string; readonly value: string }[] | undefined;
  },
  connection: ConnectionSpec,
  opId: string,
  docsUrl: string | undefined,
): ConnectionPatch | null => {
  const patch: {
    baseUrl?: string;
    auth?: AuthSpec;
    headers?: Record<string, string>;
    ops?: Record<string, { rowsPath?: string; inputs?: Record<string, string | number | boolean> }>;
  } = {};
  if (proposal.baseUrl) {
    try {
      const host = new URL(proposal.baseUrl).hostname;
      const known = [connection.baseUrl, docsUrl].flatMap((url) => {
        try {
          return url ? [new URL(url).hostname] : [];
        } catch {
          return [];
        }
      });
      if (proposal.baseUrl.startsWith("https://") && known.some((one) => sameSite(one, host)))
        patch.baseUrl = proposal.baseUrl.replace(/\/+$/, "");
    } catch {
      /* not an address */
    }
  }
  const auth = connection.auth;
  if (proposal.authStyle && (auth.type === "bearer" || auth.type === "header" || auth.type === "query")) {
    const keyRef = auth.keyRef;
    if (proposal.authStyle === "bearer") patch.auth = { type: "bearer", keyRef };
    else if (proposal.authStyle === "header" && proposal.authName)
      patch.auth = {
        type: "header",
        header: proposal.authName,
        keyRef,
        ...(proposal.authPrefix ? { template: `${proposal.authPrefix.trim()} {{key}}` } : {}),
      };
    else if (proposal.authStyle === "query" && proposal.authName)
      patch.auth = { type: "query", param: proposal.authName, keyRef };
  }
  if (proposal.headerName && proposal.headerValue) patch.headers = { [proposal.headerName]: proposal.headerValue };
  if (proposal.rowsPath && proposal.rowsPath.startsWith("$")) patch.ops = { [opId]: { rowsPath: proposal.rowsPath } };
  /*
   * Values a read must send, from the documentation: never a template, never
   * the parameter the key goes in, and never one the paging rule sets.
   */
  const op = getOp(connection, opId);
  const reserved = new Set([
    ...(op ? pagingParamNames(op.pagination) : []),
    ...(auth.type === "query" ? [auth.param] : []),
    ...pathParamNames(op?.path ?? ""),
  ]);
  const inputs: Record<string, string | number | boolean> = {};
  for (const one of proposal.inputs ?? []) {
    const name = one.name.trim();
    const value = one.value.trim();
    if (!/^[A-Za-z_][\w.[\]-]{0,80}$/.test(name) || reserved.has(name)) continue;
    if (value === "" || value.length > 500 || value.includes("{{")) continue;
    inputs[name] = /^-?\d{1,15}$/.test(value) ? Number(value) : value === "true" || value === "false" ? value === "true" : value;
  }
  if (Object.keys(inputs).length > 0) patch.ops = { [opId]: { ...(patch.ops?.[opId] ?? {}), inputs } };
  return Object.keys(patch).length > 0 ? patch : null;
};

/** The request as configured, for a model: addresses, names and constants — never a secret. */
const describeRequest = (connection: ConnectionSpec, opId: string): string => {
  const op = getOp(connection, opId);
  const auth = connection.auth;
  const how =
    auth.type === "bearer"
      ? "a bearer token in the Authorization header"
      : auth.type === "header"
        ? `the key in the ${auth.header} header${auth.template ? ` as "${auth.template.replace("{{key}}", "<key>")}"` : ""}`
        : auth.type === "query"
          ? `the key as the ${auth.param} query parameter`
          : auth.type === "basic"
            ? "HTTP Basic with a username and password"
            : auth.type === "headers"
              ? `keys in ${auth.parts.map((part) => part.header).join(", ")}`
              : "no key";
  /* What the endpoint takes, and what it sends already: a missing search is only visible here. */
  const params = (op?.params ?? [])
    .map(
      (param) =>
        `${param.name} (${param.in}${param.required ? ", required" : ""}${param.default !== undefined ? `, default ${String(param.default)}` : ""})`,
    )
    .join(", ");
  const sent = Object.entries(op?.query ?? {})
    .map(([name, value]) => `${name}=${String(value)}`)
    .join("&");
  const body =
    op?.body?.type === "json"
      ? `JSON ${JSON.stringify(op.body.template ?? {}).slice(0, 300)}`
      : op?.body?.type === "graphql"
        ? `GraphQL ${op.body.query.slice(0, 300)}`
        : op?.body?.type === "form"
          ? `form ${JSON.stringify(op.body.template).slice(0, 300)}`
          : op?.body?.type === "xml"
            ? `XML ${op.body.template.slice(0, 400)}`
            : "";
  return [
    `${op?.method ?? "GET"} ${connection.baseUrl ?? ""}${op?.path ?? ""}${sent ? `?${sent}` : ""}`,
    `Sign-in: ${how}.`,
    `Headers sent: ${Object.keys(op?.headers ?? {}).join(", ") || "none"}.`,
    ...(params ? [`Parameters: ${params}.`] : []),
    ...(body ? [`Body: ${body}`] : []),
    `Records read at: ${op?.rowsPath ?? "$"}.`,
  ].join("\n");
};

/**
 * Reads through an MCP server's tools, one session for the whole check: the
 * transport it is handed is the counted one, so its calls spend the budget.
 */
const mcpReader = (resolveSecret: IntegrateDeps["resolveSecret"]): NonNullable<ReadDeps["adapter"]> => {
  let latest: HttpFetch | null = null;
  const adapter = new McpAdapter((connection) =>
    openMcpClient(connection, { http: (url, init, host) => latest!(url, init, host), resolveSecret }),
  );
  return (http) => {
    latest = http;
    return adapter;
  };
};

export const integrate = async (
  initial: ConnectionSpec,
  options: IntegrateOptions,
  deps: IntegrateDeps,
): Promise<IntegrationReport> => {
  let connection = initial;
  const budget = budgetOf(options.requests ?? 60);
  const readDeps: ReadDeps = {
    http: deps.http,
    resolveSecret: deps.resolveSecret,
    now: deps.now,
    budget,
    ...(initial.kind === "mcp"
      ? { adapter: mcpReader(deps.resolveSecret) }
      : deps.connectors
        ? { adapter: connectorReader(deps.connectors) }
        : {}),
    ...(deps.around ? { around: deps.around } : {}),
    ...(deps.onRead ? { onRead: deps.onRead } : {}),
    ...(deps.refresh ? { refresh: deps.refresh } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
  const docsUrl = options.docsUrl ?? options.entry?.docsUrl;
  const docs = docsKnowledge({
    docsUrl,
    specUrl: options.entry?.specUrl,
    known: [options.entry?.keyHelp, options.entry?.notes].filter((one): one is string => !!one),
    fetchDocument: deps.fetchDocument,
  });
  const strategies = deps.strategies ?? DEFAULT_STRATEGIES;
  const maxModelCalls = options.modelCalls ?? 3;
  const log: string[] = [];
  const changes: string[] = [];
  const tried = new Set<string>([fingerprintConnection(connection)]);
  let modelCalls = 0;
  let cannot: string | null = null;
  const plain = { op: { pagination: { kind: "none" } as PaginationSpec, maxPages: 1 } };

  const keep = (next: ConnectionSpec, because: string, patch: ConnectionPatch) => {
    connection = next;
    const titleOf = (op: string) => getOp(next, op)?.title ?? op;
    changes.push(`${because.replace(/[.\s]+$/, "")} — ${describePatch(patch, titleOf)}`);
  };

  /** Try one change; keep it when the read gets further. */
  const attemptChange = async (
    patch: ConnectionPatch,
    because: string,
    opId: string,
    current: Attempt,
  ): Promise<Attempt | null> => {
    const next = applyPatch(connection, patch);
    if (!next) return null;
    const key = fingerprintConnection(next);
    if (tried.has(key)) return null;
    tried.add(key);
    const again = await tryRead(next, opId, readDeps, plain);
    log.push(`Tried ${describePatch(patch, (op) => getOp(next, op)?.title ?? op)} (${because}): ${again.message}`);
    if (PROGRESS[again.kind] > PROGRESS[current.kind]) {
      keep(next, because, patch);
      return again;
    }
    return again.kind === "budget" ? again : null;
  };

  /*
   * Connector code, when nothing in the connection's own vocabulary can work:
   * written from the documentation, proven by a read, kept only when that read
   * returns records. Once per check — it has its own attempts inside.
   */
  let authoring = 0;
  const escalate = async (opId: string, attempt: Attempt, reason?: string): Promise<Attempt | null> => {
    const writer = deps.connectorLlm ?? deps.llm;
    if (!deps.connectors || !writer || authoring > 0) return null;
    authoring++;
    const gaps = attempt.kind === "noSignIn" ? signInGapNotes(await docs.spec()).join(" ") : "";
    const problem = [reason, gaps, attempt.message].filter((one): one is string => !!one).join(" ");
    const authored = await authorConnector({
      connection,
      opId,
      problem,
      docs,
      docsUrl,
      llm: writer,
      kit: deps.connectors,
      read: readDeps,
      attempts: options.connectorAttempts ?? 3,
      now: deps.now,
    });
    modelCalls += authored.modelCalls;
    log.push(...authored.log);
    if (authored.cannot) cannot = authored.cannot;
    if (!authored.connection || !authored.patch) return null;
    tried.add(fingerprintConnection(authored.connection));
    keep(authored.connection, authored.because ?? "connector code", authored.patch);
    return authored.attempt;
  };

  /** Read one endpoint and repair until it reads, or nothing more helps. */
  /* Whether reading without a key has been tried, where the specification declared none. */
  let anonymousTried = false;
  const settle = async (opId: string, repairConnection: boolean): Promise<Attempt> => {
    let attempt = await tryRead(connection, opId, readDeps, plain);
    log.push(attempt.message);
    /*
     * A read through connector code that stopped short is not done, and nor is
     * one that returned nothing: its code is revised like a failure. Code
     * written before the key was pasted is proven only once it is, and an
     * export it gave up waiting on answered with no records, which the check
     * then took as an empty account (2026-09-30, vaultbank).
     */
    const emptyFromCode = (current: Attempt): boolean =>
      current.kind === "ok" &&
      (current.rows?.length ?? 0) === 0 &&
      getOp(connection, opId)?.servedBy === "connector";
    for (
      let round = 0;
      round < 8 && (attempt.kind !== "ok" || stoppedShort(connection, opId, attempt) || emptyFromCode(attempt));
      round++
    ) {
      /*
       * Nothing a repair here can change: a rate limit, a refusal of access,
       * a person who must sign in, or values nobody has pasted yet. Asking a
       * model about any of them spends calls to learn what is known.
       */
      if (["budget", "rateLimited", "forbidden", "signInNeeded", "needsCredentials"].includes(attempt.kind)) break;
      /*
       * Code already runs this connection: what failed is the code, and the
       * fix is a revision of it — not a header or an address around it.
       */
      if (connection.connector && repairConnection) {
        const revised = await escalate(
          opId,
          attempt,
          stoppedShort(connection, opId, attempt)
            ? "The connector code that reads this stopped before the end of its records."
            : emptyFromCode(attempt)
              ? "The connector code that reads this ran without error but produced no records, and the documentation describes records here."
              : "The connector code that reads this failed.",
        );
        if (!revised) break;
        attempt = revised;
        continue;
      }
      /*
       * A sign-in the connection cannot send, or an endpoint whose ids come
       * from other requests: not a repair, but perhaps code. An address only
       * the person knows is neither.
       */
      /*
       * A sign-in nobody declared: the specification named none, so the API
       * may simply answer. Tried once without a key, and kept only if records
       * come back — a refusal means a key is needed after all. A public API
       * had connector code written for it, for want of trying (checkpoint 2).
       */
      if (
        attempt.kind === "noSignIn" &&
        connection.auth.type === "none" &&
        connection.authRequired &&
        !anonymousTried &&
        /* Only where nothing was declared: a declared sign-in no connection can send is code's to do. */
        signInGapNotes(await docs.spec()).length === 0
      ) {
        anonymousTried = true;
        const patch: ConnectionPatch = { authRequired: false };
        const open = applyPatch(connection, patch);
        const again = open ? await tryRead(open, opId, readDeps, plain) : null;
        if (open && again) log.push(`Tried reading without signing in: ${again.message}`);
        if (open && again?.kind === "ok") {
          keep(open, "The API answered without signing in", patch);
          attempt = again;
          continue;
        }
      }
      const needsIds =
        attempt.kind === "missingInput" &&
        !connectionNeedsAddress(connection) &&
        pathParamNames(getOp(connection, opId)?.path ?? "").length > 0;
      if (attempt.kind === "noSignIn" || needsIds) {
        const written = repairConnection ? await escalate(opId, attempt) : null;
        if (!written) break;
        attempt = written;
        continue;
      }
      /*
       * A value no board supplies — a search, a start time — is not an id: the
       * documentation says what to send to read everything, and a model reads
       * it (below). An id of one record is code's, above.
       */
      const op = getOp(connection, opId)!;
      let improved: Attempt | null = null;
      for (const strategy of strategies) {
        if (!strategy.handles.includes(attempt.kind)) continue;
        if (!repairConnection && strategy.id !== "rows-path") continue;
        for (const candidate of await strategy.propose({ connection, op, attempt, docs, docsUrl })) {
          const result = await attemptChange(candidate.patch, candidate.because, opId, attempt);
          if (result?.kind === "budget") return result;
          if (result) {
            improved = result;
            break;
          }
        }
        if (improved) break;
      }
      if (improved) {
        attempt = improved;
        continue;
      }
      /* Nothing built-in helped: one change from a model, with the same rule. */
      if (!deps.llm || modelCalls >= maxModelCalls || !repairConnection) break;
      modelCalls++;
      const answer = await proposeRepair(deps.llm, {
        apiTitle: connection.title,
        request: describeRequest(connection, opId),
        failure: attempt.message,
        tried: log.filter((line) => line.startsWith("Tried ")).slice(-8),
        docs: await docs.text(),
      });
      if ("error" in answer) {
        log.push(`Asked a model for a repair; ${answer.error}`);
        break;
      }
      if (answer.proposal.cannot) {
        cannot = answer.proposal.cannot;
        log.push(`A model read the documentation and found this cannot be expressed: ${cannot}`);
        const written = await escalate(opId, attempt, cannot);
        if (!written) break;
        attempt = written;
        continue;
      }
      const patch = patchFromProposal(answer.proposal, connection, opId, docsUrl);
      if (!patch) {
        log.push("A model proposed a change that is not allowed here; it was not tried.");
        break;
      }
      const result = await attemptChange(patch, `a model's reading: ${answer.proposal.reason}`, opId, attempt);
      if (result?.kind === "budget") return result;
      if (result) attempt = result;
    }
    return attempt;
  };

  interface Observed {
    readonly op: string;
    readonly level: EvidenceLevel;
    readonly rows: number;
    readonly pages: number;
    readonly reportedTotal?: number;
    readonly pagination?: PaginationSpec;
    readonly note: string;
    readonly by: Evidence["by"];
    readonly maxPages: number;
  }
  const observed: Observed[] = [];
  const outcomes: OpOutcome[] = [];
  const shapes: Record<string, ObservedShape> = {};
  const values: Record<string, SeenSet> = {};

  /** Confirm how an endpoint that read pages, when there is reason to think it does. */
  const confirmPaging = async (opId: string, first: Attempt): Promise<void> => {
    const op = getOp(connection, opId)!;
    const rows = first.rows?.length ?? 0;
    const stated = reportedTotal(first.body);
    const unconfirmed = !op.paginationChecked;
    const worth =
      unconfirmed &&
      ((connection.paginationPending && op.pagination.kind === "none") ||
        op.pagination.kind !== "none" ||
        (stated !== undefined && stated > rows) ||
        /* The answer names a next page, or says outright there is more. */
        (rows > 0 && (nextAddressPaths(first.body).length > 0 || saysMore(first.body))) ||
        (rows >= 10 && (cursorPaths(first.body).length > 0 || ROUND_SIZES.has(rows))));
    if (!worth) return;
    const proposal =
      op.pagination.kind !== "none" ? op.pagination : (options.entry?.paginationProposal ?? undefined);
    const probe = await probePagination(connection, opId, readDeps, {
      proposal,
      traverseUpTo: options.traverseUpTo ?? 20,
      first,
    });
    log.push(`Paging for ${op.title}: ${probe.note}${probe.tried.length > 0 ? ` (tried ${probe.tried.join("; ")})` : ""}`);
    if (probe.level && probe.level !== "accepted") {
      observed.push({
        op: opId,
        level: probe.level,
        rows: probe.rows,
        pages: probe.pages,
        ...(probe.reportedTotal !== undefined ? { reportedTotal: probe.reportedTotal } : {}),
        ...(probe.pagination ? { pagination: probe.pagination } : {}),
        note: probe.note,
        by: "probe",
        maxPages: probe.maxPages ?? op.maxPages,
      });
    }
    if (probe.pagination) {
      const patch: ConnectionPatch = {
        ops: {
          [opId]: {
            pagination: probe.pagination,
            paginationChecked: true,
            ...(probe.maxPages ? { maxPages: probe.maxPages } : {}),
            /* A larger page the probe asked for, sent with the first request from now on. */
            ...(probe.query ? { inputs: probe.query } : {}),
          },
        },
      };
      const next = applyPatch(connection, patch);
      if (next) keep(next, probe.note, patch);
      return;
    }
    /*
     * Nothing read a second page, and nothing says there is one: the endpoint
     * takes none of the parameters the documentation pages with (the rule was
     * another endpoint's), the answer names no total above what came back, no
     * next page and no "more", and it is not a page-sized answer. Confirmed as
     * one page, rather than warned about on every tile for ever — a CSV export
     * of 96 subscribers said "only the first page was read" (2026-09-30).
     */
    const proposed = proposal ? pagingParamNames(proposal) : [];
    const takesPaging = op.params.some((param) => proposed.includes(param.name) || PAGING_NAME.test(param.name));
    if (
      probe.level === "accepted" &&
      op.pagination.kind === "none" &&
      !takesPaging &&
      rows > 0 &&
      !ROUND_SIZES.has(rows) &&
      (stated === undefined || stated <= rows) &&
      !saysMore(first.body) &&
      nextAddressPaths(first.body).length === 0 &&
      cursorPaths(first.body).length === 0
    ) {
      const patch: ConnectionPatch = { ops: { [opId]: { pagination: { kind: "none" }, paginationChecked: true } } };
      const next = applyPatch(connection, patch);
      if (next) keep(next, "It takes no paging parameter and its answer names no further page: read as one page", patch);
    }
  };

  /*
   * Which of an endpoint's parameters narrow its records by a field, found by
   * asking: the parameter is sent with a value the first page held, and kept
   * only if every record comes back holding it — while the unnarrowed page
   * held others. Its name only chooses what to try. Once confirmed, a number
   * narrowed to one value asks the API for those records alone, where it read
   * five pages of 11,848 to count 295 before (checkpoint 2).
   */
  const confirmFilters = async (opId: string, first: Attempt, shape: ObservedShape): Promise<void> => {
    const op = getOp(connection, opId);
    if (!op) return;
    const rows = rowsOf(first.body, shape.rowsPath);
    if (rows.length < 2) return;
    const paging = new Set(pagingParamNames(op.pagination));
    const confirmed: Record<string, string> = {};
    /*
     * Which to try, and in what order: a parameter matching a field by name,
     * never an id or a name — a filter by one of those finds one record, not
     * a kind of record — and fields whose values repeat most first. Tried in
     * the order documented, four ids and names used the tries before the type
     * of brewery was reached (checkpoint 2).
     */
    const heldBy = (path: string) =>
      rows
        .map((row) => readField(row, path))
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 60);
    const worth = op.params
      .filter(
        (param) =>
          param.in === "query" &&
          !param.filters &&
          !param.required &&
          !paging.has(param.name) &&
          op.query[param.name] === undefined &&
          (param.type === "string" || param.type === "array"),
      )
      .flatMap((param) => {
        const field = shape.fields.find(
          (one) =>
            one.kinds.includes("string") &&
            !FILTER_NEVER.test(one.name) &&
            filtersByName(param.name, one.name),
        );
        if (!field) return [];
        const held = heldBy(field.name);
        const distinct = new Set(held.map((one) => one.trim().toLowerCase())).size;
        /* Every value different: a name, not a kind of record. */
        if (held.length === 0 || distinct === held.length) return [];
        return [{ param, field, held, repeats: held.length / distinct }];
      })
      .sort((a, b) => b.repeats - a.repeats);
    let tries = 0;
    for (const { param, field, held } of worth) {
      if (tries >= MAX_FILTER_TRIES || budget.remaining < 3) break;
      const value = mostCommon(held);
      /* A value the unnarrowed page held beside others: a filter that did nothing would be caught. */
      if (!value || held.every((one) => sameWord(one, value))) continue;
      tries++;
      const narrowed = await tryRead(connection, opId, readDeps, {
        op: { query: { ...op.query, [param.name]: value }, pagination: { kind: "none" }, maxPages: 1 },
      });
      const got = narrowed.kind === "ok" ? (narrowed.rows ?? []).map((row) => readField(row, field.name)) : [];
      if (got.length > 0 && got.every((one) => typeof one === "string" && sameWord(one, value))) {
        confirmed[param.name] = field.name;
        log.push(`Filtering ${op.title}: ${param.name}=${value} answered only records whose ${field.name} is ${value}.`);
      }
    }
    if (Object.keys(confirmed).length === 0) return;
    const patch: ConnectionPatch = { ops: { [opId]: { filterParams: confirmed } } };
    const next = applyPatch(connection, patch);
    if (next) keep(next, `Asking ${op.title} for records by a field returned only those records`, patch);
  };

  /*
   * An endpoint that says how many records a list holds, kept only when a read
   * agrees with it. Its number is what a complete read of the list found, or
   * what the list itself stated; or, for a list too long to read whole, the
   * count narrowed by a confirmed filter is what the list read to its end
   * under that filter holds — Oregon's 295 of 11,848 breweries. Either shows
   * what the endpoint counts, and each filter that agreed is one it honours.
   * "How many" is then one request, where a list read page by page stops at
   * its ceiling (plan, track D).
   */
  const confirmCount = async (opId: string, first: Attempt): Promise<void> => {
    const op = getOp(connection, opId);
    const resource = connection.resources.find((one) => one.listOp === opId);
    if (!op || !resource || resource.count || opUsesRange(connection, op)) return;
    const candidates = countCandidates(connection, op);
    if (candidates.length === 0) return;
    /* What the list is known to hold, whole: read to its end, or stated by the API. */
    const seen = observed.filter((one) => one.op === opId);
    const whole =
      seen.find((one) => one.level === "traversed" || one.level === "count-reconciled")?.rows ??
      seen.map((one) => one.reportedTotal).find((one) => one !== undefined) ??
      first.meta?.reportedTotal;
    /* Each confirmed filter's values on the first page, rarest first: the shortest lists to read to their end. */
    const rows = first.rows ?? [];
    const narrowings = op.params
      .filter((param) => param.filters)
      .slice(0, 3)
      .map((param) => {
        const held = new Map<string, number>();
        for (const row of rows) {
          const value = readField(row, param.filters!);
          if (typeof value === "string" && value.trim().length > 0 && value.length <= 60)
            held.set(value, (held.get(value) ?? 0) + 1);
        }
        return { param: param.name, values: [...held].sort((a, b) => a[1] - b[1]).slice(0, 2).map(([value]) => value) };
      });
    for (const candidate of candidates.slice(0, 2)) {
      if (budget.remaining < 2) return;
      const answer = await tryRead(connection, candidate.id, readDeps, { op: { pagination: { kind: "none" }, maxPages: 1 } });
      const counted = answer.kind === "ok" ? countIn(answer.body) : null;
      if (!counted) continue;
      /* A number that is not what the list is known to hold is not its count. */
      if (whole !== undefined && counted.value !== whole) continue;
      const honoured: string[] = [];
      if (op.paginationChecked) {
        for (const { param, values } of narrowings) {
          for (const value of values) {
            if (budget.remaining < 4) break;
            const list = await tryRead(connection, opId, readDeps, {
              op: { query: { ...op.query, [param]: value }, maxPages: COUNT_CHECK_PAGES },
            });
            if (list.kind !== "ok" || list.meta?.truncated) continue;
            const narrowed = await tryRead(connection, candidate.id, readDeps, {
              op: { query: { ...candidate.query, [param]: value }, pagination: { kind: "none" }, maxPages: 1 },
            });
            const number = narrowed.kind === "ok" ? countIn(narrowed.body) : null;
            if (
              number?.field === counted.field &&
              number.value === (list.rows?.length ?? -1) &&
              number.value < counted.value
            ) {
              honoured.push(param);
              break;
            }
          }
        }
      }
      if (whole === undefined && honoured.length === 0) continue;
      const patch: ConnectionPatch = {
        resources: { [resource.id]: { count: { op: candidate.id, field: counted.field, filters: honoured } } },
        /* A count answers in one object, never in pages: said, so its tile does not warn of pages it never had. */
        ops: { [candidate.id]: { pagination: { kind: "none" }, paginationChecked: true } },
      };
      const next = applyPatch(connection, patch);
      if (!next) return;
      keep(next, `${candidate.title} counts ${op.title}, as a read of the records agreed`, patch);
      log.push(
        `Counting ${op.title}: ${candidate.title} answered ${counted.value}${whole !== undefined ? ", as many as the list holds" : ""}${honoured.length > 0 ? `, and agreed with the records read under ${honoured.join(", ")}` : ""}.`,
      );
      return;
    }
  };

  const targets = [...new Set(options.targets)].filter((opId) => getOp(connection, opId));

  /*
   * A GraphQL endpoint read as if it were REST: asked for its schema, and read
   * through what the schema declares — one query per list, generated rather
   * than written per API (plan, track A). Where it will not say, the check
   * goes on as before, and code may read it.
   */
  const added = { ops: [] as CatalogEntry["ops"][number][], resources: [] as ResourceSpec[], replaced: [] as string[] };
  for (const opId of [...targets]) {
    const op = getOp(connection, opId);
    if (!op || !/graphql/i.test(op.path) || op.body?.type === "graphql" || budget.remaining < 3) continue;
    const introspect = (query: string) =>
      tryRead(connection, opId, readDeps, {
        op: {
          method: "POST",
          body: { type: "graphql", query, variables: {} },
          readSafety: { basis: "graphql-query" },
          rowsPath: "$",
          pagination: { kind: "none" },
          maxPages: 1,
        },
      });
    let asked = await introspect(INTROSPECTION_QUERY);
    let schema = asked.kind === "ok" ? parseIntrospection(asked.body) : null;
    /* Refused as too deep, too costly or too large: asked again, more simply, then a type at a time. */
    if (!schema && budget.remaining >= 2 && asked.kind !== "unauthorized" && asked.kind !== "forbidden") {
      asked = await introspect(SHALLOW_INTROSPECTION_QUERY);
      schema = asked.kind === "ok" ? parseIntrospection(asked.body) : null;
      if (!schema && asked.kind !== "unauthorized" && asked.kind !== "forbidden") {
        schema = await introspectByType(
          async (query) => {
            if (budget.remaining < 3) return null;
            const answer = await introspect(query);
            return answer.kind === "ok" ? answer.body : null;
          },
          Math.min(30, Math.max(0, budget.remaining - 10)),
        );
      }
    }
    if (!schema) {
      log.push(`${op.title}: a GraphQL endpoint that did not describe its schema when asked${asked.kind === "ok" ? "" : ` (${asked.message})`}.`);
      continue;
    }
    const reads = graphqlReads(schema, { path: op.path });
    log.push(...reads.skipped.map((one) => `Not set up: ${one}.`));
    if (reads.ops.length === 0) continue;
    const patch: ConnectionPatch = { reads: { replace: opId, ops: reads.ops, resources: reads.resources } };
    const next = applyPatch(connection, patch);
    if (!next) continue;
    keep(next, `the GraphQL endpoint described its schema, and ${reads.ops.length} list(s) were set up from it`, patch);
    const ids = reads.ops.map((one) => one.id).filter((id) => getOp(connection, id));
    targets.splice(targets.indexOf(opId), 1, ...ids);
    added.ops.push(...reads.ops.filter((one) => ids.includes(one.id)));
    added.resources.push(...reads.resources.filter((one) => one.listOp !== undefined && ids.includes(one.listOp)));
    added.replaced.push(opId);
  }
  let blocked: string | undefined;
  /*
   * An MCP server: the tools it marks read-only are its endpoints, asked of
   * the server itself now that whatever token it wanted is in. Tools it has
   * and the connection lacks are added; every tool that takes no argument it
   * insists on is read once, like any collection.
   */
  if (connection.kind === "mcp") {
    try {
      const counting: HttpFetch = async (url, init, host) => {
        if (budget.remaining <= 0) throw new BudgetSpent();
        budget.remaining--;
        budget.spent++;
        return deps.http(url, init, host);
      };
      const client = await openMcpClient(connection, { http: counting, resolveSecret: deps.resolveSecret });
      const { ops, left } = toolOps(await client.listTools());
      if (left.length > 0)
        log.push(`Tools not known to only read were left out, and are never called for a board: ${left.slice(0, 8).join(", ")}${left.length > 8 ? ", and others" : ""}.`);
      const fresh = ops.filter((one) => !getOp(connection, one.id));
      if (fresh.length > 0) {
        const patch: ConnectionPatch = { reads: { ops: fresh, resources: [] } };
        const next = applyPatch(connection, patch);
        if (next) {
          keep(next, `the MCP server lists ${fresh.length} read-only tool(s)`, patch);
          added.ops.push(...fresh.filter((one) => getOp(connection, one.id)));
        }
      }
      for (const one of connection.ops) {
        if (targets.length >= 8) break;
        const needsInput = one.params.some((param) => param.required && param.default === undefined && one.query[param.name] === undefined);
        if (!needsInput && !targets.includes(one.id)) targets.push(one.id);
      }
      if (targets.length === 0)
        blocked =
          connection.ops.length === 0
            ? "The MCP server offers no tool it marks as read-only, so there is nothing a board may call."
            : "Every read-only tool this MCP server offers needs an input a board does not have.";
    } catch (error) {
      const refused = error instanceof McpError && (error.status === 401 || error.status === 403);
      blocked = refused
        ? `${connection.title} refused the access token. Check it is one its provider issued for connecting clients.`
        : `${connection.title} did not answer as an MCP server: ${error instanceof Error ? error.message : String(error)}`;
      log.push(blocked);
    }
  }
  /*
   * The endpoint the check starts from. A key recognised and refused one
   * endpoint (403) may read every other, so the next becomes the start rather
   * than the check ending there (checkpoint 2); only when every endpoint
   * refuses is the connection blocked.
   */
  let first = 0;
  /* Endpoints read, in order, for paging and filters once every one has been. */
  const read: Array<{ opId: string; title: string; attempt: Attempt; shape: ObservedShape | null }> = [];
  for (const [index, opId] of targets.entries()) {
    const primary = index === first;
    const op = getOp(connection, opId)!;
    if (budget.remaining <= 0) {
      outcomes.push({ op: opId, title: op.title, outcome: "skipped", note: "Not checked: the check's requests were used up." });
      continue;
    }
    const attempt = await settle(opId, primary);
    if (attempt.kind !== "ok") {
      /* A sign-in the importer could not represent: say which, in the manifest's words. */
      const unsupported =
        attempt.kind === "noSignIn" ? signInGapNotes(await docs.spec()).join(" ") : "";
      const waiting =
        attempt.kind === "needsCredentials"
          ? `Paste the ${authCredentials(connection.auth)
              .map((one) => one.label)
              .join(" and ")} from your ${connection.title} account. The check runs again by itself once you have.`
          : "";
      const reason =
        waiting ||
        unsupported ||
        (primary && cannot) ||
        `${BLOCKED_WORDS[attempt.kind] ?? "The API refused the request."}${attempt.said ? ` The API said: ${attempt.said}` : ""}`;
      outcomes.push({ op: opId, title: op.title, outcome: "blocked", note: reason });
      if (primary && attempt.kind === "forbidden" && index < targets.length - 1) {
        first = index + 1;
        continue;
      }
      if (primary) {
        blocked = reason;
        break;
      }
      continue;
    }
    const shape = observedShape(attempt.body, getOp(connection, opId)?.rowsPath);
    if (shape) {
      shapes[opId] = shape;
      const read = rowsOf(attempt.body, shape.rowsPath);
      const fields = seenValues(read, shape.fields);
      /* Every record only where the API's own count, under the same scope, says so. */
      const total = attempt.meta?.reportedTotal;
      const everyRecord = total !== undefined && total === read.length && !attempt.meta?.truncated;
      const unique = uniqueFields(read, shape.fields);
      if (Object.keys(fields).length > 0 || unique.length > 0) values[opId] = { fields, everyRecord, unique };
    }
    /* Code that reads a whole collection and says how many there are: counted against its own word. */
    const servedTotal = getOp(connection, opId)?.servedBy === "connector" ? attempt.meta?.reportedTotal : undefined;
    const rows = attempt.rows?.length ?? 0;
    observed.push({
      op: opId,
      level:
        servedTotal !== undefined && servedTotal === rows && !attempt.meta?.truncated ? "count-reconciled" : "accepted",
      rows,
      pages: attempt.meta?.pages ?? 1,
      ...(servedTotal !== undefined ? { reportedTotal: servedTotal } : {}),
      note: attempt.message,
      by: "integrate",
      maxPages: getOp(connection, opId)?.maxPages ?? 1,
    });
    read.push({ opId, title: op.title, attempt, shape });
  }

  /*
   * Then how each pages, and what it filters by, with what is left. Every
   * endpoint is read before any is read to its end: a count reconciled over
   * forty-two pages spent the budget the next collection needed, and it was
   * never read at all (checkpoint 2).
   */
  for (const { opId, title, attempt, shape } of read) {
    await confirmPaging(opId, attempt);
    if (shape) await confirmFilters(opId, attempt, shape);
    await confirmCount(opId, attempt);
    const best = observed.filter((one) => one.op === opId).at(-1);
    outcomes.push({
      op: opId,
      title,
      outcome: "ready",
      ...(best ? { level: best.level } : {}),
      note: best?.note ?? attempt.message,
    });
  }

  /* A first page of each collection nothing has read, for its fields — only once the connection reads at all. */
  if (!blocked && (options.sample?.length ?? 0) > 0) {
    const sampling: ReadDeps = { ...readDeps, budget: budgetOf(options.sampleRequests ?? SAMPLE_REQUESTS) };
    let sampled = 0;
    for (const opId of options.sample ?? []) {
      if (shapes[opId] || !getOp(connection, opId)) continue;
      const attempt = await tryRead(connection, opId, sampling, { op: { pagination: { kind: "none" }, maxPages: 1 } });
      if (attempt.kind === "budget" || attempt.kind === "rateLimited") break;
      if (attempt.kind !== "ok") continue;
      const shape = observedShape(attempt.body, getOp(connection, opId)?.rowsPath);
      if (!shape) continue;
      shapes[opId] = shape;
      const read = rowsOf(attempt.body, shape.rowsPath);
      const fields = seenValues(read, shape.fields);
      const unique = uniqueFields(read, shape.fields);
      if (Object.keys(fields).length > 0 || unique.length > 0) values[opId] = { fields, everyRecord: false, unique };
      sampled++;
    }
    if (sampled > 0) log.push(`Read a first page of ${sampled} more collection(s), for the fields their documentation does not declare.`);
  }

  /* Evidence is recorded against the configuration it ends up describing. */
  const configVersion = fingerprintConnection(connection);
  const at = new Date(deps.now()).toISOString();
  const evidence = observed.map((one) =>
    evidenceSchema.parse({
      workspace: deps.workspace ?? "local",
      connection: connection.id,
      op: one.op,
      level: one.level,
      configVersion,
      at,
      limits: { pages: one.pages, maxPages: one.maxPages, requests: budget.spent },
      observed: {
        rows: one.rows,
        ...(one.reportedTotal !== undefined ? { reportedTotal: one.reportedTotal } : {}),
        ...(one.pagination ? { pagination: one.pagination } : {}),
        note: one.note.slice(0, 400),
      },
      by: one.by,
    }),
  );

  const ready = outcomes.filter((one) => one.outcome === "ready").length;
  const outcome: IntegrationReport["outcome"] = blocked
    ? "blocked"
    : ready === outcomes.length
      ? "ready"
      : "partial";
  return {
    connection,
    changed: fingerprintConnection(connection) !== fingerprintConnection(initial),
    changes,
    ops: outcomes,
    evidence,
    outcome,
    ...(blocked ? { blocked } : {}),
    log,
    requests: budget.spent,
    modelCalls,
    observed: shapes,
    values,
    ...(added.ops.length > 0 ? { added } : {}),
    ...(blocked && connection.auth.type === "connector" && outcomes[0]?.note.startsWith("Paste the ")
      ? { needsCredentials: authCredentials(connection.auth) }
      : {}),
  };
};
