import { fingerprintConnection, getOp, type ConnectionSpec } from "@freebirdai/connect-spec";
import type { Job, JobStore } from "./store.js";

/**
 * Which endpoints a check reads next.
 *
 * A check settles up to eight endpoints. Which eight used to be decided
 * afresh each time from the connection alone, and remembered in memory: an
 * endpoint was marked covered before its check ran, so a check that failed
 * left it covered; the ninth endpoint a board read was never reached; a
 * change seen on one endpoint started a check of the connection, not of that
 * endpoint; and a restart forgot all of it.
 *
 * Now each endpoint waiting for a check is a job in the job store, keyed by
 * connection and endpoint, under the configuration it would be checked with
 * — the connection narrowed to that endpoint, so a check's own changes to
 * other endpoints leave it alone, and a new key, address or request for it
 * makes it due again. An endpoint is settled only once a check has recorded
 * evidence for it, never when its check starts. A check takes the eight most
 * pressing, and runs again while any are due: a change seen first, then what
 * boards newly read, then what no check has settled, then the rest.
 */

export type CheckReason = "drift" | "used" | "unsettled" | "rest";
export type BlockedBecause = "rate-limit" | "needs-input" | "needs-credential" | "failed";

const PRIORITY: Readonly<Record<CheckReason, number>> = { drift: 3, used: 2, unsettled: 1, rest: 0 };

/** How long an endpoint waits after its check failed, before it is due again. */
const WAIT_MS: Readonly<Record<BlockedBecause, number>> = {
  "rate-limit": 15 * 60_000,
  /* Until somebody supplies it — which changes the configuration, and makes it due at once. */
  "needs-input": 24 * 60 * 60_000,
  "needs-credential": 24 * 60 * 60_000,
  failed: 30 * 60_000,
};
const WAIT_MAX_MS = 24 * 60 * 60_000;

interface Progress {
  readonly reason: CheckReason;
  readonly because?: BlockedBecause;
  readonly settledAt?: number;
}

/** The configuration an endpoint's check is about: the connection, narrowed to that endpoint. */
export const checkVersion = (connection: ConnectionSpec, op: string): string =>
  fingerprintConnection({ ...connection, ops: connection.ops.filter((one) => one.id === op) });

const idOf = (connection: string, op: string): string => `check:${connection}:${op}`;

export class CheckQueue {
  constructor(private readonly deps: { readonly store: JobStore; readonly now: () => number }) {}

  /**
   * Endpoints due a check, for a reason. One already settled under this
   * configuration stays settled — unless what is seen now is a change, which
   * is always checked again, first, or somebody asked for a check (`again`).
   */
  async enqueue(
    connection: ConnectionSpec,
    ops: readonly string[],
    reason: CheckReason,
    options: { readonly again?: boolean } = {},
  ): Promise<void> {
    const now = this.deps.now();
    for (const op of new Set(ops)) {
      if (!getOp(connection, op)) continue;
      const version = checkVersion(connection, op);
      const held = await this.deps.store.get(idOf(connection.id, op));
      const current = held !== null && held.configVersion === version;
      if (current && held.state === "running") continue;
      if (current && held.state === "done" && reason !== "drift" && !options.again) continue;
      /* Waiting already, for as good a reason or a better one: left as it is. */
      if (current && (held.state === "pending" || held.state === "blocked") && held.priority >= PRIORITY[reason]) continue;
      const priority = Math.max(PRIORITY[reason], current && held.state !== "done" ? held.priority : 0);
      await this.deps.store.put({
        id: idOf(connection.id, op),
        kind: "check",
        connection: connection.id,
        op,
        configVersion: version,
        state: "pending",
        priority,
        progress: { reason } satisfies Progress,
        attempts: current ? held.attempts : 0,
        /* A change seen is checked at once, whatever the last failure asked it to wait for. */
        ...(current && reason !== "drift" && held.notBefore !== undefined ? { notBefore: held.notBefore } : {}),
        createdAt: current ? held.createdAt : now,
        updatedAt: now,
      });
    }
  }

  /**
   * The most pressing endpoints due now, at most `max`, marked as being
   * checked. One settled under another configuration than the connection's
   * now is due again.
   */
  async take(connection: ConnectionSpec, max: number): Promise<string[]> {
    const due = await this.due(connection);
    const now = this.deps.now();
    const taken = due.slice(0, max);
    for (const job of taken)
      await this.deps.store.put({ ...job, configVersion: checkVersion(connection, job.op!), state: "running", updatedAt: now });
    return taken.map((job) => job.op!);
  }

