import { Badge, Button } from "@freebirdai/dash-components";
import { useScreenChanged } from "../chatScreen.js";
import { CONTACT_CHANNELS, fieldValueOf, type Contact, type ContactChannel, type ContactFieldDef } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ContactSource, type RecordTarget } from "../../api.js";
import { colorVar } from "../calendar/model.js";
import { Segmented } from "../calendar/controls.jsx";
import { ChipsInput, FormRow, SheetSection, TextInput } from "../calendar/scheduling/inputs.jsx";
import { SetupSheet } from "../calendar/scheduling/SetupSheet.jsx";
import { BookingLinks } from "./BookingLinks.jsx";
import { timeZones } from "../calendar/scheduling/model.js";
import { FROM_WORDS, KIND_WORDS, MATCH_TONES, MATCH_WORDS, contactColor, contactTitle, fieldValues, formatPhone, initials, recordTypeWords, relativeTime, valueWords } from "./model.js";

/**
 * One contact: who they are, the facts block rules read about them and where
 * each came from, the records they are linked to, and what they have done.
 *
 * Saving changes only what a member typed: the name, emails and phones, and
 * the team's own value for a field. Matching, Refresh, Link and Unlink act at
 * once and the sheet keeps what was typed meanwhile.
 */

const CHANNEL_WORDS: Readonly<Record<ContactChannel, string>> = { text: "Text", email: "Email", call: "Call" };

interface Draft {
  name: string;
  emails: string[];
  phones: string[];
  timezone: string;
  channel: ContactChannel | "";
  optOut: ContactChannel[];
  /** The team's own value for each field, as typed. "" means none. */
  fields: Record<string, string>;
}

const draftOf = (contact: Contact): Draft => ({
  name: contact.name,
  emails: [...contact.emails],
  phones: contact.phones.map(formatPhone),
  timezone: contact.timezone ?? "",
  channel: contact.preferences.channel ?? "",
  optOut: [...contact.preferences.optOut],
  fields: Object.fromEntries(
    Object.entries(contact.fields).flatMap(([key, field]) => (field.member ? [[key, typeof field.member.value === "boolean" ? String(field.member.value) : valueWords(field.member.value)]] : [])),
  ),
});

const SHEET_SCREENS = ["contacts"] as const;

