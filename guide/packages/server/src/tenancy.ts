import type {
  AuthContext,
  ComponentRegistry,
  LlmAdapter,
  LlmGenerateOptions,
  LlmStreamChunk,
  LlmTool,
  LlmTokenUsage,
} from "@freebirdai/core";

/**
 * Multi-tenancy for `@freebirdai/server`.
 *
 * A single-tenant deployment passes a concrete `registry` and `llm` and this
 * module is a no-op fast path — deps are built once at mount and reused, with
 * zero per-request overhead (identical to the pre-tenancy behavior).
 *
 * A multi-tenant deployment (e.g. FreeBird Studio's managed backend) passes
 * *resolver functions* keyed off the request's `AuthContext`, so one server
 * process serves many sites: each request resolves the caller's own registry
 * (compiled from their manifest) and their own LLM adapter (their API key /
 * limits). Resolved registries are cached per tenant with a TTL.
 */

type MaybePromise<T> = T | Promise<T>;

export type RegistryResolver<TAuth = unknown> = (
  ctx: AuthContext,
) => MaybePromise<ComponentRegistry<any, TAuth>>;

export type LlmResolver = (ctx: AuthContext) => MaybePromise<LlmAdapter>;

/** Either a fixed value (single-tenant) or an auth-keyed resolver (multi). */
export type RegistryInput<TAuth = unknown> =
  | ComponentRegistry<any, TAuth>
  | RegistryResolver<TAuth>;
export type LlmInput = LlmAdapter | LlmResolver;

export interface TenantLimits {
  /** Reject chat turns once this many messages are sent in a UTC day. */
  maxMessagesPerDay?: number;
  /** Reject chat turns once this many tokens are consumed in a UTC day. */
  maxTokensPerDay?: number;
}

/** One completion's token usage, normalized for the metering hook. */
export interface LlmUsageRecord {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model?: string;
}

export type OnLlmUsage = (
  ctx: AuthContext,
  usage: LlmUsageRecord,
) => void | Promise<void>;

/** Resolve the cache/scoping key for an auth context. */
export type TenantKeyFn = (ctx: AuthContext) => string | undefined;

export const isRegistryResolver = <TAuth>(
  value: RegistryInput<TAuth>,
): value is RegistryResolver<TAuth> => typeof value === "function";

export const isLlmResolver = (value: LlmInput): value is LlmResolver =>
  typeof value === "function";

/**
 * Default tenant key: `orgId`, then `extra.tenantId`. Returning undefined
 * means "not tenant-scoped" — the shared/default deps are used.
 */
export const defaultTenantKey: TenantKeyFn = (ctx) => {
  if (ctx.orgId) return ctx.orgId;
  const t = ctx.extra?.["tenantId"];
  return typeof t === "string" && t.length > 0 ? t : undefined;
};

// ---------------------------------------------------------------------------
// LLM metering wrapper
// ---------------------------------------------------------------------------

const toRecord = (
  usage: LlmTokenUsage,
  model: string | undefined,
): LlmUsageRecord => ({
  inputTokens: usage.promptTokens,
  outputTokens: usage.completionTokens,
  totalTokens:
    usage.totalTokens || usage.promptTokens + usage.completionTokens,
  ...(model !== undefined ? { model } : {}),
});

/**
 * Wrap an LLM adapter so every completion carrying token usage invokes
 * `onUsage(ctx, record)`. Bound to a single request's auth context. Applies to
 * chat, layout planning, explain, and digest summaries alike — anywhere the
 * adapter is used — because it decorates the adapter itself rather than any one
 * call site. Metering-hook failures never break generation.
 */
export const meteredLlm = (
  llm: LlmAdapter,
  ctx: AuthContext,
  onUsage: OnLlmUsage,
): LlmAdapter => {
  const report = (usage: LlmTokenUsage | undefined, model: string | undefined) => {
    if (!usage) return;
    try {
      const maybe = onUsage(ctx, toRecord(usage, model));
      if (maybe && typeof (maybe as Promise<void>).catch === "function") {
        (maybe as Promise<void>).catch((err) => {
          console.error("[freebird] onLlmUsage hook rejected:", err);
        });
      }
    } catch (err) {
      console.error("[freebird] onLlmUsage hook threw:", err);
    }
  };

  return {
    get defaultModel() {
      return llm.defaultModel;
    },
    async *stream<TTools extends Record<string, LlmTool> = {}>(
      opts: LlmGenerateOptions<TTools>,
    ): AsyncIterable<LlmStreamChunk> {
      let lastModel: string | undefined;
      for await (const chunk of llm.stream(opts)) {
        if (chunk.model) lastModel = chunk.model;
        if (chunk.usage) report(chunk.usage, chunk.model ?? lastModel);
        yield chunk;
      }
    },
    async generate<TTools extends Record<string, LlmTool> = {}>(
      opts: LlmGenerateOptions<TTools>,
    ) {
      const res = await llm.generate(opts);
      report(res.usage, res.model);
      return res;
    },
  };
};

// ---------------------------------------------------------------------------
// Per-tenant registry cache
// ---------------------------------------------------------------------------

interface CacheEntry<TAuth> {
  registry: ComponentRegistry<any, TAuth>;
  expiresAt: number;
}

/**
 * TTL cache for resolver-produced registries, keyed by tenant. Studio calls
 * {@link invalidate} when a site's manifest changes so the next request
 * recompiles.
 */
export class RegistryCache<TAuth = unknown> {
  private readonly entries = new Map<string, CacheEntry<TAuth>>();
  constructor(private readonly ttlMs: number) {}

  async resolve(
    key: string,
    resolver: RegistryResolver<TAuth>,
    ctx: AuthContext,
  ): Promise<ComponentRegistry<any, TAuth>> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.registry;
    const registry = await resolver(ctx);
    this.entries.set(key, { registry, expiresAt: now + this.ttlMs });
    return registry;
  }

  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}
