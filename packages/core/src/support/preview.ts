import type { TicketDraft } from "./ticket.js";

export interface TicketPreviewRow {
  label: string;
  value: string;
}

export interface TicketPreviewContent {
  title: string;
  rows: TicketPreviewRow[];
}

const TYPE_LABELS: Record<TicketDraft["type"], string> = {
  bug: "Bug",
  feature: "Feature request",
  behavior: "Agent behavior",
};

const TITLE_LABELS: Record<TicketDraft["type"], string> = {
  bug: "Bug report",
  feature: "Feature request",
  behavior: "Agent behavior report",
};

const severityDimension = (type: TicketDraft["type"]): string =>
  type === "feature" ? "Complexity" : "Severity";

const severityLabel = (
  type: TicketDraft["type"],
  severity: TicketDraft["severity"],
): string => `${severityDimension(type)}: ${severity}`;

export const deriveTicketPreview = (draft: TicketDraft): TicketPreviewContent => {
  const rows: TicketPreviewRow[] = [
    { label: "Type", value: TYPE_LABELS[draft.type] },
    {
      label: severityDimension(draft.type),
      value: draft.severity,
    },
    { label: "Title", value: draft.title },
    { label: "Summary", value: draft.summary },
  ];

  if (draft.stepsToReproduce) {
    rows.push({ label: "Steps to reproduce", value: draft.stepsToReproduce });
  }
  if (draft.desiredOutcome) {
    rows.push({ label: "Desired outcome", value: draft.desiredOutcome });
  }
  if (draft.observedResponse) {
    rows.push({ label: "Observed response", value: draft.observedResponse });
  }
  if (draft.attemptedRemedies?.length) {
    rows.push({
      label: "Attempted remedies",
      value: draft.attemptedRemedies.join("; "),
    });
  }
  if (draft.relatedComponentIds?.length) {
    rows.push({
      label: "Related components",
      value: draft.relatedComponentIds.join(", "),
    });
  }
  if (draft.tags?.length) {
    rows.push({ label: "Tags", value: draft.tags.join(", ") });
  }

  return {
    title: `${TITLE_LABELS[draft.type]} — ${severityLabel(draft.type, draft.severity)}`,
    rows,
  };
};
