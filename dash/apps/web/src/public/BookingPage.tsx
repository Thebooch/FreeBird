import { useCallback, useEffect, useMemo, useState } from "react";
import { bookingApi, PublicApiError, type LinkState, type PublicBooking, type PublicType, type Question, type Slot, type TimesResult } from "./api.js";
import { browserZone, dayKey, dayWords, monthGrid, monthOf, monthRange, monthWords, shortDay, timeOf, whenWords, zoneChoices, zoneLabel } from "./time.js";
import { Alert, Button, Field, Icon, LOCATION_ICONS, Loading, Shell, Unavailable } from "./ui.jsx";

/**
 * A person's own booking page (`/p/<workspace>/book/<token>`).
 *
 * The token decides what shows: their booking's status while they have one,
 * else times to pick. Opening it changes nothing; every change is a button.
 */

type Api = ReturnType<typeof bookingApi>;

const ACTIVE = new Set(["pending", "confirmed", "suggested"]);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong. Try again.");

export const BookingPage = ({ workspace, token }: { readonly workspace: string; readonly token: string }) => {
  const api = useMemo(() => bookingApi(workspace, token), [workspace, token]);
  const [state, setState] = useState<LinkState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /* "status" while there's a booking to show; "pick" to choose a time, for a new booking or to move one. */
  const [mode, setMode] = useState<{ readonly kind: "status" } | { readonly kind: "pick"; readonly moving?: PublicBooking }>({ kind: "status" });
  const [chosenType, setChosenType] = useState<PublicType | null>(null);

  useEffect(() => {
    api.state().then(setState, (error: unknown) => setFailure(messageOf(error)));
  }, [api]);

  const footer = "This page is just for you: anyone with its link can see and change your booking, so please don't share it.";
  if (failure) {
    return (
      <Shell brand={null} width="narrow">
        <Unavailable title="This link can't be opened" message={failure} />
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

  const done = (next: LinkState) => {
    setState(next);
    setMode({ kind: "status" });
  };
  const type = state.type ?? chosenType;

  if (mode.kind === "status" && state.booking && (ACTIVE.has(state.booking.status) || !state.canBook || !type)) {
    return (
      <Shell brand={state.workspace} width="narrow" footer={footer}>
        <StatusView api={api} state={state} onChange={setState} onPick={(moving) => setMode({ kind: "pick", ...(moving ? { moving } : {}) })} />
      </Shell>
    );
  }
  if (!type) {
    return (
      <Shell brand={state.workspace} width="narrow" footer={footer}>
        <TypeChooser state={state} onPick={setChosenType} />
      </Shell>
    );
  }
  return (
    <Shell brand={state.workspace} footer={footer}>
      <Picker
        api={api}
        state={state}
        type={type}
        {...(mode.kind === "pick" && mode.moving ? { moving: mode.moving } : {})}
        onDone={done}
        {...(state.booking && (mode.kind === "pick" || ACTIVE.has(state.booking.status)) ? { onBack: () => setMode({ kind: "status" }) } : {})}
        {...(!state.type && chosenType ? { onChangeType: () => setChosenType(null) } : {})}
      />
    </Shell>
  );
};

/* ── what to book, when the link didn't say ────────────────────────────── */

const TypeChooser = ({ state, onPick }: { readonly state: LinkState; readonly onPick: (type: PublicType) => void }) => (
  <div className="pub-card">
    <div className="pub-card__body pub-stack" data-gap="lg">
      <div className="pub-stack" data-gap="sm">
        <span className="pub-eyebrow">Book a time</span>
        <h1 className="pub-title">{state.contact.name ? `Hi ${state.contact.name.split(" ")[0]}, what would you like to book?` : "What would you like to book?"}</h1>
      </div>
      {state.types.length === 0 ? (
        <Alert tone="info" title="Nothing to book right now">
          There's nothing open to book from this page at the moment. Please check back later.
        </Alert>
      ) : (
        <div className="pub-types">
          {state.types.map((one) => (
            <button key={one.id} type="button" className="pub-type" onClick={() => onPick(one)}>
              <span className="pub-type__name">{one.name}</span>
              <span className="pub-type__meta">
                {one.minutes} min · {one.location.words}
              </span>
              <Icon name="right" />
            </button>
          ))}
        </div>
      )}
    </div>
  </div>
);

/* ── the type, beside the picker ───────────────────────────────────────── */

const About = ({ type, state, onChangeType }: { readonly type: PublicType; readonly state: LinkState; readonly onChangeType?: () => void }) => (
  <aside className="pub-book__about">
    <div className="pub-stack" data-gap="sm">
      <span className="pub-eyebrow">{state.contact.name ? `Booking for ${state.contact.name}` : "Book a time"}</span>
      <h1 className="pub-title">{type.name}</h1>
    </div>
    <ul className="pub-meta">
      <li className="pub-meta__item">
        <Icon name="clock" />
        <span>
          <strong>{type.minutes} min</strong>
        </span>
      </li>
      <li className="pub-meta__item">
        <Icon name={LOCATION_ICONS[type.location.kind] ?? "pin"} />
        <span>{type.location.words}</span>
      </li>
      {type.approval ? (
        <li className="pub-meta__item">
          <Icon name="hourglass" />
          <span>Requests are confirmed by the team</span>
        </li>
      ) : (
        <li className="pub-meta__item">
          <Icon name="check" />
          <span>Confirmed as soon as you book</span>
        </li>
      )}
    </ul>
    {type.description ? <p className="pub-muted pub-book__desc">{type.description}</p> : null}
    {onChangeType ? (
      <button type="button" className="pub-link" onClick={onChangeType}>
        <Icon name="left" size={16} />
        Book something else
      </button>
    ) : null}
  </aside>
);

/* ── picking a time ────────────────────────────────────────────────────── */

type Step = "questions" | "time" | "review";

const Picker = ({
  api,
  state,
  type,
  moving,
  onDone,
  onBack,
  onChangeType,
}: {
  readonly api: Api;
  readonly state: LinkState;
  readonly type: PublicType;
  readonly moving?: PublicBooking;
  readonly onDone: (state: LinkState) => void;
  readonly onBack?: () => void;
  readonly onChangeType?: () => void;
}) => {
  const [zone, setZone] = useState(() => browserZone());
  const today = dayKey(Date.now(), zone);
  const [month, setMonth] = useState(() => monthOf(today));
  const [host, setHost] = useState("");
  const [all, setAll] = useState(false);
  const [request, setRequest] = useState<Record<string, string>>({});
  const [times, setTimes] = useState<TimesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("time");
  const [asked, setAsked] = useState(false);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [advanced, setAdvanced] = useState(false);
  /* What the times on hand were looked up for: the month and the answers. Only times for what is asked now decide anything. */
  const wanted = JSON.stringify([month.year, month.month, all, host, request]);
  const [timesFor, setTimesFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const range = monthRange(month.year, month.month);
      const found = await api.times({ type: type.id, ...range, all, ...(host ? { host } : {}), request });
      setTimes(found);
      setTimesFor(JSON.stringify([month.year, month.month, all, host, request]));
      setProblem(null);
      if (found.questions.length > 0 && !asked) setStep("questions");
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setLoading(false);
    }
  }, [api, type.id, month, all, host, request, asked]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Times by the day they fall on, in the zone shown. */
  const byDay = useMemo(() => {
    const out = new Map<string, Slot[]>();
    for (const one of times?.slots ?? []) {
      const key = dayKey(one.start, zone);
      if (monthOf(key).month !== month.month) continue;
      out.set(key, [...(out.get(key) ?? []), one]);
    }
    return out;
  }, [times, zone, month]);

  /* The first open day is picked for them; an empty current month moves on once by itself. */
  useEffect(() => {
    if (loading || !times || timesFor !== wanted) return;
    /* Nothing is shown yet while questions wait, or when the type doesn't take them: no reason to move on. */
    if (step !== "time" || times.notEligible) return;
    if (day && byDay.has(day)) return;
    const first = [...byDay.keys()].sort()[0] ?? null;
    setDay(first);
    if (!first && !advanced && month.year === monthOf(today).year && month.month === monthOf(today).month) {
      setAdvanced(true);
      setMonth((held) => (held.month === 11 ? { year: held.year + 1, month: 0 } : { year: held.year, month: held.month + 1 }));
    }
  }, [loading, times, timesFor, wanted, byDay, day, advanced, month, today, step]);

  const shift = (by: number) => {
    setDay(null);
    setMonth((held) => {
      const at = held.month + by;
      return { year: held.year + Math.floor(at / 12), month: ((at % 12) + 12) % 12 };
    });
  };
  const atFirstMonth = month.year === monthOf(today).year && month.month === monthOf(today).month;

  const steps: Array<{ key: Step; label: string }> = [
    ...(asked || (times && times.questions.length > 0) ? [{ key: "questions" as const, label: "A few questions" }] : []),
    { key: "time", label: "Pick a time" },
    { key: "review", label: moving ? "Confirm the move" : "Review" },
  ];
  const at = steps.findIndex((one) => one.key === step);

  return (
    <div className="pub-card pub-book">
      <About type={type} state={state} {...(onChangeType ? { onChangeType } : {})} />
      <section className="pub-book__work" aria-label="Pick a time">
        {onBack ? (
          <div style={{ marginBottom: 16 }}>
            <button type="button" className="pub-link" onClick={onBack}>
              <Icon name="left" size={16} />
              Back to your booking
            </button>
          </div>
        ) : null}
        <ol className="pub-steps" aria-label="Steps">
          {steps.map((one, index) => (
            <li key={one.key} className="pub-steps__one" data-state={index < at ? "done" : index === at ? "now" : "next"}>
              {index > 0 ? <span className="pub-steps__sep" aria-hidden="true" /> : null}
              <span className="pub-steps__num">{index < at ? <Icon name="check" size={12} /> : index + 1}</span>
              <span>{one.label}</span>
            </li>
          ))}
        </ol>
        {moving ? (
          <div style={{ marginBottom: 18 }}>
            <Alert tone="info" title={moving.status === "suggested" ? "Asking for another time" : "Moving your booking"}>
              Now: {whenWords(moving.start, moving.end, zone)}. {moving.status === "confirmed" ? "It keeps this time until the new one is confirmed." : ""}
            </Alert>
          </div>
        ) : null}
        {problem && step !== "review" ? (
          <div style={{ marginBottom: 18 }}>
            <Alert tone="danger" title="Times couldn't be loaded">
              {problem}
            </Alert>
          </div>
        ) : null}

        {step === "questions" && times ? (
          <Questions
            api={api}
            questions={times.questions}
            answered={request}
            onDone={(answers) => {
              setAsked(true);
              setRequest(answers);
              setStep("time");
            }}
          />
        ) : null}

        {step === "time" && times?.notEligible ? (
          <div className="pub-stack" data-gap="lg">
            <Alert tone="info" title="This can't be booked online">
              {times.notEligible}
            </Alert>
            {asked ? (
              <div>
                <button
                  type="button"
                  className="pub-link"
                  onClick={() => {
                    /* Asked again from the start: the answers decide what is offered. */
                    setRequest({});
                    setAsked(false);
                  }}
                >
                  <Icon name="left" size={16} />
                  Change my answers
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === "time" && !times?.notEligible ? (
          <div className="pub-stack" data-gap="lg">
            {type.hosts.length > 0 ? (
              <Field label="With" htmlFor="pub-host">
                <select id="pub-host" className="pub-select" value={host} onChange={(event) => setHost(event.target.value)}>
                  <option value="">Anyone available</option>
                  {type.hosts.map((one) => (
                    <option key={one.id} value={one.id}>
                      {one.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <div className="pub-picker">
              <div>
                <div className="pub-cal__head">
                  <h2 className="pub-cal__title">{monthWords(month.year, month.month)}</h2>
                  <div className="pub-cal__nav">
                    <button type="button" className="pub-icon-btn" aria-label="Previous month" disabled={atFirstMonth} onClick={() => shift(-1)}>
                      <Icon name="left" size={16} />
                    </button>
                    <button type="button" className="pub-icon-btn" aria-label="Next month" onClick={() => shift(1)}>
                      <Icon name="right" size={16} />
                    </button>
                  </div>
                </div>
                <div className={`pub-cal__grid${loading ? " pub-cal__loading" : ""}`} role="grid" aria-busy={loading}>
                  {DOW.map((one) => (
                    <span key={one} className="pub-cal__dow" role="columnheader">
                      {one}
                    </span>
                  ))}
                  {monthGrid(month.year, month.month).map((cell) => {
                    const open = cell.inMonth && byDay.has(cell.key);
                    return (
                      <button
                        key={cell.key}
                        type="button"
                        className="pub-cal__day"
                        data-outside={!cell.inMonth || undefined}
                        data-open={open || undefined}
                        data-today={cell.key === today || undefined}
                        aria-pressed={day === cell.key}
                        aria-label={`${dayWords(cell.key)}${open ? `, ${byDay.get(cell.key)!.length} times open` : ", nothing open"}`}
                        disabled={!open}
                        onClick={() => {
                          setDay(cell.key);
                          setSlot(null);
                        }}
                      >
                        {cell.day}
                      </button>
                    );
                  })}
                </div>
                <div className="pub-zone">
                  <label className="pub-zone__label" htmlFor="pub-zone">
                    <Icon name="globe" size={14} />
                    Times are shown in
                  </label>
                  <select id="pub-zone" className="pub-select" value={zone} onChange={(event) => setZone(event.target.value)}>
                    {zoneChoices(zone, state.contact.timezone ?? "").map((one) => (
                      <option key={one} value={one}>
                        {zoneLabel(one)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="pub-times">
                <h3 className="pub-times__day">{day ? dayWords(day) : "Pick a day"}</h3>
                {day && byDay.get(day) ? (
                  <div className="pub-times__list" role="list">
                    {byDay.get(day)!.map((one) => (
                      <button
                        key={one.start}
                        type="button"
                        role="listitem"
                        className="pub-time"
                        aria-pressed={slot?.start === one.start}
                        onClick={() => {
                          setSlot(one);
                          setStep("review");
                        }}
                      >
                        <span>{timeOf(one.start, zone)}</span>
                        {one.recommended && !times?.consolidatedOnly ? <span className="pub-time__tag">Recommended</span> : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="pub-times__empty">{loading ? "Looking for open times…" : byDay.size === 0 ? "Nothing is open this month. Try the next one." : "Pick a highlighted day to see its times."}</p>
                )}
                {times?.consolidatedOnly && times.more ? (
                  <button type="button" className="pub-link" onClick={() => setAll(true)}>
                    See all available times
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {step === "review" && slot ? (
          <Review
            api={api}
            type={type}
            slot={slot}
            zone={zone}
            host={host}
            request={request}
            {...(moving ? { moving } : {})}
            onBack={() => setStep("time")}
            onTaken={(message) => {
              setProblem(message);
              setSlot(null);
              setStep("time");
              void load();
            }}
            onDone={onDone}
          />
        ) : null}
      </section>
    </div>
  );
};

/* ── questions whose answers change the times ──────────────────────────── */

const ADDRESS_PARTS = [
  ["line1", "Street address"],
  ["city", "City"],
  ["region", "State"],
  ["postalCode", "ZIP code"],
] as const;

const Questions = ({
  api,
  questions,
  answered,
  onDone,
}: {
  readonly api: Api;
  readonly questions: readonly Question[];
  readonly answered: Readonly<Record<string, string>>;
  readonly onDone: (request: Record<string, string>) => void;
}) => {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(answered).map(([key, value]) => [`request.${key}`, value])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (key: string, value: string) => setValues((held) => ({ ...held, [key]: value }));

  const submit = async () => {
    const missing: Record<string, string> = {};
    for (const one of questions) {
      const filled = one.kind === "address" ? Boolean(values[`${one.field}.line1`]?.trim()) : Boolean(values[one.field]?.trim());
      if (one.required && !filled) missing[one.field] = "This one is needed to show your times.";
    }
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    setBusy(true);
    try {
      const contact: Record<string, unknown> = {};
      const request: Record<string, string> = {};
      for (const one of questions) {
        if (one.kind === "address") {
          const parts = Object.fromEntries(ADDRESS_PARTS.map(([part]) => [part, values[`${one.field}.${part}`]?.trim() ?? ""]).filter(([, value]) => value));
          if (Object.keys(parts).length > 0) contact[one.field] = parts;
          continue;
        }
        const value = values[one.field]?.trim();
        if (!value) continue;
        if (one.field.startsWith("request.")) request[one.field.slice(8)] = value;
        else contact[one.field] = one.kind === "boolean" ? value === "yes" : one.kind === "number" ? Number(value) : value;
      }
      const result = Object.keys(contact).length > 0 ? await api.answers(contact) : { problems: {} };
      if (Object.keys(result.problems).length > 0) {
        setErrors(result.problems);
        return;
      }
      onDone({ ...Object.fromEntries(Object.entries(answered)), ...request });
    } catch (error) {
      setErrors({ _: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="pub-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="pub-stack" data-gap="sm">
        <h2 className="pub-subtitle">A few questions first</h2>
        <p className="pub-muted">Your answers decide which times we can offer you.</p>
      </div>
      {errors["_"] ? <Alert tone="danger">{errors["_"]}</Alert> : null}
      {questions.map((one) => {
        const id = `q-${one.field.replace(/[^a-zA-Z0-9]/g, "-")}`;
        if (one.kind === "address") {
          return (
            <fieldset key={one.field} className="pub-field">
              <legend className="pub-field__label">
                {one.question}
                {one.required ? null : <em>Optional</em>}
              </legend>
              <div className="pub-stack" data-gap="sm">
                <input id={id} className="pub-input" placeholder="Street address" autoComplete="street-address" value={values[`${one.field}.line1`] ?? ""} onChange={(event) => set(`${one.field}.line1`, event.target.value)} aria-invalid={Boolean(errors[one.field]) || undefined} />
                <div className="pub-grid3">
                  {ADDRESS_PARTS.slice(1).map(([part, label]) => (
                    <input key={part} className="pub-input" placeholder={label} aria-label={label} autoComplete={part === "postalCode" ? "postal-code" : part === "city" ? "address-level2" : "address-level1"} value={values[`${one.field}.${part}`] ?? ""} onChange={(event) => set(`${one.field}.${part}`, event.target.value)} />
                  ))}
                </div>
              </div>
              {errors[one.field] ? <span className="pub-field__error">{errors[one.field]}</span> : null}
            </fieldset>
          );
        }
        return (
          <Field key={one.field} label={one.question} optional={!one.required} htmlFor={id} {...(errors[one.field] ? { error: errors[one.field] } : {})}>
            {one.choices && one.choices.length > 0 ? (
              <select id={id} className="pub-select" value={values[one.field] ?? ""} onChange={(event) => set(one.field, event.target.value)}>
                <option value="">Choose…</option>
                {one.choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            ) : one.kind === "boolean" ? (
              <select id={id} className="pub-select" value={values[one.field] ?? ""} onChange={(event) => set(one.field, event.target.value)}>
                <option value="">Choose…</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            ) : (
              <input
                id={id}
                className="pub-input"
                type={one.kind === "email" ? "email" : one.kind === "phone" ? "tel" : one.kind === "number" ? "number" : one.kind === "date" ? "date" : "text"}
                value={values[one.field] ?? ""}
                onChange={(event) => set(one.field, event.target.value)}
                aria-invalid={Boolean(errors[one.field]) || undefined}
              />
            )}
          </Field>
        );
      })}
      <div className="pub-row" data-justify="end">
        {questions.every((one) => !one.required) ? (
          <Button tone="ghost" onClick={() => onDone({ ...answered })}>
            Skip
          </Button>
        ) : null}
        <Button tone="primary" type="submit" busy={busy}>
          Show my times
        </Button>
      </div>
    </form>
  );
};

/* ── the last look ─────────────────────────────────────────────────────── */

const Review = ({
  api,
  type,
  slot,
  zone,
  host,
  request,
  moving,
  onBack,
  onTaken,
  onDone,
}: {
  readonly api: Api;
  readonly type: PublicType;
  readonly slot: Slot;
  readonly zone: string;
  readonly host: string;
  readonly request: Readonly<Record<string, string>>;
  readonly moving?: PublicBooking;
  readonly onBack: () => void;
  readonly onTaken: (message: string) => void;
  readonly onDone: (state: LinkState) => void;
}) => {
  const [notes, setNotes] = useState("");
  const [where, setWhere] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const asksWhere = type.location.kind === "ask" && !moving;
  const verb = slot.approval ? "Request" : moving ? "Move" : "Book";

  const submit = async () => {
    if (asksWhere && !where.trim()) {
      setProblem("Say where you'd like to meet.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const next = moving
        ? await api.reschedule(moving.id, slot.start, host || undefined)
        : await api.request({ type: type.id, start: slot.start, ...(host ? { host } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), ...(where.trim() ? { where: where.trim() } : {}), timezone: zone, request });
      onDone(next);
    } catch (error) {
      if (error instanceof PublicApiError && error.status === 409 && /taken|isn't open/i.test(error.message)) onTaken("That time was just taken. Here's what's still open.");
      else setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="pub-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <button type="button" className="pub-link" onClick={onBack}>
          <Icon name="left" size={16} />
          Change the time
        </button>
      </div>
      <div className="pub-chosen">
        <span className="pub-chosen__icon">
          <Icon name="calendar" size={20} />
        </span>
        <div>
          <div className="pub-chosen__what">{type.name}</div>
          <div className="pub-chosen__when">{whenWords(slot.start, slot.end, zone)}</div>
        </div>
      </div>
      {slot.approval ? (
        <Alert tone="info" title="The team confirms this time">
          We'll hold it for you while they look, and this page will show their answer.
        </Alert>
      ) : null}
      {asksWhere ? (
        <Field label="Where should we meet?" htmlFor="pub-where" hint="An address, or how you'd like to meet.">
          <input id="pub-where" className="pub-input" value={where} onChange={(event) => setWhere(event.target.value)} autoComplete="street-address" />
        </Field>
      ) : null}
      {!moving ? (
        <Field label="Anything we should know?" optional htmlFor="pub-notes">
          <textarea id="pub-notes" className="pub-textarea" maxLength={1000} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      ) : null}
      {problem ? <Alert tone="danger">{problem}</Alert> : null}
      <div className="pub-row" data-justify="end">
        <Button tone="primary" size="lg" type="submit" busy={busy}>
          {verb === "Request" ? (moving ? "Request this new time" : "Request this time") : verb === "Move" ? "Move to this time" : "Book this time"}
        </Button>
      </div>
    </form>
  );
};

/* ── where things stand ────────────────────────────────────────────────── */

const STATUS: Readonly<Record<string, { readonly icon: Parameters<typeof Icon>[0]["name"]; readonly tone: string; readonly title: string }>> = {
  pending: { icon: "hourglass", tone: "warn", title: "Request sent" },
  confirmed: { icon: "check", tone: "good", title: "You're booked" },
  suggested: { icon: "sparkle", tone: "accent", title: "New times suggested" },
  denied: { icon: "x", tone: "danger", title: "This time isn't available" },
  cancelled: { icon: "ban", tone: "", title: "Cancelled" },
  expired: { icon: "clock", tone: "", title: "This request ran out" },
  completed: { icon: "check", tone: "good", title: "Completed" },
  no_show: { icon: "clock", tone: "", title: "Missed" },
};

const StatusView = ({
  api,
  state,
  onChange,
  onPick,
}: {
  readonly api: Api;
  readonly state: LinkState;
  readonly onChange: (state: LinkState) => void;
  readonly onPick: (moving?: PublicBooking) => void;
}) => {
  const booking = state.booking!;
  const zone = booking.timezone;
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"cancel" | "decline" | null>(null);
  const look = STATUS[booking.status] ?? STATUS["cancelled"]!;

  const act = async (key: string, run: () => Promise<LinkState>) => {
    setBusy(key);
    setProblem(null);
    try {
      onChange(await run());
      setConfirming(null);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(null);
    }
  };

  const lead: Readonly<Record<string, string>> = {
    pending: booking.holdUntil ? `The team will confirm it soon. We're holding this time for you until ${whenWordsShort(booking.holdUntil, zone)}.` : "The team will confirm it soon.",
    confirmed: "Everything's set. You can add it to your calendar, or change it here if plans change.",
    suggested: "The team couldn't do the time you asked for and offered these instead. Each is held for you for a little while.",
    denied: "The team couldn't take this request.",
    cancelled: "This booking was cancelled, and its time was released.",
    expired: "Nobody could confirm it in time, so the time was released.",
    completed: "This appointment has taken place.",
    no_show: "This appointment was marked as missed.",
  };

  return (
    <div className="pub-card">
      <div className="pub-card__body pub-stack" data-gap="lg">
        <div className="pub-status">
          <span className="pub-status__icon" data-tone={look.tone || undefined}>
            <Icon name={look.icon} size={26} />
          </span>
          <span className="pub-eyebrow">{booking.type}</span>
          <h1 className="pub-title">{look.title}</h1>
          <p className="pub-lead">{lead[booking.status]}</p>
        </div>

        {booking.message ? (
          <blockquote className="pub-quote" style={{ margin: 0 }}>
            {booking.message}
            <span className="pub-quote__by">A note from the team</span>
          </blockquote>
        ) : null}

        {booking.status === "suggested" && booking.suggestions ? (
          <div>
            {booking.suggestions.map((one) => (
              <div key={one.id} className="pub-offer">
                <div>
                  <div className="pub-offer__when">{whenWords(one.start, one.end, zone)}</div>
                  <div className="pub-offer__held">
                    {one.host ? `With ${one.host} · ` : ""}Held for you until {whenWordsShort(one.holdUntil, zone)}
                  </div>
                </div>
                <Button tone="primary" busy={busy === one.id} disabled={busy !== null} onClick={() => void act(one.id, () => api.accept(booking.id, one.id))}>
                  Accept
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <dl className="pub-details">
            <dt>What</dt>
            <dd>{booking.type}</dd>
            <dt>When</dt>
            <dd>
              {whenWords(booking.start, booking.end, zone)}
              {booking.status === "pending" ? <small>Waiting for the team to confirm</small> : null}
            </dd>
            {booking.where ? (
              <>
                <dt>Where</dt>
                <dd>{booking.where}</dd>
              </>
            ) : null}
            {booking.host ? (
              <>
                <dt>With</dt>
                <dd>{booking.host}</dd>
              </>
            ) : null}
          </dl>
        )}

        {booking.change ? (
          <Alert tone="info" title="Your move is waiting for the team">
            You asked to move this to {whenWords(booking.change.start, booking.change.end, zone)}. It keeps its current time until they confirm.
          </Alert>
        ) : null}
        {booking.status === "confirmed" && booking.insideCutoff ? (
          <Alert tone="warn" title="It's close to the time">
            Changes can't be made online this close to the appointment. Please contact the team to change it.
          </Alert>
        ) : null}
        {problem ? <Alert tone="danger">{problem}</Alert> : null}

        {confirming ? (
          <div className="pub-confirm" role="alertdialog" aria-label={confirming === "cancel" ? "Cancel this booking" : "Turn down these times"}>
            <strong>{confirming === "cancel" ? (booking.status === "pending" ? "Cancel this request?" : "Cancel this booking?") : "Turn down these times?"}</strong>
            <span className="pub-muted">{confirming === "cancel" ? "Its time will be released for others." : "The team will see that none of them work for you."}</span>
            <div className="pub-row" data-justify="end">
              <Button onClick={() => setConfirming(null)} disabled={busy !== null}>
                Keep it
              </Button>
              <Button
                tone="danger-solid"
                busy={busy === confirming}
                onClick={() => void act(confirming, () => (confirming === "cancel" ? api.cancel(booking.id) : api.decline(booking.id)))}
              >
                {confirming === "cancel" ? "Yes, cancel" : "Yes, turn them down"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="pub-row" data-justify="between">
            <div className="pub-row">
              {booking.status === "confirmed" ? (
                <a className="dash-btn" href={api.icsUrl()} download="booking.ics">
                  <Icon name="download" size={16} />
                  Add to calendar
                </a>
              ) : null}
              {booking.status === "suggested" ? (
                <Button onClick={() => onPick(booking)} disabled={busy !== null}>
                  Pick another time
                </Button>
              ) : null}
              {(booking.status === "pending" || booking.status === "confirmed") && booking.canReschedule ? (
                <Button onClick={() => onPick(booking)} disabled={busy !== null}>
                  <Icon name="edit" size={16} />
                  {booking.status === "pending" ? "Pick a different time" : "Reschedule"}
                </Button>
              ) : null}
              {!ACTIVE.has(booking.status) && state.canBook ? (
                <Button tone="primary" onClick={() => onPick()}>
                  {booking.status === "denied" ? "Pick another time" : "Book again"}
                </Button>
              ) : null}
            </div>
            {booking.status === "suggested" ? (
              <Button tone="ghost" onClick={() => setConfirming("decline")} disabled={busy !== null}>
                None of these work
              </Button>
            ) : booking.canCancel ? (
              <Button tone="danger" onClick={() => setConfirming("cancel")} disabled={busy !== null}>
                {booking.status === "pending" ? "Cancel request" : "Cancel"}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

/** "Thu, Oct 15, 9:00 AM". */
const whenWordsShort = (at: string, zone: string): string => `${shortDay(dayKey(at, zone))}, ${timeOf(at, zone)}`;
