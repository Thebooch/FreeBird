import type { WarmTarget } from "./targets.js";

/**
 * Keeping the cache warm, so that looking at a board costs nothing.
 *
 * Every upstream call used to be triggered by somebody *looking* — opening a
 * board, switching a tab, reloading — so traffic was at its burstiest exactly
 * when a person was waiting, which is the shape that gets an account
 * throttled. Views no longer fetch at all (see `QueryCache.read`), and this is
 * the other half of that bargain: something has to keep the answers current,
 * and it should be something nobody is waiting for.
 *
 * Four decisions shape it.
 *
 * **The gate is the batching.** Every refresh goes through `QueryCache` at
 * `Priority.Background`, so the existing `ConnectionGate` — three at a time,
 * two hundred milliseconds apart, a tile on screen always first — decides how
 * hard anybody's API is hit. A second pacing mechanism here would be a second
 * place to get it wrong.
 *
 * **When something is due is read off the data, not remembered.** A target
 * is due when the copy under its key is older than its cadence, with a small
 * fixed offset per key so a board fetched together does not come due
 * together forever. Nothing about the schedule is stored, so moving an
 * endpoint to another cadence, coming back after a night away, or a reader
 * fetching the copy themselves all take effect at the next tick.
 *
 * **It reads the outcome, not just the absence of an exception.** The cache
 * hands back an old copy rather than throwing whenever it has one — right for
 * a reader, and useless to anything trying to tell a refusal from a success.
 * So a stale answer is inspected: a 401 or 403 stops that target until the
 * account changes, a 429 stops the whole connection until the API says it
 * may be asked again, and anything else backs off briefly.
 *
 * **It sleeps when nobody is there.** A board left open overnight polling
 * somebody's whole rate limit is a bug this codebase already fixed once, in
 * the per-widget poller; reintroducing it on the server — where closing the
 * tab would not even stop it — would be worse. A connection nothing has read
 * from recently is left alone until somebody comes back.
 */

/** How often the keeper looks for work. Not how often anything is fetched. */
export const TICK_MS = 30_000;

/** Nothing read from a connection for this long means nobody is looking. */
export const IDLE_MS = 15 * 60_000;

/** The cadence for anything nothing has an opinion about. */
export const DEFAULT_EVERY_MS = 10 * 60_000;

/**
 * How long a refresh that failed for no stated reason waits before the next.
 *
 * Its copy did not get any newer, so without this it would be due again on
 * the very next tick — a broken endpoint retried every thirty seconds.
 */
export const FAILURE_BACKOFF_MS = 5 * 60_000;

/**
 * When somebody last read from a connection.
 *
 * Distinct from the accounting's `lastCallAt`, which counts calls that left
 * this machine — and under view mode a board being read makes none of those,
 * so it would report every connection as idle the moment the cache was warm.
 * This counts *being asked*, which is the question the keeper needs answered:
 * is anybody there?
 */
export class LastSeen {
  private readonly at = new Map<string, number>();

  touch(connection: string, now: number): void {
    this.at.set(connection, now);
  }

  seenAt(connection: string): number | null {
    return this.at.get(connection) ?? null;
  }
}

/** What a refresh reports back. The shape of `QueryOutcome` the keeper reads. */
export interface RefreshOutcome {
  readonly outcome: "hit" | "miss" | "revalidating" | "stale";
  readonly error?: {
    readonly status?: number | undefined;
    readonly retryAfter?: string | undefined;
  };
}

export interface KeeperDeps {
  /** The current warm set. Re-read each pass, so a new board is picked up. */
  readonly targets: () => readonly WarmTarget[];
  /**
   * Refresh one target through the cache, paced and at background priority.
   * Resolves to nothing when the target no longer names anything.
   */
  readonly refresh: (target: WarmTarget) => Promise<RefreshOutcome | void>;
  /** When this connection was last read from, or null if never. */
  readonly lastReadAt: (connection: string) => number | null;
  /** When the copy under this key was stored, or null if there is none. */
  readonly storedAt: (key: string) => number | null;
  /** When this connection may be asked again, or null if it may now. */
  readonly coolingUntil?: (connection: string) => number | null;
  readonly now: () => number;
  /**
   * How often this particular target is worth asking again.
   *
   * Per target rather than one number for the whole keeper, because one
   * cadence for everything is wrong in both directions: applications and
   * charges arrive all day, while vendors and bank accounts change a few
   * times a year. Falls back to `everyMs` where nothing has an opinion — a
   * connection nobody has classified still has to be refreshed somehow.
   */
  readonly everyMsFor?: (target: WarmTarget) => number;
  readonly everyMs?: number;
  readonly idleMs?: number;
  /** Told when a pass finishes, for the status panel and the tests. */
  readonly onPass?: (report: KeeperPass) => void;
}

