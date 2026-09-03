import { z } from "zod";
import {
  newId,
  prepareActionArgs,
  runAction,
  resolveMode,
  type AuthContext,
  type ComponentRegistry,
  type ModeInput,
} from "@freebirdai/core";
import {
  actionRequiresMcpConfirmation,
  isActionExposed,
  isComponentReadable,
  isComponentReviewable,
  listExposedActions,
  listExposedComponents,
  resolveToolAccess,
  type McpAccessMode,
} from "./access.js";
import {
  authFingerprint,
  type ConfirmationTokenStore,
} from "./confirm.js";
import { listRequiredFields, schemaToJson } from "./schema.js";
import type {
  FreeBirdMcpServerOptions,
  McpActionEvent,
  McpToolContext,
} from "./types.js";

export const TOOL_NAMES = {
  listActions: "freebird_list_actions",
  describeAction: "freebird_describe_action",
  readComponent: "freebird_read_component",
  reviewItems: "freebird_review_items",
  prepareAction: "freebird_prepare_action",
  executeAction: "freebird_execute_action",
} as const;

export interface McpRuntimeContext<TAuth> {
  registry: ComponentRegistry<any, TAuth>;
  mode: McpAccessMode;
  getAuthContext: () => TAuth | null | Promise<TAuth | null>;
  sessionId: string;
  onActionEvent?: FreeBirdMcpServerOptions<TAuth>["onActionEvent"];
  executeReviewItems?: FreeBirdMcpServerOptions<TAuth>["executeReviewItems"];
  defaultReadProps: Record<string, unknown>;
  confirmationTokens: ConfirmationTokenStore;
  /**
   * Posture for MCP callers, fixed or resolved from the auth this connection
   * carries. Distinct from {@link McpAccessMode}, which says what this server
   * *exposes*; this says what the caller behind it is allowed to do.
   */
  permissionMode?: ModeInput;
}

const jsonResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

const requireAuth = async <TAuth>(
  ctx: McpRuntimeContext<TAuth>,
): Promise<
  | { ok: true; auth: TAuth; toolCtx: McpToolContext<TAuth> }
  | { ok: false; error: string }
> => {
  const auth = await ctx.getAuthContext();
  if (auth == null) {
    return { ok: false, error: "MCP access denied: auth context unavailable" };
  }
  return {
    ok: true,
    auth,
    toolCtx: { auth, sessionId: ctx.sessionId },
  };
};

const emitEvent = async <TAuth>(
  ctx: McpRuntimeContext<TAuth>,
  event: McpActionEvent,
  auth: TAuth,
): Promise<void> => {
  if (!ctx.onActionEvent) return;
  try {
    await ctx.onActionEvent(event, auth);
  } catch (err) {
     
    console.error("[freebird-mcp] onActionEvent hook failed:", err);
  }
};

export const handleListActions = async <TAuth>(
  ctx: McpRuntimeContext<TAuth>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
  const authResult = await requireAuth(ctx);
  if (!authResult.ok) return jsonResult({ error: authResult.error });

  const access = resolveToolAccess(ctx.mode);
  if (!access.metadata) {
    return jsonResult({ error: "metadata tools not allowed in this mode" });
  }

  const actions = listExposedActions(ctx.registry, ctx.mode).map((a) => {
    const def = ctx.registry.getAction(a.componentId, a.actionId);
    const inputSchema = def ? schemaToJson(def.schema) : undefined;
    return {
      ref: a.ref,
      componentId: a.componentId,
      actionId: a.actionId,
      description: a.description,
      requiresConfirmation: a.requiresConfirmation,
      inputSchema,
      requiredFields: inputSchema ? listRequiredFields(inputSchema) : [],
    };
  });

  const components = listExposedComponents(ctx.registry, ctx.mode).filter(
    (c) => c.readable || c.reviewable,
  );

  return jsonResult({ mode: ctx.mode, actions, components });
};

export const handleDescribeAction = async <TAuth>(
  ctx: McpRuntimeContext<TAuth>,
  input: { componentId: string; actionId: string },
): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
  const authResult = await requireAuth(ctx);
  if (!authResult.ok) return jsonResult({ error: authResult.error });

  const access = resolveToolAccess(ctx.mode);
  if (!access.metadata) {
    return jsonResult({ error: "metadata tools not allowed in this mode" });
  }

  if (
    !isActionExposed(ctx.registry, ctx.mode, input.componentId, input.actionId)
  ) {
    return jsonResult({
      error: `action not exposed: ${input.componentId}:${input.actionId}`,
    });
  }

  const def = ctx.registry.getAction(input.componentId, input.actionId);
  if (!def) {
    return jsonResult({ error: "unknown action" });
  }

  const inputSchema = schemaToJson(def.schema);
  return jsonResult({
    ref: `${input.componentId}:${input.actionId}`,
    description: def.description,
    requiresConfirmation: actionRequiresMcpConfirmation(def),
    inputSchema,
    requiredFields: listRequiredFields(inputSchema),
  });
};

