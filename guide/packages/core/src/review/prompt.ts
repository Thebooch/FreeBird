import type { ReviewableComponentSummary } from "./types.js";

/**
 * System-prompt block describing the review flow. Injected only when the
 * registry has reviewable components.
 */
export const buildReviewPrompt = (
  reviewable: ReviewableComponentSummary[],
): string => {
  if (reviewable.length === 0) return "";

  const lines = [
    "## Review mode",
    "",
    "Some components support a guided review of their items (e.g. call logs).",
    "When the user asks to review one of these, open it with `plan_layout` so the review surface renders, and call `review_items` to load and discuss the items.",
    "Highlight items flagged as concerning, summarize what happened, and answer questions.",
    "Users can dismiss or flag items in the review surface.",
    "When a user wants to report a problem about a specific item, follow the customer-service flow: try to remedy first, then escalate with `report_issue`, attaching that item's details.",
    "",
    "Reviewable components:",
    ...reviewable.map(
      (r) =>
        `- ${r.componentId} (${r.title}): ${r.itemNoun}s; dispositions: ${r.dispositions.join(", ")}` +
        (r.guidance ? ` — ${r.guidance}` : ""),
    ),
  ];

  return lines.join("\n");
};