export interface KeeperPass {
  readonly at: number;
  readonly refreshed: readonly string[];
  readonly skipped: readonly { key: string; reason: "idle" | "denied" | "cooling" }[];
  readonly failed: readonly { key: string; reason: string }[];
}

interface Known {
  target: WarmTarget;
  /** Not before this, whatever the copy's age. Set by a failure or a 429. */
  holdUntil?: number;
  /**
   * Refused outright — a credential or a licence, not a rate limit.
   *
   * Dropped from the rotation rather than retried every pass: the answer will
   * not change by asking again, and the requests it costs belong to the
   * endpoints that can still answer. Lifted by `forget`, which the server
   * calls whenever the connection's data is invalidated — a credential
   * change above all, which is exactly when the answer *does* change.
   */
  denied?: string;
}

/** 401 and 403 will not change by asking again; 429 and the rest will. */
const isDenied = (status: number | undefined): boolean => status === 401 || status === 403;

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};

/**
 * A Retry-After as the upstream sent it — seconds, or an HTTP date — in
 * milliseconds from now. Undefined when there was none or it made no sense.
 */
export const retryAfterMs = (value: unknown, now: number): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value * 1000);
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
};

/**
 * A fixed 0–10% of the cadence, by key.
 *
 * Twenty widgets warmed in one pass would otherwise come due in the same
 * tick forever after. Deterministic, so a target's slot does not wander
 * between restarts.
 */
export const jitterOf = (key: string): number => {
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return (hash % 1000) / 10_000;
};

