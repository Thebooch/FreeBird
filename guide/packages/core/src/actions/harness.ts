import { z } from "zod";
import { looseObjectSchema } from "../schema/looseObject.js";
import type { ComponentRegistry } from "../components/registry.js";
import type { LlmMessage, LlmTool } from "../adapters/llm.js";
import type { ActionRecord, ActionState } from "./types.js";
import { allowsActions, type PermissionMode } from "../permissions/index.js";

/**
 * Output of {@link buildHarnessTurn}: a per-turn slice of LLM-facing
 * configuration the action layer wants to inject into the chat call.
 *
 * The chat engine merges:
 *   - `tools`           into its existing `tools` map
 *   - `systemMessages`  immediately after the global system prompt
 *
 * `phase`/`activeActionIds` are echoed for callers that want to log or
 * gate behaviour outside the LLM call itself.
 */
export interface HarnessTurn {
  tools: Record<string, LlmTool>;
  systemMessages: LlmMessage[];
  phase: ActionState["phase"];
  activeActionIds: string[];
}

/**
 * How the harness shapes the `args` field on `start_action` /
 * `update_action_args`:
 *
 * - `"typed"` (default) — emits a discriminated union per action ref so
 *   the LLM gets the action's actual Zod schema as a tool parameter.
 *   Eliminates the "label vs args" confusion at the source. Falls back to
 *   `"loose"` if the schema can't be represented (e.g. complex refines
 *   that the JSON-Schema converter rejects).
 * - `"loose"` — `args: z.record(z.unknown())` with the per-action schema
 *   buried in the description. Use as an escape hatch if your provider
 *   adapter struggles with discriminated unions.
 * - `"per_action"` (recommended) — one LLM tool per candidate action
 *   (`start_action__<componentId>__<actionId>`) whose parameters are that
 *   action's partial Zod object at the top level. Avoids root-level `oneOf`
 *   (OpenAI) and `const` literals (small models) while keeping typed fields.
 */
export type HarnessArgsMode = "typed" | "loose" | "per_action";

/** Prefix for per-action start tools. */
export const PER_ACTION_START_PREFIX = "start_action__";

/** Encode a per-action harness tool name (ids must not contain `__`). */
export const encodePerActionStartToolName = (
  componentId: string,
  actionId: string,
): string => `${PER_ACTION_START_PREFIX}${componentId}__${actionId}`;

/** Resolve a per-action tool name against registered actions. */
export const resolvePerActionStartToolName = (
  name: string,
  registry: ComponentRegistry<any, any>,
): { componentId: string; actionId: string } | null => {
  if (!name.startsWith(PER_ACTION_START_PREFIX)) return null;
  const body = name.slice(PER_ACTION_START_PREFIX.length);
  for (const entry of registry.listActions()) {
    const suffix = `${entry.componentId}__${entry.action.id}`;
    if (body === suffix) {
      return { componentId: entry.componentId, actionId: entry.action.id };
    }
  }
  return null;
};

export interface BuildHarnessTurnInput {
  registry: ComponentRegistry<any, any>;
  actionState: ActionState;
  /** Component ids the user can currently see / interact with. */
  activeComponentIds?: string[];
  /** @default "per_action" */
  argsMode?: HarnessArgsMode;
  /**
   * Posture for this turn. Already resolved by the caller from its auth.
   *
   * Under `readonly` no action tool is emitted at all: a model that cannot
   * see a schema cannot propose calling it, which is a cheaper and more
   * honest gate than letting it try and refusing afterwards.
   *
   * @default "full"
   */
  permissionMode?: PermissionMode;
}

/**
 * Build the action-layer slice of a chat turn.
 *
 * Tool gating by phase:
 *
 *   idle / error
 *     - start_action          (only for active components with actions[])
 *     - resume_action         (only when a paused journal record exists)
 *
 *   collecting
 *     - update_action_args
 *     - request_clarification
 *     - cancel_action
 *     - pause_action
 *
 *   awaiting_confirmation
 *     - cancel_action
 *     - pause_action
 *
 *   executing
 *     - (no action tools; the harness prevents start until executed/failed)
 */
