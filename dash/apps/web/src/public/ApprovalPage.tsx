import { useEffect, useMemo, useState } from "react";
import { approvalApi, PublicApiError, type ApprovalState, type Slot } from "./api.js";
import { dayKey, instantIn, rangeOf, shortDay, timeOf, untilWords, whenWords, zoneShort } from "./time.js";
import { Alert, Button, Field, Icon, Loading, Shell, Unavailable, initials } from "./ui.jsx";

/**
 * A member's approval page (`/p/<workspace>/approve/<token>`), opened from
 * their email or from "Copy approval link": no sign-in, the link is theirs.
 *
 * Opening it decides nothing, whatever button in the email opened it: the
 * choice only picks which panel shows. Only pressing a button here answers,
 * and the server checks again then that they may.
 */

type Choice = "approve" | "suggest" | "deny";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong. Try again.");

export const ApprovalPage = ({ workspace, token, choice }: { readonly workspace: string; readonly token: string; readonly choice: Choice | null }) => {
  const api = useMemo(() => approvalApi(workspace, token), [workspace, token]);
  const [state, setState] = useState<ApprovalState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    api.state().then(setState, (error: unknown) => setFailure(messageOf(error)));
  }, [api]);

  if (failure) {
    return (
      <Shell brand={null} width="narrow">
        <Unavailable title="This approval link can't be opened" message={failure} />
      </Shell>
    );
  }
  if (!state) {
    return (
      <Shell brand={null}>
        <Loading />
      </Shell>
    );
  }
  const zone = state.member.timezone;
  const { booking } = state;

  return (
    <Shell brand={state.workspace} footer="This link lets whoever holds it answer as you until it's used, so please don't forward it.">
      <div className="pub-as">
        <span className="pub-as__avatar" aria-hidden="true">
          {initials(state.member.name)}
        </span>
        <span>
          Answering as <strong>{state.member.name}</strong>
          {state.member.email ? ` (${state.member.email})` : ""}
        </span>
        <span className="pub-muted" style={{ marginLeft: "auto" }}>
          Times in {zoneShort(zone)}
        </span>
      </div>
      <div className="pub-approve">
        <article className="pub-card">
          <div className="pub-card__body pub-stack" data-gap="lg">
            <div className="pub-row" data-justify="between">
              <span className="pub-eyebrow">Booking request</span>
              <span className="pub-pill" data-tone={booking.status === "pending" ? "warn" : booking.status === "confirmed" ? "good" : booking.status === "denied" ? "danger" : "accent"}>
                {booking.statusWords}
              </span>
            </div>
            <div className="pub-person">
              <span className="pub-person__avatar" aria-hidden="true">
                {initials(booking.contact.name)}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="pub-person__name">{booking.contact.name}</div>
                <div className="pub-person__reach">
                  {booking.contact.email ? (
                    <span>
                      <Icon name="mail" size={14} />
                      {booking.contact.email}
                    </span>
                  ) : null}
                  {booking.contact.phone ? (
                    <span>
                      <Icon name="phone" size={14} />
                      {booking.contact.phone}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            <dl className="pub-details">
              <dt>What</dt>
              <dd>
                {booking.type}
                {booking.description ? <small>{booking.description}</small> : null}
              </dd>
              <dt>When</dt>
              <dd>
                {whenWords(booking.start, booking.end, zone)}
                {booking.change ? <small>Asking to move to {whenWords(booking.change.start, booking.change.end, zone)}</small> : null}
              </dd>
              {booking.where ? (
                <>
                  <dt>Where</dt>
                  <dd>{booking.where}</dd>
                </>
              ) : null}
              {booking.holdUntil && booking.status === "pending" ? (
                <>
                  <dt>Held</dt>
                  <dd>
                    Until {shortDay(dayKey(booking.holdUntil, zone))}, {timeOf(booking.holdUntil, zone)}
                    <small>The hold runs out {untilWords(booking.holdUntil)}</small>
                  </dd>
                </>
              ) : null}
            </dl>
            {booking.notes.length > 0 ? (
              <section className="pub-stack" data-gap="sm">
                <h3 className="pub-eyebrow">What they told us</h3>
                <dl className="pub-details">
                  {booking.notes.map((one) => (
                    <FragmentRow key={one.label} label={one.label} value={one.value} />
                  ))}
                </dl>
              </section>
            ) : null}
            {booking.facts.length > 0 ? (
              <section className="pub-stack" data-gap="sm">
                <h3 className="pub-eyebrow">What matched</h3>
                <ul className="pub-facts">
                  {booking.facts.map((one) => (
                    <li key={one} className="pub-pill">
                      {one}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {state.day.length > 0 ? (
              <section className="pub-stack" data-gap="sm">
                <h3 className="pub-eyebrow">Your day · {shortDay(dayKey(booking.start, zone))}</h3>
                <ul className="pub-dayline">
                  {state.day.map((one) => (
                    <li key={`${one.start}-${one.label}`} className="pub-dayline__item" data-current={one.current || undefined}>
                      <span className="pub-dayline__time">{rangeOf(one.start, one.end, zone)}</span>
                      <span className="pub-dayline__label">{one.current ? `${one.label} · this request` : one.label}</span>
                      <span className="pub-muted">{one.current ? "" : one.status}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </article>
        <aside className="pub-approve__side">
          {state.open && state.ask ? <Decide api={api} state={state} initial={choice} onAnswered={setState} /> : <Decided state={state} />}
        </aside>
      </div>
    </Shell>
  );
};

const FragmentRow = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <>
    <dt>{label}</dt>
    <dd>{value}</dd>
  </>
);

/* ── answering ─────────────────────────────────────────────────────────── */

const Decide = ({ api, state, initial, onAnswered }: { readonly api: ReturnType<typeof approvalApi>; readonly state: ApprovalState; readonly initial: Choice | null; readonly onAnswered: (state: ApprovalState) => void }) => {
  const ask = state.ask!;
  const tabs: Choice[] = ["approve", ...(ask.allowSuggest ? (["suggest"] as const) : []), ...(ask.allowDeny ? (["deny"] as const) : [])];
  const [tab, setTab] = useState<Choice>(initial && tabs.includes(initial) ? initial : "approve");
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [picked, setPicked] = useState<Array<{ start: string; typed: boolean }>>([]);
  const zone = state.member.timezone;

  const answer = async () => {
    if (tab === "suggest" && picked.length === 0) {
      setProblem("Pick at least one time to offer.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.answer({
        answer: tab,
        ...(tab === "suggest" ? { times: picked.map((one) => ({ start: one.start })), allowOutside: picked.some((one) => one.typed) } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(tab !== "approve" && reason.trim() ? { reason: reason.trim() } : {}),
      });
      onAnswered(result);
    } catch (error) {
      if (error instanceof PublicApiError && error.status === 409) {
        /* Someone else answered, or the request changed: show where it stands now. */
        onAnswered(await api.state().catch(() => state));
      }
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const words: Record<Choice, string> = { approve: "Approve", suggest: "Suggest", deny: "Deny" };
  return (
    <div className="pub-card">
      <div className="pub-card__body pub-stack" data-gap="lg">
        <div className="pub-stack" data-gap="sm">
          <span className="pub-eyebrow">Your answer</span>
          <h2 className="pub-subtitle">{ask.question}</h2>
        </div>
        <div className="pub-tabs" role="tablist" style={{ ["--pub-tabs" as string]: tabs.length }}>
          {tabs.map((one) => (
            <button key={one} type="button" role="tab" className="pub-tab" aria-selected={tab === one} onClick={() => setTab(one)}>
              <Icon name={one === "approve" ? "check" : one === "suggest" ? "calendar" : "x"} size={15} />
              {words[one]}
            </button>
          ))}
        </div>

        {tab === "suggest" ? <SuggestTimes api={api} zone={zone} max={ask.maxSuggestions} picked={picked} onPicked={setPicked} /> : null}

        {tab === "approve" ? <p className="pub-muted">They'll be told it's confirmed. The time is already held, so nothing else needs doing.</p> : null}

        <Field label={tab === "approve" ? "A note for them" : "A message for them"} optional htmlFor="pub-message" hint="They'll see this.">
          <textarea id="pub-message" className="pub-textarea" maxLength={1000} value={message} onChange={(event) => setMessage(event.target.value)} />
        </Field>
        {tab !== "approve" ? (
          <Field label="Why, for the team" optional htmlFor="pub-reason" hint="Kept inside the team. They never see it.">
            <textarea id="pub-reason" className="pub-textarea" style={{ minHeight: 72 }} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        ) : null}
        {problem ? <Alert tone="danger">{problem}</Alert> : null}
        <Button tone={tab === "deny" ? "danger-solid" : "primary"} size="lg" block busy={busy} onClick={() => void answer()}>
          {tab === "approve" ? "Approve request" : tab === "deny" ? "Deny request" : picked.length > 0 ? `Offer ${picked.length} time${picked.length === 1 ? "" : "s"}` : "Offer times"}
        </Button>
      </div>
    </div>
  );
};

/** Their own open times for this type, and any time they type, up to the most they may offer. */
const SuggestTimes = ({
  api,
  zone,
  max,
  picked,
  onPicked,
}: {
  readonly api: ReturnType<typeof approvalApi>;
  readonly zone: string;
  readonly max: number;
  readonly picked: ReadonlyArray<{ start: string; typed: boolean }>;
  readonly onPicked: (next: Array<{ start: string; typed: boolean }>) => void;
}) => {
  const [slots, setSlots] = useState<readonly Slot[] | null>(null);
  const [host, setHost] = useState<{ name: string; self: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
    api.times(from, to).then(
      (found) => {
        setSlots(found.slots);
        setHost(found.host);
      },
      (error: unknown) => setProblem(messageOf(error)),
    );
  }, [api]);

  const byDay = useMemo(() => {
    const out = new Map<string, Slot[]>();
    for (const one of slots ?? []) {
      const key = dayKey(one.start, zone);
      out.set(key, [...(out.get(key) ?? []), one]);
    }
    return [...out.entries()].slice(0, 10);
  }, [slots, zone]);

  const isPicked = (start: string) => picked.some((one) => one.start === start);
  const toggle = (start: string, wasTyped = false) => {
    if (isPicked(start)) onPicked(picked.filter((one) => one.start !== start));
    else if (picked.length < max) onPicked([...picked, { start, typed: wasTyped }].sort((a, b) => a.start.localeCompare(b.start)));
  };
  const addTyped = () => {
    const at = instantIn(typed, zone);
    if (at === null || at <= Date.now()) {
      setProblem("Type a time in the future.");
      return;
    }
    const start = new Date(at).toISOString();
    const open = (slots ?? []).some((one) => one.start === start);
    setProblem(null);
    setTyped("");
    if (!isPicked(start)) toggle(start, !open);
  };

  return (
    <div className="pub-stack">
      <p className="pub-muted">
        Pick up to {max} of {host && !host.self ? `${host.name}'s` : "your"} open times. Each is held for them while they decide.
      </p>
      {picked.length > 0 ? (
        <div className="pub-picked">
          {picked.map((one) => (
            <button key={one.start} type="button" className="pub-pill" data-tone={one.typed ? "warn" : "accent"} onClick={() => toggle(one.start)} aria-label={`Remove ${shortDay(dayKey(one.start, zone))} ${timeOf(one.start, zone)}`} style={{ cursor: "pointer", border: 0 }}>
              {shortDay(dayKey(one.start, zone))}, {timeOf(one.start, zone)}
              <Icon name="x" size={12} />
            </button>
          ))}
        </div>
      ) : null}
      {picked.some((one) => one.typed) ? (
        <Alert tone="warn" title="Not one of the open times">
          A time you typed may be outside the hours or clash with another booking. It will be offered anyway.
        </Alert>
      ) : null}
      {slots === null && !problem ? (
        <div className="pub-row">
          <span className="pub-spinner" aria-hidden="true" />
          <span className="pub-muted">Finding open times…</span>
        </div>
      ) : null}
      {slots && slots.length === 0 ? <p className="pub-times__empty">Nothing is open in the next two weeks. Type a time below.</p> : null}
      {byDay.length > 0 ? (
        <div className="pub-pick">
          {byDay.map(([key, times]) => (
            <div key={key}>
              <div className="pub-pick__day">{shortDay(key)}</div>
              <div className="pub-pick__times">
                {times.map((one) => (
                  <button key={one.start} type="button" className="pub-chip" aria-pressed={isPicked(one.start)} disabled={!isPicked(one.start) && picked.length >= max} onClick={() => toggle(one.start)}>
                    {timeOf(one.start, zone)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <Field label="Or type a time" htmlFor="pub-typed" hint={`In ${zoneShort(zone)}.`}>
        <div className="pub-row" style={{ flexWrap: "nowrap" }}>
          <input id="pub-typed" className="pub-input" type="datetime-local" value={typed} onChange={(event) => setTyped(event.target.value)} />
          <Button onClick={addTyped} disabled={!typed || picked.length >= max}>
            Add
          </Button>
        </div>
      </Field>
      {problem ? <Alert tone="danger">{problem}</Alert> : null}
    </div>
  );
};

/* ── after the answer ──────────────────────────────────────────────────── */

const Decided = ({ state }: { readonly state: ApprovalState }) => {
  const zone = state.member.timezone;
  const decided = state.decided;
  const words = decided
    ? {
        approved: { icon: "check" as const, tone: "good", title: `${decided.by} approved it` },
        suggested: { icon: "sparkle" as const, tone: "accent", title: `${decided.by} suggested other times` },
        denied: { icon: "x" as const, tone: "danger", title: `${decided.by} denied it` },
      }[decided.outcome]
    : state.booking.status === "cancelled"
      ? { icon: "ban" as const, tone: "", title: "They withdrew the request" }
      : state.booking.status === "expired"
        ? { icon: "clock" as const, tone: "", title: "Nobody answered in time" }
        : { icon: "info" as const, tone: "", title: "Nothing to answer" };
  return (
    <div className="pub-card">
      <div className="pub-card__body pub-stack" data-gap="lg">
        <div className="pub-status">
          <span className="pub-status__icon" data-tone={words.tone || undefined}>
            <Icon name={words.icon} size={26} />
          </span>
          <h2 className="pub-title" data-size="sm">
            {words.title}
          </h2>
          {decided ? (
            <p className="pub-muted">
              {shortDay(dayKey(decided.at, zone))}, {timeOf(decided.at, zone)}
            </p>
          ) : null}
          {state.closed && !decided ? <p className="pub-lead">{state.closed}</p> : null}
        </div>
        {decided?.message ? (
          <blockquote className="pub-quote" style={{ margin: 0 }}>
            {decided.message}
            <span className="pub-quote__by">Sent to them</span>
          </blockquote>
        ) : null}
        {state.booking.suggestions && state.booking.suggestions.length > 0 ? (
          <section className="pub-stack" data-gap="sm">
            <h3 className="pub-eyebrow">Times offered</h3>
            {state.booking.suggestions.map((one) => (
              <div key={one.start} className="pub-offer">
                <div className="pub-offer__when">{whenWords(one.start, one.end, zone)}</div>
              </div>
            ))}
          </section>
        ) : null}
        <Alert tone="info">There's nothing more to do here. You can close this page.</Alert>
      </div>
    </div>
  );
};
