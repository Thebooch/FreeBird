import { Button } from "@freebirdai/dash-components";
import type { Contact, MailMessage } from "@freebirdai/dash-spec";
import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { SheetSection } from "../calendar/scheduling/inputs.jsx";

/**
 * A contact's email, and folding a second record of them into this one.
 */

const when = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

/** Every message to or from them, across the mailboxes you may read: read live. */
export const ContactMessages = ({ contact }: { readonly contact: Pick<Contact, "id" | "emails"> }): JSX.Element | null => {
  const [messages, setMessages] = useState<readonly MailMessage[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (contact.emails.length === 0) return;
    void api.contactMessages(contact.id).then(
      (answer) => {
        setMessages(answer.messages);
        if (answer.problems.length > 0) setProblem(`Some mailboxes could not be searched: ${answer.problems.map((one) => one.message).join("; ")}`);
      },
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    );
  }, [contact.id, contact.emails.join(",")]);
  if (contact.emails.length === 0) return null;
  return (
    <SheetSection title="Messages" description="Email to and from them in every mailbox you can read, newest first. Open Comms to answer.">
      {messages === null && !problem && <p className="dash-hint">Reading their mail…</p>}
      {messages?.length === 0 && <p className="dash-hint">No email with them yet.</p>}
      {messages && messages.length > 0 && (
        <ul className="dash-contact-messages" data-testid="contact-messages">
          {messages.map((one) => (
            <li key={`${one.mailbox}:${one.id}`} className="dash-contact-messages__row">
              <span className="dash-contact-messages__when">{when(one.at)}</span>
              <span className="dash-contact-messages__subject">{one.sent ? "→ " : "← "}{one.subject || "(no subject)"}</span>
              <span className="dash-contact-messages__snippet">{one.snippet}</span>
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="dash-sched-error">{problem}</p>}
    </SheetSection>
  );
};

/** Fold another contact — the same person under another email — into this one. */
export const MergeContact = ({ contact, onMerged }: { readonly contact: Pick<Contact, "id">; readonly onMerged: (merged: Contact) => void }): JSX.Element => {
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<readonly Contact[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (search.trim().length < 2) {
      setFound([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void api.contacts({ search: search.trim(), limit: 8 }).then((answer) => setFound(answer.contacts.filter((one) => one.id !== contact.id)), () => setFound([]));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [search, contact.id]);
  return (
    <SheetSection title="Same person?" description="Merge another contact into this one: their emails, phones, fields, links and bookings come here, and they stop being separate.">
      <input className="dash-sched-input" type="search" placeholder="Find the other contact by name, email or phone" value={search} onChange={(event) => setSearch(event.target.value)} data-testid="merge-search" />
      <ul className="dash-contact-messages">
        {found.map((one) => (
          <li key={one.id} className="dash-contact-messages__row">
            <span className="dash-contact-messages__subject">{one.name || one.emails[0] || one.phones[0]}</span>
            <span className="dash-contact-messages__snippet">{[...one.emails, ...one.phones].join(", ")}</span>
            <Button
              size="sm"
              busy={busy === one.id}
              onClick={() => {
                setBusy(one.id);
                setError(null);
                void api
                  .mergeContact(contact.id, one.id)
                  .then(onMerged, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
                  .finally(() => setBusy(null));
              }}
            >
              Merge into this one
            </Button>
          </li>
        ))}
      </ul>
      {error && <p className="dash-sched-error">{error}</p>}
    </SheetSection>
  );
};