export const buildHarnessTurn = (
  input: BuildHarnessTurnInput,
): HarnessTurn => {
  const { registry, actionState, activeComponentIds } = input;
  const argsMode: HarnessArgsMode = input.argsMode ?? "per_action";
  const phase = actionState.phase;
  const mode: PermissionMode = input.permissionMode ?? "full";

  /*
   * Read-only sessions get no action surface whatsoever — not the start
   * tools, not the ones that steer an action already under way. Returning
   * early rather than filtering at the end keeps that a single statement
   * instead of a condition repeated in every phase branch.
   */
  if (!allowsActions(mode)) {
    return { tools: {}, systemMessages: [], phase, activeActionIds: [] };
  }

  const candidateActions = registry
    .listActions(
      activeComponentIds && activeComponentIds.length > 0
        ? { componentIds: activeComponentIds }
        : undefined,
    )
    .map((entry) => ({
      ref: `${entry.componentId}:${entry.action.id}`,
      componentId: entry.componentId,
      actionId: entry.action.id,
      description: entry.action.description,
    }));

  const pausedRecords = actionState.journal.filter((r) => r.status === "paused");

  const tools: Record<string, LlmTool> = {};
  const systemMessages: LlmMessage[] = [];

  if (phase === "idle" || phase === "error") {
    if (candidateActions.length > 0) {
      mergeStartActionTools(tools, systemMessages, candidateActions, registry, argsMode);
    }
    if (pausedRecords.length > 0) {
      tools.resume_action = buildResumeActionTool(pausedRecords);
      systemMessages.push({
        role: "system",
        content: renderPausedSummary(pausedRecords),
      });
    }
  } else if (phase === "collecting") {
    tools.update_action_args = buildUpdateArgsTool(
      actionState,
      registry,
      argsMode,
    );
    tools.request_clarification = buildRequestClarificationTool();
    tools.cancel_action = buildCancelActionTool();
    tools.pause_action = buildPauseActionTool();
    if (actionState.pending) {
      systemMessages.push({
        role: "system",
        content: renderCollectingPrompt(actionState),
      });
    }
  } else if (phase === "awaiting_confirmation") {
    tools.cancel_action = buildCancelActionTool();
    tools.pause_action = buildPauseActionTool();
    if (actionState.pending) {
      systemMessages.push({
        role: "system",
        content: renderAwaitingConfirmationPrompt(actionState),
      });
    }
  } else if (phase === "blocked") {
    tools.cancel_action = buildCancelActionTool();
    tools.pause_action = buildPauseActionTool();
    if (actionState.pending && blockersAllowArgUpdate(actionState)) {
      tools.update_action_args = buildUpdateArgsTool(
        actionState,
        registry,
        argsMode,
      );
    }
    const suggested = collectSuggestedActions(actionState);
    if (suggested.length > 0) {
      mergeStartActionTools(tools, systemMessages, suggested, registry, argsMode);
    }
    if (actionState.pending) {
      systemMessages.push({
        role: "system",
        content: renderBlockedPrompt(actionState),
      });
    }
  }

  return {
    tools,
    systemMessages,
    phase,
    activeActionIds: candidateActions.map((c) => c.ref),
  };
};

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

/**
 * Wrap an action's args schema so the LLM may supply *some* of the fields
 * (it's the harness's job to detect missing required fields). For
 * `ZodObject`s we return `.partial()`; for non-object schemas we return
 * the schema as-is wrapped in `.optional()`.
 */
const partialArgsSchema = (schema: z.ZodTypeAny): z.ZodTypeAny => {
  if (schema instanceof z.ZodObject) {
    return schema.partial();
  }
  return schema.optional();
};

