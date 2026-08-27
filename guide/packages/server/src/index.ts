import type {
  AuthContext,
  ChatEngine,
  ComponentRegistry,
  CustomTabsService,
  DbAdapter,
  DigestEngine,
  EmailAdapter,
  KnowledgeGraph,
  LlmAdapter,
} from "@freebirdai/core";
import {
  createChatEngine,
  createCustomTabsService,
  createDigestEngine,
  createKnowledgeGraph,
} from "@freebirdai/core";
import type { HandlerDeps } from "./handlers.js";
import { InProcessScheduler, createInProcessScheduler } from "./scheduler.js";
import {
  RegistryCache,
  defaultTenantKey,
  isLlmResolver,
  isRegistryResolver,
  meteredLlm,
  type LlmInput,
  type OnLlmUsage,
  type RegistryInput,
  type RegistryResolver,
  type TenantKeyFn,
  type TenantLimits,
} from "./tenancy.js";
export { ROUTES } from "./handlers.js";
export type {
  FreeBirdRequest,
  FreeBirdResponse,
  FreeBirdResponseJson,
  FreeBirdResponseSse,
  HandlerDeps,
  RouteSpec,
  ChatBody,
  ExplainBody,
  CreateTabBody,
  UpdateTabBody,
  ConfirmActionBody,
  ConfirmActionResponse,
  CancelActionBody,
  UpdateActionArgsBody,
  ServerActionEvent,
  ServerTicketEvent,
  ActionEventSource,
  FileTicketResponse,
} from "./handlers.js";
export { InProcessScheduler, createInProcessScheduler } from "./scheduler.js";
export {
  meteredLlm,
  defaultTenantKey,
  RegistryCache,
  isRegistryResolver,
  isLlmResolver,
  type RegistryInput,
  type LlmInput,
  type RegistryResolver,
  type LlmResolver,
  type TenantLimits,
  type LlmUsageRecord,
  type OnLlmUsage,
  type TenantKeyFn,
} from "./tenancy.js";

/**
 * Shared configuration consumed by every framework integration
 * (`@freebirdai/server/express`, `/fastify`, `/next`).
 *
 * `registry` and `llm` accept either a fixed value (single-tenant) or an
 * auth-keyed resolver function (multi-tenant). Passing any resolver, or an
 * `onLlmUsage` hook, switches the router to per-request dependency resolution;
 * otherwise deps are built once at mount (unchanged single-tenant behavior).
 */
