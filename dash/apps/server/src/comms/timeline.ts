import type { MailDraft } from "@freebirdai/dash-spec";

/**
 * Email a person sent from Comms, as finished work on the chat's timeline.
 * A workflow's email already shows there as its step's task, so only email
 * no workflow step sent is listed.
 */
export const emailTimeline = (drafts: readonly MailDraft[]) =>
  drafts
    .filter((draft) => draft.status === "sent" && draft.sentAt && !draft.task)
    .map((draft) => ({
      id: `email:${draft.id}`,
      kind: "email" as const,
      at: draft.sentAt!,
      title: `${draft.replyTo ? "Replied to" : "Emailed"} ${draft.to.split(",")[0]?.replace(/<.*>/, "").replace(/"/g, "").trim() || draft.to}`,
      detail: draft.subject || undefined,
      status: "succeeded",
      agent: draft.agent,
      link: "#/comms",
    }));
