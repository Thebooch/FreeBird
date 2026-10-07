import { type CatalogEntry, type ConnectionSpec, type EntitySpec, getOp, type OpSpec, type ReadCompletion, resolveRange } from "@freebirdai/connect-spec";
import { AdapterError } from "./adapters/index.js";
import type { Priority } from "./cache/gate.js";
import type { ConnectionRepository } from "./connections.js";
import type { Engine } from "./engine.js";
import { rowsOf } from "./integrate/read.js";
import { findEntity } from "./writes/service.js";

/**
 * The single read: what `connect.read()` answers, and what a host such as
 * FreeBird Dash reads with when something other than a board needs records —
 * a workflow, say. One function, so every reader of an account goes through
 * the same cache, gate and long-read handling.
 */

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
  /**
   * When the answer is longer than one read takes, the rest is read in the
   * background. `true` (the default) waits for it and returns every record;
   * `false` returns what the first read got, with `progress` saying how far
   * the rest has got. Read again later for the whole answer.
   */
  readonly wait?: boolean;
  /** The longest `wait` waits, in milliseconds. Default two minutes. */
  readonly waitMs?: number;
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
  /**
   * Whether these are known to be all the records: the read reached its end
   * (`completion.state` is `traversed`), nothing was cut short, and nothing is
   * still being read. False whenever that is not established, including when
   * the end is unknown.
   */
  readonly complete: boolean;
  /** How the read ended, as the adapter judged it: traversed to its end, partial, or unknown. */
  readonly completion?: ReadCompletion | undefined;
  /** Pages read for this answer. */
  readonly pages: number;
  /** How many records the API says there are, where it says. */
  readonly reportedTotal?: number | undefined;
  /** The rest of the answer, being read in the background: how far it has got. Null when there is none. */
  readonly progress: {
    readonly state: string;
    readonly read: number;
    readonly of?: number | undefined;
    readonly error?: string | undefined;
  } | null;
  /** A change in the endpoint's response since it was accepted, in words; null when there is none. */
  readonly changed: string | null;
}

/** "30s", "5m", "1h", "1d" or a number of milliseconds. */
export const freshness = (value: number | string | undefined): number => {
  if (value === undefined) return 5 * 60_000;
  if (typeof value === "number") return Math.max(0, value);
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`"${value}" is not a duration: use 30s, 5m, 1h or 1d.`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "ms" | "s" | "m" | "h" | "d"];
  return Math.round(Number(match[1]) * unit);
};

export interface RecordReaderDeps {
  readonly engine: Pick<Engine, "read" | "settled" | "seen">;
  readonly store: Pick<ConnectionRepository, "getConnection">;
  /** The catalog entry behind a connection: what lets a read name a record type. */
  readonly entryOf: (connection: ConnectionSpec) => CatalogEntry | undefined;
  /** Told after every read, and every failed one. */
  readonly onRead?: (event: { readonly connection: string; readonly op: string; readonly rows: number; readonly cache: ReadResult["cache"] }) => void;
  readonly onReadFailed?: (event: { readonly connection: string; readonly op: string; readonly message: string; readonly status: number }) => void;
  readonly now?: () => number;
}

export type RecordReader = (connection: string, request: ReadRequest, priority?: Priority) => Promise<ReadResult>;

export const createRecordReader = (deps: RecordReaderDeps): RecordReader => {
  const now = deps.now ?? Date.now;

  const need = (id: string): ConnectionSpec => {
    const connection = deps.store.getConnection(id);
    if (!connection) throw Object.assign(new Error(`There is no connection "${id}".`), { status: 404 });
    return connection;
  };

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
    const entities = deps.entryOf(connection)?.entities ?? [];
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

  return async (id, request, priority) => {
    const connection = need(id);
    const op = opFor(connection, request);
    deps.engine.seen.touch(id, now());
    const asked = {
      connection,
      op,
      params: { ...request.params },
      resolved: { range: resolveRange({ preset: request.range ?? "30d", now: now() }), filters: {} },
      maxAgeMs: freshness(request.fresh),
      ...(priority !== undefined ? { priority } : {}),
    };
    try {
      /* The engine's read: the same one Dash's tiles go through. */
      let answer = await deps.engine.read({ ...asked, mode: "refresh" });
      const unfinished = (status: typeof answer.reading) => status !== null && status.state !== "done" && status.state !== "cancelled";
      if ((request.wait ?? true) && unfinished(answer.reading)) {
        /* The rest is being read in the background: wait for it, then take the whole answer as now held. */
        await deps.engine.settled(answer.key, request.waitMs);
        answer = await deps.engine.read({ ...asked, mode: "view" });
      }
      const { outcome, meta, reading, changed } = answer;
      const filter = Object.entries(request.filter ?? {});
      const rows = rowsOf(outcome.body, op.rowsPath).filter((row) =>
        filter.every(([field, wanted]) => (row as Record<string, unknown> | null)?.[field] === wanted),
      );
      const progress = reading
        ? {
            state: reading.state,
            read: reading.read,
            ...(reading.of !== undefined ? { of: reading.of } : {}),
            ...(reading.error ? { error: reading.error } : {}),
          }
        : null;
      /*
       * Only on affirmative evidence: the read was traversed to its end, nothing
       * was cut short, and nothing is still being read. An unknown end (paging
       * nobody confirmed, say) is not complete, however the background work went.
       */
      const complete = !unfinished(reading) && !meta.truncated && meta.completion?.state === "traversed";
      deps.onRead?.({ connection: id, op: op.id, rows: rows.length, cache: outcome.outcome });
      return {
        rows,
        body: outcome.body,
        op: op.id,
        cache: outcome.outcome,
        ageMs: Number.isFinite(outcome.ageMs) ? outcome.ageMs : 0,
        warnings: changed ? [...meta.warnings, changed] : meta.warnings,
        complete,
        ...(meta.completion ? { completion: meta.completion } : {}),
        pages: meta.pages,
        ...(meta.reportedTotal !== undefined ? { reportedTotal: meta.reportedTotal } : {}),
        progress,
        changed,
      };
    } catch (error) {
      const message = error instanceof AdapterError ? (error.userMessage ?? error.message) : String(error);
      const status = error instanceof AdapterError ? error.status : 500;
      deps.onReadFailed?.({ connection: id, op: op.id, message, status });
      throw error;
    }
  };
};
