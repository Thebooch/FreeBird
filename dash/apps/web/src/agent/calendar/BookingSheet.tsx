import { Badge, Button, type BadgeTone } from "@freebirdai/dash-components";
import { BOOKING_STATUS_WORDS, LOCATION_WORDS, type Booking, type BookingStatus, type Contact } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useScreenChanged } from "../chatScreen.js";
import { api, type SlotPreview } from "../../api.js";
import { contactTitle, formatPhone } from "../contacts/model.js";
import { CopyLink } from "../CopyLink.jsx";
import { colorVar, memberColor, type Person } from "./model.js";

/**
 * One booking, opened from its appointment on the calendar: who, when,
 * where, what they answered, what was decided and by whom, and its history.
 * Someone with `calendar.manage` decides here: approve, offer other times,
 * deny, move, cancel, or mark how it went. Every action goes through the
 * booking, so the person's status page, the calendar and any workflow
 * waiting on it all hear the same thing.
 */

const STATUS_TONES: Readonly<Record<BookingStatus, BadgeTone>> = {
  pending: "warn",
  confirmed: "accent",
  suggested: "warn",
  denied: "danger",
  cancelled: "stale",
  expired: "stale",
  completed: "neutral",
  no_show: "danger",
};

const ORIGIN_WORDS: Readonly<Record<Booking["origin"], string>> = {
  link: "Their scheduling link",
  public_link: "The booking page",
  agent: "An agent, in conversation",
  workflow: "A workflow",
  member: "Your team",
};

const BY_WORDS = (by: Booking["history"][number]["by"], people: ReadonlyMap<string, Person>): string =>
  by.kind === "member" ? (people.get(by.id ?? "")?.name ?? "Your team") : by.kind === "contact" ? "They" : by.kind === "agent" ? "An agent" : by.kind === "workflow" ? "A workflow" : "Dash";

