import { AgentChip, Button, EmptyState } from "@freebirdai/dash-components";
import type { AgentSpec, MailDraft, MailThreadMessage, WriteReviewView } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { when } from "./model.js";

/**
 * One conversation, read live, with the drafts waiting on it inline: Edit,
 * Send, Save as draft, Discard. Sending shows the review first — to, cc,
 * subject and the words exactly as they will go — and only the approval of
 * that review sends it.
 */

const who = (one: MailThreadMessage): string => one.from?.name ?? one.from?.address ?? "Unknown sender";

const DraftCard = ({ draft, agents, onSettled }: { readonly draft: MailDraft; readonly agents: readonly AgentSpec[]; readonly onSettled: () => void }): JSX.Element => {
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [subject, setSubject] = useState(draft.subject);
  const [text, setText] = useState(draft.text);
  const [review, setReview] = useState<{ readonly view: WriteReviewView; readonly save: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(draft.error ?? null);
  const agent = draft.agent ? agents.find((one) => one.id === draft.agent) : undefined;
  const dirty = to !== draft.to || cc !== draft.cc || subject !== draft.subject || text !== draft.text;

  const run = async (what: string, action: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const open = (save: boolean) =>
    run(save ? "save" : "send", async () => {
      if (dirty) await api.editDraft(draft.id, { to, cc, subject, text });
      setReview({ view: await api.reviewDraft(draft.id, save), save });
    });

  return (
    <section className="dash-comms-draft" data-testid="comms-draft">
      <header className="dash-comms-draft__head">
        <span className="dash-comms-draft__label">Draft reply</span>
        {agent && <AgentChip name={agent.name} color={agent.color} size="sm" title={`Written by ${agent.name}`} />}
      </header>
      {review ? (
        <div className="dash-comms-review" data-testid="comms-review">
          <p className="dash-comms-review__summary">{review.save ? "Save this in the mailbox's drafts:" : review.view.summary}</p>
          <dl className="dash-comms-review__rows">
            {review.view.rows
              .filter((row) => row.after !== null)
              .map((row) => (
                <div key={row.field} className="dash-comms-review__row">
                  <dt>{row.label}</dt>
                  <dd>{row.after}</dd>
                </div>
              ))}
          </dl>
          {review.view.warnings.length > 0 && <p className="dash-hint">{review.view.warnings.join(" ")}</p>}
          <div className="dash-comms-draft__actions">
            <Button
              tone="primary"
              busy={busy === "approve"}
              testId="comms-approve"
              onClick={() =>
                void run("approve", async () => {
                  await api.sendDraft(draft.id, review.view, review.save);
                  onSettled();
                })
              }
            >
              {review.save ? "Save draft" : "Send now"}
            </Button>
            <Button tone="ghost" onClick={() => setReview(null)}>
              Back to editing
            </Button>
          </div>
        </div>
      ) : (
        <>
          <label className="dash-comms-field">
            <span>To</span>
            <input className="dash-sched-input" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label className="dash-comms-field">
            <span>Cc</span>
            <input className="dash-sched-input" value={cc} onChange={(event) => setCc(event.target.value)} />
          </label>
          <label className="dash-comms-field">
            <span>Subject</span>
            <input className="dash-sched-input" value={subject} onChange={(event) => setSubject(event.target.value)} />
          </label>
          <textarea className="dash-sched-input dash-comms-draft__text" rows={8} value={text} onChange={(event) => setText(event.target.value)} placeholder="Write your reply" data-testid="comms-draft-text" />
          <div className="dash-comms-draft__actions">
            <Button tone="primary" busy={busy === "send"} testId="comms-send" onClick={() => void open(false)}>
              Send…
            </Button>
            <Button busy={busy === "save"} onClick={() => void open(true)}>
              Save as draft…
            </Button>
            {dirty && (
              <Button tone="ghost" busy={busy === "keep"} onClick={() => void run("keep", async () => void (await api.editDraft(draft.id, { to, cc, subject, text })))}>
                Keep changes
              </Button>
            )}
            <Button
              tone="ghost"
              busy={busy === "discard"}
              onClick={() =>
                void run("discard", async () => {
                  await api.discardDraft(draft.id);
                  onSettled();
                })
              }
            >
              Discard
            </Button>
          </div>
        </>
      )}
      {error && (
        <p className="dash-sched-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
};

export const ThreadView = ({
  mailbox,
  threadId,
  agents,
  onBack,
  onChanged,
}: {
  readonly mailbox: string;
  readonly threadId: string;
  readonly agents: readonly AgentSpec[];
  readonly onBack: () => void;
  readonly onChanged: () => void;
}): JSX.Element => {
  const [messages, setMessages] = useState<readonly MailThreadMessage[] | null>(null);
  const [drafts, setDrafts] = useState<readonly MailDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const thread = await api.commsThread(mailbox, threadId);
      setMessages(thread.messages);
      setDrafts(thread.drafts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [mailbox, threadId]);
  useEffect(() => {
    setMessages(null);
    void load();
  }, [load]);

  const last = messages?.at(-1);
  const reply = async () => {
    if (!last) return;
    setStarting(true);
    try {
      await api.startReply(mailbox, (messages?.filter((one) => !one.sent).at(-1) ?? last).id, threadId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="dash-comms-thread" data-testid="comms-thread">
      <header className="dash-comms-thread__head">
        <Button tone="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <h2 className="dash-comms-thread__subject">{messages?.[0]?.subject || "(no subject)"}</h2>
      </header>
      {error && <p className="dash-sched-error">{error}</p>}
      {messages === null && !error && <p className="dash-hint">Reading the conversation…</p>}
      {messages?.length === 0 && <EmptyState glyph="✉" title="Nothing here" body="This conversation has no messages Dash can read." />}
      {messages?.map((one) => (
        <article key={one.id} className="dash-comms-message" data-sent={one.sent ? "true" : undefined}>
          <header className="dash-comms-message__head">
            <span className="dash-comms-message__from" title={one.from?.address}>
              {one.sent ? "You" : who(one)}
            </span>
            <span className="dash-comms-message__when">{when(one.at)}</span>
          </header>
          <div className="dash-comms-message__to">to {one.to.map((to) => to.name ?? to.address).join(", ") || "—"}</div>
          <pre className="dash-comms-message__text">{one.text}</pre>
          {one.hasAttachments && <div className="dash-hint">Has attachments (open it in the mailbox to see them).</div>}
        </article>
      ))}
      {drafts.map((draft) => (
        <DraftCard
          key={draft.id}
          draft={draft}
          agents={agents}
          onSettled={() => {
            void load();
            onChanged();
          }}
        />
      ))}
      {messages && messages.length > 0 && drafts.length === 0 && (
        <div className="dash-comms-thread__foot">
          <Button busy={starting} onClick={() => void reply()} testId="comms-reply">
            Reply
          </Button>
        </div>
      )}
    </div>
  );
};
