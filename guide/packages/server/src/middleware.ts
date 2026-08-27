import type { FreeBirdRequest, FreeBirdResponse } from "./handlers.js";

export type FreeBirdMiddleware<T = unknown> = (
  req: FreeBirdRequest<T>,
  next: () => Promise<FreeBirdResponse>,
) => Promise<FreeBirdResponse>;

/** Fixed-window rate limiter keyed by a caller-supplied function. */
export interface RateLimitOptions<T = unknown> {
  /** Max requests per window. */
  max: number;
  /** Window duration in ms. */
  windowMs: number;
  /** Key used to identify a caller. Default: `auth.userId || 'anon'`. */
  getKey?: (req: FreeBirdRequest<T>) => string;
  /** Message when the limit is hit. */
  message?: string;
}

export const rateLimit = <T = unknown>(opts: RateLimitOptions<T>): FreeBirdMiddleware<T> => {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const getKey = opts.getKey ?? ((r) => r.auth.userId ?? "anon");

  return async (req, next) => {
    const now = Date.now();
    const key = getKey(req);
    const cur = windows.get(key);
    if (!cur || cur.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    if (cur.count >= opts.max) {
      return {
        kind: "json",
        status: 429,
        body: { error: opts.message ?? "Too many requests" },
      };
    }
    cur.count += 1;
    return next();
  };
};

/**
 * Prompt-injection guardrail. Rejects requests whose body contains obviously
 * malicious patterns (system-prompt overrides, role-swapping). This is a
 * floor, not a ceiling — you still want provider-side safety.
 */
export const promptGuard = <T extends { text?: string }>(): FreeBirdMiddleware<T> => {
  const forbidden = [
    /ignore (all|previous) (instructions|prompts)/i,
    /you are now (a|the) [^.]{0,60}(admin|root|god)/i,
    /```system[\s\S]{0,2000}```/i,
  ];
  return async (req, next) => {
    const text = req.body?.text;
    if (typeof text === "string") {
      for (const pat of forbidden) {
        if (pat.test(text)) {
          return {
            kind: "json",
            status: 400,
            body: { error: "Message rejected by prompt guard" },
          };
        }
      }
    }
    return next();
  };
};

export const applyMiddlewares = <T>(
  middlewares: FreeBirdMiddleware<T>[],
  final: (req: FreeBirdRequest<T>) => Promise<FreeBirdResponse>,
) => {
  return async (req: FreeBirdRequest<T>): Promise<FreeBirdResponse> => {
    const run = (i: number): Promise<FreeBirdResponse> =>
      i >= middlewares.length
        ? final(req)
        : middlewares[i]!(req, () => run(i + 1));
    return run(0);
  };
};