export class Keeper {
  private readonly known = new Map<string, Known>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: KeeperDeps) {}

  private get everyMs(): number {
    return this.deps.everyMs ?? DEFAULT_EVERY_MS;
  }

  /** This target's own cadence, or the keeper's if nothing has an opinion. */
  private everyMsOf(target: WarmTarget): number {
    const asked = this.deps.everyMsFor?.(target);
    return asked !== undefined && Number.isFinite(asked) && asked > 0 ? asked : this.everyMs;
  }

  private get idleMs(): number {
    return this.deps.idleMs ?? IDLE_MS;
  }

  /** When this entry next wants refreshing, read off its copy's age. */
  private dueAt(entry: Known, now: number): number {
    const stored = this.deps.storedAt(entry.target.key);
    const byAge =
      stored === null
        ? now
        : stored + this.everyMsOf(entry.target) * (1 - jitterOf(entry.target.key));
    return Math.max(byAge, entry.holdUntil ?? 0);
  }

  start(intervalMs = TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    /* Never keep the process alive on the keeper's account: a server with
     * nothing else to do should still be able to exit. */
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Lift every refusal and hold on a connection, or on all of them.
   *
   * Called when a connection's cached data is invalidated. A 403 recorded
   * against the old key says nothing about the new one, and keeping it would
   * leave the widgets it covers frozen at whatever the first read after the
   * fix returned.
   */
  forget(connection?: string): void {
    for (const entry of this.known.values()) {
      if (connection !== undefined && entry.target.connection !== connection) continue;
      delete entry.denied;
      delete entry.holdUntil;
    }
  }

  /** The warm set as it stands right now, without waiting for a tick. */
  currentTargets(): readonly WarmTarget[] {
    return this.deps.targets();
  }

  /** What the status panel reads: every target, when it is next due. */
  state(): ReadonlyArray<{
    readonly target: WarmTarget;
    readonly dueAt: number;
    readonly everyMs: number;
    readonly denied?: string;
  }> {
    const now = this.deps.now();
    return [...this.known.values()].map((entry) => ({
      target: entry.target,
      dueAt: this.dueAt(entry, now),
      everyMs: this.everyMsOf(entry.target),
      ...(entry.denied ? { denied: entry.denied } : {}),
    }));
  }

  /**
   * Take stock of the current warm set.
   *
   * A target that is already known keeps its refusal and its hold, and takes
   * the latest version of itself — a board re-saved with a new cadence is
   * picked up without losing what the keeper learned about the endpoint.
   */
  private sync(): void {
    const targets = this.deps.targets();
    const live = new Map(targets.map((target) => [target.key, target]));
    for (const key of [...this.known.keys()]) {
      if (!live.has(key)) this.known.delete(key);
    }
    for (const [key, target] of live) {
      const existing = this.known.get(key);
      if (existing) existing.target = target;
      else this.known.set(key, { target });
    }
  }

  /**
   * One pass. Refreshes what is due on connections somebody is using.
   *
   * Serial rather than parallel, deliberately: the gate would queue them
   * anyway, and awaiting each one means a pass that meets a cooldown stops
   * costing anything rather than piling up behind it.
   */
  async tick(): Promise<KeeperPass> {
    const now = this.deps.now();
    const empty: KeeperPass = { at: now, refreshed: [], skipped: [], failed: [] };
    /* A pass still running when the next tick fires is not a reason to start
     * a second one; it is a reason to wait. */
    if (this.running) return empty;
    this.running = true;

    const refreshed: string[] = [];
    const skipped: { key: string; reason: "idle" | "denied" | "cooling" }[] = [];
    const failed: { key: string; reason: string }[] = [];
    /* Connections that asked us to wait during this pass. */
    const cooling = new Set<string>();

    try {
      this.sync();

      for (const entry of this.known.values()) {
        const { target } = entry;
        if (entry.denied) {
          skipped.push({ key: target.key, reason: "denied" });
          continue;
        }
        if (this.dueAt(entry, now) > now) continue;

        const lastRead = this.deps.lastReadAt(target.connection);
        if (lastRead === null || now - lastRead > this.idleMs) {
          /* Left due, so the moment somebody comes back the next tick picks
           * it up rather than making it wait out an interval spent asleep. */
          skipped.push({ key: target.key, reason: "idle" });
          continue;
        }

        /*
         * A connection the API has told to wait is not asked anything until
         * it may be. Left due rather than pushed a whole interval out: once
         * the wait is over there is nothing to gain from leaving a board
         * stale for another ten minutes, or another day.
         */
        const until = this.deps.coolingUntil?.(target.connection) ?? null;
        if (cooling.has(target.connection) || (until !== null && until > now)) {
          skipped.push({ key: target.key, reason: "cooling" });
          continue;
        }

        let status: number | undefined;
        let retryAfter: unknown;
        let reason: string | undefined;
        try {
          const result = await this.deps.refresh(target);
          if (!result) continue;
          if (result.outcome !== "stale") {
            delete entry.holdUntil;
            refreshed.push(target.key);
            continue;
          }
          status = result.error?.status;
          retryAfter = result.error?.retryAfter;
          reason = status !== undefined ? `refused with ${status}` : "served an older copy";
        } catch (error) {
          status = statusOf(error);
          retryAfter = (error as { retryAfter?: unknown } | null)?.retryAfter;
          reason = error instanceof Error ? error.message : String(error);
        }

        const at = this.deps.now();
        if (isDenied(status)) {
          entry.denied = reason ?? `refused with ${status}`;
        } else if (status === 429) {
          cooling.add(target.connection);
          entry.holdUntil =
            this.deps.coolingUntil?.(target.connection) ??
            at + (retryAfterMs(retryAfter, at) ?? FAILURE_BACKOFF_MS);
        } else {
          entry.holdUntil = at + Math.min(FAILURE_BACKOFF_MS, this.everyMsOf(target));
        }
        failed.push({ key: target.key, reason: reason ?? "failed" });
      }
    } finally {
      this.running = false;
    }

    const report: KeeperPass = { at: now, refreshed, skipped, failed };
    this.deps.onPass?.(report);
    return report;
  }
}