export const ContactSheet = ({
  id,
  fields,
  sources,
  canManage,
  onClose,
  onChanged,
  onRemoved,
  onSetUpFields,
}: {
  readonly id: string;
  readonly fields: readonly ContactFieldDef[];
  readonly sources: readonly ContactSource[];
  readonly canManage: boolean;
  readonly onClose: () => void;
  readonly onChanged: (contact: Contact) => void;
  readonly onRemoved: (id: string) => void;
  readonly onSetUpFields: () => void;
}): JSX.Element => {
  const [contact, setContact] = useState<Contact | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const zones = useMemo(() => timeZones(), []);

  /* A change the chat made to this contact shows here at once. */
  const [revision, setRevision] = useState(0);
  useScreenChanged(SHEET_SCREENS, useCallback(() => setRevision((n) => n + 1), []));
  useEffect(() => {
    void api.contact(id).then(
      (one) => {
        setContact(one);
        setDraft(draftOf(one));
      },
      (cause) => setFailed(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [id, revision]);

  /** Runs one of the actions that change the contact at once, keeping what was typed. */
  const act = async (what: string, run: () => Promise<{ contact: Contact; problems?: readonly string[] } | Contact>) => {
    setBusy(what);
    setNotes([]);
    setFailed(null);
    try {
      const done = await run();
      const next = "contact" in done ? done.contact : done;
      setContact(next);
      onChanged(next);
      if ("problems" in done && done.problems && done.problems.length > 0) setNotes([...done.problems]);
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!contact || !draft) {
    return (
      <SetupSheet trail="Contacts" title={failed ? "Contact" : "Loading…"} onClose={onClose} onSave={async () => onClose()} saveLabel="Close">
        <p className={failed ? "dash-sched-error" : "dash-hint"}>{failed ?? "Loading…"}</p>
      </SetupSheet>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((held) => (held ? { ...held, [key]: value } : held));
  const ambiguous = contact.lastMatch?.outcome === "ambiguous" ? (contact.lastMatch.candidates ?? []) : [];

  return (
    <SetupSheet
      trail="Contacts"
      title={contactTitle(contact)}
      wide
      testId="contact-sheet"
      saveLabel="Save changes"
      onClose={onClose}
      onSave={async () => {
        if (!canManage) return onClose();
        /* Only the fields someone changed, so an untouched value keeps when it was set. */
        const before = draftOf(contact).fields;
        const memberFields: Record<string, unknown> = {};
        for (const def of fields) {
          const typed = (draft.fields[def.key] ?? "").trim();
          if (typed === (before[def.key] ?? "").trim()) continue;
          memberFields[def.key] = typed === "" ? null : def.kind === "boolean" ? typed === "true" : typed;
        }
        const saved = await api.updateContact(contact.id, {
          name: draft.name.trim(),
          emails: draft.emails,
          phones: draft.phones,
          timezone: draft.timezone || null,
          preferences: { channel: draft.channel || null, optOut: draft.optOut },
          fields: memberFields,
          revision: contact.revision,
        });
        onChanged(saved);
        onClose();
      }}
      {...(canManage
        ? {
            removeLabel: "Delete contact",
            onRemove: async () => {
              await api.forgetContact(contact.id);
              onRemoved(contact.id);
            },
          }
        : {})}
    >
      <div className="dash-contact-hero">
        <span className="dash-contacts-avatar dash-contacts-avatar--large" style={{ ["--cal-color" as string]: colorVar(contactColor(contact.id)) }} aria-hidden="true">
          {initials(contact)}
        </span>
        <div className="dash-contact-hero__who">
          <span className="dash-contact-hero__name">{[contact.emails[0], contact.phones[0] ? formatPhone(contact.phones[0]) : ""].filter(Boolean).join(" · ") || contactTitle(contact)}</span>
          <span className="dash-contact-hero__meta">
            Added {relativeTime(contact.createdAt)} · {ORIGIN_WORDS[contact.origin]}
            {contact.links.length > 0 && ` · linked to ${contact.links.length === 1 ? "a record" : `${contact.links.length} records`}`}
          </span>
        </div>
      </div>

      <SheetSection title="Contact" description="How they are found and reached. Each email and phone belongs to one contact.">
        <FormRow label="Name">{(field) => <TextInput id={field} value={draft.name} maxLength={160} onChange={(value) => set("name", value)} testId="contact-name" />}</FormRow>
        <FormRow label="Emails">{(field) => <ChipsInput id={field} values={draft.emails} placeholder="Add an email" onChange={(value) => set("emails", value)} testId="contact-emails" />}</FormRow>
        <FormRow label="Phones" hint="With the area code.">
          {(field) => <ChipsInput id={field} values={draft.phones} placeholder="Add a phone" onChange={(value) => set("phones", value)} testId="contact-phones" />}
        </FormRow>
        <FormRow label="Time zone">
          {(field) => (
            <select id={field} className="dash-sched-input" value={draft.timezone} onChange={(event) => set("timezone", event.target.value)}>
              <option value="">Not known</option>
              {draft.timezone && !zones.includes(draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          )}
        </FormRow>
        <FormRow label="Prefers">
          {() => (
            <Segmented
              label="Preferred channel"
              value={draft.channel}
              options={[{ value: "" as const, label: "No preference" }, ...CONTACT_CHANNELS.map((channel) => ({ value: channel, label: CHANNEL_WORDS[channel] }))]}
              onChange={(value) => set("channel", value)}
            />
          )}
        </FormRow>
        <FormRow label="Do not contact by" hint="Messages never go out on these.">
          {() => (
            <div className="dash-sched-inline">
              {CONTACT_CHANNELS.map((channel) => (
                <label key={channel} className="dash-contacts-check">
                  <input
                    type="checkbox"
                    checked={draft.optOut.includes(channel)}
                    onChange={(event) => set("optOut", event.target.checked ? [...draft.optOut, channel] : draft.optOut.filter((one) => one !== channel))}
                  />
                  {CHANNEL_WORDS[channel]}
                </label>
              ))}
            </div>
          )}
        </FormRow>
      </SheetSection>

      <SheetSection
        title="Fields"
        description="What block rules read about them. Your team's value wins over a record's, and a record's over what they told us."
        {...(canManage ? { actions: <Button size="sm" tone="ghost" onClick={onSetUpFields}>Set up fields</Button> } : {})}
      >
        {fields.length === 0 ? (
          <p className="dash-contacts-note">No contact fields yet. Add the facts your blocks need, like a service area or a segment, under Contact fields.</p>
        ) : (
          fields.map((def) => {
            const values = fieldValues(contact.fields[def.key]);
            const best = fieldValueOf(contact.fields[def.key]);
            return (
              <FormRow key={def.key} label={def.label} hint={values.length > 0 ? KIND_WORDS[def.kind] : `${KIND_WORDS[def.kind]} · not known yet`}>
                {(field) => (
                  <div className="dash-contact-field">
                    {def.kind === "choice" || def.kind === "boolean" ? (
                      <select id={field} className="dash-sched-input" value={draft.fields[def.key] ?? ""} onChange={(event) => set("fields", { ...draft.fields, [def.key]: event.target.value })} disabled={!canManage}>
                        <option value="">{best && best.from !== "member" ? `${valueWords(best.value)} (${FROM_WORDS[best.from].toLowerCase()})` : "Not set by your team"}</option>
                        {(def.kind === "boolean" ? ["true", "false"] : (def.choices ?? [])).map((choice) => (
                          <option key={choice} value={choice}>
                            {def.kind === "boolean" ? (choice === "true" ? "Yes" : "No") : choice}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <TextInput
                        id={field}
                        value={draft.fields[def.key] ?? ""}
                        placeholder={best && best.from !== "member" ? valueWords(best.value) : "Not set by your team"}
                        onChange={(value) => set("fields", { ...draft.fields, [def.key]: value })}
                      />
                    )}
                    {values.length > 0 && (
                      <ul className="dash-contact-provenance" aria-label={`Where ${def.label} came from`}>
                        {values.map((one) => (
                          <li key={one.from} className="dash-contact-provenance__row" data-from={one.from} data-winning={one.from === best?.from ? "true" : undefined}>
                            <span className="dash-contact-provenance__from">{FROM_WORDS[one.from]}</span>
                            <span className="dash-contact-provenance__value">{valueWords(one.value)}</span>
                            <span className="dash-contact-provenance__when">
                              {one.ref ? `${recordTypeWords(one.ref.connection, one.ref.entity, sources)} · ` : ""}
                              {relativeTime(one.at)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </FormRow>
            );
          })
        )}
      </SheetSection>

      <SheetSection
        title="Linked records"
        description="A record's values are copied when it is linked, and again only when you refresh."
        {...(canManage
          ? {
              actions: (
                <div className="dash-sched-inline">
                  <Button size="sm" tone="ghost" busy={busy === "match"} onClick={() => void act("match", () => api.matchContact(contact.id))} testId="contact-match">
                    Find a match
                  </Button>
                  <Button size="sm" busy={busy === "refresh"} disabled={contact.links.length === 0} onClick={() => void act("refresh", () => api.refreshContact(contact.id))} testId="contact-refresh">
                    Refresh
                  </Button>
                </div>
              ),
            }
          : {})}
      >
        {contact.lastMatch && (
          <div className="dash-contact-match" data-outcome={contact.lastMatch.outcome}>
            <Badge tone={MATCH_TONES[contact.lastMatch.outcome]}>{MATCH_WORDS[contact.lastMatch.outcome]}</Badge>
            <span className="dash-contact-match__detail">{contact.lastMatch.detail}</span>
            <span className="dash-contact-match__when">{relativeTime(contact.lastMatch.at)}</span>
          </div>
        )}
        {ambiguous.length > 0 && (
          <ul className="dash-contact-links" aria-label="Records that match">
            {ambiguous.map((candidate) => (
              <li key={`${candidate.connection}/${candidate.entity}/${candidate.recordId}`} className="dash-contact-link">
                <span className="dash-contact-link__main">
                  <span className="dash-contact-link__title">{candidate.label ?? `Record ${candidate.recordId}`}</span>
                  <span className="dash-contact-link__meta">
                    {recordTypeWords(candidate.connection, candidate.entity, sources)} · {candidate.recordId}
                  </span>
                </span>
                {canManage && (
                  <Button size="sm" busy={busy === `link:${candidate.recordId}`} onClick={() => void act(`link:${candidate.recordId}`, () => api.linkContact(contact.id, candidate))}>
                    Link this one
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {contact.links.length === 0 && ambiguous.length === 0 ? (
          <p className="dash-contacts-note">Not linked to a record. Matching links them when exactly one record has their email or phone.</p>
        ) : (
          contact.links.length > 0 && (
            <ul className="dash-contact-links" aria-label="Linked records">
              {contact.links.map((link) => {
                const target: RecordTarget = { connection: link.connection, entity: link.entity, recordId: link.recordId };
                return (
                  <li key={`${link.connection}/${link.entity}/${link.recordId}`} className="dash-contact-link" data-linked="true">
                    <span className="dash-contact-link__main">
                      <span className="dash-contact-link__title">{link.label ?? `Record ${link.recordId}`}</span>
                      <span className="dash-contact-link__meta">
                        {recordTypeWords(link.connection, link.entity, sources)} · {link.by === "match" ? `matched on ${link.matchedOn.join(" and ")}` : "linked by your team"} · copied {relativeTime(link.syncedAt)}
                      </span>
                    </span>
                    {canManage && (
                      <Button size="sm" tone="ghost" busy={busy === `unlink:${link.recordId}`} onClick={() => void act(`unlink:${link.recordId}`, () => api.unlinkContact(contact.id, target))}>
                        Unlink
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        )}
        {(notes.length > 0 || failed) && (
          <div className="dash-contacts-callout" data-tone="warn" role="status">
            <span>{[failed, ...notes].filter(Boolean).join(" ")}</span>
          </div>
        )}
      </SheetSection>

      {canManage ? <BookingLinks contact={contact.id} /> : null}

      <SheetSection title="Activity" description="Counted by Dash as bookings happen. Block rules can use these too.">
        <div className="dash-contact-stats">
          <Stat label="Bookings" value={String(contact.stats.bookings)} />
          <Stat label="Cancellations" value={String(contact.stats.cancellations)} />
          <Stat label="No-shows" value={String(contact.stats.noShows)} />
          <Stat label="Last booked" value={contact.stats.lastBookedAt ? relativeTime(contact.stats.lastBookedAt) : "Never"} />
          <Stat label="First contact" value={relativeTime(contact.stats.firstContactAt)} />
        </div>
      </SheetSection>
    </SetupSheet>
  );
};

const ORIGIN_WORDS: Readonly<Record<Contact["origin"], string>> = {
  public_link: "from a booking page",
  agent: "by an agent",
  member: "by your team",
  workflow: "by a workflow",
};

const Stat = ({ label, value }: { readonly label: string; readonly value: string }): JSX.Element => (
  <div className="dash-contact-stat">
    <span className="dash-contact-stat__value">{value}</span>
    <span className="dash-contact-stat__label">{label}</span>
  </div>
);
