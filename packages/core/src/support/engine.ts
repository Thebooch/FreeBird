import type { LlmTool } from "../adapters/llm.js";
import { ticketDraftSchema, type IssueClassification, type TicketDraft } from "./ticket.js";
import { deriveTicketPreview, type TicketPreviewContent } from "./preview.js";

export const REPORT_ISSUE_TOOL_NAME = "report_issue";

export const buildReportIssueTool = (): LlmTool<TicketDraft> => ({
  name: REPORT_ISSUE_TOOL_NAME,
  description:
    "Escalate to a support ticket when you cannot remedy the user's issue with available tools/actions. " +
    "Ask clarifying questions in chat first, then call this with a complete draft. " +
    "You MUST call this tool to create a ticket — never list a ticket draft only in chat text. " +
    "For bugs include stepsToReproduce when known; for features include desiredOutcome; for behavior include observedResponse. " +
    "severity: for bugs = impact; for features = perceived complexity; for behavior = high (broken/non-conversational reply), medium (wrong info), low (stylistic only).",
  schema: ticketDraftSchema,
});

export const parseReportIssueArgs = (raw: unknown): TicketDraft | null => {
  const parsed = ticketDraftSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export const classificationFromDraft = (
  draft: TicketDraft,
): IssueClassification => ({
  type: draft.type,
  severity: draft.severity,
});

export interface TicketDraftPayload {
  draftId: string;
  draft: TicketDraft;
  preview: TicketPreviewContent;
  classification: IssueClassification;
  subject?: Record<string, unknown>;
  transcriptExcerpt?: string;
  metadata?: Record<string, unknown>;
}

export const buildTicketDraftPayload = (
  draftId: string,
  draft: TicketDraft,
  ctx?: {
    subject?: Record<string, unknown>;
    transcriptExcerpt?: string;
    metadata?: Record<string, unknown>;
  },
): TicketDraftPayload => ({
  draftId,
  draft,
  preview: deriveTicketPreview(draft),
  classification: classificationFromDraft(draft),
  subject: ctx?.subject,
  transcriptExcerpt: ctx?.transcriptExcerpt,
  metadata: ctx?.metadata,
});
