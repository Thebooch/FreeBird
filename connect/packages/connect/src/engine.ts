import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionKeyRefs,
  connectionNeedsAuthSetup,
  type ConnectionSpec,
  type EntityLinkView,
  entityLinkViews,
  type EntitySpec,
  type EvidenceLevel,
  type OpSpec,
  type ResolvedParams,
  fieldLexicon,
  opUsesRange,
  evidenceRank,
  fingerprintConnection,
  getOp,
  isStale,
  observeEntity,
  pathParamNames,
  readingsDiffer,
  resolveRange,
} from "@freebirdai/connect-spec";
import {
  AdapterError,
  AdapterRegistry,
  DependentAdapter,
  type FetchResult,
  type HttpFetch,
  INCOMPLETE,
  isIncompleteNote,
  McpAdapter,
  RestAdapter,
} from "./adapters/index.js";
import { type InferredShape, inferShape, type LlmAdapter } from "./agent/index.js";
import { CredentialBroker, type OAuthAppRegistry, vaultApps } from "./auth/broker.js";
import { type CredentialMetaStore, MemoryCredentialMetaStore } from "./auth/credential-meta.js";
import { OAuthRetryAdapter, RateLimitWaitAdapter } from "./auth/retry-adapter.js";
import { coolingMessage, retryAfterSeconds } from "./cache/cooldown.js";
import { ConnectionGate, Priority } from "./cache/gate.js";
import { clampMaxAge, QueryCache, type QueryOutcome } from "./cache/queryCache.js";
import { MemoryShapeStore, type ShapeStore } from "./drift/store.js";
import { DriftWatch } from "./drift/watch.js";
import type { CacheStore } from "./cache/store.js";
import { analyseConnection, type AnalyseOptions, fromReport, type SampleFn, toReport, withVerifiedParams } from "./capabilities.js";
import type { CatalogStore } from "./catalog.js";
import type { ConnectionRepository } from "./connections.js";
import { ConnectorAdapter } from "./connector/adapter.js";
import type { ConnectorTokenStore } from "./connector/host.js";
import { type ConnectorSandbox, refusingSandbox } from "./connector/sandbox.js";
import { VaultConnectorTokens } from "./connector/tokens.js";
import { type EvidenceStore, MemoryEvidenceStore } from "./evidence/store.js";
import { EACH_KEEP_MS, type EachReader, EachReads, type EachRequest } from "./fanout/each.js";
import { createIntegrationRunner, type IntegrateRouteDeps, type IntegrationRunner } from "./integrate/runner.js";
import { CheckQueue } from "./jobs/check-queue.js";
import { LongReads, type LongReadStatus } from "./jobs/long-reads.js";
import { type JobStore, MemoryJobStore } from "./jobs/store.js";
import { DEFAULT_EVERY_MS, LastSeen } from "./keeper/keeper.js";
import { decideAll } from "./keeper/rhythm.js";
import { openMcpClient } from "./mcp/client.js";
import { buildQueryRequest, type QueryRequest } from "./query.js";
import { withAddedReads, withEntryResources, withObservedFields } from "./integrate/observed.js";
import { describeMissingRecords } from "./map.js";
import { RhythmStore } from "./rhythm-store.js";
import { fetchPublicDocument, guardedFetch } from "./safe-fetch.js";
import { MemorySeenValueStore, type SeenValueStore } from "./values/store.js";
import type { SecretRepository } from "./vault.js";
import { nullJournal, type WriteJournal } from "./writes/journal.js";
import type { WritePolicy } from "./writes/policy.js";
import { JournalingAdapter, readEventFor } from "./writes/read-journal.js";
import { type FetchDocument, WriteEndpointReader } from "./writes/read-writes.js";
import { Discovered } from "./writes/catalog-writes.js";
import { WriteService } from "./writes/service.js";

/**
 * The real transport, wrapped in the SSRF guard and the host allowlist.
 *
 * Exported so a driver script reads through exactly the transport the engine
 * does. A second, unguarded copy in a script is how an SSRF guard stops being
 * true of every path that reaches an API.
 */
export const nodeHttp: HttpFetch = async (url, init, allowedHost) => {
  const result = await guardedFetch(url, init, allowedHost);
  return {
    status: result.status,
    text: result.text,
    url: result.url,
    header: (name) => result.headers.get(name),
  };
};

/**
 * A pacing number from the environment, or the default.
 *
 * Non-numeric and negative values fall back rather than throwing: a typo in a
 * deployment's environment should not stop the server, and every value here
 * has a sane answer without it. Zero is legal and means "no limit".
 */
export const pacingEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export interface EngineLog {
  info(line: string): void;
  warn(line: string): void;
  debug(line: string): void;
}

const quiet: EngineLog = { info: () => {}, warn: () => {}, debug: () => {} };

/** A published document — an API's specification — fetched through the SSRF guard. */
export const fetchSpecification: FetchDocument = async (url) => {
  const response = await fetchPublicDocument(url);
  return { status: response.status, text: response.text, url: response.url };
};

