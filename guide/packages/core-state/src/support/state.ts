import type {
  IssueClassification,
  Ticket,
  TicketDraft,
  TicketPreviewContent,
} from "@freebirdai/core";

export type SupportPhase = "idle" | "awaiting_confirmation" | "filed";

export interface SupportDraftState {
  draftId: string;
  draft: TicketDraft;
  preview: TicketPreviewContent;
  classification: IssueClassification;
  subject?: Record<string, unknown>;
  transcriptExcerpt?: string;
  metadata?: Record<string, unknown>;
}

export interface SupportState {
  phase: SupportPhase;
  pending: SupportDraftState | null;
  lastFiled: Ticket | null;
  lastError?: string;
}

export const initialSupportState = (): SupportState => ({
  phase: "idle",
  pending: null,
  lastFiled: null,
});

export type SupportTransition =
  | { type: "draft"; payload: SupportDraftState }
  | { type: "filed"; ticket: Ticket }
  | { type: "failed"; message: string }
  | { type: "cancel" }
  | { type: "reset" };

export const applySupportTransition = (
  state: SupportState,
  t: SupportTransition,
): SupportState => {
  switch (t.type) {
    case "draft":
      return {
        ...state,
        phase: "awaiting_confirmation",
        pending: t.payload,
        lastError: undefined,
      };
    case "filed":
      return {
        phase: "filed",
        pending: null,
        lastFiled: t.ticket,
        lastError: undefined,
      };
    case "failed":
      return {
        ...state,
        lastError: t.message,
      };
    case "cancel":
      return {
        ...state,
        phase: "idle",
        pending: null,
        lastError: undefined,
      };
    case "reset":
      return initialSupportState();
    default:
      return state;
  }
};
