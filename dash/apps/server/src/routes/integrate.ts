import type { HttpFetch } from "@freebirdai/dash-adapters";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import {
  connectionKeyRefs,
  connectionNeedsAddress,
  fingerprintConnection,
  getOp,
  missingInputs,
  pathParamNames,
  strongestEvidence,
  type CatalogEntry,
  type ConnectionSpec,
} from "@freebirdai/dash-spec";
import type { FastifyInstance } from "fastify";
import type { EvidenceStore } from "../evidence/store.js";
import { integrate, type IntegrateDeps, type IntegrationReport } from "../integrate/agent.js";
import type { ConnectorKit } from "../integrate/connector.js";

/**
 * The integration loop, for a connection somebody has just given a key to.
 *
 * It runs by itself. Somebody pastes a key — or adds an API that needs none,
 * or fills in the address of their account — and the connection is checked in
 * the background: the endpoints that matter are read, what the documentation
 * got wrong is repaired, how each pages is confirmed, and the result is kept.
 * Nobody is asked to start it, and nobody is asked a technical question
 * about it.
 *
 * - `POST /api/connections/:id/integrate` — check now, or wait for the check
 *   already running. API requests, bounded; model calls only when the
 *   built-in repairs are not enough. Reads only: it never changes the account.
 * - `GET  /api/connections/:id/evidence` — what has been observed about each
 *   endpoint under the connection's current configuration. Free.
 */

export interface IntegrateRouteDeps {
  readonly getConnection: (id: string) => ConnectionSpec | null | undefined;
  /** Save a changed connection the way every other change is saved: invalidating what it read. */
  readonly saveConnection: (next: ConnectionSpec, changed: boolean) => void;
  readonly catalogEntry: (id: string) => CatalogEntry | null | undefined;
  readonly hasSecret: (keyRef: string) => boolean;
  readonly resolveSecret: (keyRef: string) => Promise<string | null>;
  readonly http: HttpFetch;
  readonly fetchDocument: (url: string) => Promise<{ status: number; text: string; url: string }>;
  readonly llm: () => LlmAdapter | null;
  readonly evidence: EvidenceStore;
  /**
   * Told what a check that read something established, so the API's catalog
   * entry can say when it was last checked and how far each endpoint got.
   */
  readonly recordCheck?: (connection: ConnectionSpec, report: Pick<IntegrationReport, "outcome" | "evidence">) => void;
  /** The per-connection gate and cooldown; a check started by itself waits behind boards. */
  readonly around: (connection: string, background: boolean) => <T>(run: () => Promise<T>) => Promise<T>;
  /** Told of every read the check sends: the journal keeps the ones that might not be reads. */
  readonly onRead?: IntegrateDeps["onRead"];
  /** A new token after a refusal, for an OAuth connection. */
  readonly refresh?: IntegrateDeps["refresh"];
  /**
   * Whether a check starts by itself when a connection becomes readable.
   * **Off unless asked**, for the keeper's reason: a test must not spend
   * somebody's requests by existing. The real entry point turns it on.
   */
  readonly auto: boolean;
  /** The endpoints boards read on a connection, checked before any other. */
  readonly usedOps?: (connection: string) => readonly string[];
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  /** Running connector code. Absent: the check repairs in the connection's own vocabulary only. */
  readonly connectors?: ConnectorKit;
  /** The model that writes connector code — its own task, so it can be chosen apart from repairs. */
  readonly connectorLlm?: () => LlmAdapter | null;
  /**
   * What the check's reads showed, for the catalog entry: fields for endpoints
   * the documentation declared none for, and the record types that can then
   * be described. Absent in tests that do not keep a catalog.
   */
  readonly recordObserved?: (
    connection: ConnectionSpec,
    observed: IntegrationReport["observed"],
    added?: IntegrationReport["added"],
  ) => void;
  /** Waiting out a short rate limit during a check. Absent, a rate limit stops it. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Keep what the records held, per connection: this account's, so never with the catalog. */
  readonly recordValues?: (connection: ConnectionSpec, values: IntegrationReport["values"]) => Promise<void>;
}