export interface EngineOptions {
  /** Where connections and their capability reports live. */
  readonly store: ConnectionRepository;
  /** API keys and tokens. */
  readonly keys: SecretRepository;
  /** What is known about each API, shared by everybody who connects it. */
  readonly catalog?: CatalogStore | undefined;
  /** Test seam: swap the transport. Absent means `nodeHttp`, behind the SSRF guard. */
  readonly http?: HttpFetch | undefined;
  /** When each OAuth token expires. Absent means in memory. */
  readonly credentialMeta?: CredentialMetaStore | undefined;
  /** Where an OAuth app's client id and secret come from. Absent means what the person pasted. */
  readonly oauthApps?: OAuthAppRegistry | undefined;
  /** Every change, and every read that might not be one. Absent means nowhere. */
  readonly journal?: WriteJournal | undefined;
  /** Work that outlives a request. Absent means in memory. */
  readonly jobs?: JobStore | undefined;
  /** Where cached responses live. Absent means in this process only. */
  readonly cache?: CacheStore | undefined;
  /** What has been observed about reading each endpoint. Absent means in memory. */
  readonly evidence?: EvidenceStore | undefined;
  /** What each connection's records were seen to hold. Absent means in memory. */
  readonly seenValues?: SeenValueStore | undefined;
  /** How often each endpoint is asked again. Absent means a scratch directory. */
  readonly rhythms?: RhythmStore | undefined;
  /** Where connector code runs. Absent means nowhere: connector code is refused. */
  readonly sandbox?: ConnectorSandbox | undefined;
  /** Where a connector's session tokens are kept. Absent means the vault. */
  readonly connectorTokens?: ConnectorTokenStore | undefined;
  /** Who may change what. Every review and commit asks it first. */
  readonly policy: WritePolicy;
  /** The model for one task, or null when none is configured. */
  readonly llm: (task?: string) => LlmAdapter | null;
  /** Test seam: how a published specification is fetched. */
  readonly fetchDocument?: FetchDocument | undefined;
  /** Whether a connection is checked by itself once it can be read. Off unless asked. */
  readonly autoIntegrate?: boolean | undefined;
  readonly log?: EngineLog | undefined;
  /**
   * What the host tells the integration loop: which endpoints its own views
   * read, and what to do with what a check observed about an API.
   */
  readonly integration?: Pick<IntegrateRouteDeps, "usedOps" | "recordObserved" | "recordFound"> | undefined;
  /**
   * An API's record types were just described: what an account read showed
   * about them can be applied now.
   */
  readonly onDescribed?: ((catalogId: string) => void) | undefined;
  /**
   * What an account read showed changed how some record types' fields read
   * (a flag sent as 0/1, a number sent as text). A host rebuilds whatever it
   * built on them.
   */
  readonly onReadingsChanged?:
    | ((connection: string, entities: ReadonlySet<string>, wrapped: ReadonlyMap<string, string>) => void)
    | undefined;
  /** Read each API's write endpoints from its specification, in the background. Off unless asked. */
  readonly autoReadWrites?: boolean | undefined;
  /** An API's write endpoints were just read. */
  readonly onWritesChanged?: (() => void) | undefined;
  /** The shape each endpoint was accepted in, and any change seen since. Absent means in memory. */
  readonly shapes?: ShapeStore | undefined;
  /**
   * Whether anything the host saved reads these fields of an endpoint. A
   * change nothing reads is taken as the new shape. Absent means every change
   * is reported and the endpoint checked again.
   */
  readonly readsFields?: ((connection: string, op: string, fields: readonly string[]) => boolean) | undefined;
}

/** One read through the engine: what to read, and how old an answer may be. */
export interface EngineReadInput {
  readonly connection: ConnectionSpec;
  readonly op: OpSpec;
  /** Inputs, by name: path segments and query values. */
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  /** The window, and the filters with path inputs folded in. */
  readonly resolved: ResolvedParams;
  /** `view` serves what is held at any age; `refresh` asks the API when it is older than `maxAgeMs`. */
  readonly mode?: "view" | "refresh";
  /** How old an answer may be, in milliseconds. Clamped. */
  readonly maxAgeMs: number;
  /** How long an answer counts as fresh for its label, where the host keeps it warm. */
  readonly freshForMs?: number;
  readonly priority?: Priority;
  /** The request as spelled, before it is sent: Dash records what was viewed from it. */
  readonly onRequest?: (request: QueryRequest) => void;
}

/** What a read through the engine hands back. */
export interface EngineReadResult extends QueryRequest {
  readonly outcome: QueryOutcome;
  /** The answer's meta, with the engine's continuation replaced by how far a background read has got. */
  readonly meta: Omit<QueryOutcome["meta"], "continuation">;
  /** The rest of the answer being read in the background, and how far it has got; null when there is none. */
  readonly reading: LongReadStatus | null;
  /** A change open on this endpoint since it was accepted, in words; null when there is none. */
  readonly changed: string | null;
}

/**
 * The engine's moving parts, wired together.
 *
 * Every read, check and change to a connected account goes through these:
 * one credential broker, one adapter chain behind the SSRF guard and the
 * journal, one gate and cooldown per connection, one response cache, one job
 * store for work that outlives a request, and the integration loop. A host
 * builds one of these per workspace and serves it however it likes; Dash's
 * server is one such host.
 */
