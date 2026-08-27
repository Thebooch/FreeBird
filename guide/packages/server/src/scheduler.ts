import type { DbAdapter, DigestEngine, DigestRunResult } from "@freebirdai/core";

export interface InProcessSchedulerOptions {
  digest: DigestEngine;
  db: DbAdapter;
  /** Poll interval in ms. Default 60000 (one minute). */
  pollMs?: number;
  /** Name of the distributed lock used to prevent duplicate runs. */
  lockKey?: string;
  /** Lease for the lock (ms). Default 55000 — just under the poll. */
  lockLeaseMs?: number;
  /** Callback when a digest finishes (success or failure). */
  onResult?: (r: DigestRunResult) => void;
  /** Callback when the scheduler encounters an unexpected error. */
  onError?: (err: unknown) => void;
}

/**
 * Tiny in-process cron for digests. Suitable for single-replica deployments
 * and local development. For multi-replica production, run the standalone
 * `@freebirdai/digest-worker` and disable this with `{ scheduler: "external" }`.
 *
 * Uses the DbAdapter's optional lock when available so that if a host
 * accidentally runs multiple replicas in-process mode, only one replica
 * fires the digest.
 */
export class InProcessScheduler {
  private readonly pollMs: number;
  private readonly lockKey: string;
  private readonly lockLeaseMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly opts: InProcessSchedulerOptions) {
    this.pollMs = opts.pollMs ?? 60_000;
    this.lockKey = opts.lockKey ?? "freebird:digest:scheduler";
    this.lockLeaseMs = opts.lockLeaseMs ?? this.pollMs - 5000;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.runOnce();
      } catch (err) {
        this.opts.onError?.(err);
      } finally {
        if (!this.stopped) {
          this.timer = setTimeout(tick, this.pollMs);
        }
      }
    };
    this.timer = setTimeout(tick, this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Run one scheduling pass — exposed for tests / CLI. */
  async runOnce(now: Date = new Date()): Promise<DigestRunResult[]> {
    const locks = this.opts.db.locks;
    const handle = locks
      ? await locks.acquire(this.lockKey, this.lockLeaseMs)
      : { release: async () => {} };
    if (!handle) return [];
    try {
      const results = await this.opts.digest.runDue(now);
      for (const r of results) this.opts.onResult?.(r);
      return results;
    } finally {
      await handle.release();
    }
  }
}

export const createInProcessScheduler = (
  opts: InProcessSchedulerOptions,
): InProcessScheduler => new InProcessScheduler(opts);
