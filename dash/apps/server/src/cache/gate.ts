/**
 * How many requests one API gets at once, and how closely spaced.
 *
 * The cooldown in `cooldown.ts` reacts to a 429; this is what stops most of
 * them being provoked. Nothing anywhere limited concurrency before, so opening
 * a board fired every widget's sources simultaneously, each of them up to
 * `maxPages` HTTP requests, plus a fan-out of up to a hundred more — a burst
 * that would rate-limit a generous API, never mind a metered one. The board
 * then showed a row of refusals, which is the problem this whole area exists
 * to fix.
 *
 * Held per connection, like the cooldown and for the same reason: a rate limit
 * is almost always a property of the credential rather than the path, so
 * pacing one endpoint while hammering its neighbour is not pacing anything.
 *
 * Priority matters as much as the ceiling. Once requests queue, the order they
 * come off the queue decides what a person sees first, and a fan-out child for
 * a tile below the fold must not go ahead of the tile they are looking at.
 */

/** Lower runs first. */
export const enum Priority {
  /** A widget's own source. Something on screen is waiting for it. */
  Widget = 0,
  /** One row's worth of a fan-out. Enriches a tile that can already draw. */
  FanOut = 1,
  /** A name behind a reference. The cell has a legible fallback without it. */
  Lookup = 2,
  /** Setup, verification, chat. Nobody is watching a tile for these. */
  Background = 3,
}

export interface ConnectionGateOptions {
  /** In-flight requests allowed per connection. */
  readonly maxConcurrent?: number;
  /** Minimum spacing between two starts on one connection. */
  readonly minGapMs?: number;
  /** Injected so tests do not depend on the wall clock. */
  readonly now?: () => number;
  /** Injected so tests do not wait in real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Waiting {
  readonly priority: number;
  /** Ties break by arrival, so equal-priority work stays first-come. */
  readonly seq: number;
  readonly release: () => void;
}

interface Lane {
  active: number;
  lastStart: number;
  readonly queue: Waiting[];
}

export class ConnectionGate {
  private readonly lanes = new Map<string, Lane>();
  private readonly maxConcurrent: number;
  private readonly minGapMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private seq = 0;

  constructor(options: ConnectionGateOptions = {}) {
    /*
     * Unlimited by default.
     *
     * So that constructing a `QueryCache` in a test changes nothing about how
     * it behaves — the suite has thousands of cases that assume a fetch starts
     * when it is asked for. The real limits are applied where the server is
     * built, which is the one place that knows it is talking to a real API.
     */
    const asked = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
    // A ceiling of zero would mean nothing ever runs, which is never what
    // somebody setting this meant. Read it as "do not limit".
    this.maxConcurrent = asked > 0 ? asked : Number.POSITIVE_INFINITY;
    this.minGapMs = Math.max(0, options.minGapMs ?? 0);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Run `task` when this connection has room for it.
   *
   * The slot is taken for the whole task, not per HTTP request, because a
   * paginating op is one logical read and splitting it would let two ops
   * interleave their pages and finish later than either would alone.
   */
  async run<T>(connection: string, priority: number, task: () => Promise<T>): Promise<T> {
    if (this.maxConcurrent === Number.POSITIVE_INFINITY && this.minGapMs === 0) {
      return task();
    }

    const lane = this.laneFor(connection);
    await this.acquire(lane, priority);

    try {
      const gap = this.minGapMs - (this.now() - lane.lastStart);
      if (gap > 0) await this.sleep(gap);
      lane.lastStart = this.now();
      return await task();
    } finally {
      /*
       * In a `finally`, so a task that throws — which on this path is the
       * common case, since a 429 is an exception — cannot leak its slot and
       * slowly strangle the connection it was meant to protect.
       */
      lane.active--;
      this.next(lane);
    }
  }

  /** What the accounting panel shows: work waiting, per connection. */
  queued(connection: string): number {
    return this.lanes.get(connection)?.queue.length ?? 0;
  }

  private laneFor(connection: string): Lane {
    const existing = this.lanes.get(connection);
    if (existing) return existing;
    const lane: Lane = { active: 0, lastStart: Number.NEGATIVE_INFINITY, queue: [] };
    this.lanes.set(connection, lane);
    return lane;
  }

  private acquire(lane: Lane, priority: number): Promise<void> {
    if (lane.active < this.maxConcurrent && lane.queue.length === 0) {
      lane.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      lane.queue.push({ priority, seq: this.seq++, release: resolve });
      /*
       * Sorted on insert rather than scanned on release. The queue is short
       * and read far more often than it is written, and keeping it ordered
       * means `next` is a shift — so a late-arriving widget request overtakes
       * queued fan-out work without anything having to search for it.
       */
      lane.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    });
  }

  private next(lane: Lane): void {
    const waiting = lane.queue.shift();
    if (!waiting) return;
    lane.active++;
    waiting.release();
  }
}
