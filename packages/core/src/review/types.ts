/**
 * Universal "review" capability.
 *
 * A component declares it is reviewable; the host provides the actual items
 * (via the `review_items` tool execution) and renders the review surface.
 * FreeBird owns the LLM contract: normalized item shape, supported
 * dispositions, the prompt, and the bridge into the support/escalation flow.
 */

export type ReviewDisposition = "dismiss" | "flag" | "report";

export const ALL_REVIEW_DISPOSITIONS: ReviewDisposition[] = [
  "dismiss",
  "flag",
  "report",
];

/**
 * One reviewable item, normalized so the LLM can talk about it and the
 * support flow can attach it as `supportContext.subject` when reporting.
 */
export interface ReviewableItem {
  id: string;
  title?: string;
  summary?: string;
  /** Host-flagged (already marked by a user). */
  flagged?: boolean;
  /** Heuristically concerning (host or framework hint). */
  concerning?: boolean;
  createdAt?: string | Date;
  /** Raw host payload carried through to a ticket subject. */
  payload?: Record<string, unknown>;
}

/**
 * Capability declared on a {@link ComponentDefinition}. Rendering stays
 * host-side; this only describes the review contract for the LLM.
 */
export interface ReviewCapability {
  /** Singular noun for an item, e.g. "call", "invoice". Default "item". */
  itemNoun?: string;
  /** Dispositions the host supports. Default: all. */
  dispositions?: ReviewDisposition[];
  /** Extra LLM guidance: what to look for / flag as concerning. */
  guidance?: string;
}

export interface ReviewableComponentSummary {
  componentId: string;
  title: string;
  itemNoun: string;
  dispositions: ReviewDisposition[];
  guidance?: string;
}
