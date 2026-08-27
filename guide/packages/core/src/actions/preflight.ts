import type { ActionContext, ActionDefinition } from "../types.js";
import type {
  ActionPreflightResult,
} from "./types.js";

export type { ActionBlocker, ActionPreflightResult, SuggestedAction } from "./types.js";

export async function runActionPreflight<TArgs, TResult, TAuth>(
  def: ActionDefinition<TArgs, TResult, TAuth>,
  args: TArgs,
  ctx: ActionContext<TAuth>,
): Promise<ActionPreflightResult> {
  if (!def.preflight) return { ok: true };
  try {
    const result = await def.preflight(args, ctx);
    if (result.ok) return result;
    return {
      ok: false,
      message: result.message,
      blockers: result.blockers ?? [],
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      blockers: [
        {
          code: "PREFLIGHT_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}