/** How many endpoints a check settles, and what it may spend doing it. */
const MAX_TARGETS = 8;
/** Collections a check reads one first page of, for their fields. */
const MAX_SAMPLES = 40;
const REQUESTS = 60;
const TRAVERSE_UP_TO = 20;

/**
 * The endpoints worth checking, most important first: the one discovery
 * chose to validate with, then each record type's list — those a board can
 * read with no input, since a check has none to give.
 */
/**
 * The other collections worth one first page each: those the check does not
 * settle and whose documentation declared no fields, so a read is the only
 * account of their records there will be.
 */
export const samplingTargets = (
  connection: ConnectionSpec,
  entry: CatalogEntry | undefined,
  settled: readonly string[],
): string[] =>
  connection.resources
    .map((resource) => resource.listOp)
    .filter((opId): opId is string => {
      if (!opId || settled.includes(opId)) return false;
      const op = getOp(connection, opId);
      if (!op || pathParamNames(op.path).length > 0 || missingInputs(op, {}).length > 0 || op.servedBy === "connector") return false;
      const declared = entry?.ops.find((one) => one.id === opId);
      return !declared?.fields || declared.fields.length === 0;
    })
    .filter((opId, index, all) => all.indexOf(opId) === index)
    .slice(0, MAX_SAMPLES);

export const integrationTargets = (
  connection: ConnectionSpec,
  options: { canWriteCode?: boolean; used?: readonly string[] } = {},
): string[] => {
  const readable = (opId: string | undefined): opId is string => {
    const op = opId ? getOp(connection, opId) : undefined;
    /* A connector reads its endpoint its own way: the path's ids are its requests' business. */
    return (
      !!op && (op.servedBy === "connector" || pathParamNames(op.path).length === 0) && missingInputs(op, {}).length === 0
    );
  };
  /* What boards read comes first: a widget over an endpoint no check reached reads one unconfirmed page. */
  const ordered = [
    connection.validateOpId,
    ...(options.used ?? []),
    ...connection.resources.map((resource) => resource.listOp),
  ];
  const targets = [...new Set(ordered.filter(readable))].slice(0, MAX_TARGETS);
  /*
   * Nothing is readable as the documentation describes it and the sign-in is
   * one no connection can send: the endpoint discovery chose to validate with
   * is where connector code starts. Only where code can be written at all.
   */
  if (targets.length === 0 && options.canWriteCode && connection.authRequired && connection.auth.type === "none") {
    /*
     * Failing that, the first collection the documentation offers, even one
     * whose path needs an id: connector code may be what supplies it. Without
     * this, an API whose records exist only behind an export had nothing for
     * a check to start on, so nothing was read, nothing could be described,
     * and no request could reach it (measurement 1).
     */
    /*
     * Collections before the endpoint discovery validates with: the point is
     * to read records. Started on "check an export" instead, connector code
     * read the export's status, not the transactions it holds (measurement 1).
     */
    const fallback = [...connection.resources.map((resource) => resource.listOp), connection.validateOpId].find(
      (opId): opId is string => !!opId && !!getOp(connection, opId),
    );
    if (fallback) return [fallback];
  }
  return targets;
};

export interface IntegrationResult {
  readonly outcome: IntegrationReport["outcome"];
  readonly blocked?: string;
  readonly changes: readonly string[];
  readonly ops: IntegrationReport["ops"];
  readonly requests: number;
  readonly modelCalls: number;
  readonly log: readonly string[];
}

export type IntegrationRun = IntegrationResult | { readonly error: string; readonly status: number };

export interface IntegrationRunner {
  /** Check a connection. A check already running for it is joined, never repeated. */
  run(id: string, options?: { readonly background?: boolean }): Promise<IntegrationRun>;
  /**
   * Start a check in the background if this connection can be read now: its
   * address is known and every key it asks for is in the vault.
   */
  whenReady(connection: ConnectionSpec): void;
  /** Check a connection by itself when boards read endpoints of it no check has settled. */
  whenUsed(connection: ConnectionSpec, ops: readonly string[]): void;
  running(id: string): boolean;
}

