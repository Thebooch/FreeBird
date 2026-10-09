import { Badge, Button } from "@freebirdai/dash-components";
import type { AppointmentType } from "@freebirdai/dash-spec";
import { useEffect, useState } from "react";
import { api, type BookingLinkInfo } from "../../api.js";
import { SheetSection } from "../calendar/scheduling/inputs.jsx";
import { relativeTime } from "./model.js";

/**
 * A contact's booking links: their own page, where they see their booking or
 * pick a time. Each is shown once, when it is made (only its hash is kept),
 * and can be withdrawn here, which stops it opening at once.
 */

const stateOf = (link: BookingLinkInfo): "active" | "withdrawn" | "expired" => (link.revokedAt ? "withdrawn" : Date.parse(link.expiresAt) <= Date.now() ? "expired" : "active");

const dateWords = (at: string): string => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export const BookingLinks = ({ contact }: { readonly contact: string }): JSX.Element => {
  const [links, setLinks] = useState<BookingLinkInfo[] | null>(null);
  const [types, setTypes] = useState<readonly AppointmentType[]>([]);
  const [type, setType] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    void api.contactLinks(contact).then(setLinks, (cause) => setFailed(cause instanceof Error ? cause.message : String(cause)));
    void api.scheduling().then((overview) => setTypes(overview.types.filter((one) => one.active)), () => undefined);
  }, [contact]);

  const run = async (what: string, work: () => Promise<void>) => {
    setBusy(what);
    setFailed(null);
    try {
      await work();
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const typeName = (id?: string) => (id ? (types.find((one) => one.id === id)?.name ?? "An appointment type") : "Anything they can book");

  return (
    <SheetSection title="Booking links" description="Their own page to book, see and change their appointments. A link is shown once, when you make it." testId="contact-booking-links">
      {links === null && !failed ? <p className="dash-hint">Loading…</p> : null}
      {links && links.length === 0 ? <p className="dash-contacts-note">No links yet. Workflows make one whenever they tell this person about a booking.</p> : null}
      {links && links.length > 0 ? (
        <ul className="dash-booklinks" aria-label="Booking links">
          {links.slice(0, 12).map((link) => {
            const state = stateOf(link);
            return (
              <li key={link.id} className="dash-booklink" data-state={state}>
                <span className="dash-booklink__main">
                  <span className="dash-booklink__title">
                    {typeName(link.type)}
                    <Badge tone={state === "active" ? "accent" : state === "withdrawn" ? "danger" : "neutral"}>{state === "active" ? "Works" : state === "withdrawn" ? "Withdrawn" : "Expired"}</Badge>
                    {link.fromPublic ? <Badge tone="neutral">From the public page</Badge> : null}
                  </span>
                  <span className="dash-booklink__meta">
                    Made {relativeTime(link.createdAt)}
                    {state === "active" ? ` · works until ${dateWords(link.expiresAt)}, or while a booking on it is active` : state === "withdrawn" && link.revokedAt ? ` · withdrawn ${relativeTime(link.revokedAt)}` : ""}
                  </span>
                </span>
                {state === "active" ? (
                  <Button
                    size="sm"
                    tone="ghost"
                    busy={busy === link.id}
                    onClick={() =>
                      void run(link.id, async () => {
                        const revoked = await api.revokeContactLink(contact, link.id);
                        setLinks((held) => (held ?? []).map((one) => (one.id === revoked.id ? revoked : one)));
                      })
                    }
                  >
                    Withdraw
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="dash-booklinks__make">
        <select className="dash-sched-input" aria-label="What the link is for" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="">Anything they can book</option>
          {types.map((one) => (
            <option key={one.id} value={one.id}>
              {one.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          busy={busy === "make"}
          testId="contact-make-link"
          onClick={() =>
            void run("make", async () => {
              const next = await api.makeContactLink(contact, type || undefined);
              setLinks((held) => [next.link, ...(held ?? [])]);
              setMade(next.url);
              setCopied(false);
            })
          }
        >
          Make a link
        </Button>
      </div>
      {made ? (
        <div className="dash-booklinks__made" role="status">
          <div className="dash-booklinks__made-row">
            <input readOnly value={made} aria-label="The new link" onFocus={(event) => event.target.select()} />
            <Button
              size="sm"
              tone="primary"
              onClick={() =>
                void navigator.clipboard.writeText(made).then(
                  () => setCopied(true),
                  () => undefined,
                )
              }
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="dash-hint">This is the only time it is shown. Anyone with it can see and change their bookings, so send it only to them.</p>
        </div>
      ) : null}
      {failed ? (
        <div className="dash-contacts-callout" data-tone="warn" role="alert">
          <span>{failed}</span>
        </div>
      ) : null}
    </SheetSection>
  );
};