const mergeStartActionTools = (
  tools: Record<string, LlmTool>,
  systemMessages: LlmMessage[],
  candidates: Array<{
    ref: string;
    componentId: string;
    actionId: string;
    description: string;
  }>,
  registry: ComponentRegistry<any, any>,
  mode: HarnessArgsMode,
): void => {
  if (mode === "per_action") {
    for (const c of candidates) {
      const name = encodePerActionStartToolName(c.componentId, c.actionId);
      tools[name] = buildPerActionStartTool(c, registry);
    }
    const summary = candidates
      .map(
        (c) =>
          `- ${encodePerActionStartToolName(c.componentId, c.actionId)}: ${c.description}`,
      )
      .join("\n");
    systemMessages.push({
      role: "system",
      content:
        "To start an action, call the matching `start_action__...` tool for that " +
        "component. Put argument field values at the **top level** of the tool " +
        "call (not nested under `args`). Use `label` only as a short human title. " +
        "Available tools:\n" +
        summary,
    });
    return;
  }
  tools.start_action = buildStartActionTool(candidates, registry, mode);
};

const buildPerActionStartTool = (
  candidate: {
    ref: string;
    componentId: string;
    actionId: string;
    description: string;
  },
  registry: ComponentRegistry<any, any>,
): LlmTool => {
  const def = registry.getAction(candidate.componentId, candidate.actionId);
  const partial = def
    ? partialArgsSchema(def.schema as z.ZodTypeAny)
    : looseObjectSchema().optional();

  let schema: z.ZodTypeAny = z.object({
    label: labelField(),
    args: partial.describe(
      "Arguments the user has already specified (fallback when fields cannot be flattened).",
    ),
  });

  if (partial instanceof z.ZodObject) {
    schema = partial.extend({
      label: labelField(),
    });
  }

  return {
    name: encodePerActionStartToolName(candidate.componentId, candidate.actionId),
    description:
      `Start action \`${candidate.ref}\`. ${candidate.description} ` +
      "Provide whichever fields the user has already specified at the top level; " +
      "the system will ask for any missing required fields, then show a confirmation preview.",
    schema,
  };
};

const buildStartActionTool = (
  candidates: Array<{
    ref: string;
    componentId: string;
    actionId: string;
    description: string;
  }>,
  registry: ComponentRegistry<any, any>,
  mode: HarnessArgsMode,
): LlmTool => {
  const refs = candidates.map((c) => c.ref);
  const refSchema =
    refs.length > 0
      ? z.enum(refs as [string, ...string[]])
      : z.string().min(1);

  const looseSchema = z.object({
    action: refSchema.describe(
      "Action reference in the form `componentId:actionId`. Choose from the list provided.",
    ),
    label: labelField(),
    args: looseObjectSchema()
      .optional()
      .describe(
        "Initial arguments. Provide whichever fields the user has already specified; the system will ask for the rest.",
      ),
  });

  let schema: z.ZodTypeAny = looseSchema;
  if (mode === "typed" && candidates.length > 0) {
    try {
      const variants = candidates.map((c) => {
        const def = registry.getAction(c.componentId, c.actionId);
        const argsSchema = def
          ? partialArgsSchema(def.schema as z.ZodTypeAny)
          : looseObjectSchema().optional();
        return z
          .object({
            action: z.literal(c.ref),
            label: labelField(),
            args: (argsSchema as z.ZodTypeAny).describe(
              "Arguments the user has already specified. The system will ask " +
                "for any missing required fields.",
            ),
          })
          .describe(c.description);
      });
      // discriminatedUnion needs ≥ 2 variants; with one, use the variant directly.
      schema =
        variants.length === 1
          ? variants[0]!
          : (z.discriminatedUnion(
              "action",
              variants as unknown as [
                z.ZodObject<any>,
                z.ZodObject<any>,
                ...z.ZodObject<any>[],
              ],
            ) as unknown as z.ZodTypeAny);
    } catch (err) {
       
      console.warn(
        "[freebird] harness: typed start_action schema failed; falling back to loose mode.",
        err,
      );
      schema = looseSchema;
    }
  }

  const summary = candidates
    .map((c) => `- ${c.ref}: ${c.description}`)
    .join("\n");

  return {
    name: "start_action",
    description:
      "Start an action on the user's behalf. Pick the most relevant action " +
      "from the list. The system will collect any missing arguments and " +
      "show the user a confirmation preview before applying changes. " +
      "Use this when the user clearly asks to change a setting or perform " +
      "an action one of the listed components supports.\n" +
      summary,
    schema,
  };
};