export const createEngine = (options: EngineOptions) => {
  const { store, keys } = options;
  const log = options.log ?? quiet;
  const http = options.http ?? nodeHttp;
  const journal = options.journal ?? nullJournal;
  const credentialMeta = options.credentialMeta ?? new MemoryCredentialMetaStore();
  const llm = options.llm;

  /*
   * Every secret a request sends is asked of the broker: the vault's value
   * for a static key, a live token for OAuth — fetched, renewed and retried
   * without anybody's help. See `auth/broker.ts`.
   */
  const broker = new CredentialBroker({
    vault: keys,
    meta: credentialMeta,
    apps: options.oauthApps ?? vaultApps(keys),
    http,
    getConnection: (id) => store.getConnection(id),
    listConnections: () => store.listConnections(),
    now: Date.now,
    log: (message) => log.warn(message),
  });
  const secretFor = broker.resolve;
  const rest = new RestAdapter(http);
  /*
   * Connector code — for an API a connection cannot describe in data — runs
   * in the sandbox, under its authority, with its session tokens in the vault.
   * See `connector/`.
   */
  const connectors = {
    sandbox: options.sandbox ?? refusingSandbox,
    tokens: options.connectorTokens ?? new VaultConnectorTokens(keys, credentialMeta),
  };
  const reader = new ConnectorAdapter(http, {
    ...connectors,
    onLog: (connection, line) => log.debug(`connector ${connection.id}: ${line}`),
    /* The API's endpoints that change things, as its catalog entry knows them: never sent by connector code. */
    writes: (connection) =>
      (connection.catalog ? (options.catalog?.get(connection.catalog)?.writes ?? []) : []).map((write) => ({
        method: write.method,
        path: write.path,
      })),
  });
  /*
   * An MCP server's read-only tools, called over the same guarded transport
   * and with the same broker as any other read, and journalled: a tool call
   * is a read on the server's word, not the protocol's. See `mcp/`.
   */
  const mcp = new McpAdapter((connection) =>
    openMcpClient(connection, { http, resolveSecret: (keyRef) => secretFor(keyRef) }),
  );
  /*
   * Reads go through the journal first: a read sent with POST on the
   * documentation's word is recorded each time it is sent. Reads go through
   * the connector adapter, which is REST exactly for a connection with no
   * connector. Writes use `rest` directly, through the write service, which
   * journals them itself.
   */
  const registry = new AdapterRegistry()
    .register(
      /* Outermost: an input another endpoint's records supply is read through the same chain as everything else. */
      new DependentAdapter(
        new JournalingAdapter(
          new OAuthRetryAdapter(new RateLimitWaitAdapter(reader), broker),
          journal,
          (message) => log.warn(message),
        ),
      ),
    )
    .register(new JournalingAdapter(mcp, journal, (message) => log.warn(message)));

  /**
   * How hard the engine is willing to lean on somebody else's API.
   *
   * The defaults are deliberately modest: three at a time with a fifth of a
   * second between starts is slower on an idle API and dramatically better on
   * a metered one, because a refusal costs every view reading it.
   * Environment-overridable so a deployment with a generous quota is not
   * stuck with a limit chosen for a strict one.
   */
  const gate = new ConnectionGate({
    maxConcurrent: pacingEnv("DASH_MAX_CONCURRENCY", 3),
    minGapMs: pacingEnv("DASH_MIN_GAP_MS", 200),
  });

  /*
   * Memory-only by default. A response cache holds a customer's own records,
   * and keeping them in a process that forgets everything when it stops is
   * what makes "we read your API, we do not keep it" true for a self-hoster.
   */
  const queries = new QueryCache({ gate, ...(options.cache ? { store: options.cache } : {}) });

  /* Who is actually looking. Read by the keeper, which refuses to spend a rate limit on a connection nobody opened. */
  const seen = new LastSeen();

  /* Work that outlives a request — a read carried on, every record's related records — kept so a restart carries it on. */
  const jobs: JobStore = options.jobs ?? new MemoryJobStore();
  /** Which endpoints are due a check, kept in the job store. See `CheckQueue`. */
  const checkQueue = new CheckQueue({ store: jobs, now: () => Date.now() });
  /** Every record's related records, read in the background and kept in the job store while they run. */
  const eachReads = new EachReads({
    store: jobs,
    /* Defined below, with the reads it needs: only ever called after. */
    reader: (request) => eachPlan(request)?.read ?? null,
    log: (line) => log.info(line),
  });

  /**
   * How often each endpoint is asked again, per connection: the personal
   * half. The shared half is on the catalog entry. Absent means a directory
   * of this engine's own, so a cadence one test ticked never leaks into the next.
   */
  const rhythms = options.rhythms ?? new RhythmStore(mkdtempSync(join(tmpdir(), "connect-rhythm-")));

  /** Everything needed to place one of a connection's endpoints in a tier. */
  const rhythmFor = (connection: ConnectionSpec) => {
    const entry = connection.catalog ? options.catalog?.get(connection.catalog) : undefined;
    return {
      connection,
      ...(entry?.rhythm ? { api: entry.rhythm } : {}),
      entities: entry?.entities ?? [],
      personal: rhythms.get(connection.id),
    };
  };

  /*
   * Tier decisions, remembered for a few seconds: each answer reads the rhythm
   * file and the catalog entry from disk. A cadence somebody just moved is at
   * most this stale, and `forgetTiers` clears it outright.
   */
  const TIER_MEMO_MS = 5_000;
  let tierMemo = { at: 0, byConnection: new Map<string, Map<string, number>>() };
  const forgetTiers = (): void => {
    tierMemo = { at: 0, byConnection: new Map() };
  };

  /**
   * How often one endpoint is asked again: the tier its records were placed
   * in, or the fast one where nothing has an opinion. A view that asked for a
   * shorter interval gets it.
   */
  const everyMsForOp = (connection: string, op: string, viewEveryMs?: number): number => {
    const now = Date.now();
    if (now - tierMemo.at > TIER_MEMO_MS) tierMemo = { at: now, byConnection: new Map() };
    let ops = tierMemo.byConnection.get(connection);
    if (!ops) {
      ops = new Map();
      const spec = store.getConnection(connection);
      if (spec) {
        for (const decision of decideAll({ ...rhythmFor(spec), ops: spec.ops.map((one) => one.id) })) {
          ops.set(decision.op, decision.everyMs);
        }
      }
      tierMemo.byConnection.set(connection, ops);
    }
    const tier = ops.get(op) ?? DEFAULT_EVERY_MS;
    return viewEveryMs !== undefined ? Math.min(tier, viewEveryMs) : tier;
  };

  /**
   * Every upstream call that is not a cached query: checks, samples,
   * enumeration, writes. Not cached, but sharing the connection's gate and
   * cooldown, because a rate limit is a property of the connection.
   */
  const upstream = async <T>(
    connection: string,
    run: () => Promise<T>,
    priority: Priority = Priority.Background,
  ): Promise<T> => {
    const cooling = queries.cooldown.check(connection, Date.now());
    if (cooling)
      throw new AdapterError(`cooling down for ${connection}`, {
        status: cooling.status,
        userMessage: coolingMessage(cooling, Date.now()),
        retryAfter: retryAfterSeconds(cooling.until, Date.now()),
      });

    return gate.run(connection, priority, async () => {
      try {
        const result = await run();
        queries.cooldown.succeeded(connection);
        return result;
      } catch (error) {
        if (error instanceof AdapterError && error.status === 429) {
          queries.accounting.refused(connection);
          queries.cooldown.refused({
            connection,
            status: 429,
            retryAfter: error.retryAfter,
            reason: error.userMessage,
            now: Date.now(),
          });
        }
        throw error;
      }
    });
  };

  /*
   * Reads too long for a view's own limits, carried on in the background from
   * where they stopped, behind every view's own reads, and handed to the
   * cache whole when they reach their end. See `LongReads`.
   */
  const longReads = new LongReads({
    store: jobs,
    getConnection: (id) => store.getConnection(id),
    read: (connection, op, overrides, ctx) => {
      registry.addConnection(connection);
      const adapter = registry.adapterFor(connection.kind);
      if (!adapter) throw new AdapterError(`no adapter registered for kind "${connection.kind}"`, { status: 501 });
      return upstream(connection.id, () => adapter.fetch(connection, op, overrides, { ...ctx, resolveSecret: secretFor }), Priority.Background);
    },
    answer: async (key, _connection, result) => queries.put(key, result),
    now: () => Date.now(),
    log: (line) => log.info(line),
  });

  /*
   * A connection's configuration, as the cache last knew it: a change to it
   * drops every answer read under the old one.
   */
  const queryVersions = new Map(
    store.listConnections().map((connection) => [connection.id, fingerprintConnection(connection)]),
  );
  const refreshQueryIdentity = (connection: ConnectionSpec) => {
    const current = fingerprintConnection(connection);
    if (queryVersions.get(connection.id) !== current) {
      queries.invalidate(connection.id);
      queryVersions.set(connection.id, current);
    }
  };

  /*
   * A per-record read's requests, spelled exactly as a view spells them —
   * so one already held is not asked again — and how to read one of them.
   * Null when the connection is gone or its configuration changed since.
   */
  const eachPlan = (request: EachRequest): { readonly keys: string[]; readonly read: EachReader } | null => {
    const spec = store.getConnection(request.connection);
    const resolvedOp = spec ? getOp(spec, request.op) : undefined;
    if (!spec || !resolvedOp || fingerprintConnection(spec) !== request.configVersion) return null;
    registry.addConnection(spec);
    refreshQueryIdentity(spec);
    const reads = request.values.map((value) =>
      buildQueryRequest({
        connection: request.connection,
        op: resolvedOp,
        params: { ...request.params, [request.input]: value },
        resolved: request.window,
      }),
    );
    return {
      keys: reads.map((read) => read.key),
      read: async (index, signal) => {
        const { key, overrides, resolved } = reads[index]!;
        const fetcher = () =>
          registry.fetch(request.connection, request.op, overrides, {
            params: resolved,
            now: Date.now(),
            resolveSecret: secretFor,
            signal,
          });
        /* Already held — a view's own first twenty-five, say: served as held. */
        const answer =
          queries.storedAt(key) !== null
            ? await queries.read({
                key,
                connection: request.connection,
                mode: "view",
                maxAgeMs: EACH_KEEP_MS,
                fetcher,
                priority: Priority.Background,
              })
            : await upstream(request.connection, fetcher, Priority.Background);
        const said = answer.meta.warnings.filter(isIncompleteNote);
        return {
          body: answer.body,
          notes:
            answer.meta.truncated && said.length === 0
              ? ["Not every page was read, so what is shown may exclude additional records."]
              : said,
        };
      },
    };
  };

  /*
   * What a view is told of its read: a continuation is the engine's own,
   * never the caller's, and a read being carried on says how far it has got
   * in place of the note that it stopped.
   */
  const withReadingOn = <M extends FetchResult["meta"]>(meta: M, reading: LongReadStatus | null): Omit<M, "continuation"> => {
    const { continuation: _continuation, ...rest } = meta;
    if (!reading) return rest;
    const stopped = (warning: string) => /^Only the first \d+ page\(s\) were read/.test(warning) || warning === INCOMPLETE.connectorStopped;
    return {
      ...rest,
      warnings: [...meta.warnings.filter((warning) => !stopped(warning)), INCOMPLETE.readingOn(reading.read, reading.of)],
      readingOn: { read: reading.read, ...(reading.of !== undefined ? { of: reading.of } : {}) },
    };
  };

  /*
   * The only thing that changes a connected account. Beside `upstream`,
   * because a change waits in the same gate as every read — just at the front
   * of it — and answers to the same cooldown.
   */
  const writes = new WriteService({
    store,
    catalog: options.catalog,
    // Read through the broker, so a change to an OAuth account sends a current token.
    keys: { get: secretFor },
    registry,
    rest,
    queries,
    seen,
    policy: options.policy,
    journal,
    upstream,
  });
  const evidence: EvidenceStore = options.evidence ?? new MemoryEvidenceStore();
  const seenValues: SeenValueStore = options.seenValues ?? new MemorySeenValueStore();
  const fetchDocument: FetchDocument = options.fetchDocument ?? fetchSpecification;

  /**
   * The last enumeration of a connection, kept briefly.
   *
   * Enumerating is by far the most request-hungry thing here — dozens of real
   * calls against someone else's API — and both `/capabilities` and
   * `/suggestions` need the same answer. Without this, opening the drawer
   * twice doubles the load on an API that may well start refusing: a 403 where
   * an empty list used to be, which then makes everything look broken.
   *
   * Deliberately in memory and short-lived. It is an observation about a
   * moment, not a fact worth persisting, and `refresh` forces a fresh look.
   */
  const enumerated = new Map<
    string,
    {
      at: number;
      value: Awaited<ReturnType<typeof analyseConnection>>;
      shapes: Record<string, InferredShape>;
    }
  >();
  const ENUMERATION_TTL = 5 * 60_000;

  /**
   * What the last account read saw, endpoint by endpoint, values included.
   *
   * Held only until the record types can be told what their fields really
   * hold (see `observeConnection`): a read often finishes before the record
   * types are described, and the values it saw are the evidence. In memory
   * and short-lived, like the enumeration beside it — they are a customer's
   * data, and only the conclusions drawn from them are ever written down.
   */
  const sampledShapes = new Map<string, { at: number; byOp: Map<string, InferredShape> }>();
  const SAMPLES_TTL = 30 * 60_000;

  /**
   * One real request against one endpoint, shaped for the analyser.
   *
   * Extracted because enumeration is no longer the only caller: verifying a
   * proposed relationship reads a single child collection the same way, and
   * two implementations of "call an endpoint and describe what came back"
   * would drift on exactly the details that matter — how inputs are split, how
   * an empty 200 is classified.
   */
  const sampleFor =
    (
      connection: ConnectionSpec,
      onShape?: (opId: string, shape: InferredShape) => void,
    ): SampleFn =>
    async (opId, inputs) => {
      const op = getOp(connection, opId);
      if (!op) return { kind: "failed", message: `no endpoint named "${opId}"` };

      /*
       * A caller's inputs are a flat bag; the endpoint knows which of them are
       * path segments and which are query values. Splitting here rather than
       * guessing is the same rule `/api/query` follows — a path token resolved
       * from the wrong bag interpolates to nothing and produces a 404 that
       * reads like a bad credential.
       */
      const declared = new Set(pathParamNames(op.path));
      const filters: Record<string, string | number | boolean> = {};
      const query: Record<string, string | number | boolean> = {};
      for (const [name, value] of Object.entries(
        (inputs ?? {}) as Record<string, string | number | boolean>,
      )) {
        if (declared.has(name)) filters[name] = value;
        else query[name] = value;
      }

      const result = await upstream(connection.id, () =>
        registry.fetch(connection.id, op.id, query, {
          params: { range: resolveRange({ preset: "30d", now: Date.now() }), filters },
          now: Date.now(),
          resolveSecret: secretFor,
        }),
      );
      const shape = inferShape(result.body, op.rowsPath ? { rowsPath: op.rowsPath } : {});
      // A 200 with nothing in it is a fact about the account, not a failure.
      if (shape.fields.length === 0) return { kind: "empty" };
      onShape?.(op.id, shape);
      return { kind: "rows", fields: shape.fields, rowCount: shape.rowCount };
    };

  /**
   * Enumerate a connection, reusing a recent pass unless told not to.
   *
   * Three tiers, cheapest first: the in-process cache, then the report on disk,
   * then real requests. The disk tier is what makes a restart free — the report
   * describes the same endpoints (`isStale` proves it) so re-spending the
   * budget to learn what we already wrote down would be pure waste.
   */
  const enumerate = async (
    connection: ConnectionSpec,
    refresh: boolean,
    budget: AnalyseOptions = {},
  ) => {
    const cached = enumerated.get(connection.id);
    const currentReport = store.getReport(connection.id);
    if (
      !refresh &&
      cached &&
      currentReport &&
      !isStale(currentReport, connection) &&
      Date.now() - cached.at < ENUMERATION_TTL
    )
      return cached;

    if (!refresh) {
      const stored = store.getReport(connection.id);
      if (stored && !isStale(stored, connection)) {
        const { value, shapes } = fromReport(stored);
        /*
         * A report is data written by an earlier version of this code, so it
         * is normalised on the way in rather than trusted. The case that
         * forced it: a relation carrying a filter parameter the endpoint never
         * declared, which no later pass would rewrite — the model can see the
         * link already and correctly declines to propose it again.
         */
        const restored = {
          at: Date.now(),
          shapes,
          value: {
            ...value,
            resources: withVerifiedParams(value.resources, connection.ops),
          },
        };
        enumerated.set(connection.id, restored);
        return restored;
      }
    }

    const shapes: Record<string, InferredShape> = {};
    const byOpShape = new Map<string, InferredShape>();

    const value = await analyseConnection(
      connection,
      sampleFor(connection, (opId, shape) => byOpShape.set(opId, shape)),
      budget,
    );
    sampledShapes.set(connection.id, { at: Date.now(), byOp: byOpShape });
    observeConnection(connection.id);

    // Re-key the shapes from op id onto resource id, which is what the
    // suggestion engine reasons in.
    for (const resource of value.resources) {
      const shape = resource.listOp ? byOpShape.get(resource.listOp) : undefined;
      if (shape) shapes[resource.id] = shape;
    }

    const entry = { at: Date.now(), value, shapes };
    enumerated.set(connection.id, entry);
    // Write it down so the next process — or the next drawer opening after a
    // restart — costs nothing.
    store.putReport(toReport(connection, value, shapes));
    return entry;
  };

  /**
   * Tell a connection's record types what their fields really hold.
   *
   * From the last account read, while its values are still held: flags the
   * docs call boolean and the API sends as 0/1, numbers declared as text. Runs
   * when a read lands and again when the record types are described, because
   * either can finish first. Widgets reading a field whose reading changed are
   * rebuilt so a filter on a flag compares what the API actually sends.
   */
  const observeConnection = (connectionId: string): void => {
    const connection = store.getConnection(connectionId);
    const held = sampledShapes.get(connectionId);
    if (!connection?.catalog || !held || !options.catalog) return;
    if (Date.now() - held.at > SAMPLES_TTL) {
      sampledShapes.delete(connectionId);
      return;
    }
    const entry = options.catalog.get(connection.catalog);
    if (!entry?.entities?.length) return;

    const at = new Date(held.at).toISOString();
    const resources = connection.resources.length > 0 ? connection.resources : (entry.resources ?? []);
    const changed = new Set<string>();
    const wrapped = new Map<string, string>();
    let touched = false;
    const entities = entry.entities.map((entity) => {
      const found = resources.find((one) => one.id === entity.resource);
      // The list where it was read, else the record's own endpoint.
      const shape =
        (found?.listOp ? held.byOp.get(found.listOp) : undefined) ??
        (found?.detailOp ? held.byOp.get(found.detailOp) : undefined);
      if (!shape) return entity;
      const observed = observeEntity(entity, shape.fields, at);
      if (observed === entity) return entity;
      const { wrapped: wrapper, ...next } = observed;
      touched = true;
      if (wrapper) wrapped.set(entity.id, wrapper);
      if (wrapper || readingsDiffer(entity, next)) changed.add(entity.id);
      return next;
    });
    if (!touched) return;
    options.catalog.put({ ...entry, entities });
    if (changed.size > 0) options.onReadingsChanged?.(connection.id, changed, wrapped);
  };

  /*
   * Every connection can change what its API lets it change — nothing to
   * switch on — so an entry whose write endpoints were never read has them
   * read: when a connection is added from it, and once at start for any
   * added before writes existed. That is a read of the API's published
   * specification, never of the account.
   */
  const writeReader =
    options.autoReadWrites === true && options.catalog
      ? new WriteEndpointReader({
          catalog: options.catalog,
          fetchDocument,
          onRead: (entryId, result) => {
            log.info(`read ${result.writes} write endpoint(s) for ${entryId}`);
            options.onWritesChanged?.();
          },
          onFailed: (entryId, error) =>
            log.warn(`could not read the write endpoints for ${entryId}: ${error instanceof Error ? error.message : String(error)}`),
        })
      : undefined;
  /** Read a connection's write endpoints if its entry never has had them read. */
  const readWritesFor = (connection: ConnectionSpec): void => {
    if (connection.catalog) void writeReader?.ensure(connection.catalog);
  };
  /** Write endpoints discovery read, held until their entry is adopted. */
  const discovered = new Discovered();

  /**
   * The rest of an API, for a brief that names two record types.
   *
   * The catalog's record types with *this connection's* endpoints, which is
   * the same pairing a record page is built from and for the same reason: the
   * catalog describes the whole API, a connection may hold a subset of it, and
   * a join naming an endpoint this connection does not carry is one nothing
   * here could ever fetch.
   */
  const relatedFor = (
    connection: ConnectionSpec,
    entities: readonly EntitySpec[],
  ) => ({
    entities,
    resources: connection.resources,
    ops: connection.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
  });

  /**
   * Which of a connection's fields point at other records.
   *
   * Extracted because two callers need the same answer: the public connection
   * the browser reads, and the keeper deciding which reference lists are worth
   * warming. Derived on every call rather than stored — it is a property of
   * the API, read off the catalog, so re-describing one is live everywhere at
   * once.
   */
  const linksFor = (
    connection: ConnectionSpec,
  ): readonly EntityLinkView[] => {
    const entities = connection.catalog
      ? (options.catalog?.get(connection.catalog)?.entities ?? [])
      : [];
    if (entities.length === 0) return [];
    return entityLinkViews({
      entities,
      resources: connection.resources,
      ops: connection.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
    });
  };

  const publicConnection = (connection: ConnectionSpec | null) => {
    if (!connection) return null;
    const refs = connectionKeyRefs(connection);
    // `authRequired` with no auth style chosen yet is not "ready" — the key
    // exists somewhere, we just have not been told where it goes.
    const hasKey = !connectionNeedsAuthSetup(connection) && refs.every((ref) => keys.has(ref));
    /*
     * What this API's fields are called, derived rather than stored.
     *
     * Read off the described record types on every request, so there is one
     * copy to correct and re-describing an API is live for every connection to
     * it at once. It used to be written by a model pass of its own, run inside
     * every mapping and costing a call per batch of field names — for a worse
     * answer than the describing pass already gives, since one map keyed by
     * bare field name has to give `Title` a single meaning for the whole API.
     *
     * This is the fallback, not the answer: a widget that knows its record
     * type gets that record type's own words (`EntityLinkView.labels`), which
     * outrank these. This serves the places holding a field name and nothing
     * else.
     *
     * Empty for a connection to an API nobody has described, which every
     * renderer already handles by falling back to the mechanical label.
     */
    const labels = connection.catalog
      ? fieldLexicon(options.catalog?.get(connection.catalog)?.entities ?? [])
      : {};
    /*
     * Which of this API's fields point at other records, resolved the same way
     * and for the same reason — a property of the API, kept once on the
     * catalog entry rather than copied onto every connection to it.
     *
     * Deliberately the *links* and not the record types. A browser needs to
     * know that a column holds a vendor's id, what a vendor is called, and
     * which endpoint returns one; it does not need the twelve hundred field
     * descriptions that make the artifact worth sharing, and on a real API
     * that difference is tens of kilobytes against well over a megabyte on a
     * payload read at every page load.
     *
     * The ops come from the *connection* rather than the catalog: a reach plan
     * that names an endpoint this connection does not carry is a link nothing
     * here could follow.
     */
    const entities = connection.catalog
      ? (options.catalog?.get(connection.catalog)?.entities ?? [])
      : [];
    const entityLinks = linksFor(connection);
    /*
     * Which of this connection's endpoints actually read the time range.
     *
     * Published rather than re-derived in the browser, because the browser and
     * this server must build the *same* cache key and `queryKey`'s own
     * docblock says what two spellings of a key cost. Cheap: it reads the op's
     * own query and the dialect, with no resolution and no parse.
     */
    const rangeOps = connection.ops
      .filter((op) => opUsesRange(connection, op))
      .map((op) => op.id);

    return { ...connection, hasKey, labels, entityLinks, rangeOps };
  };

  /** A connection with whether its key is in place. */
  const withKeyFlag = (connection: ConnectionSpec | null) => {
    if (!connection) return null;
    const refs = connectionKeyRefs(connection);
    // `authRequired` with no auth style chosen yet is not "ready" — the key
    // exists somewhere, we just have not been told where it goes.
    const hasKey = !connectionNeedsAuthSetup(connection) && refs.every((ref) => keys.has(ref));
    return { ...connection, hasKey };
  };

  /**
   * A field name that reads as somebody else's identity.
   *
   * `userId`, `album_id`, `postIds`, `id` — and deliberately not `valid` or
   * `hybrid`, which is the whole reason this is not `/id$/i`. Two spellings
   * rather than one clever pattern, because the two are genuinely different
   * conventions and a reader should be able to see which one matched.
   */
  const looksLikeAnId = (path: string): boolean => {
    const last = path.split(".").pop() ?? "";
    return /[a-z0-9]Ids?$/.test(last) || /(?:^|_)ids?$/i.test(last);
  };


  /* Catalog ids whose record types are being described right now: one pass per API at a time. */
  const describing = new Set<string>();
  /** Describe an API's record types where they have not been, when a model is configured. */
  const describeRecords = (entryId: string): Promise<void> =>
    describeMissingRecords(
      {
        catalog: options.catalog,
        llm: (task) => llm(task),
        describing,
        onDescribed: (catalogId) => {
          for (const one of store.listConnections()) if (one.catalog === catalogId) observeConnection(one.id);
          options.onDescribed?.(catalogId);
        },
      },
      entryId,
    );
  /**
   * What a check's reads showed, onto the shared catalog entry: fields for
   * endpoints the documentation declared none for — names and kinds, never
   * values — and reads it added. The record types that can now be described
   * are described next, by themselves; the promise settles once they are.
   */
  const keepObserved = async (
    connection: ConnectionSpec,
    observed: Parameters<NonNullable<IntegrateRouteDeps["recordObserved"]>>[1],
    added: Parameters<NonNullable<IntegrateRouteDeps["recordObserved"]>>[2],
  ): Promise<void> => {
    const entries = options.catalog;
    const entry = connection.catalog ? entries?.get(connection.catalog) : undefined;
    if (!entries || !entry) return;
    /* Reads written from a GraphQL schema first, so their records are what is described. */
    const read = withAddedReads(entry, added);
    const next = withObservedFields(read ?? entry, observed) ?? read;
    if (!next) return;
    entries.put(next);
    /* A collection a read showed, carried by every connection made from this entry. */
    for (const one of store.listConnections()) {
      if (one.catalog !== entry.id) continue;
      const grown = withEntryResources(one, next);
      if (grown !== one) {
        store.putConnection(grown);
        registry.addConnection(grown);
      }
    }
    await describeRecords(entry.id);
  };

  /*
   * The integration loop: read what matters on a new connection, repair what
   * its documentation got wrong, confirm how it pages, and keep the result.
   * It starts by itself once a connection can be read; its reads go through
   * the same gate and cooldown as every other reader of the connection.
   */
  const integrationDeps: IntegrateRouteDeps = {
    getConnection: (id) => store.getConnection(id),
    saveConnection: (next, changed) => {
      store.putConnection(next);
      if (changed) queries.invalidate(next.id);
      registry.addConnection(next);
    },
    catalogEntry: (id) => options.catalog?.get(id),
    hasSecret: (keyRef) => keys.has(keyRef),
    resolveSecret: secretFor,
    refresh: (connection) => broker.refresh(connection),
    http,
    fetchDocument,
    llm: () => llm("repair"),
    connectorLlm: () => llm("connector"),
    evidence,
    around: (connection, background) => (run) =>
      upstream(connection, run, background ? Priority.Background : Priority.Interactive),
    /* A read the check sends on the documentation's word is journalled like any other. */
    onRead: (connection, op, outcome) => {
      const event = readEventFor(connection, op, "check", outcome, Date.now());
      if (event)
        Promise.resolve(journal.recordRead?.(event)).catch((error: unknown) =>
          log.warn(`a check's read could not be journalled: ${String(error)}`),
        );
    },
    auto: options.autoIntegrate ?? false,
    log: (message) => log.info(message),
    connectors,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    recordValues: async (connection, values) => {
      for (const [op, held] of Object.entries(values)) await seenValues.put(connection.id, op, held);
    },
    /*
     * What the check established, kept on the API's entry: when, against which
     * version, and the rung each endpoint reached. Rungs only — a count is one
     * account's, and an entry is every account's.
     */
    recordCheck: (connection, report) => {
      const entries = options.catalog;
      const entry = entries && connection.catalog ? entries.get(connection.catalog) : null;
      if (!entries || !entry || report.evidence.length === 0) return;
      const ops: Record<string, EvidenceLevel> = {};
      for (const one of report.evidence) {
        const held = ops[one.op];
        if (!held || evidenceRank(one.level) > evidenceRank(held)) ops[one.op] = one.level;
      }
      const at = new Date().toISOString();
      entries.put({
        ...entry,
        ...(report.outcome === "ready" ? { verifiedAt: at } : {}),
        evidence: { at, ...(entry.version !== undefined ? { version: entry.version } : {}), outcome: report.outcome === "ready" ? "ready" : "partial", ops },
      });
    },
    /* What the check's reads showed, kept on the entry, and the record types it lets be described, described. */
    recordObserved: (connection, observed, added) => {
      void keepObserved(connection, observed, added).catch((error: unknown) =>
        log.warn(`describing ${connection.catalog ?? connection.id} after its check failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    },
    /* What a search for a request's records found, described before whoever asked asks again. */
    recordFound: (connection, observed, added) => keepObserved(connection, observed, added),
    ...options.integration,
  };
  const integration: IntegrationRunner = createIntegrationRunner({ ...integrationDeps, queue: checkQueue });

  /*
   * Each fresh answer, held against the shape its endpoint was accepted in.
   * A change is said on every read of that endpoint and the endpoint is
   * checked again by itself; nothing is repaired behind anybody's back.
   */
  const drift = new DriftWatch({
    shapes: options.shapes ?? new MemoryShapeStore(),
    now: () => Date.now(),
    recheck: (connection, ops) => integration.recheck(connection, ops),
    ...(options.readsFields ? { readsFields: options.readsFields } : {}),
    log: (line) => log.info(line),
  });
  /** Kept out of the way of the read it describes: a shape that cannot be kept costs nothing shown. */
  const watchShape = (connection: ConnectionSpec, op: OpSpec, body: unknown): void => {
    void drift
      .observe(connection, op, body)
      .catch((error: unknown) => log.warn(`the shape of ${connection.id}/${op.id} could not be checked: ${String(error)}`));
  };

  /**
   * One read, the way every reader of an endpoint reads it.
   *
   * The request is spelled once (`buildQueryRequest`), so it lands on the key
   * every other reader writes. A key whose whole answer was read in the
   * background is refreshed the same way, never by a capped read that would
   * put a partial answer back over the whole one. A fresh answer that stopped
   * at its own limit with more to read is carried on in the background from
   * where it stopped, and a fresh answer is held against its accepted shape.
   */
  const read = async (input: EngineReadInput): Promise<EngineReadResult> => {
    const { connection, op } = input;
    registry.addConnection(connection);
    refreshQueryIdentity(connection);
    const request = buildQueryRequest({ connection: connection.id, op, params: { ...input.params }, resolved: input.resolved });
    input.onRequest?.(request);
    const { key, overrides, resolved } = request;
    const maxAgeMs = clampMaxAge(input.maxAgeMs);
    const mode = input.mode ?? "refresh";

    const heldAt = queries.storedAt(key);
    const owned =
      mode !== "view" &&
      heldAt !== null &&
      Date.now() - heldAt > maxAgeMs &&
      (await longReads.owns(key).catch(() => false));
    if (owned)
      void longReads
        .refresh({ key, connection, op, overrides, resolved })
        .catch((error: unknown) => log.warn(`a long read could not be refreshed: ${String(error)}`));
    const outcome = await queries.read({
      key,
      connection: connection.id,
      mode: owned ? "view" : mode,
      maxAgeMs,
      ...(input.freshForMs !== undefined ? { freshForMs: input.freshForMs } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      fetcher: (validators) =>
        registry.fetch(connection.id, op.id, overrides, {
          params: resolved,
          now: Date.now(),
          resolveSecret: secretFor,
          ...(validators ? { validators } : {}),
        }),
    });

    if (outcome.outcome === "miss") watchShape(connection, op, outcome.body);
    /* Stopped at its own limit with more to read: the rest is read in the background, from there. */
    if (outcome.outcome === "miss" && outcome.meta.continuation)
      await longReads
        .carryOn({ key, connection, op, overrides, resolved, first: outcome })
        .catch((error: unknown) => log.warn(`a long read could not be carried on: ${String(error)}`));
    const reading = await longReads.status(key).catch(() => null);
    const changed = await drift.noteFor(connection, op.id).catch(() => null);
    return { key, overrides, resolved, outcome, meta: withReadingOn(outcome.meta, reading), reading, changed };
  };

  /**
   * Until the background read of this key, if there is one, has finished:
   * what a caller that wants the whole answer now waits for.
   */
  const settled = async (key: string, timeoutMs = 120_000): Promise<LongReadStatus | null> => {
    const finished = (status: LongReadStatus | null) =>
      !status || status.state === "done" || status.state === "blocked" || status.state === "cancelled";
    const until = Date.now() + timeoutMs;
    for (;;) {
      const status = await longReads.status(key).catch(() => null);
      if (finished(status) || Date.now() >= until) return status;
      longReads.kick();
      await longReads.idle();
      const after = await longReads.status(key).catch(() => null);
      if (finished(after) || Date.now() >= until) return after;
      /* Waiting its turn, or out a rate limit: give it a moment rather than spinning. */
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };


  return {
    store,
    keys,
    catalog: options.catalog,
    http,
    log,
    llm,
    broker,
    secretFor,
    rest,
    connectors,
    registry,
    gate,
    queries,
    seen,
    jobs,
    checkQueue,
    eachReads,
    eachPlan,
    rhythms,
    rhythmFor,
    forgetTiers,
    everyMsForOp,
    upstream,
    longReads,
    withReadingOn,
    refreshQueryIdentity,
    writes,
    journal,
    evidence,
    seenValues,
    fetchDocument,
    integrationDeps,
    integration,
    drift,
    watchShape,
    read,
    settled,
    describing,
    describeRecords,
    keepObserved,
    enumerated,
    enumerate,
    sampledShapes,
    sampleFor,
    observeConnection,
    readWritesFor,
    discovered,
    relatedFor,
    linksFor,
    publicConnection,
    withKeyFlag,
    looksLikeAnId,
    /** Carry on whatever was being read, read for every record, or waiting a check when the engine last stopped. */
    resume: (): void => {
      void longReads.resume().catch((error: unknown) => log.warn(`long reads could not resume: ${String(error)}`));
      void eachReads.resume().catch((error: unknown) => log.warn(`per-record reads could not resume: ${String(error)}`));
      void checkQueue.resume().catch((error: unknown) => log.warn(`checks waiting their turn could not resume: ${String(error)}`));
      for (const connection of store.listConnections()) readWritesFor(connection);
    },
    stop: (): void => {
      longReads.stop();
      writeReader?.close();
    },
  };
};

export type Engine = ReturnType<typeof createEngine>;