export const createIntegrationRunner = (deps: IntegrateRouteDeps): IntegrationRunner => {
  const inFlight = new Map<string, Promise<IntegrationRun>>();
  /* The endpoints a check has settled on each connection since the server started. */
  const settled = new Map<string, Set<string>>();
  const covered = (connection: string): Set<string> => {
    const known = settled.get(connection) ?? new Set<string>();
    settled.set(connection, known);
    return known;
  };

  const check = async (id: string, background: boolean): Promise<IntegrationRun> => {
    const connection = deps.getConnection(id);
    if (!connection) return { error: "no such connection", status: 404 };
    const targets = integrationTargets(connection, {
      canWriteCode: !!deps.connectors,
      ...(deps.usedOps ? { used: deps.usedOps(connection.id) } : {}),
    });
    /* An MCP server's endpoints are its tools, which the check itself asks for. */
    if (targets.length === 0 && connection.kind !== "mcp")
      return { error: "This connection has no endpoint a check can read without an input.", status: 409 };
    const entry = (connection.catalog ? deps.catalogEntry(connection.catalog) : undefined) ?? undefined;
    const now = deps.now ?? Date.now;
    for (const opId of targets) covered(connection.id).add(opId);

    const report = await integrate(
      connection,
      {
        targets,
        entry,
        requests: REQUESTS,
        traverseUpTo: TRAVERSE_UP_TO,
        sample: samplingTargets(connection, entry, targets),
      },
      {
        http: deps.http,
        resolveSecret: deps.resolveSecret,
        fetchDocument: deps.fetchDocument,
        now,
        llm: deps.llm(),
        around: deps.around(connection.id, background),
        ...(deps.onRead ? { onRead: deps.onRead } : {}),
        ...(deps.refresh ? { refresh: deps.refresh } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.connectors ? { connectors: deps.connectors } : {}),
        ...(deps.connectorLlm ? { connectorLlm: deps.connectorLlm() } : {}),
      },
    );
    /*
     * Evidence is worth keeping, and not worth losing a check over: an
     * embedded database left damaged by a hard stop refuses writes, and the
     * connection still reads exactly as well as the check found. Said, not
     * swallowed.
     */
    try {
      for (const record of report.evidence) await deps.evidence.record(record);
    } catch (error) {
      deps.log?.(
        `evidence for ${connection.id} could not be kept: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    /*
     * Somebody may have changed the connection while it was being checked —
     * a new key, a new address. The check describes what it started from, so
     * it is not saved over a newer configuration; the change will start its
     * own check.
     */
    const latest = deps.getConnection(id);
    if (!latest || fingerprintConnection(latest) !== fingerprintConnection(connection)) {
      return { error: "The connection changed while it was being checked.", status: 409 };
    }

    /*
     * A new address or a new way of sending the key reads as a different
     * account, exactly as changing either by hand does: the revision moves,
     * so nothing read the old way is shown as if it came from the new.
     */
    const moved =
      report.connection.baseUrl !== connection.baseUrl ||
      JSON.stringify(report.connection.auth) !== JSON.stringify(connection.auth);
    deps.saveConnection(
      {
        ...report.connection,
        ...(moved ? { credentialsRevision: (connection.credentialsRevision ?? 0) + 1 } : {}),
        integration: {
          at: new Date(now()).toISOString(),
          outcome: report.outcome,
          changes: report.changes.slice(0, 20).map((change) => change.slice(0, 400)),
          notes: report.ops.slice(0, 20).map((one) => `${one.title}: ${one.note}`.slice(0, 400)),
        },
      },
      report.changed,
    );
    deps.log?.(
      `checked ${connection.id}: ${report.outcome}, ${report.changes.length} change(s), ${report.requests} request(s)`,
    );
    try {
      if (report.outcome !== "blocked") deps.recordCheck?.(report.connection, report);
    } catch (error) {
      deps.log?.(`what ${connection.id}'s check established could not be kept on its catalog entry: ${error instanceof Error ? error.message : String(error)}`);
    }
    /* Kept, never allowed to cost the check: a read that showed fields is worth describing. */
    try {
      if (Object.keys(report.observed).length > 0 || report.added)
        deps.recordObserved?.(report.connection, report.observed, report.added);
    } catch (error) {
      deps.log?.(`what ${connection.id}'s check read could not be kept: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Object.keys(report.values).length > 0) {
      await deps
        .recordValues?.(report.connection, report.values)
        .catch((error: unknown) =>
          deps.log?.(`the values ${connection.id}'s records held could not be kept: ${error instanceof Error ? error.message : String(error)}`),
        );
    }
    return {
      outcome: report.outcome,
      ...(report.blocked ? { blocked: report.blocked } : {}),
      changes: report.changes,
      ops: report.ops,
      requests: report.requests,
      modelCalls: report.modelCalls,
      log: report.log,
    };
  };

  const run: IntegrationRunner["run"] = (id, options = {}) => {
    const running = inFlight.get(id);
    if (running) return running;
    const started = check(id, options.background ?? false)
      .catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
        status: 500,
      }))
      .finally(() => inFlight.delete(id));
    inFlight.set(id, started);
    return started;
  };

  const whenReady: IntegrationRunner["whenReady"] = (connection) => {
    if (!deps.auto || inFlight.has(connection.id)) return;
    if (connectionNeedsAddress(connection)) return;
    if (!connectionKeyRefs(connection).every((ref) => deps.hasSecret(ref))) return;
    if (connection.kind !== "mcp" && integrationTargets(connection, { canWriteCode: !!deps.connectors }).length === 0) return;
    void run(connection.id, { background: true }).then((result) => {
      if ("error" in result && result.status !== 409) deps.log?.(`checking ${connection.id} failed: ${result.error}`);
    });
  };

  /*
   * A board began reading an endpoint no check has settled: check again, by
   * itself, so its paging is confirmed and its filters found. Once per
   * endpoint per run of the server, so saving a board is never a loop of checks.
   */
  const whenUsed: IntegrationRunner["whenUsed"] = (connection, ops) => {
    const fresh = ops.filter((opId) => {
      const op = getOp(connection, opId);
      return !!op && !op.paginationChecked && !covered(connection.id).has(opId);
    });
    if (fresh.length > 0) whenReady(connection);
  };

  return { run, whenReady, whenUsed, running: (id) => inFlight.has(id) };
};

