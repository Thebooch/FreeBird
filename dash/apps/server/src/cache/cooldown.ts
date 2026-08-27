/**
 * Not calling an API that has just told us to stop.
 *
 * `rest.ts` already reads `Retry-After` off a 429 and attaches it to the error,
 * and until now nothing acted on it — every widget on the board went on to make
 * its own request and collect its own 429. One rate-limited endpoint became
 * eleven refused ones.
 *
 * Held per connection rather than per endpoint, because a rate limit is almost
 * always a property of the credential rather than the path. Backing off one
 * endpoint while hammering its neighbour is not backing off.
 */

export interface Cooling {
  readonly connection: string;
  /** When calls may resume. */
  readonly until: number;
  /** What the upstream said, for the message shown to the reader. */
  readonly reason: string;
  readonly status: number;
}

/** Used when a 429 arrives with no `Retry-After` to go on. */
const DEFAULT_BACKOFF_MS = 60_000;
/** However long an API asks for, we stop waiting eventually. */
const MAX_BACKOFF_MS = 15 * 60_000;

export class ConnectionCooldown {
  private readonly cooling = new Map<string, Cooling>();

  /**
   * Record a refusal.
   *
   * `retryAfter` is the header's value: seconds, or an HTTP date. Both are
   * legal and APIs use both, so both are read — a date parsed as a number
   * would come out as `NaN` and silently disable the back-off.
   */
  refused(input: {
    connection: string;
    status: number;
    retryAfter?: string | undefined;
    reason: string;
    now: number;
  }): Cooling {
    const waitMs = Math.min(parseRetryAfter(input.retryAfter, input.now) ?? DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS);
    const entry: Cooling = {
      connection: input.connection,
      until: input.now + waitMs,
      reason: input.reason,
      status: input.status,
    };
    this.cooling.set(input.connection, entry);
    return entry;
  }

  /** The cooldown in force, or undefined once it has passed. */
  check(connection: string, now: number): Cooling | undefined {
    const entry = this.cooling.get(connection);
    if (!entry) return undefined;
    if (entry.until <= now) {
      this.cooling.delete(connection);
      return undefined;
    }
    return entry;
  }

  /** A successful call means whatever was wrong has cleared. */
  succeeded(connection: string): void {
    this.cooling.delete(connection);
  }

  clear(): void {
    this.cooling.clear();
  }
}

export const parseRetryAfter = (value: string | undefined, now: number): number | null => {
  if (!value) return null;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  // The other legal form is an HTTP date.
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
};

/** How long to wait, phrased for a person rather than in milliseconds. */
export const waitPhrase = (untilMs: number, now: number): string => {
  const seconds = Math.max(1, Math.ceil((untilMs - now) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};
