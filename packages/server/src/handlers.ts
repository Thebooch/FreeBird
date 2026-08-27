import type { ActionState, AuthContext, ChatEngine, ChatMessage, ChatSession, ComponentRegistry, CustomTab, CustomTabsService, DbAdapter, DigestConfig, GridCell, KnowledgeGraph, LayoutPlan, LlmTool } from "@freebirdai/core";
import {
  validateActionArgs,
  runAction,
  runActionPreflight,
  runAuthorize,
  fileTicketBodySchema,
  stampTicket,
} from "@freebirdai/core";
import type { ActionBlocker, SupportSink, Ticket } from "@freebirdai/core";

/**
 * Framework-agnostic request/response types. Each host integration
 * (Express/Fastify/Next) maps its native types into these.
 */
export interface FreeBirdRequest<TBody = unknown> {
  body: TBody;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  /** Host-supplied auth context. */
  auth: AuthContext;
  /** For cancellations. */
  signal?: AbortSignal;
}

export interface FreeBirdResponseJson<T = unknown> {
  kind: "json";
  status: number;
  body: T;
}

export interface FreeBirdResponseSse {
  kind: "sse";
  status: 200;
  /** Async iterator producing events to serialize as SSE. */
  events: AsyncIterable<unknown>;
}

export type FreeBirdResponse<T = unknown> = FreeBirdResponseJson<T> | FreeBirdResponseSse;

/**
 * Audit event emitted by the action endpoints, mirrors the client-side
 * shape (re-implemented here so server-only consumers don't have to depend
 * on `@freebirdai/core-state`).
 */
export type ActionEventSource = "http" | "mcp" | "chat";

export type ServerActionEvent =
  | {
      kind: "action.executed";
      sessionId: string;
      recordId: string;
      componentId: string;
      actionId: string;
      args: Record<string, unknown>;
      before?: unknown;
      changed?: string[];
      result?: unknown;
      source?: ActionEventSource;
      at: Date;
    }
  | {
      kind: "action.failed";
      sessionId: string;
      recordId: string;
      componentId: string;
      actionId: string;
      args: Record<string, unknown>;
      before?: unknown;
      message: string;
      source?: ActionEventSource;
      at: Date;
    }
  | {
      kind: "action.cancelled";
      sessionId: string;
      recordId: string;
      reason?: string;
      source?: ActionEventSource;
      at: Date;
    }
  | {
      kind: "action.unauthorized";
      sessionId: string;
      recordId: string;
      componentId: string;
      actionId: string;
      args: Record<string, unknown>;
      reason?: string;
      source?: ActionEventSource;
      at: Date;
    }
  | {
      kind: "action.blocked";
      sessionId: string;
      recordId: string;
      componentId: string;
      actionId: string;
      args: Record<string, unknown>;
      message: string;
      blockers: ActionBlocker[];
      source?: ActionEventSource;
      at: Date;
    };

export interface HandlerDeps {
  chat: ChatEngine;
  tabs: CustomTabsService;
  db: DbAdapter;
  registry: ComponentRegistry<any, any>;
  knowledge: KnowledgeGraph;
  /**
   * Read-only tools the model may call on any turn, whose results are fed
   * back to it before it answers.
   *
   * The engine has always supported these per `send()`; nothing exposed them
   * to a host mounting the plugin, so a host could only offer *actions* — and
   * an action is a confirmed side effect whose result never returns to the
   * conversation. Asked a question needing a lookup, the model would announce
   * the lookup and the turn would end there, because from its side nothing
   * came back.
   *
   * Paired with {@link FreeBirdPluginOptions.executeExtraTool}, which runs
   * them. Without that the engine exposes the tools and discards the calls.
   */
  extraTools?: Record<string, LlmTool>;
  /**
   * Optional host hook for action-layer audit events. Hosts can use this
   * to mirror executions into their own audit table, fire webhooks, etc.
   * Failures inside the hook are caught and logged.
   */
  onActionEvent?: (
    event: ServerActionEvent,
    auth: AuthContext,
  ) => void | Promise<void>;
  /** Host callback when a support ticket is filed via POST /support/tickets. */
  ticketSink?: SupportSink;
  /** Optional audit hook for ticket lifecycle events. */
  onTicketEvent?: (
    event: ServerTicketEvent,
    auth: AuthContext,
  ) => void | Promise<void>;
}