export interface CreateFreeBirdRouterOptions<TAuth = unknown> {
  db: DbAdapter;
  llm: LlmInput;
  email?: EmailAdapter;
  registry: RegistryInput<TAuth>;
  /** Explicit chat engine; created if omitted. Ignored in multi-tenant mode. */
  chat?: ChatEngine;
  /** Explicit custom tabs service; created if omitted. */
  tabs?: CustomTabsService;
  /** Explicit knowledge graph; created if omitted. Ignored in multi-tenant mode. */
  knowledge?: KnowledgeGraph;
  /** Explicit digest engine; created if omitted (and email is provided). */
  digest?: DigestEngine;
  /**
   * "inProcess" — the server runs a cron itself (single-replica dev).
   * "external" — the standalone `@freebirdai/digest-worker` does the work.
   * Default: "external" (safer for production). Not supported alongside
   * registry/llm resolvers or `onLlmUsage` — run the worker externally.
   */
  scheduler?: "inProcess" | "external";
  /** Options forwarded to the in-process scheduler. */
  schedulerOptions?: Partial<
    ConstructorParameters<typeof InProcessScheduler>[0]
  >;
  /** System prompt passed to the chat engine. */
  systemPrompt?: string;
  /** Forwarded to ChatEngineOptions.enablePlanLayout (default true). */
  enablePlanLayout?: boolean;
  /** Forwarded to ChatEngineOptions.citations (default disabled). */
  citations?: { enabled?: boolean };
  /**
   * Forwarded to ChatEngineOptions.knowledgeContext (default enabled).
   * Includes the optional `retrieve` hook for per-message knowledge
   * retrieval (embeddings search) in place of exhaustive injection.
   */
  knowledgeContext?: import("@freebirdai/core").ChatEngineOptions["knowledgeContext"];
  /**
   * Read-only tools the model may call on any turn, whose results are fed
   * back to it in the same turn before it answers.
   *
   * The engine has always supported this; nothing exposed it to a host
   * mounting the plugin. Without it a host can only offer **actions**, and an
   * action is a confirmed side effect whose result never returns to the
   * conversation — so a question needing a lookup gets "I'll look that up" and
   * then silence, because from the model's side nothing came back.
   *
   * These are always eligible, unlike {@link processingToolCatalog}, which is
   * exposed only when a component or pending action names it.
   */
  extraTools?: Record<string, import("@freebirdai/core").LlmTool>;
  /** Catalog of tools exposed only when a component or action declares them. */
  processingToolCatalog?: import("@freebirdai/core").ChatEngineOptions["processingToolCatalog"];
  /**
   * Runs whatever the model calls from `extraTools` or the catalog, and hands
   * the result back to it. Without this the tools are offered and the calls
   * are discarded, which is worse than not offering them.
   */
  executeExtraTool?: import("@freebirdai/core").ChatEngineOptions["executeExtraTool"];
  /** Inner LLM steps per message. Default 3; 1 disables the loop. */
  maxToolSteps?: import("@freebirdai/core").ChatEngineOptions["maxToolSteps"];
  /** Summary prompt passed to the digest engine. */
  summaryPrompt?: string;
  /**
   * Host-supplied auth resolver. Called per request by framework integrations
   * to populate `FreeBirdRequest.auth`. Return null to reject.
   */
  getAuthContext?: (request: unknown) => AuthContext | null | Promise<AuthContext | null>;
  /**
   * Optional host hook for action-layer audit events. Forwarded to handlers.
   */
  onActionEvent?: HandlerDeps["onActionEvent"];
  ticketSink?: import("@freebirdai/core").SupportSink;
  onTicketEvent?: HandlerDeps["onTicketEvent"];
  // ── Multi-tenancy ──────────────────────────────────────────────────────────
  /**
   * Metering hook fired for every LLM completion carrying token usage. The
   * primary billing signal for hosted deployments. Setting this enables
   * per-request LLM wrapping.
   */
  onLlmUsage?: OnLlmUsage;
  /** Resolve per-tenant limits (advisory; enforcement lives in the host). */
  limits?: (ctx: AuthContext) => TenantLimits | undefined | Promise<TenantLimits | undefined>;
  /** Override how a tenant cache/scoping key is derived. Default: orgId ?? extra.tenantId. */
  tenantKey?: TenantKeyFn;
  /** TTL for resolver-produced registries. Default 60s. */
  registryCacheTtlMs?: number;
}

/**
 * Per-request dependency resolver. In single-tenant mode `resolve()` returns
 * the same pre-built deps every time; in multi-tenant mode it resolves the
 * caller's registry (cached per tenant) and LLM (their key, metered).
 */
export interface DepsResolver {
  resolve: (auth: AuthContext) => Promise<HandlerDeps>;
  /** Drop a tenant's cached registry (call when its manifest changes). */
  invalidateRegistry: (tenantKey?: string) => void;
  /** The in-process scheduler, if `scheduler: "inProcess"`. */
  scheduler?: InProcessScheduler;
}

/**
 * Legacy single-shot dependency resolution. Retained for backward
 * compatibility and used internally by the static fast path. Throws if given
 * resolver forms — call {@link createDepsResolver} for multi-tenant configs.
 */
export const resolveDeps = <TAuth = unknown>(opts: CreateFreeBirdRouterOptions<TAuth>) => {
  if (isRegistryResolver(opts.registry) || isLlmResolver(opts.llm)) {
    throw new Error(
      "FreeBird: resolveDeps() cannot build static deps from registry/llm resolvers. Use createDepsResolver().",
    );
  }
  const registry = opts.registry as ComponentRegistry<any, TAuth>;
  const llm = opts.llm as LlmAdapter;
  const knowledge = opts.knowledge ?? createKnowledgeGraph(registry);
  const chat =
    opts.chat ??
    createChatEngine({
      db: opts.db,
      llm,
      registry,
      knowledge,
      systemPrompt: opts.systemPrompt,
      enablePlanLayout: opts.enablePlanLayout,
      citations: opts.citations,
      knowledgeContext: opts.knowledgeContext,
      maxToolSteps: opts.maxToolSteps,
      processingToolCatalog: opts.processingToolCatalog,
      executeExtraTool: opts.executeExtraTool,
    });
  const tabs = opts.tabs ?? createCustomTabsService(opts.db);
  const digest =
    opts.digest ??
    (opts.email
      ? createDigestEngine({
          db: opts.db,
          llm,
          email: opts.email,
          registry,
          summaryPrompt: opts.summaryPrompt,
        })
      : undefined);

  let scheduler: InProcessScheduler | undefined;
  if (opts.scheduler === "inProcess") {
    if (!digest) {
      throw new Error(
        `FreeBird: scheduler "inProcess" requires an email adapter (or a pre-built digest engine).`,
      );
    }
    scheduler = createInProcessScheduler({
      digest,
      db: opts.db,
      ...opts.schedulerOptions,
    });
    scheduler.start();
  }

  return {
    chat,
    tabs,
    knowledge,
    digest,
    scheduler,
    onActionEvent: opts.onActionEvent,
    ticketSink: opts.ticketSink,
    onTicketEvent: opts.onTicketEvent,
  };
};