export const handleReadComponent = async <TAuth>(
  ctx: McpRuntimeContext<TAuth>,
  input: { componentId: string; props?: Record<string, unknown> },
): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
  const authResult = await requireAuth(ctx);
  if (!authResult.ok) return jsonResult({ error: authResult.error });

  if (!isComponentReadable(ctx.registry, ctx.mode, input.componentId)) {
    return jsonResult({
      error: `component not readable via MCP: ${input.componentId}`,
    });
  }

  const component = ctx.registry.get(input.componentId);
  if (!component?.dataSource) {
    return jsonResult({ error: "component has no dataSource" });
  }

  const data = await component.dataSource({
    tabId: "mcp",
    auth: authResult.auth,
    runAt: new Date(),
    props: { ...ctx.defaultReadProps, ...(input.props ?? {}) },
  });

  return jsonResult({ componentId: input.componentId, data });
};

export const handleReviewItems = async <TAuth>(
  ctx: McpRuntimeContext<TAuth>,
  input: {
    componentId: string;
    onlyConcerning?: boolean;
    limit?: number;
  },
): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
  const authResult = await requireAuth(ctx);
  if (!authResult.ok) return jsonResult({ error: authResult.error });

  if (!isComponentReviewable(ctx.registry, ctx.mode, input.componentId)) {
    return jsonResult({
      error: `component not reviewable via MCP: ${input.componentId}`,
    });
  }

  if (!ctx.executeReviewItems) {
    return jsonResult({
      error:
        "executeReviewItems is required to load review items for this component",
    });
  }

  const { items } = await ctx.executeReviewItems(input, authResult.toolCtx);
  return jsonResult({ componentId: input.componentId, items });
};

export const handlePrepareAction = async <TAuth>(
  ctx: McpRuntimeContext<TAuth>,
  input: {
    componentId: string;
    actionId: string;
    args?: Record<string, unknown>;
  },
): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
  const authResult = await requireAuth(ctx);
  if (!authResult.ok) return jsonResult({ error: authResult.error });

  if (
    !isActionExposed(ctx.registry, ctx.mode, input.componentId, input.actionId)
  ) {
    return jsonResult({
      error: `action not exposed: ${input.componentId}:${input.actionId}`,
    });
  }

  const def = ctx.registry.getAction(input.componentId, input.actionId);
  if (!def) {
    return jsonResult({ error: "unknown action" });
  }

  const prepared = await prepareActionArgs(ctx.registry, {
    componentId: input.componentId,
    actionId: input.actionId,
    args: input.args ?? {},
    auth: authResult.auth,
    sessionId: ctx.sessionId,
  });

  if (prepared.kind === "not_found") {
    return jsonResult({ error: prepared.message });
  }
  if (prepared.kind === "blocked") {
    return jsonResult({
      ready: false,
      blocked: true,
      message: prepared.message,
      blockers: prepared.blockers,
      args: prepared.args,
    });
  }
  if (prepared.kind === "invalid") {
    return jsonResult({
      ready: false,
      missing: prepared.missing,
      errors: prepared.errors,
      normalizedArgs: prepared.normalizedArgs,
      args: prepared.args,
    });
  }

  const needsConfirmation = actionRequiresMcpConfirmation(def);
  let confirmationToken: string | undefined;
  if (needsConfirmation) {
    confirmationToken = ctx.confirmationTokens.issue({
      componentId: input.componentId,
      actionId: input.actionId,
      args: prepared.normalizedArgs,
      sessionId: ctx.sessionId,
      authFingerprint: authFingerprint(authResult.auth),
    });
  }

  return jsonResult({
    ready: true,
    missing: [],
    normalizedArgs: prepared.normalizedArgs,
    requiresConfirmation: needsConfirmation,
    confirmationToken,
  });
};

