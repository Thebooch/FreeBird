import { join } from "node:path";
import {
  type CapabilityReport,
  type CatalogEntry,
  type ConnectionSpec,
  connectionKeyRefs,
  connectionNeedsAddress,
  connectionNeedsAuthSetup,
  type EntitySpec,
  getOp,
  type OpSpec,
  resolveRange,
} from "@freebirdai/connect-spec";
import { AdapterError, type HttpFetch } from "./adapters/index.js";
import type { LlmAdapter } from "./agent/index.js";
import type { Priority } from "./cache/gate.js";
import type { CacheStore } from "./cache/store.js";
import { CatalogStore, connectionFromCatalog } from "./catalog.js";
import type { ConnectionRepository } from "./connections.js";
import type { ConnectorSandbox } from "./connector/sandbox.js";
import { type DocsRenderer, discover, type DiscoveryResult } from "./discovery/index.js";
import type { SearchProvider } from "./discovery/search.js";
import { createEngine, type Engine, type EngineLog } from "./engine.js";
import type { IntegrationRun } from "./integrate/runner.js";
import { rowsOf } from "./integrate/read.js";
import { Keeper, type WarmTarget } from "./keeper/keeper.js";
import { createLocalStores, type EngineStores } from "./platform/stores.js";
import { buildQueryRequest } from "./query.js";
import type { SecretRepository } from "./vault.js";
import type { WriteIntent, WriteReview } from "./writes/pending.js";
import type { WriteActor, WritePermission, WriteScope } from "./writes/policy.js";
import type { FetchDocument } from "./writes/read-writes.js";
import { type CommitResult, findEntity } from "./writes/service.js";

/** Connections kept in this process only: the default, and right for a script. */
export class MemoryConnectionStore implements ConnectionRepository {
  private readonly connections = new Map<string, ConnectionSpec>();
  private readonly reports = new Map<string, CapabilityReport>();
  listConnections(): ConnectionSpec[] {
    return [...this.connections.values()];
  }
  getConnection(id: string): ConnectionSpec | null {
    return this.connections.get(id) ?? null;
  }
  putConnection(spec: ConnectionSpec): void {
    this.connections.set(spec.id, spec);
  }
  deleteConnection(id: string): void {
    this.connections.delete(id);
  }
  listReports(): CapabilityReport[] {
    return [...this.reports.values()];
  }
  getReport(connectionId: string): CapabilityReport | null {
    return this.reports.get(connectionId) ?? null;
  }
  putReport(report: CapabilityReport): CapabilityReport {
    this.reports.set(report.connection, report);
    return report;
  }
  deleteReport(connectionId: string): void {
    this.reports.delete(connectionId);
  }
}

/**
 * Whether one actor may make one kind of change. The host's own permission
 * check, the same pattern as guide's `ActionDefinition.authorize`. Absent
 * means every change is allowed: a script run by its owner.
 */
export type Authorize = (
  actor: WriteActor,
  permission: WritePermission,
  scope: WriteScope,
) => boolean | Promise<boolean>;

export interface ConnectOptions {
  /** Where the engine keeps files: the key vault, cadences, worked-out APIs. Default `.connect`. */
  readonly dir?: string;
  /** Where connections live. Default: in memory. */
  readonly store?: ConnectionRepository;
  /** Where API keys live. Default: an encrypted file under `dir`. */
  readonly keys?: SecretRepository;
  /** What is known about each API. Default: worked-out entries under `dir/catalog`. */
  readonly catalog?: CatalogStore;
  /** The engine's relational state. Default: in memory; see `@freebirdai/connect-postgres`. */
  readonly stores?: Partial<EngineStores>;
  /** Where cached responses live. Default: in this process. */
  readonly cache?: CacheStore;
  /** A model, needed to map and repair an API; never needed to read one. */
  readonly llm?: LlmAdapter | ((task?: string) => LlmAdapter | null) | null;
  /** Web search, for finding an API's documentation from its name. */
  readonly search?: SearchProvider | null;
  /** Where generated connector code runs. Default: refused; see `@freebirdai/connect-sandbox`. */
  readonly sandbox?: ConnectorSandbox;
  /** Draws documentation rendered in a browser. Default: none; see `@freebirdai/connect-browser`. */
  readonly renderDocs?: DocsRenderer;
  /** Test seam: the transport. Default: Node's fetch behind the SSRF guard. */
  readonly http?: HttpFetch;
  /** Test seam: how a published document is fetched. Default: behind the SSRF guard. */
  readonly fetchDocument?: FetchDocument;
  /** The host's permission check for changes. */
  readonly authorize?: Authorize;
  /** Check a connection by itself as soon as it can be read. Default true. */
  readonly autoIntegrate?: boolean;
  readonly log?: EngineLog;
}

