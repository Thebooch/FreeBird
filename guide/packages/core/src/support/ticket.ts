import { z } from "zod";
import { newId } from "../id.js";

export const ticketTypeSchema = z.enum(["bug", "feature", "behavior"]);
export type TicketType = z.infer<typeof ticketTypeSchema>;

export const ticketSeveritySchema = z.enum(["low", "medium", "high"]);
export type TicketSeverity = z.infer<typeof ticketSeveritySchema>;

/**
 * LLM-produced ticket body before server stamping. One Zod schema drives
 * tool parameters, confirmation preview, and final validation.
 */
export const ticketDraftSchema = z.object({
  type: ticketTypeSchema.describe(
    "bug = something broken or not working as expected in the app; " +
      "feature = new capability or setting request; " +
      "behavior = a complaint about how an AI agent responded in conversation (not app behavior)",
  ),
  severity: ticketSeveritySchema.describe(
    "For a bug: severity/impact (low/medium/high). " +
      "For a feature: perceived implementation complexity (low/medium/high). " +
      "For behavior: high = technically broken response (leaked prompt/instructions, raw JSON, non-conversational output); " +
      "medium = the agent gave incorrect information/answer; " +
      "low = stylistic/wording complaint where the information is still accurate.",
  ),
  title: z.string().min(1).describe("Short one-line summary"),
  summary: z
    .string()
    .min(1)
    .describe(
      "Full description of the issue or request in the user's words, clarified",
    ),
  stepsToReproduce: z
    .string()
    .optional()
    .describe("Bugs only: how to reproduce"),
  desiredOutcome: z
    .string()
    .optional()
    .describe("Features only: what the user wants to be able to do"),
  observedResponse: z
    .string()
    .optional()
    .describe(
      "Behavior only: what the agent actually said and what was wrong with it",
    ),
  attemptedRemedies: z
    .array(z.string())
    .optional()
    .describe("What the assistant already tried before escalating"),
  relatedComponentIds: z
    .array(z.string())
    .optional()
    .describe("FreeBird component ids related to this issue"),
  tags: z.array(z.string()).optional().describe("Optional categorization tags"),
});

export type TicketDraft = z.infer<typeof ticketDraftSchema>;

/** Host context attached when filing (e.g. a call log row from review). */
export const ticketSubjectSchema = z.record(z.unknown()).optional();

export const fileTicketBodySchema = z.object({
  sessionId: z.string().min(1),
  draft: ticketDraftSchema,
  subject: ticketSubjectSchema,
  transcriptExcerpt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type FileTicketBody = z.infer<typeof fileTicketBodySchema>;

/**
 * Canonical ticket JSON emitted to the host {@link SupportSink}.
 */
export interface Ticket extends TicketDraft {
  id: string;
  userId: string;
  sessionId: string;
  createdAt: Date;
  /** Optional tenant/organization id from {@link AuthContext}. */
  orgId?: string;
  /** Host context object (e.g. call log snapshot). */
  subject?: Record<string, unknown>;
  transcriptExcerpt?: string;
  metadata?: Record<string, unknown>;
  /** Set when the sink returns an external reference. */
  externalId?: string;
  externalUrl?: string;
}

export interface IssueClassification {
  type: TicketType;
  severity: TicketSeverity;
}

export interface StampTicketInput {
  subject?: Record<string, unknown>;
  transcriptExcerpt?: string;
  metadata?: Record<string, unknown>;
  externalId?: string;
  externalUrl?: string;
}

/** Merge draft + auth/session into a filed {@link Ticket}. */
export const stampTicket = (
  draft: TicketDraft,
  auth: { userId?: string; orgId?: string },
  sessionId: string,
  extra?: StampTicketInput,
): Ticket => ({
    ...draft,
    id: newId("ticket"),
    userId: auth.userId ?? "unknown",
    orgId: auth.orgId,
    sessionId,
    createdAt: new Date(),
    subject: extra?.subject,
    transcriptExcerpt: extra?.transcriptExcerpt,
    metadata: extra?.metadata,
    externalId: extra?.externalId,
    externalUrl: extra?.externalUrl,
  });