export const handleExecuteAction = async <TAuth>(
  ctx: McpRuntimeContext<TAuth>,
  input: {
    componentId: string;
    actionId: string;
    args?: Record<string, unknown>;
    confirmationToken?: string;
    recordId?: string;
  },
): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
  const authResult = await requireAuth(ctx);
  if (!authResult.ok) return jsonResult({ error: authResult.error });

  if (
    !isActionExposed(ctx.registry, ctx.mode, input.componentId, input.actionId)
  ) {
    return jsonResult({
      error: `action not exposed: ${input.componentId}:${input.actionId}`,
    });
  }

  const def = ctx.registry.getAction(input.componentId, input.actionId);
  if (!def) {
    return jsonResult({ error: "unknown action" });
  }

  const args = input.args ?? {};
  const recordId = input.recordId ?? newId("act");

  if (actionRequiresMcpConfirmation(def)) {
    if (!input.confirmationToken) {
      return jsonResult({
        error:
          "confirmationToken required — call freebird_prepare_action first when requiresConfirmation is preview/strict",
      });
    }
    const tokenCheck = ctx.confirmationTokens.consume(input.confirmationToken, {
      componentId: input.componentId,
      actionId: input.actionId,
      args,
      sessionId: ctx.sessionId,
      authFingerprint: authFingerprint(authResult.auth),
    });
    if (!tokenCheck.ok) {
      return jsonResult({ error: tokenCheck.reason });
    }
  } else {
    const prepared = await prepareActionArgs(ctx.registry, {
      componentId: input.componentId,
      actionId: input.actionId,
      args,
      auth: authResult.auth,
      sessionId: ctx.sessionId,
    });
    if (prepared.kind !== "ready") {
      if (prepared.kind === "not_found") {
        return jsonResult({ error: prepared.message });
      }
      if (prepared.kind === "blocked") {
        return jsonResult({
          ok: false,
          blocked: true,
          message: prepared.message,
          blockers: prepared.blockers,
        });
      }
      return jsonResult({
        ok: false,
        missing: prepared.missing,
        errors: prepared.errors,
        hint: "call freebird_prepare_action to see required fields",
      });
    }
  }

  const outcome = await runAction(ctx.registry, {
    componentId: input.componentId,
    actionId: input.actionId,
    args,
    auth: authResult.auth,
    sessionId: ctx.sessionId,
    recordId,
    permissionMode: await resolveMode(ctx.permissionMode, authResult.auth as AuthContext),
  });

  const at = new Date();

  switch (outcome.kind) {
    case "not_found":
      return jsonResult({ ok: false, error: outcome.message });
    case "blocked":
      await emitEvent(
        ctx,
        {
          kind: "action.blocked",
          sessionId: ctx.sessionId,
          recordId,
          componentId: input.componentId,
          actionId: input.actionId,
          args: outcome.args,
          message: outcome.message,
          blockers: outcome.blockers,
          source: "mcp",
          at,
        },
        authResult.auth,
      );
      return jsonResult({
        ok: false,
        blocked: true,
        message: outcome.message,
        blockers: outcome.blockers,
      });
    case "validation_error":
      return jsonResult({
        ok: false,
        missing: outcome.missing,
        error: outcome.message,
        hint: "call freebird_prepare_action to see required fields",
      });
    case "unauthorized":
      await emitEvent(
        ctx,
        {
          kind: "action.unauthorized",
          sessionId: ctx.sessionId,
          recordId,
          componentId: input.componentId,
          actionId: input.actionId,
          args: outcome.args,
          reason: outcome.reason,
          source: "mcp",
          at,
        },
        authResult.auth,
      );
      return jsonResult({
        ok: false,
        error: outcome.reason ?? "not authorized",
      });
    case "grant_required": {
      // Permitted, but not covered by a live confirmation. This path never
      // reaches the chat engine, so the check has to be repeated here — an
      // external agent calling the tool directly is exactly the caller a
      // confirmation is meant to bind.
      const reason =
        outcome.reason === "widened"
          ? `this needs approval for ${outcome.added.join(", ")}`
          : "the details changed since this was confirmed — prepare and confirm it again";
      await emitEvent(
        ctx,
        {
          kind: "action.unauthorized",
          sessionId: ctx.sessionId,
          recordId,
          componentId: input.componentId,
          actionId: input.actionId,
          args: outcome.args,
          reason,
          source: "mcp",
          at,
        },
        authResult.auth,
      );
      return jsonResult({ ok: false, error: reason });
    }
    case "failed":
      await emitEvent(
        ctx,
        {
          kind: "action.failed",
          sessionId: ctx.sessionId,
          recordId,
          componentId: input.componentId,
          actionId: input.actionId,
          args: outcome.args,
          before: outcome.before,
          message: outcome.message,
          source: "mcp",
          at,
        },
        authResult.auth,
      );
      return jsonResult({ ok: false, error: outcome.message, recordId });
    case "executed":
      await emitEvent(
        ctx,
        {
          kind: "action.executed",
          sessionId: ctx.sessionId,
          recordId,
          componentId: input.componentId,
          actionId: input.actionId,
          args: outcome.args,
          before: outcome.before,
          changed: outcome.changed,
          result: outcome.result,
          source: "mcp",
          at,
        },
        authResult.auth,
      );
      return jsonResult({
        ok: true,
        recordId,
        result: outcome.result,
        before: outcome.before,
        changed: outcome.changed,
      });
  }

  return jsonResult({ ok: false, error: "unexpected runAction outcome" });
};

/** Zod schemas for MCP tool inputs (used when registering tools). */
export const toolInputSchemas = {
  describeAction: z.object({
    componentId: z.string().min(1),
    actionId: z.string().min(1),
  }),
  readComponent: z.object({
    componentId: z.string().min(1),
    props: z.record(z.unknown()).optional(),
  }),
  reviewItems: z.object({
    componentId: z.string().min(1),
    onlyConcerning: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  prepareAction: z.object({
    componentId: z.string().min(1),
    actionId: z.string().min(1),
    args: z.record(z.unknown()).optional(),
  }),
  executeAction: z.object({
    componentId: z.string().min(1),
    actionId: z.string().min(1),
    args: z.record(z.unknown()).optional(),
    confirmationToken: z.string().optional(),
    recordId: z.string().optional(),
  }),
};
