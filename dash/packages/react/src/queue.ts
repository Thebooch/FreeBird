/**
 * What the browser asks for first when a board opens.
 *
 * The server has a gate of its own, and it is the one that matters for
 * correctness: it holds the cooldown and the accounting, and it is the only
 * layer that works when several people have the same board open. This is the
 * *ordering* layer, and it exists because only the browser knows which tile is
 * on screen. Without it the server would faithfully serve a fan-out burst for
 * a widget below the fold ahead of the one somebody is looking at.
 *
 * Three waves, in the order a person notices them:
 *
 * 1. a widget's own sources — something visible is blank until these land
 * 2. fan-out children — the tile can already draw; these complete a total
 * 3. reference lookups — the cell has a legible fallback without them
 *
 * There is deliberately no fourth wave of speculative prefetching. Drill-downs
 * fetch when opened and record tabs when activated, and guessing ahead of that
 * would spend somebody's rate limit on what they have not looked at — the same
 * thing `LazyWidget` exists to refuse.
 */

/** Lower runs first. Mirrors the server's own tiers. */
export const enum Wave {
  /** A forced refresh. Somebody just pressed a button and is watching it. */
  Forced = -1,
  /** A widget's own source. */
  Widget = 0,
  /** One row's worth of a fan-out. */
  FanOut = 1,
  /** The name behind a reference column. */
  Lookup = 2,
}

/** How long a slot may be held before it is assumed lost. */
const SLOT_TIMEOUT_MS = 30_000;

interface Waiting {
  readonly connection: string;
  readonly wave: number;
  /** Ties break by arrival, so equal waves stay first-come. */
  readonly seq: number;
  readonly release: () => void;
}

export interface RequestQueueOptions {
  /** Requests in flight across the whole board. */
  readonly maxConcurrent?: number;
  /** Requests in flight against any one connection. */
  readonly maxPerConnection?: number;
  /** Injected so tests need not wait in real time. */
  readonly timeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export class RequestQueue {
  private readonly queue: Waiting[] = [];
  private readonly perConnection = new Map<string, number>();
  private readonly maxConcurrent: number;
  private readonly maxPerConnection: number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private active = 0;
  private seq = 0;

  constructor(options: RequestQueueOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 6;
    this.maxPerConnection = options.maxPerConnection ?? 3;
    this.setTimer =
      options.timeout ?? ((run, ms) => (typeof setTimeout === "function" ? setTimeout(run, ms) : 0));
    this.clearTimer =
      options.clearTimeout ??
      ((handle) => {
        if (typeof clearTimeout === "function") clearTimeout(handle as never);
      });
  }

  /** Run `task` when the board and this connection both have room. */
  async run<T>(connection: string, wave: number, task: () => Promise<T>): Promise<T> {
    await this.acquire(connection, wave);

    /*
     * A slot released on a timer as well as on completion.
     *
     * Nothing here can cancel a request — `ensure` never passes an abort
     * signal — so a request that never settles would hold its slot forever and
     * the board would stop loading entirely. Degrading to no limiting is a far
     * better failure than a permanently stalled page.
     */
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
      this.perConnection.set(connection, (this.perConnection.get(connection) ?? 1) - 1);
      this.next();
    };
    const timer = this.setTimer(release, SLOT_TIMEOUT_MS);

    try {
      return await task();
    } finally {
      this.clearTimer(timer);
      release();
    }
  }

  private hasRoom(connection: string): boolean {
    return (
      this.active < this.maxConcurrent &&
      (this.perConnection.get(connection) ?? 0) < this.maxPerConnection
    );
  }

  private take(connection: string): void {
    this.active++;
    this.perConnection.set(connection, (this.perConnection.get(connection) ?? 0) + 1);
  }

  private acquire(connection: string, wave: number): Promise<void> {
    if (this.queue.length === 0 && this.hasRoom(connection)) {
      this.take(connection);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({
        connection,
        wave,
        seq: this.seq++,
        release: () => {
          this.take(connection);
          resolve();
        },
      });
      // Sorted on insert: the queue is short and read far more often than
      // written, so a late widget request overtakes queued lookups for free.
      this.queue.sort((a, b) => a.wave - b.wave || a.seq - b.seq);
    });
  }

  /**
   * Start the best-placed waiting request that can actually run.
   *
   * Not simply the front of the queue: that entry may belong to a connection
   * already at its own cap, and starting it would break the per-connection
   * limit — which is the one that maps to a rate limit. Scanning past it lets
   * a second API's work proceed while the first is saturated, instead of the
   * whole board waiting on the busiest connection.
   */
  private next(): void {
    const index = this.queue.findIndex((waiting) => this.hasRoom(waiting.connection));
    if (index === -1) return;
    const [waiting] = this.queue.splice(index, 1);
    waiting?.release();
  }

  /** For the inspector and for tests. */
  get pending(): number {
    return this.queue.length;
  }
}