const formatIn = (at: string | number, zone?: string, withDay = true): string =>
  new Intl.DateTimeFormat(undefined, {
    ...(withDay ? { weekday: "short", month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    ...(zone ? { timeZone: zone, timeZoneName: "short" } : {}),
  }).format(new Date(at));

const span = (start: string, end: string, zone?: string): string => `${formatIn(start, zone)} – ${formatIn(end, zone, false)}`;

type Panel = null | "suggest" | "deny" | "move" | "cancel";

const SHEET_SCREENS = ["bookings"] as const;

export const BookingSheet = ({
  id,
  people: given,
  canManage,
  onClose,
  onChanged,
}: {
  readonly id: string;
  /** Hosts' names and colours. Absent: read from the scheduling setup. */
  readonly people?: ReadonlyMap<string, Person>;
  readonly canManage: boolean;
  readonly onClose: () => void;
  /** After any change, so the calendar reads its entries again. */
  readonly onChanged: () => void;
}): JSX.Element => {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [slots, setSlots] = useState<SlotPreview["slots"] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const viewerZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Person>>(new Map());
  useEffect(() => {
    if (given) return;
    void api.scheduling().then(
      (setup) => setLoaded(new Map(setup.profiles.map((profile) => [profile.member, { name: profile.displayName, color: profile.color ?? memberColor(profile.member) }]))),
      () => undefined,
    );
  }, [given]);
  const people = given ?? loaded;

  /* A decision the chat made on this booking shows here at once. */
  const [revision, setRevision] = useState(0);
  useScreenChanged(SHEET_SCREENS, useCallback(() => setRevision((n) => n + 1), []));
  useEffect(() => {
    void api.booking(id).then(
      (one) => {
        setBooking(one);
        void api.contact(one.contact).then(setContact, () => undefined);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [id, revision]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  /* Open times to offer or move to: the next two weeks, as this person would be offered them. */
  useEffect(() => {
    if (!booking || (panel !== "suggest" && panel !== "move")) return;
    setSlots(null);
    setPicked([]);
    const from = new Date(Math.max(Date.now(), Date.parse(booking.start) - 3 * 86_400_000)).toISOString();
    const to = new Date(Date.parse(from) + 14 * 86_400_000).toISOString();
    void api.bookingSlots(booking.type.id, booking.contact, from, to).then(
      (result) => setSlots(result.slots.filter((slot) => slot.start !== Date.parse(booking.start))),
      () => setSlots([]),
    );
  }, [booking, panel]);

  const act = async (what: string, run: () => Promise<Booking>) => {
    setBusy(what);
    setError(null);
    try {
      setBooking(await run());
      setPanel(null);
      setMessage("");
      setReason("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const host = booking ? people.get(booking.host) : undefined;
  const theirZone = booking && booking.timezone !== viewerZone ? booking.timezone : undefined;
  const days = useMemo(() => {
    const out = new Map<string, NonNullable<typeof slots>>();
    for (const slot of slots ?? []) {
      const key = new Date(slot.start).toDateString();
      out.set(key, [...(out.get(key) ?? []), slot]);
    }
    return [...out.entries()].slice(0, 7);
  }, [slots]);
  const toggle = (start: number) =>
    setPicked((held) => (panel === "move" ? [start] : held.includes(start) ? held.filter((one) => one !== start) : held.length < 3 ? [...held, start] : held));

  return (
    <div className="dash-sheet-backdrop" onClick={() => !busy && onClose()} role="presentation">
      <div
        className="dash-sheet dash-booking-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-title"
        onClick={(event) => event.stopPropagation()}
        style={{ ["--cal-color" as string]: colorVar(host?.color ?? memberColor(booking?.host ?? "")) }}
        data-testid="booking-sheet"
      >
        <header className="dash-sheet__head">
          <div className="dash-sheet__trail">
            <span className="dash-cal-sheet__swatch" aria-hidden="true" />
            <span>Calendar</span>
            <span className="dash-sheet__crumb-sep">/</span>
            <span>Booking</span>
          </div>
          <div className="dash-sheet__bar">
            <h2 id="booking-title" className="dash-sheet__title">
              {booking ? `${booking.type.name} · ${contact ? contactTitle(contact) : "…"}` : "Booking"}
            </h2>
            <Button tone="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>

        <div className="dash-sheet__body">
          {!booking ? (
            <p className={error ? "dash-cal-form__error" : "dash-hint"}>{error ?? "Loading…"}</p>
          ) : (
            <>
              <div className="dash-booking-status" data-status={booking.status}>
                <Badge tone={STATUS_TONES[booking.status]}>{BOOKING_STATUS_WORDS[booking.status]}</Badge>
                <span className="dash-booking-status__words">
                  {booking.status === "pending" && booking.holdUntil
                    ? `Waiting for approval. The time is held until ${formatIn(booking.holdUntil)}.`
                    : booking.status === "suggested"
                      ? "Other times were offered. They are held until the person picks one."
                      : booking.status === "confirmed" && booking.change
                        ? "They asked to move it. It keeps its time until that is approved."
                        : booking.status === "confirmed"
                          ? "Booked."
                          : ""}
                </span>
              </div>

              <section className="dash-sheet__section">
                <dl className="dash-cal-sheet__facts">
                  <dt>When</dt>
                  <dd className="dash-booking-when">
                    <span className="dash-cal-sheet__when">{span(booking.start, booking.end)}</span>
                    {theirZone && <span className="dash-hint">Their time: {span(booking.start, booking.end, theirZone)}</span>}
                  </dd>
                  <dt>With</dt>
                  <dd>
                    <span className="dash-booking-host">
                      <span className="dash-booking-host__dot" aria-hidden="true" />
                      {host?.name ?? booking.host}
                    </span>
                  </dd>
                  <dt>Who</dt>
                  <dd className="dash-booking-who">
                    <span>{contact ? contactTitle(contact) : "…"}</span>
                    {contact && (
                      <span className="dash-hint">{[contact.emails[0], contact.phones[0] ? formatPhone(contact.phones[0]) : ""].filter(Boolean).join(" · ")}</span>
                    )}
                  </dd>
                  {booking.location && (
                    <>
                      <dt>Where</dt>
                      <dd>
                        {LOCATION_WORDS[booking.location.kind]}
                        {booking.location.value ? `: ${booking.location.value}` : ""}
                      </dd>
                    </>
                  )}
                  <dt>Came from</dt>
                  <dd>{ORIGIN_WORDS[booking.origin]}</dd>
                </dl>
              </section>

              {Object.keys(booking.answers).length > 0 && (
                <section className="dash-sheet__section">
                  <h3 className="dash-sheet__sub">What they told us</h3>
                  <dl className="dash-cal-sheet__facts">
                    {Object.entries(booking.answers).map(([key, value]) => (
                      <div key={key} className="dash-booking-answer">
                        <dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}</dt>
                        <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              {booking.status === "suggested" && booking.suggestions && (
                <section className="dash-sheet__section">
                  <h3 className="dash-sheet__sub">Times offered</h3>
                  <ul className="dash-booking-list">
                    {booking.suggestions.map((one) => (
                      <li key={one.id} className="dash-booking-list__row">
                        <span>{span(one.start, one.end)}</span>
                        <span className="dash-hint">
                          {people.get(one.host)?.name ?? one.host} · held until {formatIn(one.holdUntil)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {booking.status === "confirmed" && booking.change && (
                <div className="dash-cal-sheet__callout dash-booking-change">
                  <span>
                    They asked to move to <strong>{span(booking.change.start, booking.change.end)}</strong>.
                  </span>
                  {canManage && (
                    <span className="dash-sched-inline">
                      <Button size="sm" tone="primary" busy={busy === "approve-move"} onClick={() => void act("approve-move", () => api.confirmBooking(booking.id))}>
                        Approve the move
                      </Button>
                      <Button size="sm" busy={busy === "deny-move"} onClick={() => void act("deny-move", () => api.denyBooking(booking.id, {}))}>
                        Keep the time
                      </Button>
                    </span>
                  )}
                </div>
              )}

              {booking.decision && (
                <section className="dash-sheet__section">
                  <h3 className="dash-sheet__sub">Decision</h3>
                  <dl className="dash-cal-sheet__facts">
                    <dt>Answer</dt>
                    <dd>
                      {booking.decision.outcome === "approved" ? "Approved" : booking.decision.outcome === "suggested" ? "Other times offered" : "Denied"} by{" "}
                      {people.get(booking.decision.by)?.name ?? (booking.decision.by === "workflow" ? "a workflow" : booking.decision.by)}, {formatIn(booking.decision.at)}
                    </dd>
                    {booking.decision.message && (
                      <>
                        <dt>Told them</dt>
                        <dd>“{booking.decision.message}”</dd>
                      </>
                    )}
                    {booking.decision.reason && (
                      <>
                        <dt>Team note</dt>
                        <dd>
                          {booking.decision.reason} <Badge>Team only</Badge>
                        </dd>
                      </>
                    )}
                  </dl>
                </section>
              )}

              {panel && (
                <section className="dash-sheet__section dash-booking-panel" data-testid={`booking-panel-${panel}`}>
                  <h3 className="dash-sheet__sub">
                    {panel === "suggest" ? "Offer other times" : panel === "move" ? "Move it" : panel === "deny" ? "Deny the request" : "Cancel the booking"}
                  </h3>
                  {(panel === "suggest" || panel === "move") && (
                    <>
                      <p className="dash-hint">{panel === "suggest" ? "Pick up to three. Each is held for them until they answer." : "Pick the new time."}</p>
                      {slots === null ? (
                        <p className="dash-hint">Finding open times…</p>
                      ) : days.length === 0 ? (
                        <p className="dash-sched-empty">No open times in the next two weeks.</p>
                      ) : (
                        <div className="dash-sched-preview">
                          {days.map(([day, list]) => (
                            <div key={day} className="dash-sched-preview__day">
                              <span className="dash-sched-preview__date">{new Date(list[0]!.start).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>
                              <span className="dash-sched-preview__slots">
                                {list.slice(0, 18).map((slot) => (
                                  <button
                                    key={slot.start}
                                    type="button"
                                    className="dash-sched-slot dash-booking-slot"
                                    aria-pressed={picked.includes(slot.start)}
                                    data-selected={picked.includes(slot.start) ? "true" : undefined}
                                    data-consolidated={slot.consolidated ? "true" : undefined}
                                    onClick={() => toggle(slot.start)}
                                  >
                                    {new Date(slot.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                                  </button>
                                ))}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {(panel === "suggest" || panel === "deny") && (
                    <label className="dash-field">
                      <span className="dash-field__label">Message for them</span>
                      <textarea className="dash-sched-input dash-sched-textarea" value={message} maxLength={1000} placeholder={panel === "deny" ? "Sorry, we can't come out that far." : "Mornings are full that week."} onChange={(event) => setMessage(event.target.value)} />
                    </label>
                  )}
                  {(panel === "suggest" || panel === "deny" || panel === "cancel") && (
                    <label className="dash-field">
                      <span className="dash-field__label">Note for the team</span>
                      <input className="dash-sched-input" value={reason} maxLength={1000} placeholder="Never shown to them" onChange={(event) => setReason(event.target.value)} />
                    </label>
                  )}
                  <div className="dash-sched-inline">
                    <Button tone="ghost" onClick={() => setPanel(null)}>
                      Back
                    </Button>
                    {panel === "suggest" && (
                      <Button
                        tone="primary"
                        disabled={picked.length === 0}
                        busy={busy === "suggest"}
                        testId="booking-send-suggestions"
                        onClick={() =>
                          void act("suggest", () =>
                            api.suggestBooking(booking.id, {
                              times: picked.map((start) => ({ start: new Date(start).toISOString() })),
                              ...(message.trim() ? { message: message.trim() } : {}),
                              ...(reason.trim() ? { reason: reason.trim() } : {}),
                            }),
                          )
                        }
                      >
                        Offer {picked.length > 1 ? `${picked.length} times` : "this time"}
                      </Button>
                    )}
                    {panel === "move" && (
                      <Button tone="primary" disabled={picked.length === 0} busy={busy === "move"} onClick={() => void act("move", () => api.moveBooking(booking.id, new Date(picked[0]!).toISOString()))}>
                        Move it
                      </Button>
                    )}
                    {panel === "deny" && (
                      <Button
                        tone="danger"
                        busy={busy === "deny"}
                        onClick={() => void act("deny", () => api.denyBooking(booking.id, { ...(message.trim() ? { message: message.trim() } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) }))}
                      >
                        Deny
                      </Button>
                    )}
                    {panel === "cancel" && (
                      <Button tone="danger" busy={busy === "cancel"} onClick={() => void act("cancel", () => api.cancelBooking(booking.id, reason.trim() || undefined))}>
                        Cancel the booking
                      </Button>
                    )}
                  </div>
                </section>
              )}

              <section className="dash-sheet__section">
                <h3 className="dash-sheet__sub">History</h3>
                <ol className="dash-booking-history">
                  {[...booking.history].reverse().map((one, index) => (
                    <li key={index} className="dash-booking-history__row" data-status={one.status}>
                      <span className="dash-booking-history__dot" aria-hidden="true" />
                      <span className="dash-booking-history__what">
                        {BOOKING_STATUS_WORDS[one.status]}
                        <span className="dash-hint"> · {BY_WORDS(one.by, people)}</span>
                        {one.note && <span className="dash-booking-history__note">{one.note}</span>}
                      </span>
                      <span className="dash-booking-history__when">{formatIn(one.at)}</span>
                    </li>
                  ))}
                </ol>
              </section>

              {error && (
                <p className="dash-cal-form__error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        {booking && canManage && !panel && ["pending", "confirmed", "suggested", "completed"].includes(booking.status) && (
          <footer className="dash-cal-sheet__foot">
            <div className="dash-cal-sheet__foot-group">
              {booking.status === "pending" && (
                <>
                  <Button tone="primary" busy={busy === "approve"} onClick={() => void act("approve", () => api.confirmBooking(booking.id))} testId="booking-approve">
                    Approve
                  </Button>
                  <Button onClick={() => setPanel("suggest")} testId="booking-suggest">
                    Offer other times
                  </Button>
                  <Button tone="ghost" onClick={() => setPanel("deny")} testId="booking-deny">
                    Deny
                  </Button>
                </>
              )}
              {booking.status === "confirmed" && !booking.change && (
                <Button onClick={() => setPanel("move")} testId="booking-move">
                  Move
                </Button>
              )}
              {(booking.status === "confirmed" || booking.status === "completed") && Date.parse(booking.start) <= Date.now() && (
                <>
                  {booking.status === "confirmed" && (
                    <Button busy={busy === "completed"} onClick={() => void act("completed", () => api.markBooking(booking.id, "completed"))}>
                      Mark completed
                    </Button>
                  )}
                  <Button tone="ghost" busy={busy === "no_show"} onClick={() => void act("no_show", () => api.markBooking(booking.id, "no_show"))}>
                    They didn't show
                  </Button>
                </>
              )}
            </div>
            <div className="dash-cal-sheet__foot-group">
              {["pending", "confirmed", "suggested"].includes(booking.status) && (
                <CopyLink label="Copy their link" tone="ghost" make={async () => (await api.bookingPageLink(booking.id)).url} testId="booking-copy-link" />
              )}
              {["pending", "confirmed", "suggested"].includes(booking.status) && (
                <Button tone="ghost" onClick={() => setPanel("cancel")} testId="booking-cancel">
                  Cancel booking
                </Button>
              )}
            </div>
          </footer>
        )}
      </div>
    </div>
  );
};
