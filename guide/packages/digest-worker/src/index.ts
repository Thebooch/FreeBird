import type { DbAdapter, DigestEngine, DigestRunResult } from "@freebirdai/core";

/**
 * Worker-level options. Auth-refresh for long-running digests (e.g. JWT
 * rotation between save-time and run-time) is configured on the engine
 * itself via `DigestEngineOptions.refreshAuth` — pass it to
 * `createDigestEngine(...)` and the worker will use it automatically.
 */
export interface DigestWorkerOptions {
  digest: DigestEngine;
  db: DbAdapter;
  /** Polling interval in ms. Default 60000. */
  pollMs?: number;
  /** Distributed lock key. Default "freebird:digest:worker". */
  lockKey?: string;
  /** Lease for the distributed lock (ms). Default pollMs - 5000. */
  lockLeaseMs?: number;
  /** Callback for each digest result. */
  onResult?: (r: DigestRunResult) => void;
  /** Called when the worker encounters an error. */
  onError?: (err: unknown) => void;
  /** Called on startup. */
  onStart?: () => void;
  /** Called on stop. */
  onStop?: () => void;
}

/**
 * Standalone worker that periodically runs due digests across all tabs.
 * Mirrors `InProcessScheduler` from `@freebirdai/server` but is intended to
 * run as its own process. Multiple replicas can safely run concurrently —
 * the DB adapter's `locks` keep them from duplicating sends.
 */
export class DigestWorker {
  private readonly pollMs: number;
  private readonly lockKey: string;
  private readonly lockLeaseMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly opts: DigestWorkerOptions) {
    this.pollMs = opts.pollMs ?? 60_000;
    this.lockKey = opts.lockKey ?? "freebird:digest:worker";
    this.lockLeaseMs = opts.lockLeaseMs ?? this.pollMs - 5000;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.opts.onStart?.();
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.runOnce();
      } catch (err) {
        this.opts.onError?.(err);
      } finally {
        if (!this.stopped) this.timer = setTimeout(tick, this.pollMs);
      }
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.opts.onStop?.();
  }

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

export const createDigestWorker = (opts: DigestWorkerOptions): DigestWorker =>
  new DigestWorker(opts);
