import { createHash, randomInt } from "node:crypto";
import {
  AdapterError,
  INCOMPLETE,
  RestAdapter,
  resolveReadRequest,
  type Continuation,
  type FetchContext,
  type FetchResult,
  type HttpFetch,
  type HttpResponse,
  type ResolvedReadRequest,
  type SourceAdapter,
} from "@freebirdai/dash-adapters";
import {
  MAX_PAGES,
  connectorServes,
  type ConnectionSpec,
  type ConnectorSpec,
  type OpSpec,
  type ReadCompletion,
} from "@freebirdai/dash-spec";
import {
  ConnectorRefusal,
  createConnectorHost,
  type ConnectorHost,
  type ConnectorRequestEvent,
  type ConnectorTokenStore,
  type KnownWrite,
} from "./host.js";
import { SandboxError, type ConnectorSandbox, type SandboxSession } from "./sandbox.js";

/**
 * Reads through a connection's connector, when it has one.
 *
 * Registered in place of the REST adapter: a connection with no connector is
 * read by REST exactly as before. One with a connector is read in one of two
 * ways, per endpoint:
 *
 * - an endpoint the connector **serves** is read by its code — its `read`, or
 *   the endpoint's own request with its `parse` and `paginate`;
 * - any other endpoint is read by REST as declared, with every request passed
 *   through the code's `signRequest` (and its `authenticate` first) on the way
 *   out — and through the same authority as its own requests.
 *
 * Each read is one run: a fresh sandbox, the code loaded after its pin is
 * checked, and everything it asks for decided by `host.ts`. A read too long
 * for one run's allowance says where it got to (`resume`) and is carried on
 * in another run — a fresh sandbox and a fresh allowance each time, a bounded
 * number of times — so the allowance bounds a run without cutting a read short.
 */

/** How many runs one read may take. Each has the authority's own allowance of requests and time. */
export const MAX_READ_RUNS = 10;
/** How much a run may hand to the next: a place to carry on from, not data. */
const MAX_RESUME_CHARS = 8_000;

export interface ConnectorServices {
  readonly sandbox: ConnectorSandbox;
  readonly tokens: ConnectorTokenStore;
  /** The run's clock. The server's own by default; the benchmark's is simulated. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Where each run's `Math.random` starts. Random by default; the benchmark's is a sequence. */
  readonly seed?: () => number;
  /** Told of every request a run sends or is refused: the journal, and the check's log. */
  readonly onRequest?: (connection: ConnectionSpec, op: OpSpec, event: ConnectorRequestEvent) => void;
  /** Told of each line a run logs. */
  readonly onLog?: (connection: ConnectionSpec, line: string) => void;
  /** The catalog's endpoints that change this connection's account: refused to its code, whatever its authority says. */
  readonly writes?: (connection: ConnectionSpec) => readonly KnownWrite[];
}

/** `sha256:<hex>` of the code: what a connector is pinned by. */
export const connectorHash = (code: string): string =>
  `sha256:${createHash("sha256").update(code, "utf8").digest("hex")}`;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * What a run's hooks are told about the endpoint they are for. `inputs` is
 * every value the read is given — each parameter's default, the board's
 * filters, the widget's own values — resolved as REST resolves them.
 */
export const runContext = (
  connection: ConnectionSpec,
  connector: ConnectorSpec,
  op: OpSpec | undefined,
  fetch?: FetchContext,
  resolved?: ResolvedReadRequest,
) => {
  const range = fetch?.params.range;
  return {
    op: op
      ? {
          id: op.id,
          title: op.title,
          path: op.path,
          method: op.method,
          query: op.query,
          rowsPath: op.rowsPath ?? "$",
          params: op.params.map((param) => ({ name: param.name, in: param.in, required: param.required })),
        }
      : null,
    baseUrl: connection.baseUrl ?? "",
    apiHosts: connector.authority.destinations.filter((one) => one.role === "api").map((one) => one.host),
    inputs: resolved?.inputs ?? fetch?.params.filters ?? {},
    range: range ? { start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() } : null,
    /* A connector's own read goes as far as it must; only a declared endpoint's paging has a smaller default. */
    maxPages: op?.servedBy === "connector" ? MAX_PAGES : (op?.maxPages ?? 5),
  };
};