const buildUpdateArgsTool = (
  actionState: ActionState,
  registry: ComponentRegistry<any, any>,
  mode: HarnessArgsMode,
): LlmTool => {
  const looseSchema = z.object({
    args: looseObjectSchema().describe(
      "Partial arguments to merge into the in-progress action. Only include fields the user has provided.",
    ),
  });

  let schema: z.ZodTypeAny = looseSchema;
  if ((mode === "typed" || mode === "per_action") && actionState.pending) {
    try {
      const def = registry.getAction(
        actionState.pending.componentId,
        actionState.pending.actionId,
      );
      if (def) {
        schema = z.object({
          args: partialArgsSchema(def.schema as z.ZodTypeAny).describe(
            "Partial arguments to merge into the in-progress action. " +
              "Only include fields the user has provided.",
          ),
        });
      }
    } catch (err) {
       
      console.warn(
        "[freebird] harness: typed update_action_args schema failed; falling back to loose mode.",
        err,
      );
      schema = looseSchema;
    }
  }

  return {
    name: "update_action_args",
    description:
      "Provide additional arguments for the in-progress action. The system " +
      "will validate them against the action's schema and either ask for " +
      "more or move to confirmation.",
    schema,
  } satisfies LlmTool;
};

const buildRequestClarificationTool = (): LlmTool =>
  ({
    name: "request_clarification",
    description:
      "Ask the user a clarifying question before continuing the action. Use " +
      "when args are ambiguous or the user's request is contradictory.",
    schema: z.object({
      question: z
        .string()
        .min(1)
        .describe("The question to ask the user. Keep it short and specific."),
    }),
  }) satisfies LlmTool;

const buildCancelActionTool = (): LlmTool =>
  ({
    name: "cancel_action",
    description:
      "Cancel the in-progress action. Use when the user changes their mind " +
      "or asks to stop. The action is logged as 'terminated' in the journal.",
    schema: z.object({
      reason: z
        .string()
        .max(160)
        .optional()
        .describe("Optional one-line reason."),
    }),
  }) satisfies LlmTool;

const buildPauseActionTool = (): LlmTool =>
  ({
    name: "pause_action",
    description:
      "Park the in-progress action so the user can come back to it later. " +
      "Use this when the user pivots topics mid-flow ('actually, first show me X'). " +
      "The action is logged as 'paused' and can be picked back up via resume_action.",
    schema: z.object({
      label: z
        .string()
        .max(80)
        .optional()
        .describe("Optional friendly label, e.g. 'configure email digest'."),
    }),
  }) satisfies LlmTool;

const buildResumeActionTool = (paused: ActionRecord[]): LlmTool => {
  const ids = paused.map((r) => r.id);
  const idSchema =
    ids.length > 0
      ? z.enum(ids as [string, ...string[]])
      : z.string().min(1);
  const summary = paused
    .map(
      (r) =>
        `- ${r.id}: ${r.label ?? `${r.componentId}:${r.actionId}`} (paused ${r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt})`,
    )
    .join("\n");
  return {
    name: "resume_action",
    description:
      "Pick up a previously paused action. Use this when the user says " +
      "things like 'let's go back to what we were doing' or 'continue " +
      "configuring X'.\nPaused records:\n" +
      summary,
    schema: z.object({
      recordId: idSchema.describe(
        "Id of the paused journal record to resume.",
      ),
    }),
  };
};

const labelField = () =>
  z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Short human-friendly label for the journal, e.g. 'configure email digest'.",
    );

// ---------------------------------------------------------------------------
// System messages
// ---------------------------------------------------------------------------