  /** How many endpoints are due a check now. */
  async remaining(connection: ConnectionSpec): Promise<number> {
    return (await this.due(connection)).length;
  }

  /** Whether a check has settled this endpoint under its configuration now. */
  async settled(connection: ConnectionSpec, op: string): Promise<boolean> {
    const held = await this.deps.store.get(idOf(connection.id, op));
    return held !== null && held.state === "done" && held.configVersion === checkVersion(connection, op);
  }

  /** Settled: a check recorded evidence for these, under the configuration it saved. */
  async settle(connection: ConnectionSpec, ops: readonly string[]): Promise<void> {
    const now = this.deps.now();
    for (const op of ops) {
      const held = await this.deps.store.get(idOf(connection.id, op));
      if (!getOp(connection, op)) {
        if (held) await this.deps.store.remove(held.id);
        continue;
      }
      await this.deps.store.put({
        id: idOf(connection.id, op),
        kind: "check",
        connection: connection.id,
        op,
        configVersion: checkVersion(connection, op),
        state: "done",
        priority: 0,
        progress: { reason: ((held?.progress as Progress | undefined)?.reason ?? "unsettled"), settledAt: now } satisfies Progress,
        attempts: 0,
        createdAt: held?.createdAt ?? now,
        updatedAt: now,
      });
    }
  }

  /** Its check could not settle it: due again after a wait, longer each time. */
  async block(connection: ConnectionSpec, op: string, because: BlockedBecause, error: string, retryAt?: number): Promise<void> {
    const held = await this.deps.store.get(idOf(connection.id, op));
    if (!held) return;
    const now = this.deps.now();
    const attempts = held.attempts + 1;
    const wait = Math.min(WAIT_MS[because] * (because === "failed" ? 2 ** held.attempts : 1), WAIT_MAX_MS);
    await this.deps.store.put({
      ...held,
      state: "blocked",
      attempts,
      notBefore: retryAt ?? now + wait,
      error: error.slice(0, 300),
      progress: { ...(held.progress as unknown as Progress), because } satisfies Progress,
      updatedAt: now,
    });
  }

  /** Taken but not reached — the check ran out, or stopped: waiting again, as it was. */
  async release(connection: string, ops: readonly string[]): Promise<void> {
    const now = this.deps.now();
    for (const op of ops) {
      const held = await this.deps.store.get(idOf(connection, op));
      if (held?.state === "running") await this.deps.store.put({ ...held, state: "pending", updatedAt: now });
    }
  }

  /** What is waiting on a connection, and why, for whoever asks. */
  async list(connection: string): Promise<ReadonlyArray<{ op: string; state: Job["state"]; reason: CheckReason; because?: BlockedBecause; retryAt?: number; error?: string }>> {
    return (await this.deps.store.list({ kind: "check", connection })).map((job) => {
      const progress = job.progress as unknown as Progress;
      return {
        op: job.op!,
        state: job.state,
        reason: progress.reason,
        ...(progress.because ? { because: progress.because } : {}),
        ...(job.state === "blocked" && job.notBefore !== undefined ? { retryAt: job.notBefore } : {}),
        ...(job.error ? { error: job.error } : {}),
      };
    });
  }

  /** A connection removed: nothing of it waits. */
  async forget(connection: string): Promise<void> {
    for (const job of await this.deps.store.list({ kind: "check", connection })) await this.deps.store.remove(job.id);
  }

  /** On start: a check the server stopped in the middle of is due again. */
  async resume(): Promise<void> {
    const now = this.deps.now();
    for (const job of await this.deps.store.list({ kind: "check", states: ["running"] }))
      await this.deps.store.put({ ...job, state: "pending", updatedAt: now });
  }

  private async due(connection: ConnectionSpec): Promise<Job[]> {
    const now = this.deps.now();
    const jobs = await this.deps.store.list({ kind: "check", connection: connection.id });
    return jobs
      .filter((job) => {
        if (!job.op || !getOp(connection, job.op)) return false;
        const stale = job.configVersion !== checkVersion(connection, job.op);
        /* Settled under another configuration, or waiting on a failure under one: due under this one. */
        if (stale) return job.state !== "running";
        if (job.state === "pending") return job.notBefore === undefined || job.notBefore <= now;
        if (job.state === "blocked") return job.notBefore !== undefined && job.notBefore <= now;
        return false;
      })
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  }
}
