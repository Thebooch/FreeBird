/**
 * Rate limits for pages anyone may open: so many requests a minute from one
 * address, and so many on one token. A fixed window per key, in memory: one
 * server's own count, which is what a public page needs to stop a script
 * hammering it. A hosted build behind several servers can supply a shared
 * one through the same shape.
 */
export interface RateLimiter {
  /** Whether one more is allowed for this key now; counts it when it is. */
  take(key: string, limit: number, windowMs?: number): boolean;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  take(key: string, limit: number, windowMs = 60_000): boolean {
    const at = this.now();
    const held = this.windows.get(key);
    if (!held || at - held.start >= windowMs) {
      this.windows.set(key, { start: at, count: 1 });
      if (this.windows.size > 10_000) this.sweep(at, windowMs);
      return true;
    }
    if (held.count >= limit) return false;
    held.count++;
    return true;
  }

  private sweep(at: number, windowMs: number): void {
    for (const [key, held] of this.windows) if (at - held.start >= windowMs) this.windows.delete(key);
  }
}