/**
 * The endpoint's own first request, as REST would send it but for the
 * credential: what a served endpoint's code is handed as `ctx.request`, and
 * what one with no `read` of its own sends. Inputs nobody supplied are the
 * code's to fill (an id it reads first, say), so they are listed, not refused.
 */
const declaredRequest = (resolved: ResolvedReadRequest) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(resolved.headers)) headers[name.toLowerCase()] = value;
  if (resolved.body) headers["content-type"] = resolved.body.contentType;
  return {
    method: resolved.method,
    url: resolved.url,
    headers,
    ...(resolved.body ? { body: resolved.body.text } : {}),
    ...(resolved.unresolved.length > 0 ? { missing: [...resolved.unresolved] } : {}),
  };
};

const failure = (connection: ConnectionSpec, error: unknown, host: ConnectorHost | null): AdapterError => {
  if (error instanceof AdapterError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const last = host?.trace.filter((one) => one.status !== null).at(-1);
  const refused = error instanceof ConnectorRefusal || /HostError|ConnectorRefusal/.test(message);
  const limit = error instanceof SandboxError && error.kind === "limit";
  const upstream = last && last.status !== null && last.status >= 400 ? last.status : undefined;
  return new AdapterError(`connector: ${message}`, {
    status: upstream === 401 ? 401 : upstream === 403 ? 403 : upstream === 429 ? 429 : limit ? 504 : 502,
    ...(upstream !== undefined ? { upstreamStatus: upstream } : {}),
    userMessage: refused
      ? `${connection.title}'s connector asked for something it is not allowed: ${host?.redact(message) ?? message}`
      : `${connection.title}'s connector could not read this: ${host?.redact(message) ?? message}`,
  });
};

export class ConnectorAdapter implements SourceAdapter {
  readonly kind = "rest" as const;
  readonly transport = "proxy" as const;
  private readonly rest: RestAdapter;

  constructor(
    private readonly http: HttpFetch,
    private readonly services: ConnectorServices,
  ) {
    this.rest = new RestAdapter(http);
  }

  async fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    const connector = connection.connector;
    if (!connector) return this.rest.fetch(connection, op, overrides, ctx);
    const module = connector.operations[op.id];
    if (connectorHash(connector.code) !== connector.hash || (module && connectorHash(module.code) !== module.hash))
      throw new AdapterError(`connector code for ${connection.id} does not match its pin`, {
        status: 500,
        userMessage: `${connection.title}'s connector has changed since it was checked, so it was not run.`,
      });
    const served = connectorServes(connector, op.id);
    const signs = connector.hooks.includes("signRequest") || connector.hooks.includes("authenticate");
    if (!served && !signs) return this.rest.fetch(connection, op, overrides, ctx);

    const started = Date.now();
    let host: ConnectorHost | null = null;
    let session: SandboxSession | null = null;
    try {
      const opened = await this.open(connection, connector, op, ctx);
      host = opened.host;
      session = opened.session;
      /* The same inputs REST would send — the widget's own values among them — whichever way this endpoint is read. */
      const resolved = resolveReadRequest(connection, op, overrides, ctx.params);
      const runCtx = {
        ...runContext(connection, connector, op, ctx, resolved),
        ...(served ? { request: declaredRequest(resolved) } : {}),
      };
      if (session.hooks.includes("authenticate")) await session.call("authenticate", { ctx: runCtx });

      if (!served) {
        /* Declared endpoint, signed request by request. */
        const signing = this.signingHttp(session, host, runCtx);
        return await new RestAdapter(signing).fetch(connection, op, overrides, ctx);
      }

      type ReadAnswer = {
        rows?: unknown;
        total?: unknown;
        done?: unknown;
        complete?: unknown;
        pages?: unknown;
        resume?: unknown;
      } | null;
      const rows: Record<string, unknown>[] = [];
      const warnings: string[] = [];
      let dropped = 0;
      let total: number | undefined;
      let stopped = false;
      /* What the code said of its own end — "all", "partial" — on the run that ended the read. Unsaid is not "all". */
      let said: "all" | "partial" | undefined;
      /* Pages of records, by the code's own count; every request it sent, sign-ins and exports included, apart. */
      let pages = 0;
      let requests = 0;
      let lastStatus = 200;
      /* Carried on from where an earlier read's runs ran out: that read's, and nobody else's. */
      const from = ctx.continueFrom;
      if (from && (from.kind !== "connector" || (from.scope !== undefined && from.scope !== resolved.scope)))
        throw new AdapterError(`a continuation for another read was handed to ${connection.id}/${op.id}`, {
          status: 409,
          userMessage: `"${op.title}" changed since its read stopped, so it is read again from the start.`,
        });
      let resumeFrom: string | undefined = from?.resume !== undefined ? JSON.stringify(from.resume) : undefined;
      let continuation: Continuation | undefined;
      for (let run = 1; ; run++) {
        const answer = (await session.call("read", {
          ctx: resumeFrom === undefined ? runCtx : { ...runCtx, resume: JSON.parse(resumeFrom) as unknown },
        })) as ReadAnswer;
        if (!answer || !Array.isArray(answer.rows))
          throw new SandboxError("run", "the connector's read did not answer with records");
        for (const row of answer.rows) {
          if (row !== null && typeof row === "object" && !Array.isArray(row)) rows.push(row as Record<string, unknown>);
          else dropped++;
        }
        if (typeof answer.total === "number" && Number.isInteger(answer.total) && answer.total >= 0) total = answer.total;
        const sent = host.trace.filter((one) => one.status !== null);
        requests += sent.length;
        /* A sign-in or an export being prepared is a request, not a page: a run's records count as one page unless the code says. */
        pages += typeof answer.pages === "number" && Number.isInteger(answer.pages) && answer.pages >= 0 ? answer.pages : 1;
        lastStatus = sent.at(-1)?.status ?? lastStatus;
        said =
          answer.done === "all" || answer.done === "partial"
            ? answer.done
            : answer.complete === true
              ? "all"
              : answer.complete === false
                ? "partial"
                : undefined;
        if (said === "partial") stopped = true;
        /* Where it got to, for another run to carry on from: a fresh sandbox, a fresh allowance. */
        const next = answer.resume === undefined || answer.resume === null ? undefined : JSON.stringify(answer.resume);
        if (next === undefined || stopped) break;
        if (run >= MAX_READ_RUNS || next.length > MAX_RESUME_CHARS || next === resumeFrom) {
          /* More to read than a read is given, or code that is not moving on: said, not looped. */
          stopped = true;
          said = undefined;
          /* Still moving on, only out of runs: where it got to, so the read can be carried on later. */
          if (run >= MAX_READ_RUNS && next.length <= MAX_RESUME_CHARS && next !== resumeFrom)
            continuation = {
              kind: "connector",
              scope: resolved.scope,
              resume: JSON.parse(next) as unknown,
              pageIndex: (from?.pageIndex ?? 0) + pages,
              collected: (from?.collected ?? 0) + rows.length,
              ...(total !== undefined ? { reportedTotal: total } : {}),
            };
          break;
        }
        resumeFrom = next;
        await session.close();
        session = null;
        const again = await this.open(connection, connector, op, ctx);
        host = again.host;
        session = again.session;
        if (session.hooks.includes("authenticate")) await session.call("authenticate", { ctx: runCtx });
      }
      if (dropped > 0) warnings.push(`${dropped} value(s) the connector returned were not records and were left out.`);
      const short = total !== undefined && rows.length < total;
      if (stopped) warnings.push(INCOMPLETE.connectorStopped);
      else if (total !== undefined && short) warnings.push(INCOMPLETE.reportedMore(total));
      /*
       * Complete only on the code's own word. Code that returns records and
       * says nothing about whether they were all of them has not read to the
       * end as far as anyone can tell, so nothing claims it did — on the tile,
       * in the evidence, or in a count.
       */
      const completion: ReadCompletion = stopped
        ? { state: "partial", reason: said === "partial" ? "connector-partial" : "run-limit" }
        : short
          ? { state: "partial", reason: "reported-more" }
          : said === "all"
            ? { state: "traversed", reason: "connector-all" }
            : { state: "unknown", reason: "connector-silent" };
      if (completion.state === "unknown") warnings.push(INCOMPLETE.unknownEnd);
      return {
        body: rows,
        meta: {
          url: `${connection.baseUrl ?? ""}${op.path}`,
          status: lastStatus,
          fetchedAt: ctx.now,
          durationMs: Date.now() - started,
          pages,
          requests,
          truncated: stopped || short,
          warnings,
          completion,
          scope: resolved.scope,
          /* The code's own count speaks for this read only where the code also says it read to the end. */
          ...(total !== undefined ? { reportedTotal: total, ...(said === "all" ? { totalScope: resolved.scope } : {}) } : {}),
          ...(continuation && completion.reason === "run-limit" ? { continuation } : {}),
        },
      };
    } catch (error) {
      throw failure(connection, error, host);
    } finally {
      await session?.close();
    }
  }

  /** Open one run for this connection and endpoint. */
  async open(
    connection: ConnectionSpec,
    connector: ConnectorSpec,
    op: OpSpec | undefined,
    ctx: Pick<FetchContext, "resolveSecret" | "signal">,
  ): Promise<{ host: ConnectorHost; session: SandboxSession }> {
    const now = this.services.now ?? Date.now;
    const host = createConnectorHost({
      connection,
      connector,
      op,
      http: this.http,
      resolveSecret: ctx.resolveSecret ?? (async () => null),
      tokens: this.services.tokens,
      now,
      sleep: this.services.sleep ?? realSleep,
      signal: ctx.signal,
      onRequest: op && this.services.onRequest ? (event) => this.services.onRequest!(connection, op, event) : undefined,
      writes: this.services.writes?.(connection),
    });
    /* The shared sign-in, then this endpoint's own reading code where it has a module: never another endpoint's. */
    const module = op ? connector.operations[op.id] : undefined;
    const session = await this.services.sandbox.open({
      code: connector.code,
      ...(module ? { module: module.code } : {}),
      host: {
        call: (name, args) => host.call(name, args),
        now: () => host.now(),
        log: (line) => {
          host.log(line);
          this.services.onLog?.(connection, host.redact(line));
        },
      },
      limits: { wallMs: connector.authority.wallMs },
      seed: this.services.seed?.() ?? randomInt(1, 2 ** 31),
    });
    return { host, session };
  }

  /** The transport REST uses for a declared endpoint: each request signed by the code, then sent through the authority. */
  private signingHttp(session: SandboxSession, host: ConnectorHost, runCtx: Record<string, unknown>): HttpFetch {
    return async (url, init) => {
      const signed = await session.call("signRequest", {
        ctx: runCtx,
        request: {
          method: init.method ?? "GET",
          url,
          headers: init.headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
        },
      });
      /* Signed by the code, sent where it was going: the connection's own endpoint, never somewhere the code chose. */
      const answer = await host.endpointRequest(signed, { method: init.method ?? "GET", url });
      const response: HttpResponse = {
        status: answer.status,
        text: answer.text,
        url: answer.url,
        header: (name) => answer.headers[name.toLowerCase()] ?? null,
      };
      return response;
    };
  }
}
