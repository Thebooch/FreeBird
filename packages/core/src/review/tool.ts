import { z } from "zod";
import type { LlmTool } from "../adapters/llm.js";
import type { ReviewableComponentSummary } from "./types.js";

export const REVIEW_ITEMS_TOOL_NAME = "review_items";

/**
 * Build the `review_items` tool. Execution is delegated to the host
 * (`ChatEngineOptions.executeExtraTool`), which returns
 * `{ items: ReviewableItem[] }` for the requested component.
 */
export const buildReviewItemsTool = (
  reviewable: ReviewableComponentSummary[],
): LlmTool => {
  const ids = reviewable.map((r) => r.componentId);
  const componentIdSchema =
    ids.length > 0
      ? z.enum(ids as [string, ...string[]])
      : z.string().min(1);

  const summary = reviewable
    .map(
      (r) =>
        `- ${r.componentId}: review ${r.itemNoun}s (${r.title})` +
        (r.guidance ? ` — ${r.guidance}` : ""),
    )
    .join("\n");

  return {
    name: REVIEW_ITEMS_TOOL_NAME,
    description:
      "Fetch reviewable items (e.g. call logs) for a component the user wants to review. " +
      "Summarize them, surface concerning ones, and answer questions. " +
      "When the user wants to report a problem on a specific item, escalate via report_issue " +
      "and include that item's details.\n" +
      "Reviewable components:\n" +
      summary,
    schema: z.object({
      componentId: componentIdSchema.describe(
        "Which reviewable component to load items for.",
      ),
      onlyConcerning: z
        .boolean()
        .optional()
        .describe("When true, return only items flagged as concerning."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max items to return."),
    }),
  };
};