export type ServerTicketEvent =
  | { kind: "ticket.created"; ticket: Ticket; sessionId: string; at: Date }
  | {
      kind: "ticket.failed";
      sessionId: string;
      message: string;
      at: Date;
    };

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export const handleCreateSession = async (
  deps: HandlerDeps,
  req: FreeBirdRequest<{ title?: string; topic?: string; tags?: string[] }>,
): Promise<FreeBirdResponseJson<ChatSession>> => {
  const session = await deps.db.createSession(req.body ?? {}, req.auth);
  return { kind: "json", status: 201, body: session };
};

export const handleListMessages = async (
  deps: HandlerDeps,
  req: FreeBirdRequest,
): Promise<FreeBirdResponseJson<ChatMessage[]>> => {
  const id = req.params.sessionId;
  if (!id) return { kind: "json", status: 400, body: [] };
  const msgs = await deps.db.listMessages(id, req.auth);
  return { kind: "json", status: 200, body: msgs };
};

export const handleGetActiveLayout = async (
  deps: HandlerDeps,
  req: FreeBirdRequest,
): Promise<FreeBirdResponseJson<LayoutPlan | null>> => {
  // Active layout is tracked off the session; consumers wanting a more
  // advanced flow can extend this with a separate layouts table.
  const id = req.params.sessionId;
  if (!id) return { kind: "json", status: 404, body: null };
  await deps.db.getSession(id, req.auth);
  // Layouts aren't persisted server-side — clients keep them in state.
  // Returning null keeps the endpoint symmetric with the transport.
  return { kind: "json", status: 200, body: null };
};

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
export interface ChatBody {
  sessionId: string;
  text: string;
  lockedCells?: GridCell[];
  actionState?: ActionState;
  activeComponentIds?: string[];
  supportContext?: {
    subject?: Record<string, unknown>;
    transcriptExcerpt?: string;
    metadata?: Record<string, unknown>;
  };
}

export const handleChat = (
  deps: HandlerDeps,
  req: FreeBirdRequest<ChatBody>,
): FreeBirdResponseSse => {
  const body = req.body;
  if (!body?.sessionId || typeof body.text !== "string") {
    return {
      kind: "sse",
      status: 200,
      events: oneShot({ kind: "error", error: "sessionId and text are required" }),
    };
  }
  const events = deps.chat.send(
    {
      sessionId: body.sessionId,
      text: body.text,
      lockedCells: body.lockedCells,
      actionState: body.actionState,
      activeComponentIds: body.activeComponentIds,
      supportContext: body.supportContext,
      // Always eligible, unlike the processing-tool catalog, which is exposed
      // only when a component or pending action names it.
      ...(deps.extraTools ? { extraTools: deps.extraTools } : {}),
      signal: req.signal,
    },
    req.auth,
  );
  return { kind: "sse", status: 200, events };
};

export interface ExplainBody {
  sessionId: string;
  componentId: string;
}

