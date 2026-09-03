import type { ComponentRegistry } from "../components/registry.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { diffKeys, validateActionArgs } from "./diff.js";
import { runActionPreflight, type ActionBlocker } from "./preflight.js";
import {
  actionGrantDeclaration,
  actionGrantSubject,
  type ActionGrantPort,
} from "./grants.js";
import { digest, evaluateGrant, type Capability, type GrantVerdict } from "../grants/index.js";
import { allowsActions, type PermissionMode } from "../permissions/index.js";

/** Where an action execution originated (for audit tagging). */
export type ActionExecutionSource = "http" | "mcp" | "chat";

export interface RunActionInput<TAuth = unknown> {
  componentId: string;
  actionId: string;
  args: Record<string, unknown>;
  auth: TAuth;
  sessionId: string;
  recordId: string;
  /**
   * Confirmation store. Omit and no grant is required — every existing host
   * keeps its current behaviour until it opts in by supplying this.
   */
  grants?: ActionGrantPort;
  /**
   * Posture for this caller, already resolved from its auth.
   *
   * Checked here as well as in the chat engine because the MCP execute tool
   * reaches this function without passing through the engine at all — an
   * external agent is exactly the caller a read-only posture is for.
   *
   * @default "full"
   */
  permissionMode?: PermissionMode;
}

export type RunActionOutcome =
  | { kind: "not_found"; message: string }
  | {
      kind: "blocked";
      message: string;
      blockers: ActionBlocker[];
      args: Record<string, unknown>;
    }
  | {
      kind: "validation_error";
      message: string;
      missing: string[];
      args: Record<string, unknown>;
    }
  | {
      kind: "unauthorized";
      reason?: string;
      status: number;
      args: Record<string, unknown>;
    }
  | {
      /**
       * Authorized in principle, but no live confirmation covers these exact
       * arguments. The host should re-present the preview rather than execute.
       */
      kind: "grant_required";
      reason: Exclude<GrantVerdict, "valid">;
      /** Capabilities the stored confirmation never covered. */
      added: Capability[];
      args: Record<string, unknown>;
    }
  | {
      kind: "failed";
      message: string;
      args: Record<string, unknown>;
      before?: unknown;
    }
  | {
      kind: "executed";
      args: Record<string, unknown>;
      before?: unknown;
      changed?: string[];
      result: unknown;
    };

/**
 * Run an action's `authorize` hook (if any) and return a normalized decision.
 * Errors thrown inside the hook are treated as denials with status 500.
 */
export const runAuthorize = async <TArgs, TAuth>(
  def: Pick<ActionDefinition<TArgs, unknown, TAuth>, "authorize">,
  validated: TArgs,
  ctx: ActionContext<TAuth>,
): Promise<{ ok: true } | { ok: false; reason?: string; status: number }> => {
  if (!def.authorize) return { ok: true };
  try {
    const result = await def.authorize(validated, ctx);
    if (result === true) return { ok: true };
    if (result === false) return { ok: false, status: 403 };
    if (result && typeof result === "object" && result.ok === false) {
      return {
        ok: false,
        reason: result.reason,
        status: result.status ?? 403,
      };
    }
    return { ok: true };
  } catch (err) {
     
    console.error("[freebird] action authorize() threw:", err);
    return {
      ok: false,
      reason: "authorization check failed",
      status: 500,
    };
  }
};

/**
 * Validate, authorize, readCurrent, and execute a registered action.
 * Shared by HTTP confirm handlers and the MCP execute tool.
 */