export interface ReadRequest {
  /** An endpoint by its id. */
  readonly op?: string;
  /** Or a record type, by its id or its name ("tenant", "Tenants"): its list endpoint is read. */
  readonly record?: string;
  /** Inputs for the endpoint: path segments and query values, by name. */
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  /** Rows whose fields equal these, kept; the rest left out. Applied after the read. */
  readonly filter?: Readonly<Record<string, unknown>>;
  /** How old an answer is acceptable: milliseconds, or "30s", "5m", "1h", "1d". Default 5 minutes. */
  readonly fresh?: number | string;
  /** The time window, for endpoints that read one. Default the last 30 days. */
  readonly range?: "1h" | "24h" | "7d" | "30d" | "90d" | "12mo" | "ytd";
}

export interface ReadResult {
  readonly rows: unknown[];
  /** The whole response, as the API sent it. */
  readonly body: unknown;
  readonly op: string;
  readonly cache: "hit" | "miss" | "revalidating" | "stale";
  readonly ageMs: number;
  /** What the reader should know: pages not read, a read carried on, a change in shape. */
  readonly warnings: readonly string[];
}

export type ConnectEvent =
  | { readonly type: "read"; readonly connection: string; readonly op: string; readonly rows: number; readonly cache: ReadResult["cache"] }
  | { readonly type: "read-failed"; readonly connection: string; readonly op: string; readonly message: string; readonly status: number }
  | { readonly type: "checked"; readonly connection: string; readonly outcome: string }
  | { readonly type: "write"; readonly connection: string; readonly entity: string; readonly kind: WriteIntent["kind"] };

const OWNER: WriteActor = { userId: "owner", workspaceId: "local" };

/** "30s", "5m", "1h", "1d" or a number of milliseconds. */
export const freshness = (value: number | string | undefined): number => {
  if (value === undefined) return 5 * 60_000;
  if (typeof value === "number") return Math.max(0, value);
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`"${value}" is not a duration: use 30s, 5m, 1h or 1d.`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "ms" | "s" | "m" | "h" | "d"];
  return Math.round(Number(match[1]) * unit);
};

/**
 * The integration engine, ready to use.
 *
 * ```ts
 * const connect = createConnect({ llm });
 * const api = await connect.connections.add({ from: "https://api.example.com/openapi.json" });
 * await connect.connections.setKey(api.id, process.env.EXAMPLE_KEY!);
 * await connect.integrate(api.id);
 * const { rows } = await connect.read(api.id, { record: "tenant", filter: { status: "late" }, fresh: "5m" });
 * ```
 */