export const integrateRoutes =
  (deps: IntegrateRouteDeps, runner: IntegrationRunner) =>
  async (app: FastifyInstance): Promise<void> => {
    app.post<{ Params: { id: string } }>("/api/connections/:id/integrate", async (request, reply) => {
      const result = await runner.run(request.params.id);
      if ("error" in result) return reply.status(result.status).send({ error: result.error });
      return result;
    });

    app.get<{ Params: { id: string } }>("/api/connections/:id/evidence", async (request, reply) => {
      const connection = deps.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      let records: Awaited<ReturnType<EvidenceStore["forConnection"]>>;
      try {
        records = await deps.evidence.forConnection(connection.id);
      } catch (error) {
        return reply.status(503).send({
          error: `What was observed could not be read: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const current = fingerprintConnection(connection);
      const byOp = new Map<string, typeof records>();
      for (const record of records) byOp.set(record.op, [...(byOp.get(record.op) ?? []), record]);
      return {
        checking: runner.running(connection.id),
        ops: [...byOp].map(([op, list]) => ({
          op,
          title: getOp(connection, op)?.title ?? op,
          strongest: strongestEvidence(list, current),
          /** Records from an earlier configuration: history, not a claim about now. */
          earlier: list.filter((one) => one.configVersion !== current).length,
        })),
      };
    });
  };