export const runAction = async <TAuth>(
  registry: ComponentRegistry<any, TAuth>,
  input: RunActionInput<TAuth>,
): Promise<RunActionOutcome> => {
  const def = registry.getAction(input.componentId, input.actionId);
  if (!def) {
    return { kind: "not_found", message: "unknown action" };
  }

  // Before preflight: a read-only session must not run a host `preflight`
  // hook either, since those read real data to decide readiness.
  if (!allowsActions(input.permissionMode ?? "full")) {
    return {
      kind: "unauthorized",
      reason: "this session is read-only",
      status: 403,
      args: input.args,
    };
  }

  const ctx: ActionContext<TAuth> = {
    auth: input.auth,
    sessionId: input.sessionId,
  };

  const preflight = await runActionPreflight(
    def,
    input.args as never,
    ctx,
  );
  if (!preflight.ok) {
    return {
      kind: "blocked",
      message: preflight.message,
      blockers: preflight.blockers,
      args: input.args,
    };
  }

  const argsForValidation = preflight.resolvedArgs
    ? { ...input.args, ...preflight.resolvedArgs }
    : input.args;

  const validation = validateActionArgs(def.schema, argsForValidation);
  if (!validation.ok) {
    const message =
      validation.error ??
      `missing required fields: ${validation.missing.join(", ")}`;
    return {
      kind: "validation_error",
      message,
      missing: validation.missing,
      args: input.args,
    };
  }

  const execArgs = validation.data;
  const authz = await runAuthorize(def, execArgs, ctx);
  if (!authz.ok) {
    return {
      kind: "unauthorized",
      reason: authz.reason,
      status: authz.status,
      args: execArgs as Record<string, unknown>,
    };
  }

  // Consent check, after authorization and before anything reads host state:
  // an execution nobody confirmed should not even call readCurrent.
  if (input.grants) {
    const subject = actionGrantSubject(input.componentId, input.actionId, input.recordId);
    const evaluation = evaluateGrant({
      existing: await input.grants.read(subject),
      digest: digest(execArgs as Record<string, unknown>),
      declaration: actionGrantDeclaration(input.componentId, input.actionId),
    });
    if (evaluation.verdict !== "valid") {
      return {
        kind: "grant_required",
        reason: evaluation.verdict,
        added: evaluation.added,
        args: execArgs as Record<string, unknown>,
      };
    }
  }

  let before: unknown = undefined;
  if (def.readCurrent) {
    try {
      before = await def.readCurrent(execArgs, ctx);
    } catch (err) {
       
      console.warn(
        `[freebird] readCurrent threw for ${input.componentId}:${input.actionId}:`,
        err,
      );
      before = undefined;
    }
  }

  try {
    const result = await def.handler(execArgs, ctx);
    const changed =
      before === undefined
        ? undefined
        : diffKeys(before, execArgs as Record<string, unknown>);
    return {
      kind: "executed",
      args: execArgs as Record<string, unknown>,
      before,
      changed,
      result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "failed",
      message,
      args: execArgs as Record<string, unknown>,
      before,
    };
  }
};

/**
 * Validate action args (with optional preflight) without executing the handler.
 * Used by MCP prepare and HTTP update-args flows.
 */
export const prepareActionArgs = async <TAuth>(
  registry: ComponentRegistry<any, TAuth>,
  input: {
    componentId: string;
    actionId: string;
    args: Record<string, unknown>;
    auth: TAuth;
    sessionId: string;
  },
): Promise<
  | { kind: "not_found"; message: string }
  | {
      kind: "blocked";
      message: string;
      blockers: ActionBlocker[];
      args: Record<string, unknown>;
    }
  | {
      kind: "invalid";
      ready: false;
      missing: string[];
      errors?: string;
      args: Record<string, unknown>;
      normalizedArgs?: Record<string, unknown>;
    }
  | {
      kind: "ready";
      ready: true;
      missing: [];
      args: Record<string, unknown>;
      normalizedArgs: Record<string, unknown>;
    }
> => {
  const def = registry.getAction(input.componentId, input.actionId);
  if (!def) {
    return { kind: "not_found", message: "unknown action" };
  }

  const ctx: ActionContext<TAuth> = {
    auth: input.auth,
    sessionId: input.sessionId,
  };

  const preflight = await runActionPreflight(
    def,
    input.args as never,
    ctx,
  );
  if (!preflight.ok) {
    return {
      kind: "blocked",
      message: preflight.message,
      blockers: preflight.blockers,
      args: input.args,
    };
  }

  const argsForValidation = preflight.resolvedArgs
    ? { ...input.args, ...preflight.resolvedArgs }
    : input.args;

  const validation = validateActionArgs(def.schema, argsForValidation);
  if (!validation.ok) {
    return {
      kind: "invalid",
      ready: false,
      missing: validation.missing,
      errors: validation.error,
      args: input.args,
      normalizedArgs: argsForValidation,
    };
  }

  return {
    kind: "ready",
    ready: true,
    missing: [],
    args: input.args,
    normalizedArgs: validation.data as Record<string, unknown>,
  };
};
