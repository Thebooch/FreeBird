import type { HttpFetch } from "@freebirdai/connect/adapters";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import {
  boardInputs,
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
import type { EvidenceStore } from "@freebirdai/connect/evidence/store";
import { integrate, type IntegrateDeps, type IntegrationReport } from "@freebirdai/connect/integrate/agent";
import { seekRecords } from "@freebirdai/connect/integrate/seek";
import type { ConnectorKit } from "@freebirdai/connect/integrate/connector";
import { inputSources } from "@freebirdai/connect/integrate/inputs";
import { type BlockedBecause, CheckQueue } from "@freebirdai/connect/jobs/check-queue";
import { MemoryJobStore } from "@freebirdai/connect/jobs/store";

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
 *   endpoint under the connection's current configuration, and which
 *   endpoints wait for a check (and why one is blocked). Free.
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
  /** Which endpoints are due a check, kept so a restart does not forget them. Memory unless supplied. */
  readonly queue?: CheckQueue;
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
  /**
   * What a search for a request's records found, kept on the catalog entry
   * and described before it returns — the brief that asked is written again
   * over it straight away. Absent, it is kept as a check's reads are.
   */
  readonly recordFound?: (
    connection: ConnectionSpec,
    observed: IntegrationReport["observed"],
    added: NonNullable<IntegrationReport["added"]>,
  ) => Promise<void>;
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

/** Every endpoint a check can read, most important first: what boards read, then each record type's list. */
export const integrationCandidates = (connection: ConnectionSpec, options: { used?: readonly string[] } = {}): string[] => {
  const readable = (opId: string | undefined): opId is string => {
    const op = opId ? getOp(connection, opId) : undefined;
    if (!op) return false;
    /* A connector reads its endpoint its own way: the path's ids are its requests' business. */
    if (op.servedBy === "connector") return missingInputs(op, {}).length === 0;
    /*
     * An input no board gives, but another list's records can: readable, the
     * check reading that list first. Such endpoints
     * were left out, and their records could never be counted.
     */
    return boardInputs(op, {}).length === 0 || (inputSources(connection, op.id)?.length ?? 0) > 0;
  };
  /* What boards read comes first: a widget over an endpoint no check reached reads one unconfirmed page. */
  const ordered = [
    connection.validateOpId,
    ...(options.used ?? []),
    ...connection.resources.map((resource) => resource.listOp),
  ];
  return [...new Set(ordered.filter(readable))];
};

export const integrationTargets = (
  connection: ConnectionSpec,
  options: { canWriteCode?: boolean; used?: readonly string[] } = {},
): string[] => {
  const targets = integrationCandidates(connection, options).slice(0, MAX_TARGETS);
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
  /** These endpoints changed since they were checked: checked again, before anything else. */
  recheck(connection: ConnectionSpec, ops: readonly string[]): void;
  /** Each endpoint's place in the queue: settled, due, or waiting after a failure, and why. */
  queued(id: string): ReturnType<CheckQueue["list"]>;
  running(id: string): boolean;
  /**
   * Look for what a request is about among the endpoints the documentation
   * names and the import missed, check each, and keep what answers with
   * records. The endpoints added; none when nothing
   * was found.
   */
  seek(id: string, request: string): Promise<{ readonly added: readonly string[]; readonly log: readonly string[] }>;
}

/** Checks one trigger may run back to back while endpoints are still due: eight endpoints each. */
const MAX_CHAIN = 6;

/** Why a check could not settle an endpoint, from what it said. */
const becauseOf = (note: string): BlockedBecause =>
  /\b429\b|rate.?limit|too many requests|try again in/i.test(note)
    ? "rate-limit"
    : /needs? (a )?value|input|cannot supply|supply/i.test(note)
      ? "needs-input"
      : /\b40[13]\b|key|credential|sign in|signing in|refused|forbidden|unauthori[sz]ed/i.test(note)
        ? "needs-credential"
        : "failed";

export const createIntegrationRunner = (deps: IntegrateRouteDeps): IntegrationRunner => {
  const inFlight = new Map<string, Promise<IntegrationRun>>();
  /* Which endpoints are due a check, and which are settled: kept, so a restart forgets none of it. */
  const queue = deps.queue ?? new CheckQueue({ store: new MemoryJobStore(), now: deps.now ?? Date.now });
  /* Checks run back to back for one trigger, so one with many endpoints due cannot run without end. */
  const chains = new Map<string, number>();

  /** What the integration loop runs with, for one connection. */
  const loopDeps = (connection: ConnectionSpec, background: boolean): IntegrateDeps => ({
    http: deps.http,
    resolveSecret: deps.resolveSecret,
    fetchDocument: deps.fetchDocument,
    now: deps.now ?? Date.now,
    llm: deps.llm(),
    around: deps.around(connection.id, background),
    ...(deps.onRead ? { onRead: deps.onRead } : {}),
    ...(deps.refresh ? { refresh: deps.refresh } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.connectors ? { connectors: deps.connectors } : {}),
    ...(deps.connectorLlm ? { connectorLlm: deps.connectorLlm() } : {}),
  });

  /**
   * The endpoints this check reads: the most pressing of those due. What
   * boards read and what no check has settled wait in the queue; a check
   * somebody asked for checks its first endpoints again too.
   */
  const targetsFor = async (connection: ConnectionSpec, background: boolean): Promise<string[]> => {
    const used = deps.usedOps ? [...deps.usedOps(connection.id)] : [];
    const candidates = integrationCandidates(connection, { used });
    const unconfirmed = (opId: string) => !getOp(connection, opId)?.paginationChecked;
    await queue.enqueue(connection, used.filter((opId) => candidates.includes(opId) && unconfirmed(opId)), "used");
    await queue.enqueue(connection, candidates.filter(unconfirmed), "unsettled");
    const first = integrationTargets(connection, { canWriteCode: !!deps.connectors, used });
    if (!background) await queue.enqueue(connection, first, "rest", { again: true });
    const taken = await queue.take(connection, MAX_TARGETS);
    /*
     * Nothing readable as documented, and a sign-in only code can send: the
     * endpoint connector code starts on, which no queue holds.
     */
    if (taken.length === 0 && candidates.length === 0) return first;
    return taken;
  };

  /** What the check found for each endpoint it was given: settled with evidence, or due again later. */
  const recordOutcomes = async (saved: ConnectionSpec, targets: readonly string[], report: IntegrationReport): Promise<void> => {
    const evidenced = new Set(report.evidence.map((one) => one.op));
    const settled = report.ops.filter((one) => one.outcome === "ready" && evidenced.has(one.op)).map((one) => one.op);
    await queue.settle(saved, settled);
    for (const opId of targets) {
      if (settled.includes(opId) || !getOp(saved, opId)) continue;
      const outcome = report.ops.find((one) => one.op === opId);
      const note = outcome?.note ?? report.blocked ?? "The check did not reach it.";
      /* Never settled without evidence: due again after a wait, so a read nothing can settle is not checked on every tick. */
      await queue.block(saved, opId, outcome?.outcome === "blocked" ? becauseOf(note) : "failed", note);
    }
  };

  const check = async (id: string, background: boolean): Promise<IntegrationRun> => {
    const connection = deps.getConnection(id);
    if (!connection) return { error: "no such connection", status: 404 };
    const targets = await targetsFor(connection, background);
    /* An MCP server's endpoints are its tools, which the check itself asks for. */
    if (targets.length === 0 && connection.kind !== "mcp")
      return background
        ? { error: "Every endpoint a check can read is settled.", status: 409 }
        : { error: "This connection has no endpoint a check can read without an input.", status: 409 };
    const entry = (connection.catalog ? deps.catalogEntry(connection.catalog) : undefined) ?? undefined;
    const now = deps.now ?? Date.now;

    let report: IntegrationReport;
    try {
      report = await integrate(
        connection,
        {
          targets,
          entry,
          requests: REQUESTS,
          traverseUpTo: TRAVERSE_UP_TO,
          sample: samplingTargets(connection, entry, targets),
        },
        loopDeps(connection, background),
      );
    } catch (error) {
      /* Stopped part-way: what it was given waits again, as it was. */
      await queue.release(connection.id, targets);
      throw error;
    }
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
      await queue.release(connection.id, targets);
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
    const saved: ConnectionSpec = {
      ...report.connection,
      ...(moved ? { credentialsRevision: (connection.credentialsRevision ?? 0) + 1 } : {}),
      integration: {
        at: new Date(now()).toISOString(),
        outcome: report.outcome,
        changes: report.changes.slice(0, 20).map((change) => change.slice(0, 400)),
        notes: report.ops.slice(0, 20).map((one) => `${one.title}: ${one.note}`.slice(0, 400)),
      },
    };
    deps.saveConnection(saved, report.changed);
    /* Settled under what was saved, never before the check ran: what it changed is what it settled. */
    try {
      await recordOutcomes(saved, targets, report);
    } catch (error) {
      deps.log?.(`which of ${connection.id}'s endpoints are settled could not be kept: ${error instanceof Error ? error.message : String(error)}`);
    }
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
      .finally(() => {
        inFlight.delete(id);
        void rearm(id).catch((error: unknown) => deps.log?.(`checking ${id} again failed: ${String(error)}`));
      });
    inFlight.set(id, started);
    return started;
  };

  /*
   * Endpoints still due once a check ends — the ninth a board reads, a change
   * seen while it ran: checked next, by itself, a bounded number of times
   * back to back. Never past what is due: a blocked endpoint waits its turn.
   */
  const rearm = async (id: string): Promise<void> => {
    const connection = deps.getConnection(id);
    const chain = (chains.get(id) ?? 0) + 1;
    if (!deps.auto || !connection || chain > MAX_CHAIN || (await queue.remaining(connection)) === 0) {
      chains.delete(id);
      return;
    }
    chains.set(id, chain);
    whenReady(connection);
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
   * A board began reading an endpoint no check has settled: due a check, by
   * itself, so its paging is confirmed and its filters found. Settled once,
   * under its configuration — kept across restarts — so saving a board is
   * never a loop of checks, and one that failed waits before it is tried again.
   */
  const whenUsed: IntegrationRunner["whenUsed"] = (connection, ops) => {
    const fresh = ops.filter((opId) => {
      const op = getOp(connection, opId);
      return !!op && !op.paginationChecked;
    });
    if (fresh.length === 0) return;
    void (async () => {
      await queue.enqueue(connection, fresh, "used");
      if ((await queue.remaining(connection)) > 0) whenReady(connection);
    })().catch((error: unknown) => deps.log?.(`checking ${connection.id}'s endpoints could not be queued: ${String(error)}`));
  };

  /* A change seen on these endpoints: checked again, first — the endpoints themselves, not the whole connection. */
  const recheck: IntegrationRunner["recheck"] = (connection, ops) => {
    void (async () => {
      await queue.enqueue(connection, ops, "drift");
      whenReady(connection);
    })().catch((error: unknown) => deps.log?.(`checking ${connection.id} again could not be queued: ${String(error)}`));
  };

  const seek: IntegrationRunner["seek"] = async (id, request) => {
    const connection = deps.getConnection(id);
    const entry = connection?.catalog ? deps.catalogEntry(connection.catalog) : undefined;
    if (!connection || !entry) return { added: [], log: [] };
    const sought = await seekRecords({ connection, entry, request, deps: loopDeps(connection, false) });
    if (!sought || sought.added.length === 0) return { added: [], log: sought?.log ?? [] };
    /* Changed meanwhile — a new key, a new address: what was found describes the old one. */
    const latest = deps.getConnection(id);
    if (!latest || fingerprintConnection(latest) !== fingerprintConnection(connection)) return { added: [], log: sought.log };
    deps.saveConnection(sought.connection, true);
    const added = {
      ops: sought.entry.ops.filter((op) => sought.added.includes(op.id)),
      resources: sought.entry.resources.filter((one) => one.listOp !== undefined && sought.added.includes(one.listOp)),
      replaced: [] as string[],
    };
    try {
      if (deps.recordFound) await deps.recordFound(sought.connection, sought.report.observed, added);
      else deps.recordObserved?.(sought.connection, sought.report.observed, added);
    } catch (error) {
      deps.log?.(`what was found for ${id} could not be kept: ${error instanceof Error ? error.message : String(error)}`);
    }
    deps.log?.(`looked for "${request.slice(0, 80)}" on ${id}: added ${sought.added.join(", ")}`);
    return { added: sought.added, log: sought.log };
  };

  return { run, whenReady, whenUsed, recheck, queued: (id) => queue.list(id), running: (id) => inFlight.has(id), seek };
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
      /* Which endpoints wait for a check, and why one that failed is waiting: said, not hidden. */
      const waiting = (await runner.queued(connection.id).catch(() => [])).filter((one) => one.state !== "done");
      return {
        checking: runner.running(connection.id),
        waiting,
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
