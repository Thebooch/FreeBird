import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LlmTool } from "../adapters/llm.js";
import type { ComponentRegistry } from "../components/registry.js";
import { looseObjectSchema } from "../schema/looseObject.js";

/**
 * Not sending every action's schema on every turn.
 *
 * `argsMode: "per_action"` — the recommended default — emits one tool per
 * candidate action. That is the right shape at ten actions and an expensive
 * one at two hundred: the schemas go out on every turn, and on every inner
 * step of the tool loop, forever.
 *
 * Above a byte budget the per-action tools are withheld and replaced by a
 * search pair: `tool_search` finds actions by description, `tool_describe`
 * returns one schema, and a generic `start_action` calls it. Below the budget
 * nothing changes at all — this is a packaging decision for large registries,
 * not a new way to work.
 *
 * It is emphatically *not* an authorization boundary. The permission posture
 * has already run by the time any of this is consulted: a read-only session
 * gets no tools at all, so it gets no search tool either.
 */

export const TOOL_SEARCH_NAME = "tool_search";
export const TOOL_DESCRIBE_NAME = "tool_describe";

/**
 * Default budget for the whole turn's tool map.
 *
 * Bytes rather than a count of actions, because bytes are the actual cost: a
 * dozen actions with deeply nested argument schemas outweigh eighty flat ones,
 * and a count threshold would defer the wrong set in both directions.
 */
export const DEFAULT_TOOL_BUDGET_BYTES = 24 * 1024;

/**
 * How large this tool map is on the wire.
 *
 * Converts to JSON Schema first because that is what an adapter actually
 * sends; `JSON.stringify` over a Zod object measures Zod's internals, which
 * bear no useful relation to the payload.
 */
export const serializedToolBytes = (tools: Record<string, LlmTool>): number => {
  let total = 0;
  for (const tool of Object.values(tools)) {
    total += tool.name.length + (tool.description?.length ?? 0);
    try {
      total += JSON.stringify(zodToJsonSchema(tool.schema)).length;
    } catch {
      // An unconvertible schema is one the adapter will also struggle with.
      // Counting it as nothing would under-report; a flat guess is honest
      // enough for a threshold.
      total += 200;
    }
  }
  return total;
};

export interface ActionCandidate {
  readonly ref: string;
  readonly componentId: string;
  readonly actionId: string;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Plain scored substring matching over id, title and description.
 *
 * Deliberately not embeddings. This runs on every turn above the threshold,
 * and a tool list that varies between two identical turns is a debugging
 * problem nobody wants — "why did it not find the action this time" is not a
 * question worth introducing to save a keyword match.
 */
export const scoreCandidate = (query: string, candidate: ActionCandidate): number => {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const terms = q.split(/\s+/).filter(Boolean);
  const ref = candidate.ref.toLowerCase();
  const action = candidate.actionId.toLowerCase();
  const description = candidate.description.toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (action === term) score += 10;
    else if (action.includes(term)) score += 5;
    if (candidate.componentId.toLowerCase().includes(term)) score += 3;
    if (ref.includes(term)) score += 2;
    if (description.includes(term)) score += 1;
  }
  return score;
};

export const searchActions = (
  candidates: readonly ActionCandidate[],
  query: string,
  limit = 10,
): ActionCandidate[] =>
  candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(query, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.ref.localeCompare(b.candidate.ref))
    .slice(0, limit)
    .map((entry) => entry.candidate);

// ---------------------------------------------------------------------------
// The deferred tool set
// ---------------------------------------------------------------------------

export const buildToolSearchTool = (count: number): LlmTool => ({
  name: TOOL_SEARCH_NAME,
  description:
    `Find an action by describing it. This site registers ${count} actions, too many to ` +
    "list, so search for the one you need, call `tool_describe` to learn its arguments, " +
    "then start it with `start_action`.",
  schema: z.object({
    query: z
      .string()
      .min(1)
      .describe("What you want to do, in a few words — e.g. 'refund an order'."),
  }),
});

export const buildToolDescribeTool = (): LlmTool => ({
  name: TOOL_DESCRIBE_NAME,
  description:
    "Get the full argument schema for one action, using a ref returned by `tool_search`.",
  schema: z.object({
    action: z.string().min(1).describe("Action ref in the form `componentId:actionId`."),
  }),
});

/**
 * The generic starter for the deferred path.
 *
 * Its `action` is a free-form string rather than the enum the normal
 * `start_action` uses: enumerating every ref is one of the costs this whole
 * mechanism exists to avoid. The model learns valid refs from `tool_search`.
 */
export const buildDeferredStartActionTool = (): LlmTool => ({
  name: "start_action",
  description:
    "Start an action found through `tool_search`. Call `tool_describe` first so you know " +
    "which arguments it takes.",
  schema: z.object({
    action: z.string().min(1).describe("Action ref in the form `componentId:actionId`."),
    label: z.string().optional().describe("Short human title for the action."),
    args: looseObjectSchema()
      .optional()
      .describe("Whichever argument fields the user has already given."),
  }),
});

/** Split a `componentId:actionId` ref. Null when it is not one. */
export const parseActionRef = (
  ref: unknown,
): { componentId: string; actionId: string } | null => {
  if (typeof ref !== "string") return null;
  const index = ref.indexOf(":");
  if (index <= 0 || index === ref.length - 1) return null;
  return { componentId: ref.slice(0, index), actionId: ref.slice(index + 1) };
};

/** Result payload for a `tool_describe` call, or null for an unknown ref. */
export const describeActionSchema = (
  registry: ComponentRegistry<any, any>,
  ref: unknown,
): { action: string; description: string; schema: unknown } | null => {
  const parsed = parseActionRef(ref);
  if (!parsed) return null;
  const def = registry.getAction(parsed.componentId, parsed.actionId);
  if (!def) return null;
  let schema: unknown;
  try {
    schema = zodToJsonSchema(def.schema as z.ZodTypeAny);
  } catch {
    schema = { type: "object" };
  }
  return { action: `${parsed.componentId}:${parsed.actionId}`, description: def.description, schema };
};