const renderPausedSummary = (paused: ActionRecord[]): string => {
  const lines = paused.map(
    (r) =>
      `- id=${r.id}: ${r.label ?? `${r.componentId}:${r.actionId}`}`,
  );
  return (
    "There are paused actions in the user's journal. If the user references " +
    'them with phrases like "go back to", "resume", or "continue with", call ' +
    "`resume_action` with the matching record id.\n" +
    lines.join("\n")
  );
};

const collectSuggestedActions = (
  state: ActionState,
): Array<{
  ref: string;
  componentId: string;
  actionId: string;
  description: string;
}> => {
  const p = state.pending;
  if (!p?.blockers?.length) return [];
  const out: Array<{
    ref: string;
    componentId: string;
    actionId: string;
    description: string;
  }> = [];
  const seen = new Set<string>();
  for (const b of p.blockers) {
    for (const s of b.suggestActions ?? []) {
      const ref = `${s.componentId}:${s.actionId}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push({
        ref,
        componentId: s.componentId,
        actionId: s.actionId,
        description: s.label ?? `Create prerequisite via ${ref}`,
      });
    }
  }
  return out;
};

const blockersAllowArgUpdate = (state: ActionState): boolean => {
  const blockers = state.pending?.blockers ?? [];
  if (blockers.length === 0) return true;
  return blockers.some(
    (b) => b.field && !(b.suggestActions && b.suggestActions.length > 0),
  );
};

const renderBlockedPrompt = (state: ActionState): string => {
  const p = state.pending!;
  const ref = `${p.componentId}:${p.actionId}`;
  const msg = p.blockedMessage ?? "A prerequisite is missing.";
  const suggested = collectSuggestedActions(state)
    .map((s) => `- ${s.ref}: ${s.description}`)
    .join("\n");
  const canFillFields = blockersAllowArgUpdate(state);
  return (
    `Action \`${ref}\` is blocked: ${msg} ` +
    (canFillFields
      ? "When the user supplies a missing value, call the relevant processing tool " +
        "or use `update_action_args` to record it — the confirmation card will refresh. "
      : "") +
    (suggested
      ? `Suggested remediation actions:\n${suggested}\n` +
        "Use `start_action` with one of these refs if the user agrees. "
      : canFillFields
        ? "Ask the user for the missing field value. "
        : "Ask the user how they'd like to proceed. ") +
    "The host UI may also show remediation buttons."
  );
};

const renderCollectingPrompt = (state: ActionState): string => {
  const p = state.pending!;
  const ref = `${p.componentId}:${p.actionId}`;
  const collected = Object.keys(p.args).length
    ? Object.entries(p.args)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")
    : "(none)";
  const missingHint = p.missing.length
    ? `Missing required fields: ${p.missing.join(", ")}. Ask the user for these one at a time.`
    : p.blockers?.length
      ? `Prerequisite steps are incomplete (see blocked action card). Ask the user for the fields listed there.`
      : "All required schema fields are collected. Summarize and point to the confirmation card when preflight passes.";
  const progressHint = p.missing.length
    ? "Use `update_action_args` after the user gives you a value, then ask for the next missing field if any."
    : p.blockers?.length
      ? "Use `update_action_args` when the user supplies a blocked field, or use remediation child actions if suggested."
      : "Summarize what will be created/changed and point the user to Apply when ready.";
  return (
    `An action is in progress: \`${ref}\`. ` +
    `Collected so far: ${collected}. ${missingHint} ${progressHint} ` +
    "Use `pause_action` if the user pivots, or `cancel_action` if they back out."
  );
};

const renderAwaitingConfirmationPrompt = (state: ActionState): string => {
  const p = state.pending!;
  const ref = `${p.componentId}:${p.actionId}`;
  return (
    `Action \`${ref}\` is ready for the user to confirm. ` +
    "Do NOT call `update_action_args` again unless they ask to tweak. " +
    "Reply with a one-sentence summary of what will happen and wait — " +
    "the user clicks confirm in the UI; you don't need to call any tool " +
    "unless they pause or cancel."
  );
};
