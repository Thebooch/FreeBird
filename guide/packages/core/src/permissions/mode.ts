import type { AuthContext } from "../types.js";

/**
 * How much the agent is trusted to do in this session, as one posture.
 *
 * `requiresConfirmation` is the wrong axis for this and always was: it is set
 * by whoever *declared* the action, so making a deployment read-only meant
 * editing every action in the registry, and a host serving many tenants could
 * not vary it at all. This is the orthogonal axis — the action says how risky
 * it is, the posture says how much latitude this caller has.
 *
 * Three rungs, ascending in restrictiveness:
 *
 * - `full` — the action's own `requiresConfirmation` stands. What every
 *   deployment did before this existed, and the default when no resolver is
 *   configured, so nothing changes without opting in.
 * - `guarded` — nothing executes unseen. An action declaring `"none"` is
 *   raised to `"preview"`; `"strict"` is left alone.
 * - `readonly` — actions are not offered and not executed. The model never
 *   receives their schemas, so it cannot propose what it cannot call.
 *
 * OpenClaw's fourth mode, an AI reviewer between `guarded` and `full`, is
 * deliberately absent: it needs a reviewer prompt and its own eval, and it
 * should not hold up the three rungs that need neither.
 */
export type PermissionMode = "full" | "guarded" | "readonly";

/** Ascending restrictiveness. The index *is* the comparison. */
const ORDER: readonly PermissionMode[] = ["full", "guarded", "readonly"];

export const isPermissionMode = (value: unknown): value is PermissionMode =>
  typeof value === "string" && (ORDER as readonly string[]).includes(value);

/** Higher is more restrictive. */
export const restrictiveness = (mode: PermissionMode): number => ORDER.indexOf(mode);

/** Is `candidate` at least as restrictive as `floor`? */
export const isAtLeastAsRestrictive = (
  candidate: PermissionMode,
  floor: PermissionMode,
): boolean => restrictiveness(candidate) >= restrictiveness(floor);

type MaybePromise<T> = T | Promise<T>;

/** Resolve the posture for one caller, the way the registry and LLM resolve. */
export type ModeResolver = (ctx: AuthContext) => MaybePromise<PermissionMode>;

/** Either a fixed posture (single-tenant) or an auth-keyed resolver (multi). */
export type ModeInput = PermissionMode | ModeResolver;

/** Absent means ungated, which is the behaviour that predates this module. */
export const DEFAULT_MODE: PermissionMode = "full";

export const resolveMode = async (
  input: ModeInput | undefined,
  ctx: AuthContext,
): Promise<PermissionMode> => {
  if (input === undefined) return DEFAULT_MODE;
  if (typeof input === "function") return input(ctx);
  return input;
};

export type NarrowResult =
  | { readonly ok: true; readonly mode: PermissionMode }
  | { readonly ok: false; readonly reason: string };

/**
 * Apply a session's requested posture on top of the tenant's.
 *
 * A session may only tighten. Widening is **rejected**, not silently clamped:
 * a caller that asked for `full` inside a `guarded` tenant has misunderstood
 * something, and quietly handing back `guarded` would let that
 * misunderstanding survive into production looking like it worked.
 */
export const narrowMode = (
  tenant: PermissionMode,
  requested: PermissionMode | undefined,
): NarrowResult => {
  if (requested === undefined) return { ok: true, mode: tenant };
  if (!isAtLeastAsRestrictive(requested, tenant)) {
    return {
      ok: false,
      reason: `this session cannot use "${requested}" permissions: "${tenant}" is in force and a session may only narrow`,
    };
  }
  return { ok: true, mode: requested };
};

/** Whether actions may be proposed or executed at all. */
export const allowsActions = (mode: PermissionMode): boolean => mode !== "readonly";

/**
 * What confirmation this action actually requires under this posture.
 *
 * Only ever tightens. `readonly` returns `"strict"` so that a caller which
 * forgets to check {@link allowsActions} still cannot execute silently — the
 * gate is `allowsActions`, and this is the backstop behind it.
 */
export const clampConfirmation = (
  mode: PermissionMode,
  requiresConfirmation: "none" | "preview" | "strict",
): "none" | "preview" | "strict" => {
  if (mode === "full") return requiresConfirmation;
  if (mode === "readonly") return "strict";
  return requiresConfirmation === "none" ? "preview" : requiresConfirmation;
};