/**
 * Build a {@link DepsResolver} for a router. Framework integrations call this
 * once at mount and invoke `resolve(auth)` per request. This is the single
 * entry point both single- and multi-tenant deployments share.
 */
export const createDepsResolver = <TAuth = unknown>(
  opts: CreateFreeBirdRouterOptions<TAuth>,
): DepsResolver => {
  const registryIsResolver = isRegistryResolver(opts.registry);
  const llmIsResolver = isLlmResolver(opts.llm);
  const perRequest = registryIsResolver || llmIsResolver || !!opts.onLlmUsage;

  // ── Static fast path — build once, reuse. Behavior identical to pre-tenancy.
  if (!perRequest) {
    const deps = resolveDeps(opts);
    const handlerDeps: HandlerDeps = {
      chat: deps.chat,
      tabs: deps.tabs,
      db: opts.db,
      registry: opts.registry as ComponentRegistry<any, TAuth>,
      knowledge: deps.knowledge,
      extraTools: opts.extraTools,
      onActionEvent: deps.onActionEvent,
      ticketSink: opts.ticketSink,
      onTicketEvent: opts.onTicketEvent,
    };
    return {
      resolve: async () => handlerDeps,
      invalidateRegistry: () => {},
      ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
    };
  }

  // ── Multi-tenant / metered path — resolve per request.
  if (opts.scheduler === "inProcess") {
    throw new Error(
      'FreeBird: scheduler "inProcess" is not supported with registry/llm resolvers or onLlmUsage. Run @freebirdai/digest-worker externally.',
    );
  }

  const tenantKeyFn = opts.tenantKey ?? defaultTenantKey;
  const cache = new RegistryCache<TAuth>(opts.registryCacheTtlMs ?? 60_000);
  const tabs = opts.tabs ?? createCustomTabsService(opts.db);
  // Memoize the knowledge graph per registry instance so a cached (or static)
  // registry is only indexed once, not on every request.
  const knowledgeByRegistry = new WeakMap<object, KnowledgeGraph>();
  const knowledgeFor = (registry: ComponentRegistry<any, TAuth>): KnowledgeGraph => {
    const existing = knowledgeByRegistry.get(registry as object);
    if (existing) return existing;
    const created = createKnowledgeGraph(registry);
    knowledgeByRegistry.set(registry as object, created);
    return created;
  };

  const resolveRegistry = async (
    auth: AuthContext,
  ): Promise<ComponentRegistry<any, TAuth>> => {
    if (!registryIsResolver) return opts.registry as ComponentRegistry<any, TAuth>;
    const key = tenantKeyFn(auth) ?? "__default__";
    return cache.resolve(key, opts.registry as RegistryResolver<TAuth>, auth);
  };

  const resolveLlm = async (auth: AuthContext): Promise<LlmAdapter> => {
    const base = llmIsResolver
      ? await (opts.llm as import("./tenancy.js").LlmResolver)(auth)
      : (opts.llm as LlmAdapter);
    return opts.onLlmUsage ? meteredLlm(base, auth, opts.onLlmUsage) : base;
  };

  return {
    resolve: async (auth) => {
      const registry = await resolveRegistry(auth);
      const knowledge = knowledgeFor(registry);
      const llm = await resolveLlm(auth);
      const chat = createChatEngine({
        db: opts.db,
        llm,
        registry,
        knowledge,
        systemPrompt: opts.systemPrompt,
        enablePlanLayout: opts.enablePlanLayout,
        citations: opts.citations,
        knowledgeContext: opts.knowledgeContext,
        maxToolSteps: opts.maxToolSteps,
        processingToolCatalog: opts.processingToolCatalog,
        executeExtraTool: opts.executeExtraTool,
      });
      return {
        chat,
        tabs,
        db: opts.db,
        registry,
        knowledge,
        extraTools: opts.extraTools,
        onActionEvent: opts.onActionEvent,
        ticketSink: opts.ticketSink,
        onTicketEvent: opts.onTicketEvent,
      };
    },
    invalidateRegistry: (key) => cache.invalidate(key),
  };
};
