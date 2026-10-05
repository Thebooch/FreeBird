import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConnectionSpec,
  type EvidenceLevel,
  evidenceRank,
  fingerprintConnection,
  getOp,
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
import type { LlmAdapter } from "./agent/index.js";
import { CredentialBroker, type OAuthAppRegistry, vaultApps } from "./auth/broker.js";
import { type CredentialMetaStore, MemoryCredentialMetaStore } from "./auth/credential-meta.js";
import { OAuthRetryAdapter, RateLimitWaitAdapter } from "./auth/retry-adapter.js";
import { coolingMessage, retryAfterSeconds } from "./cache/cooldown.js";
import { ConnectionGate, Priority } from "./cache/gate.js";
import { QueryCache } from "./cache/queryCache.js";
import type { CacheStore } from "./cache/store.js";
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
import { buildQueryRequest } from "./query.js";
import { withAddedReads, withEntryResources, withObservedFields } from "./integrate/observed.js";
import { describeMissingRecords } from "./map.js";
import { RhythmStore } from "./rhythm-store.js";
import { fetchPublicDocument, guardedFetch } from "./safe-fetch.js";
import { MemorySeenValueStore, type SeenValueStore } from "./values/store.js";
import type { SecretRepository } from "./vault.js";
import { nullJournal, type WriteJournal } from "./writes/journal.js";
import type { WritePolicy } from "./writes/policy.js";
import { JournalingAdapter, readEventFor } from "./writes/read-journal.js";
import type { FetchDocument } from "./writes/read-writes.js";
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

  /* Catalog ids whose record types are being described right now: one pass per API at a time. */
  const describing = new Set<string>();
  /** Describe an API's record types where they have not been, when a model is configured. */
  const describeRecords = (entryId: string): Promise<void> =>
    describeMissingRecords(
      {
        catalog: options.catalog,
        llm: (task) => llm(task),
        describing,
        ...(options.onDescribed ? { onDescribed: options.onDescribed } : {}),
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
    describing,
    describeRecords,
    keepObserved,
    /** Carry on whatever was being read, read for every record, or waiting a check when the engine last stopped. */
    resume: (): void => {
      void longReads.resume().catch((error: unknown) => log.warn(`long reads could not resume: ${String(error)}`));
      void eachReads.resume().catch((error: unknown) => log.warn(`per-record reads could not resume: ${String(error)}`));
      void checkQueue.resume().catch((error: unknown) => log.warn(`checks waiting their turn could not resume: ${String(error)}`));
    },
    stop: (): void => longReads.stop(),
  };
};

export type Engine = ReturnType<typeof createEngine>;
