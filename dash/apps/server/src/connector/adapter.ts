import { createHash, randomInt } from "node:crypto";
import {
  AdapterError,
  INCOMPLETE,
  RestAdapter,
  renderBody,
  type FetchContext,
  type FetchResult,
  type HttpFetch,
  type HttpResponse,
  type SourceAdapter,
} from "@freebirdai/dash-adapters";
import { MAX_PAGES, interpolate, interpolatePath, type ConnectionSpec, type ConnectorSpec, type OpSpec } from "@freebirdai/dash-spec";
import { ConnectorRefusal, createConnectorHost, type ConnectorHost, type ConnectorRequestEvent, type ConnectorTokenStore } from "./host.js";
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
 * checked, and everything it asks for decided by `host.ts`.
 */

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
}

/** `sha256:<hex>` of the code: what a connector is pinned by. */
export const connectorHash = (code: string): string =>
  `sha256:${createHash("sha256").update(code, "utf8").digest("hex")}`;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a run's hooks are told about the endpoint they are for. */
export const runContext = (connection: ConnectionSpec, connector: ConnectorSpec, op: OpSpec | undefined, fetch?: FetchContext) => {
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
    inputs: fetch?.params.filters ?? {},
    range: range ? { start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() } : null,
    /* A connector's own read goes as far as it must; only a declared endpoint's paging has a smaller default. */
    maxPages: op?.servedBy === "connector" ? MAX_PAGES : (op?.maxPages ?? 5),
  };
};

/** The endpoint's own first request, for a served endpoint with no `read` of its own. */
const declaredRequest = (connection: ConnectionSpec, op: OpSpec, ctx: FetchContext) => {
  const base = (connection.baseUrl ?? "").replace(/\/+$/, "");
  const path = interpolatePath(op.path, ctx.params);
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(op.query)) {
    const filled = interpolate(String(value), ctx.params);
    if (filled !== "") query.set(name, filled);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(op.headers)) headers[name.toLowerCase()] = interpolate(value, ctx.params);
  const body = op.method === "POST" && op.body ? renderBody(op.body, ctx.params, {}) : undefined;
  if (body) headers["content-type"] = body.contentType;
  const text = query.toString();
  return {
    method: op.method,
    url: `${base}${path.startsWith("/") ? path : `/${path}`}${text ? `?${text}` : ""}`,
    headers,
    ...(body ? { body: body.text } : {}),
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
    if (connectorHash(connector.code) !== connector.hash)
      throw new AdapterError(`connector code for ${connection.id} does not match its pin`, {
        status: 500,
        userMessage: `${connection.title}'s connector has changed since it was checked, so it was not run.`,
      });
    const served = connector.serves.includes(op.id);
    const signs = connector.hooks.includes("signRequest") || connector.hooks.includes("authenticate");
    if (!served && !signs) return this.rest.fetch(connection, op, overrides, ctx);

    const started = Date.now();
    let host: ConnectorHost | null = null;
    let session: SandboxSession | null = null;
    try {
      const opened = await this.open(connection, connector, op, ctx);
      host = opened.host;
      session = opened.session;
      const runCtx = { ...runContext(connection, connector, op, ctx), ...(served ? { request: declaredRequest(connection, op, ctx) } : {}) };
      if (session.hooks.includes("authenticate")) await session.call("authenticate", { ctx: runCtx });

      if (!served) {
        /* Declared endpoint, signed request by request. */
        const signing = this.signingHttp(session, host, runCtx);
        return await new RestAdapter(signing).fetch(connection, op, overrides, ctx);
      }

      const answer = (await session.call("read", { ctx: runCtx })) as {
        rows?: unknown;
        total?: unknown;
        complete?: unknown;
        pages?: unknown;
      } | null;
      if (!answer || !Array.isArray(answer.rows))
        throw new SandboxError("run", "the connector's read did not answer with records");
      const rows = answer.rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row));
      const warnings: string[] = [];
      if (rows.length !== answer.rows.length)
        warnings.push(`${answer.rows.length - rows.length} value(s) the connector returned were not records and were left out.`);
      const total =
        typeof answer.total === "number" && Number.isInteger(answer.total) && answer.total >= 0 ? answer.total : undefined;
      const stopped = answer.complete === false;
      if (stopped) warnings.push(INCOMPLETE.connectorStopped);
      else if (total !== undefined && rows.length < total) warnings.push(INCOMPLETE.reportedMore(total));
      const last = host.trace.filter((one) => one.status !== null).at(-1);
      return {
        body: rows,
        meta: {
          url: `${connection.baseUrl ?? ""}${op.path}`,
          status: last?.status ?? 200,
          fetchedAt: ctx.now,
          durationMs: Date.now() - started,
          pages: typeof answer.pages === "number" ? answer.pages : Math.max(1, host.trace.filter((one) => one.status !== null).length),
          truncated: stopped || (total !== undefined && rows.length < total),
          warnings,
          ...(total !== undefined ? { reportedTotal: total } : {}),
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
    });
    const session = await this.services.sandbox.open({
      code: connector.code,
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
      const answer = (await host.call("http.request", signed)) as {
        status: number;
        headers: Record<string, string>;
        text: string;
        url: string;
      };
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