export const handleExplain = (
  deps: HandlerDeps,
  req: FreeBirdRequest<ExplainBody>,
): FreeBirdResponseSse => {
  const body = req.body;
  if (!body?.sessionId || !body?.componentId) {
    return {
      kind: "sse",
      status: 200,
      events: oneShot({ kind: "error", error: "sessionId and componentId are required" }),
    };
  }
  const def = deps.registry.get(body.componentId);
  const bullet = (s: string) => `- ${s}`;
  const knowledge = (def?.knowledge ?? []).map((k) => bullet(k.text)).join("\n");
  const prompt = def
    ? `The user clicked the info button on the "${def.title}" component (id: ${def.id}).\n` +
      `Describe what it is, what data it shows, and how to use it.\n` +
      (knowledge ? `Component facts:\n${knowledge}` : "")
    : `The user asked about an unknown component id "${body.componentId}". ` +
      `Politely tell them it's not registered in this app.`;
  const events = deps.chat.send(
    {
      sessionId: body.sessionId,
      text: prompt,
      generateLayout: false,
      signal: req.signal,
    },
    req.auth,
  );
  return { kind: "sse", status: 200, events };
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ConfirmActionBody {
  sessionId: string;
  recordId: string;
  componentId: string;
  actionId: string;
  args: Record<string, unknown>;
}

export interface ConfirmActionResponse {
  ok: boolean;
  recordId: string;
  result?: unknown;
  before?: unknown;
  changed?: string[];
  error?: string;
  blocked?: boolean;
  message?: string;
  blockers?: ActionBlocker[];
}

const emitActionEvent = async (
  deps: HandlerDeps,
  event: ServerActionEvent,
  auth: AuthContext,
): Promise<void> => {
  if (!deps.onActionEvent) return;
  try {
    await deps.onActionEvent(event, auth);
  } catch (err) {
     
    console.error("[freebird] onActionEvent host hook failed:", err);
  }
};

const persistActionAudit = async (
  deps: HandlerDeps,
  auth: AuthContext,
  payload: {
    sessionId: string;
    recordId: string;
    componentId: string;
    actionId: string;
    args: Record<string, unknown>;
    before?: unknown;
    changed?: string[];
    result?: unknown;
    error?: string;
    status: "completed" | "failed" | "terminated";
  },
): Promise<void> => {
  try {
    await deps.db.appendMessage(
      {
        sessionId: payload.sessionId,
        role: "tool",
        content:
          payload.status === "completed"
            ? `[action ${payload.componentId}:${payload.actionId}] completed`
            : payload.status === "failed"
              ? `[action ${payload.componentId}:${payload.actionId}] failed: ${payload.error ?? "unknown"}`
              : `[action ${payload.componentId}:${payload.actionId}] terminated`,
        toolName: `${payload.componentId}:${payload.actionId}`,
        toolPayload: {
          recordId: payload.recordId,
          status: payload.status,
          args: payload.args,
          before: payload.before,
          changed: payload.changed,
          result: payload.result,
          error: payload.error,
        },
      },
      auth,
    );
  } catch (err) {
     
    console.error("[freebird] action audit persistence failed:", err);
  }
};

export const handleConfirmAction = async (
  deps: HandlerDeps,
  req: FreeBirdRequest<ConfirmActionBody>,
): Promise<FreeBirdResponseJson<ConfirmActionResponse>> => {
  const body = req.body;
  if (
    !body?.sessionId ||
    !body.recordId ||
    !body.componentId ||
    !body.actionId
  ) {
    return {
      kind: "json",
      status: 400,
      body: {
        ok: false,
        recordId: body?.recordId ?? "",
        error: "sessionId, recordId, componentId, and actionId are required",
      },
    };
  }

  const def = deps.registry.getAction(body.componentId, body.actionId);
  if (!def) {
    const event: ServerActionEvent = {
      kind: "action.failed",
      sessionId: body.sessionId,
      recordId: body.recordId,
      componentId: body.componentId,
      actionId: body.actionId,
      args: body.args,
      message: "unknown action",
      source: "http",
      at: new Date(),
    };
    await emitActionEvent(deps, event, req.auth);
    return {
      kind: "json",
      status: 404,
      body: { ok: false, recordId: body.recordId, error: "unknown action" },
    };
  }

  const outcome = await runAction(deps.registry, {
    componentId: body.componentId,
    actionId: body.actionId,
    args: body.args ?? {},
    auth: req.auth,
    sessionId: body.sessionId,
    recordId: body.recordId,
  });

  switch (outcome.kind) {
    case "not_found":
      await emitActionEvent(
        deps,
        {
          kind: "action.failed",
          sessionId: body.sessionId,
          recordId: body.recordId,
          componentId: body.componentId,
          actionId: body.actionId,
          args: body.args,
          message: outcome.message,
          source: "http",
          at: new Date(),
        },
        req.auth,
      );
      return {
        kind: "json",
        status: 404,
        body: { ok: false, recordId: body.recordId, error: outcome.message },
      };
    case "blocked":
      await emitActionEvent(
        deps,
        {
          kind: "action.blocked",
          sessionId: body.sessionId,
          recordId: body.recordId,
          componentId: body.componentId,
          actionId: body.actionId,
          args: outcome.args,
          message: outcome.message,
          blockers: outcome.blockers,
          source: "http",
          at: new Date(),
        },
        req.auth,
      );
      return {
        kind: "json",
        status: 200,
        body: {
          ok: false,
          recordId: body.recordId,
          blocked: true,
          message: outcome.message,
          blockers: outcome.blockers,
          error: outcome.message,
        },
      };
    case "validation_error":
      await persistActionAudit(deps, req.auth, {
        sessionId: body.sessionId,
        recordId: body.recordId,
        componentId: body.componentId,
        actionId: body.actionId,
        args: body.args,
        error: outcome.message,
        status: "failed",
      });
      await emitActionEvent(
        deps,
        {
          kind: "action.failed",
          sessionId: body.sessionId,
          recordId: body.recordId,
          componentId: body.componentId,
          actionId: body.actionId,
          args: body.args,
          message: outcome.message,
          source: "http",
          at: new Date(),
        },
        req.auth,
      );
      return {
        kind: "json",
        status: 400,
        body: { ok: false, recordId: body.recordId, error: outcome.message },
      };
    case "unauthorized":
      await emitActionEvent(
        deps,
        {
          kind: "action.unauthorized",
          sessionId: body.sessionId,
          recordId: body.recordId,
          componentId: body.componentId,
          actionId: body.actionId,
          args: outcome.args,
          reason: outcome.reason,
          source: "http",
          at: new Date(),
        },
        req.auth,
      );
      return {
        kind: "json",
        status: outcome.status,
        body: { ok: false, recordId: body.recordId, error: outcome.reason ?? "not authorized" },
      };
    case "failed":
      await persistActionAudit(deps, req.auth, {
        sessionId: body.sessionId,
        recordId: body.recordId,
        componentId: body.componentId,
        actionId: body.actionId,
        args: outcome.args,
        before: outcome.before,
        error: outcome.message,
        status: "failed",
      });
      await emitActionEvent(
        deps,
        {
          kind: "action.failed",
          sessionId: body.sessionId,
          recordId: body.recordId,
          componentId: body.componentId,
          actionId: body.actionId,
          args: outcome.args,
          before: outcome.before,
          message: outcome.message,
          source: "http",
          at: new Date(),
        },
        req.auth,
      );
      return {
        kind: "json",
        status: 200,
        body: {
          ok: false,
          recordId: body.recordId,
          before: outcome.before,
          error: outcome.message,
        },
      };
    case "executed":
      await persistActionAudit(deps, req.auth, {
        sessionId: body.sessionId,
        recordId: body.recordId,
        componentId: body.componentId,
        actionId: body.actionId,
        args: outcome.args,
        before: outcome.before,
        changed: outcome.changed,
        result: outcome.result,
        status: "completed",
      });
      await emitActionEvent(
        deps,
        {
          kind: "action.executed",
          sessionId: body.sessionId,
          recordId: body.recordId,
          componentId: body.componentId,
          actionId: body.actionId,
          args: outcome.args,
          before: outcome.before,
          changed: outcome.changed,
          result: outcome.result,
          source: "http",
          at: new Date(),
        },
        req.auth,
      );
      return {
        kind: "json",
        status: 200,
        body: {
          ok: true,
          recordId: body.recordId,
          result: outcome.result,
          before: outcome.before,
          changed: outcome.changed,
        },
      };
  }
};

export interface CancelActionBody {
  sessionId: string;
  recordId: string;
  reason?: string;
}

export const handleCancelAction = async (
  deps: HandlerDeps,
  req: FreeBirdRequest<CancelActionBody>,
): Promise<FreeBirdResponseJson<{ ok: true }>> => {
  const body = req.body;
  if (!body?.sessionId || !body.recordId) {
    return {
      kind: "json",
      status: 400,
      body: { ok: true },
    };
  }
  await emitActionEvent(
    deps,
    {
      kind: "action.cancelled",
      sessionId: body.sessionId,
      recordId: body.recordId,
      reason: body.reason,
      at: new Date(),
    },
    req.auth,
  );
  return { kind: "json", status: 200, body: { ok: true } };
};

export interface UpdateActionArgsBody {
  sessionId: string;
  recordId: string;
  componentId?: string;
  actionId?: string;
  args: Record<string, unknown>;
}

export interface UpdateActionArgsResponse {
  ok: boolean;
  missing: string[];
  blocked?: boolean;
  message?: string;
  blockers?: ActionBlocker[];
  resolvedArgs?: Record<string, unknown>;
  error?: string;
}

export const handleUpdateActionArgs = async (
  deps: HandlerDeps,
  req: FreeBirdRequest<UpdateActionArgsBody>,
): Promise<FreeBirdResponseJson<UpdateActionArgsResponse>> => {
  const body = req.body;
  if (!body?.sessionId || !body.recordId) {
    return {
      kind: "json",
      status: 400,
      body: { ok: false, missing: [], error: "sessionId and recordId required" },
    };
  }
  let missing: string[] = [];
  let mergedArgs = body.args ?? {};
  if (body.componentId && body.actionId) {
    const def = deps.registry.getAction(body.componentId, body.actionId);
    if (def) {
      const v = validateActionArgs(def.schema, body.args);
      missing = v.missing;
      if (v.ok) {
        const authz = await runAuthorize(def, v.data, {
          auth: req.auth,
          sessionId: body.sessionId,
        });
        if (!authz.ok) {
          const reason = authz.reason ?? "not authorized";
          await emitActionEvent(
            deps,
            {
              kind: "action.unauthorized",
              sessionId: body.sessionId,
              recordId: body.recordId,
              componentId: body.componentId,
              actionId: body.actionId,
              args: body.args,
              reason,
              at: new Date(),
            },
            req.auth,
          );
          return {
            kind: "json",
            status: authz.status,
            body: { ok: false, missing: [], error: reason },
          };
        }
      }

      const argsForPreflight = v.ok ? v.data : body.args;
      if (def.preflight) {
        const pf = await runActionPreflight(def, argsForPreflight as never, {
          auth: req.auth,
          sessionId: body.sessionId,
        });
        if (!pf.ok) {
          await emitActionEvent(
            deps,
            {
              kind: "action.blocked",
              sessionId: body.sessionId,
              recordId: body.recordId,
              componentId: body.componentId,
              actionId: body.actionId,
              args: body.args,
              message: pf.message,
              blockers: pf.blockers,
              at: new Date(),
            },
            req.auth,
          );
          return {
            kind: "json",
            status: 200,
            body: {
              ok: false,
              missing,
              blocked: true,
              message: pf.message,
              blockers: pf.blockers,
            },
          };
        }
        if (pf.resolvedArgs) {
          mergedArgs = { ...body.args, ...pf.resolvedArgs };
          const rev = validateActionArgs(def.schema, mergedArgs);
          missing = rev.missing;
        }
      }
    }
  }
  const resolvedDelta =
    mergedArgs !== body.args
      ? Object.fromEntries(
          Object.entries(mergedArgs).filter(
            ([k, val]) => body.args[k] !== val,
          ),
        )
      : undefined;
  return {
    kind: "json",
    status: 200,
    body: {
      ok: true,
      missing,
      ...(resolvedDelta && Object.keys(resolvedDelta).length > 0
        ? { resolvedArgs: resolvedDelta }
        : {}),
    },
  };
};

// ---------------------------------------------------------------------------
// Custom tabs
// ---------------------------------------------------------------------------
export const handleListTabs = async (
  deps: HandlerDeps,
  req: FreeBirdRequest,
): Promise<FreeBirdResponseJson<CustomTab[]>> => ({
  kind: "json",
  status: 200,
  body: await deps.tabs.list(req.auth),
});

export interface CreateTabBody {
  title: string;
  layout: LayoutPlan;
  digest?: DigestConfig;
}

export const handleCreateTab = async (
  deps: HandlerDeps,
  req: FreeBirdRequest<CreateTabBody>,
): Promise<FreeBirdResponseJson<CustomTab>> => {
  const body = req.body;
  if (!body?.title || !body.layout) {
    return { kind: "json", status: 400, body: undefined as unknown as CustomTab };
  }
  const tab = await deps.tabs.save(body, req.auth);
  return { kind: "json", status: 201, body: tab };
};

export const handleGetTab = async (
  deps: HandlerDeps,
  req: FreeBirdRequest,
): Promise<FreeBirdResponseJson<CustomTab | null>> => {
  const id = req.params.id;
  if (!id) return { kind: "json", status: 400, body: null };
  const t = await deps.tabs.get(id, req.auth);
  return { kind: "json", status: t ? 200 : 404, body: t };
};

export interface UpdateTabBody {
  title?: string;
  layout?: LayoutPlan;
  digest?: DigestConfig | null;
}

export const handleUpdateTab = async (
  deps: HandlerDeps,
  req: FreeBirdRequest<UpdateTabBody>,
): Promise<FreeBirdResponseJson<CustomTab>> => {
  const id = req.params.id;
  if (!id) return { kind: "json", status: 400, body: undefined as unknown as CustomTab };
  const body = req.body ?? {};
  let current = await deps.tabs.get(id, req.auth);
  if (!current) return { kind: "json", status: 404, body: undefined as unknown as CustomTab };
  if (body.title !== undefined) current = await deps.tabs.rename(id, body.title, req.auth);
  if (body.layout) current = await deps.tabs.replaceLayout(id, body.layout, req.auth);
  if (body.digest !== undefined)
    current = await deps.tabs.setDigest(id, body.digest ?? null, req.auth);
  return { kind: "json", status: 200, body: current };
};

export const handleDeleteTab = async (
  deps: HandlerDeps,
  req: FreeBirdRequest,
): Promise<FreeBirdResponseJson<null>> => {
  const id = req.params.id;
  if (!id) return { kind: "json", status: 400, body: null };
  await deps.tabs.remove(id, req.auth);
  return { kind: "json", status: 204, body: null };
};

// ---------------------------------------------------------------------------
// Support / tickets
// ---------------------------------------------------------------------------

export type FileTicketResponse =
  | { ok: true; ticket: Ticket }
  | { ok: false; error: string };

export const handleFileTicket = async (
  deps: HandlerDeps,
  req: FreeBirdRequest<import("@freebirdai/core").FileTicketBody>,
): Promise<FreeBirdResponseJson<FileTicketResponse>> => {
  const parsed = fileTicketBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return {
      kind: "json",
      status: 400,
      body: { ok: false, error: parsed.error.message },
    };
  }
  const { sessionId, draft, subject, transcriptExcerpt, metadata } =
    parsed.data;
  const auth = req.auth;

  let ticket = stampTicket(
    draft,
    { userId: auth.userId, orgId: auth.orgId },
    sessionId,
    { subject, transcriptExcerpt, metadata },
  );

  try {
    if (deps.ticketSink) {
      const sinkResult = await deps.ticketSink.fileTicket(ticket, {
        auth,
        sessionId,
      });
      if (sinkResult?.externalId) {
        ticket = { ...ticket, externalId: sinkResult.externalId };
      }
      if (sinkResult?.url) {
        ticket = { ...ticket, externalUrl: sinkResult.url };
      }
    }
    await deps.onTicketEvent?.(
      { kind: "ticket.created", ticket, sessionId, at: new Date() },
      auth,
    );
    return { kind: "json", status: 200, body: { ok: true, ticket } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.onTicketEvent?.(
      { kind: "ticket.failed", sessionId, message, at: new Date() },
      auth,
    );
    return { kind: "json", status: 500, body: { ok: false, error: message } };
  }
};

// ---------------------------------------------------------------------------
// Route table (consumed by framework integrations)
// ---------------------------------------------------------------------------
export interface RouteSpec {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  kind: "json" | "sse";
  handler: (deps: HandlerDeps, req: FreeBirdRequest<any>) => any;
}

export const ROUTES: RouteSpec[] = [
  { method: "POST", path: "/sessions", kind: "json", handler: handleCreateSession },
  { method: "GET", path: "/sessions/:sessionId/messages", kind: "json", handler: handleListMessages },
  { method: "GET", path: "/sessions/:sessionId/layout", kind: "json", handler: handleGetActiveLayout },
  { method: "POST", path: "/chat", kind: "sse", handler: handleChat },
  { method: "POST", path: "/chat/explain", kind: "sse", handler: handleExplain },
  { method: "POST", path: "/actions/confirm", kind: "json", handler: handleConfirmAction },
  { method: "POST", path: "/actions/cancel", kind: "json", handler: handleCancelAction },
  { method: "POST", path: "/actions/update-args", kind: "json", handler: handleUpdateActionArgs },
  { method: "POST", path: "/support/tickets", kind: "json", handler: handleFileTicket },
  { method: "GET", path: "/tabs", kind: "json", handler: handleListTabs },
  { method: "POST", path: "/tabs", kind: "json", handler: handleCreateTab },
  { method: "GET", path: "/tabs/:id", kind: "json", handler: handleGetTab },
  { method: "PATCH", path: "/tabs/:id", kind: "json", handler: handleUpdateTab },
  { method: "DELETE", path: "/tabs/:id", kind: "json", handler: handleDeleteTab },
];

async function* oneShot<T>(value: T): AsyncIterable<T> {
  yield value;
}