export const createConnect = (options: ConnectOptions = {}) => {
  const dir = options.dir ?? ".connect";
  const local = createLocalStores({ dir });
  const store = options.store ?? new MemoryConnectionStore();
  const keys = options.keys ?? local.keys;
  const catalog = options.catalog ?? new CatalogStore(join(dir, "seed"), join(dir, "catalog"));
  const stores: EngineStores = { ...local, ...options.stores };
  const llm = (task?: string): LlmAdapter | null =>
    typeof options.llm === "function" ? options.llm(task) : (options.llm ?? null);
  const listeners = new Set<(event: ConnectEvent) => void>();
  const emit = (event: ConnectEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* A listener's failure is its own. */
      }
    }
  };
  const authorize = options.authorize;

  const engine: Engine = createEngine({
    store,
    keys,
    catalog,
    http: options.http,
    fetchDocument: options.fetchDocument,
    credentialMeta: stores.credentialMeta,
    journal: stores.journal,
    jobs: stores.jobs,
    cache: options.cache,
    evidence: stores.evidence,
    seenValues: stores.seenValues,
    rhythms: local.rhythms,
    sandbox: options.sandbox ?? local.sandbox,
    policy: {
      can: async (actor, permission, scope) =>
        !authorize || (await authorize(actor, permission, scope ?? {}))
          ? { ok: true }
          : { ok: false, reason: "That change is not allowed here." },
    },
    llm,
    autoIntegrate: options.autoIntegrate ?? true,
    log: options.log,
  });

  const need = (id: string): ConnectionSpec => {
    const connection = store.getConnection(id);
    if (!connection) throw Object.assign(new Error(`There is no connection "${id}".`), { status: 404 });
    return connection;
  };
  const entryOf = (connection: ConnectionSpec): CatalogEntry | undefined =>
    (connection.catalog ? catalog.get(connection.catalog) : null) ?? undefined;

  /** The endpoint a read names, directly or through a record type's list. */
  const opFor = (connection: ConnectionSpec, request: ReadRequest): OpSpec => {
    if (request.op) {
      /* An operation id as the documentation spells it finds the endpoint too: ids are kept lower-case. */
      const wanted = request.op.toLowerCase();
      const op =
        getOp(connection, request.op) ??
        getOp(connection, connection.ops.find((one) => one.id.toLowerCase() === wanted)?.id ?? request.op);
      if (!op) throw new Error(`${connection.title} has no endpoint "${request.op}".`);
      return op;
    }
    if (!request.record) throw new Error("Say what to read: an `op`, or a `record` type.");
    const entities = entryOf(connection)?.entities ?? [];
    const entity: EntitySpec | undefined = findEntity(entities, request.record);
    if (!entity) {
      const known = entities.map((one) => one.id).slice(0, 12).join(", ");
      throw new Error(
        entities.length > 0
          ? `${connection.title} has no record type "${request.record}". It has: ${known}.`
          : `${connection.title}'s record types are not mapped yet: run integrate() with a model, or read by \`op\`.`,
      );
    }
    const resource = connection.resources.find((one) => one.id === entity.resource);
    const opId = resource?.listOp ?? resource?.detailOp;
    const op = opId ? getOp(connection, opId) : undefined;
    if (!op) throw new Error(`Nothing on ${connection.title} lists ${entity.name.many}.`);
    return op;
  };

  const read = async (id: string, request: ReadRequest, priority?: Priority): Promise<ReadResult> => {
    const connection = need(id);
    const op = opFor(connection, request);
    engine.seen.touch(id, Date.now());
    engine.registry.addConnection(connection);
    engine.refreshQueryIdentity(connection);
    const { key, overrides, resolved } = buildQueryRequest({
      connection: id,
      op,
      params: { ...request.params },
      resolved: { range: resolveRange({ preset: request.range ?? "30d", now: Date.now() }), filters: {} },
    });
    try {
      const outcome = await engine.queries.read({
        key,
        connection: id,
        mode: "refresh",
        maxAgeMs: freshness(request.fresh),
        ...(priority !== undefined ? { priority } : {}),
        fetcher: (validators) =>
          engine.registry.fetch(id, op.id, overrides, {
            params: resolved,
            now: Date.now(),
            resolveSecret: engine.secretFor,
            ...(validators ? { validators } : {}),
          }),
      });
      const filter = Object.entries(request.filter ?? {});
      const rows = rowsOf(outcome.body, op.rowsPath).filter((row) =>
        filter.every(([field, wanted]) => (row as Record<string, unknown> | null)?.[field] === wanted),
      );
      emit({ type: "read", connection: id, op: op.id, rows: rows.length, cache: outcome.outcome });
      return {
        rows,
        body: outcome.body,
        op: op.id,
        cache: outcome.outcome,
        ageMs: Number.isFinite(outcome.ageMs) ? outcome.ageMs : 0,
        warnings: outcome.meta.warnings,
      };
    } catch (error) {
      const message = error instanceof AdapterError ? (error.userMessage ?? error.message) : String(error);
      const status = error instanceof AdapterError ? error.status : 500;
      emit({ type: "read-failed", connection: id, op: op.id, message, status });
      throw error;
    }
  };

  /* What `keep` has been asked to keep warm, refreshed on each one's rhythm. */
  const kept = new Map<string, Map<string, WarmTarget>>();
  const keeper = new Keeper({
    targets: () => [...kept.values()].flatMap((targets) => [...targets.values()]),
    refresh: async (target) => {
      const connection = store.getConnection(target.connection);
      const op = connection ? getOp(connection, target.op) : undefined;
      if (!connection || !op) return;
      engine.registry.addConnection(connection);
      return engine.queries.read({
        key: target.key,
        connection: target.connection,
        maxAgeMs: 0,
        mode: "refresh",
        fetcher: (validators) =>
          engine.registry.fetch(target.connection, target.op, { ...target.overrides }, {
            params: target.resolved,
            now: Date.now(),
            resolveSecret: engine.secretFor,
            ...(validators ? { validators } : {}),
          }),
      });
    },
    /* Kept warm because somebody asked for it, not because somebody is looking. */
    lastReadAt: () => Date.now(),
    storedAt: (key) => engine.queries.storedAt(key),
    coolingUntil: (connection) => engine.queries.coolingUntil(connection),
    everyMsFor: (target) => engine.everyMsForOp(target.connection, target.op, target.everyMs),
    now: () => Date.now(),
  });
  engine.queries.onInvalidate((connection) => keeper.forget(connection));

  return {
    /** The moving parts, for a host that serves them itself. */
    engine,
    catalog,
    keys,

    connections: {
      /**
       * Add an API from its documentation, its OpenAPI or GraphQL address, an
       * MCP server, or its name. Nothing is read from the account until it
       * has a key (or needs none).
       */
      add: async (input: { readonly from: string; readonly id?: string }): Promise<ConnectionSpec & { readonly discovery: DiscoveryResult }> => {
        const discovery = await discover(input.from, {
          fetchDocument: engine.fetchDocument,
          catalog,
          llm: llm("discover"),
          search: options.search ?? null,
          ...(options.renderDocs ? { renderDocs: options.renderDocs } : {}),
          http: engine.http,
        });
        if (!discovery.entry) throw new Error(`No API was found at ${input.from}: ${discovery.note}`);
        catalog.put(discovery.entry);
        let id = input.id ?? discovery.entry.id;
        if (!input.id) for (let suffix = 2; store.getConnection(id); suffix++) id = `${discovery.entry.id}-${suffix}`;
        const connection = connectionFromCatalog(discovery.entry, { id });
        store.putConnection(connection);
        engine.registry.addConnection(connection);
        engine.integration.whenReady(connection);
        return { ...connection, discovery };
      },
      get: (id: string): ConnectionSpec | null => store.getConnection(id),
      list: (): ConnectionSpec[] => store.listConnections(),
      /** What a connection still needs before it can be read. */
      status: (id: string) => {
        const connection = need(id);
        const missingKeys = connectionKeyRefs(connection).filter((ref) => !keys.has(ref));
        return {
          needsKey: connectionNeedsAuthSetup(connection) || missingKeys.length > 0,
          missingKeys,
          needsAddress: connectionNeedsAddress(connection),
        };
      },
      /**
       * Save a connection's key — one value, or several by name for an API
       * that signs in with more than one. The connection is checked next, by itself.
       */
      setKey: async (id: string, key: string | Readonly<Record<string, string>>): Promise<void> => {
        const connection = need(id);
        const refs = connectionKeyRefs(connection);
        if (refs.length === 0) throw new Error(`${connection.title} does not use a key.`);
        if (typeof key === "string") {
          if (refs.length > 1) throw new Error(`${connection.title} needs ${refs.length} values: pass them by name (${refs.join(", ")}).`);
          keys.set(refs[0]!, key.trim());
        } else {
          for (const [ref, value] of Object.entries(key)) if (refs.includes(ref)) keys.set(ref, value.trim());
        }
        const keyed = { ...connection, credentialsRevision: (connection.credentialsRevision ?? 0) + 1 };
        await engine.broker.forget(connection);
        store.putConnection(keyed);
        engine.queries.invalidate(id);
        engine.integration.whenReady(keyed);
      },
      remove: (id: string): void => {
        const connection = store.getConnection(id);
        if (!connection) return;
        for (const ref of connectionKeyRefs(connection)) keys.delete(ref);
        kept.delete(id);
        engine.queries.invalidate(id);
        store.deleteConnection(id);
      },
    },

    /**
     * Read the endpoints that matter, repair what the documentation got
     * wrong, confirm how each pages, and keep the result; then, with a model,
     * describe the API's record types so reads can name them. Reads only; it
     * never changes the account.
     */
    integrate: async (id: string): Promise<IntegrationRun> => {
      const run = await engine.integration.run(id);
      /* With a model, what the records are is worked out next: what lets a read name a record type. */
      const connection = store.getConnection(id);
      if (connection?.catalog) await engine.describeRecords(connection.catalog);
      if (!("error" in run)) emit({ type: "checked", connection: id, outcome: run.outcome });
      return run;
    },

    /** The record types the engine knows on a connection's API. */
    records: (id: string): readonly EntitySpec[] => entryOf(need(id))?.entities ?? [],

    read: (id: string, request: ReadRequest): Promise<ReadResult> => read(id, request),

    /**
     * Keep a connection's reads warm, each on its endpoint's own rhythm, so a
     * `read` is answered from memory. Every endpoint a record type lists from,
     * or the ones named. Returns a function that stops keeping them.
     */
    keep: (id: string, which: { readonly ops?: readonly string[]; readonly every?: number | string } = {}): (() => void) => {
      const connection = need(id);
      const ops = which.ops ?? [...new Set(connection.resources.flatMap((one) => (one.listOp ? [one.listOp] : [])))];
      const targets = new Map<string, WarmTarget>();
      for (const opId of ops) {
        const op = getOp(connection, opId);
        if (!op) continue;
        const { key, overrides, resolved } = buildQueryRequest({
          connection: id,
          op,
          params: {},
          resolved: { range: resolveRange({ preset: "30d", now: Date.now() }), filters: {} },
        });
        targets.set(key, {
          connection: id,
          op: op.id,
          key,
          overrides,
          resolved,
          because: "viewed",
          ...(which.every !== undefined ? { everyMs: freshness(which.every) } : {}),
        });
      }
      kept.set(id, targets);
      keeper.start();
      return () => {
        kept.delete(id);
        if (kept.size === 0) keeper.stop();
      };
    },

    /** Changes to a connected account, always in two steps: see what will change, then say yes. */
    writes: {
      /**
       * `sessionId` is a conversation's: asked again in the same one with the
       * same intent, the review already made comes back, without reading the
       * record again.
       */
      prepare: (intent: WriteIntent, actor: WriteActor = OWNER, options: { readonly sessionId?: string } = {}): Promise<WriteReview> =>
        engine.writes.prepare(actor, intent, options.sessionId ? { via: "chat", sessionId: options.sessionId } : { via: "form" }),
      commit: async (review: Pick<WriteReview, "pendingId" | "digest">, actor: WriteActor = OWNER): Promise<CommitResult> => {
        const result = await engine.writes.commit(actor, review.pendingId, review.digest);
        emit({ type: "write", connection: result.connection, entity: result.entity, kind: result.kind });
        return result;
      },
      discard: (review: Pick<WriteReview, "pendingId">, actor: WriteActor = OWNER): void =>
        engine.writes.discard(actor, review.pendingId),
    },

    on: (listener: (event: ConnectEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Carry on any work a previous run left; call once at start. */
    start: (): void => engine.resume(),
    /** Stop keeping anything warm and stop background reads. */
    stop: (): void => {
      keeper.stop();
      engine.stop();
    },
  };
};

export type Connect = ReturnType<typeof createConnect>;
