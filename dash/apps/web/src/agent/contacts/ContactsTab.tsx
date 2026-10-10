import { Badge, Button, EmptyState, ErrorState } from "@freebirdai/dash-components";
import { itemAttrs, screenAttrs, useChatFocus, useScreenChanged } from "../chatScreen.js";
import type { Contact, ContactFieldDef } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ContactSource } from "../../api.js";
import { colorVar } from "../calendar/model.js";
import { FormRow, SheetSection, TextInput } from "../calendar/scheduling/inputs.jsx";
import { SetupSheet } from "../calendar/scheduling/SetupSheet.jsx";
import { ContactSheet } from "./ContactSheet.jsx";
import { MATCH_TONES, MATCH_WORDS, contactColor, contactTitle, formatPhone, initials, recordTypeWords, relativeTime } from "./model.js";

/**
 * The list of contacts: a search over names, emails and phones, newest
 * changes first, a page at a time. A row opens the contact's sheet.
 */

const PAGE = 50;

const CONTACT_SCREENS = ["contacts"] as const;

export const ContactsTab = ({ canManage, onSetUpFields }: { readonly canManage: boolean; readonly onSetUpFields: () => void }): JSX.Element => {
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [fields, setFields] = useState<ContactFieldDef[]>([]);
  const [sources, setSources] = useState<ContactSource[]>([]);
  const sequence = useRef(0);

  const load = useCallback(async (query: string) => {
    const mine = ++sequence.current;
    try {
      const page = await api.contacts({ ...(query.trim() ? { search: query.trim() } : {}), limit: PAGE });
      if (mine !== sequence.current) return;
      setContacts(page.contacts);
      setNext(page.next);
      setError(null);
    } catch (cause) {
      if (mine === sequence.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  /* What the chat changes on contacts shows here at once. */
  useScreenChanged(CONTACT_SCREENS, useCallback(() => void load(search), [load, search]));
  const openContact = open ? contacts?.find((one) => one.id === open) : undefined;
  useChatFocus("contacts", open ? { id: open, label: openContact?.name || openContact?.emails[0] || "this contact" } : null);

  /* Typing searches a moment after it stops. */
  useEffect(() => {
    const timer = setTimeout(() => void load(search), search ? 220 : 0);
    return () => clearTimeout(timer);
  }, [search, load]);

  useEffect(() => {
    void api.contactSetup().then((setup) => setFields(setup.fields), () => undefined);
    if (canManage) void api.contactSources().then(setSources, () => undefined);
  }, [canManage]);

  const more = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await api.contacts({ ...(search.trim() ? { search: search.trim() } : {}), limit: PAGE, after: next });
      setContacts((held) => [...(held ?? []), ...page.contacts]);
      setNext(page.next);
    } finally {
      setLoadingMore(false);
    }
  };

  /** A contact changed in its sheet: in place, and to the top as the newest change. */
  const changed = (contact: Contact) => setContacts((held) => [contact, ...(held ?? []).filter((one) => one.id !== contact.id)]);

  if (error && !contacts) return <ErrorState message={error} onRetry={() => void load(search)} />;

  return (
    <div className="dash-sched-tab" data-testid="contacts-list" {...screenAttrs("contacts")}>
      <div className="dash-contacts-toolbar">
        <label className="dash-contacts-search">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="dash-contacts-search__icon">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className="dash-contacts-search__input"
            placeholder="Search by name, email or phone"
            aria-label="Search contacts"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            data-testid="contacts-search"
          />
        </label>
        <span className="dash-contacts-toolbar__count">
          {contacts === null ? "" : `${contacts.length}${next ? "+" : ""} ${contacts.length === 1 && !next ? "contact" : "contacts"}`}
        </span>
        {canManage && (
          <Button tone="primary" onClick={() => setAdding(true)} testId="contacts-add">
            New contact
          </Button>
        )}
      </div>

      {contacts === null ? (
        <p className="dash-hint">Loading…</p>
      ) : contacts.length === 0 ? (
        <div className="dash-contacts-empty">
          <EmptyState
            glyph="◍"
            title={search ? "Nobody matches that" : "No contacts yet"}
            body={
              search
                ? "Try part of a name, an email address, or a few digits of a phone number."
                : "People who book, and anyone you add, show up here. Each is found by their email or phone, so a person is here once."
            }
          />
        </div>
      ) : (
        <div className="dash-contacts-table" role="table" aria-label="Contacts">
          <div className="dash-contacts-table__head" role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader">Email</span>
            <span role="columnheader">Phone</span>
            <span role="columnheader">Records</span>
            <span role="columnheader" className="dash-contacts-table__right">
              Updated
            </span>
          </div>
          {contacts.map((contact) => {
            const link = contact.links[0];
            return (
              <button key={contact.id} type="button" role="row" className="dash-contacts-row" onClick={() => setOpen(contact.id)} data-testid="contacts-row" {...itemAttrs(contact.id)}>
                <span role="cell" className="dash-contacts-row__name">
                  <span className="dash-contacts-avatar" style={{ ["--cal-color" as string]: colorVar(contactColor(contact.id)) }} aria-hidden="true">
                    {initials(contact)}
                  </span>
                  <span className="dash-contacts-row__who">
                    <span className="dash-contacts-row__title">{contactTitle(contact)}</span>
                    <span className="dash-contacts-row__sub">
                      {[contact.emails[0], contact.phones[0] ? formatPhone(contact.phones[0]) : ""].filter(Boolean).join(" · ") || "No email or phone"}
                    </span>
                  </span>
                </span>
                <span role="cell" className="dash-contacts-row__cell" data-column="email">
                  {contact.emails[0] ?? <span className="dash-contacts-muted">—</span>}
                  {contact.emails.length > 1 && <span className="dash-contacts-more">+{contact.emails.length - 1}</span>}
                </span>
                <span role="cell" className="dash-contacts-row__cell dash-contacts-row__mono" data-column="phone">
                  {contact.phones[0] ? formatPhone(contact.phones[0]) : <span className="dash-contacts-muted">—</span>}
                </span>
                <span role="cell" className="dash-contacts-row__cell" data-column="records">
                  {link ? (
                    <Badge tone="accent" title={recordTypeWords(link.connection, link.entity, sources)}>
                      {contact.links.length > 1 ? `${contact.links.length} linked` : "Linked"}
                    </Badge>
                  ) : contact.lastMatch && contact.lastMatch.outcome !== "none" ? (
                    <Badge tone={MATCH_TONES[contact.lastMatch.outcome]}>{MATCH_WORDS[contact.lastMatch.outcome]}</Badge>
                  ) : (
                    <span className="dash-contacts-muted">Not linked</span>
                  )}
                </span>
                <span role="cell" className="dash-contacts-row__cell dash-contacts-table__right dash-contacts-muted" data-column="updated">
                  {relativeTime(contact.updatedAt)}
                </span>
              </button>
            );
          })}
          {next && (
            <div className="dash-contacts-table__foot">
              <Button tone="ghost" busy={loadingMore} onClick={() => void more()}>
                Show more
              </Button>
            </div>
          )}
        </div>
      )}

      {open && (
        <ContactSheet
          id={open}
          fields={fields}
          sources={sources}
          canManage={canManage}
          onClose={() => setOpen(null)}
          onChanged={changed}
          onRemoved={(id) => {
            setContacts((held) => (held ?? []).filter((one) => one.id !== id));
            setOpen(null);
          }}
          onSetUpFields={onSetUpFields}
        />
      )}
      {adding && (
        <NewContactSheet
          onClose={() => setAdding(false)}
          onMade={(contact) => {
            changed(contact);
            setAdding(false);
            setOpen(contact.id);
          }}
          onOpen={(id) => {
            setAdding(false);
            setOpen(id);
          }}
        />
      )}
    </div>
  );
};

/** Adding someone by hand: a name, and an email or phone to find them by. */
const NewContactSheet = ({ onClose, onMade, onOpen }: { readonly onClose: () => void; readonly onMade: (contact: Contact) => void; readonly onOpen: (id: string) => void }): JSX.Element => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [holder, setHolder] = useState<string | null>(null);
  return (
    <SetupSheet
      trail="Contacts"
      title="New contact"
      saveLabel="Add contact"
      testId="contact-new"
      onClose={onClose}
      onSave={async () => {
        setHolder(null);
        if (!email.trim() && !phone.trim()) throw new Error("Give an email or a phone number, so they can be found.");
        try {
          onMade(await api.createContact({ ...(name.trim() ? { name: name.trim() } : {}), ...(email.trim() ? { emails: [email.trim()] } : {}), ...(phone.trim() ? { phones: [phone.trim()] } : {}) }));
        } catch (cause) {
          const found = cause instanceof ApiError ? (cause.detail as { holder?: string } | undefined)?.holder : undefined;
          if (found) setHolder(found);
          throw cause;
        }
      }}
    >
      <SheetSection title="Who" description="A contact is found by their email or phone. Someone who already has either is not added twice.">
        <FormRow label="Name">{(id) => <TextInput id={id} value={name} placeholder="Jordan Lee" maxLength={160} onChange={setName} testId="contact-new-name" />}</FormRow>
        <FormRow label="Email">{(id) => <TextInput id={id} type="email" value={email} placeholder="jordan@example.com" onChange={setEmail} testId="contact-new-email" />}</FormRow>
        <FormRow label="Phone" hint="With its area code.">
          {(id) => <TextInput id={id} value={phone} placeholder="(512) 555-0142" onChange={setPhone} testId="contact-new-phone" />}
        </FormRow>
        {holder && (
          <div className="dash-contacts-callout" role="status">
            <span>They're already a contact.</span>
            <Button size="sm" onClick={() => onOpen(holder)}>
              Open them
            </Button>
          </div>
        )}
      </SheetSection>
    </SetupSheet>
  );
};
