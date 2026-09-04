import { WidgetShell } from "@freebirdai/dash-react";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  type ArrangementOption,
  type ConciergeControl,
  type ConciergePatch,
  type ConciergeState,
  type ConciergeStep,
} from "./api";

/**
 * The widget being built, and everything you can say about it.
 *
 * Two panes. The top one renders the draft through the *same* `WidgetShell`
 * the board uses, inside the board's own provider — so it shares the query
 * cache, the time range and the theme, and what is previewed is exactly what
 * lands. Changing a role or a view re-renders from cache and costs nothing;
 * only changing the endpoint costs a request.
 *
 * The bottom one is a control per decision, showing what it is set to and
 * opening into that decision's own derived options when clicked. Nothing here
 * knows what any of the options mean — a card that understood them would be a
 * second place where "which fields can be a date?" is decided, and the two
 * would drift.
 *
 * With no AI key there is nobody to propose anything, so the server sends a
 * question instead and this walks them one at a time. Same draft, same routes,
 * same renderer for the question either way.
 */

export interface ConciergeCardProps {
  readonly dashboardId: string;
  /** Bumped by the parent when something might have changed the draft. */
  readonly revision?: number;
  /** Called after the widget is written, so the board re-reads. */
  readonly onAdded: (widgetId: string) => void;
  readonly onDismissed?: () => void;
  /**
   * Open a panel the card must not stand in for.
   *
   * Credentials are the reason this exists: a key is entered in the connection
   * panel and nowhere else, so the card hands off rather than growing a field
   * of its own.
   */
  readonly onOpenPanel?: (panel: "connections") => void;
  /** So the column can widen while there is something to preview. */
  readonly onActiveChange?: (active: boolean) => void;
  /**
   * Whether this tab is the one that started the setup.
   *
   * The parent knows, because it watched the action execute. Without it a
   * setup the assistant began one second ago is indistinguishable from one
   * somebody abandoned yesterday — both are simply "a draft exists" — and the
   * card asked about both.
   */
  readonly startedHere?: boolean;
}

/** How many options a question shows before it needs narrowing. */
const VISIBLE_OPTIONS = 8;


/**
 * How recently a setup must have started to be one somebody is still in.
 *
 * Generous on purpose. The cost of being wrong in one direction is carrying on
 * with a setup the user had forgotten about — recoverable, and Discard is
 * right there. In the other it is interrupting somebody mid-sentence to ask
 * whether they meant to start the thing they just asked for.
 */
const FRESH_MS = 3 * 60 * 1000;

/** Remember that this draft is being worked on, if the browser will let us. */
const remember = (key: string): void => {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    /* Not being able to remember is survivable; everything still works. */
  }
};

/**
 * A control's answer, as a patch.
 *
 * Editing a decision that is already settled cannot go through `answer_step` —
 * that route only accepts an answer to the question actually being asked, and
 * refuses anything else so a stale card cannot bind a field to a role nobody
 * chose. Re-opening a chip is the opposite situation: a deliberate change to
 * something already decided, which is exactly what `revise` is for.
 */
const patchFor = (stepId: string, values: string[]): ConciergePatch => {
  if (stepId.startsWith("role:")) {
    return { roles: { [stepId.slice("role:".length)]: values } };
  }
  // Changing what a widget measures rebuilds its whole shape, so these are
  // answers the machine applies rather than fields patched one at a time.
  if (stepId === "measure") return { measure: values[0] ?? "" };
  if (stepId === "groupBy") return { groupBy: values[0] ?? "" };
  /*
   * A filter and a comparison are kept or removed, never re-chosen — their
   * one option is what the widget already has. Keeping is a no-op, and
   * removing arrives as a skip, which the machine reads as "take it off".
   */
  if (stepId === "choice") return { choice: values[0] ?? "" };
  if (stepId === "offer") return { offer: values[0] === "include" ? "include" : "skip" };
  if (stepId === "filter" || stepId.startsWith("series:")) return {};
  const single = values[0] ?? "";
  switch (stepId) {
    case "connection":
      return { connection: single };
    case "endpoint":
      return { endpoint: single };
    case "join":
      return { join: single };
    case "component":
      return { component: single };
    case "options":
      return { controls: values };
    case "drilldown":
      return { drilldown: single };
    case "drilldownFields":
      return { drilldownFields: values };
    case "extras":
      return { extras: values };
    case "highlights":
      return { highlights: values };
    case "title":
      return { title: single };
    default:
      return {};
  }
};

/** What a control is called, in as few words as the chip has room for. */
const CONTROL_LABELS: Readonly<Record<string, string>> = {
  connection: "API",
  endpoint: "Data",
  join: "Joined with",
  component: "View",
  choice: "Which one",
  measure: "Measuring",
  groupBy: "Grouped by",
  filter: "Only",
  offer: "Also count",
  options: "Controls",
  drilldown: "On click",
  drilldownFields: "Record shows",
  extras: "Also showing",
  highlights: "Marks",
  title: "Name",
};

const controlLabel = (control: ConciergeControl): string => {
  const known = CONTROL_LABELS[control.stepId];
  if (known) return known;
  // Every measurement drawn beside the first gets a row of its own, so one can
  // be taken off without starting the widget again.
  if (control.stepId.startsWith("series:")) return "Compared with";
  if (control.stepId.startsWith("role:")) {
    const role = control.stepId.slice("role:".length);
    return role.charAt(0).toUpperCase() + role.slice(1);
  }
  return control.stepId;
};

/** What a control reads as, using the option labels rather than the raw ids. */
const controlValue = (control: ConciergeControl): string => {
  if (control.value.length === 0) return control.settled ? "none" : "—";
  const labels = control.value.map(
    (value) => control.options.find((option) => option.value === value)?.label ?? value,
  );
  return labels.length > 2
    ? `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`
    : labels.join(", ");
};

/**
 * A derived question, whether it came from the wizard or from opening a
 * control.
 *
 * One renderer for both, because they are the same thing: a set of options the
 * server derived, with one suggested. The only difference is what happens
 * after — the wizard moves to the next question, a control closes back to the
 * card.
 *
 * Keyed by `stepId` at the call site so React remounts it per question; the
 * selection state below is per-question and carrying it across would tick a
 * field somebody never saw offered.
 */
const Question = ({
  step,
  busy,
  onAnswer,
  onCancel,
}: {
  step: ConciergeStep;
  busy: boolean;
  onAnswer: (values: string[], skip: boolean) => void;
  onCancel?: (() => void) | undefined;
}): JSX.Element => {
  const suggested = step.options.find((option) => option.recommended);
  const [chosen, setChosen] = useState<string[]>(suggested ? [suggested.value] : []);
  const [typed, setTyped] = useState(step.freeText ? (suggested?.value ?? "") : "");
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  /*
   * A long list is narrowed, not scrolled.
   *
   * A REST API with sixty endpoints produces sixty options, and every one of
   * them is legitimate — so this cannot be fixed by deriving fewer. The server
   * already puts the useful ones first; this shows that head and lets somebody
   * type to reach the rest.
   */
  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? step.options.filter(
        (option) =>
          option.label.toLowerCase().includes(needle) ||
          option.value.toLowerCase().includes(needle),
      )
    : step.options;
  const visible = showAll || needle ? matching : matching.slice(0, VISIBLE_OPTIONS);
  const hidden = matching.length - visible.length;
  const values = step.freeText && typed.trim() ? [typed.trim()] : chosen;

  return (
    <div className="dash-setup__question">
      <p className="dash-setup__q">{step.question}</p>
      {step.help && <p className="dash-setup__help">{step.help}</p>}

      {busy && step.stepId === "read" && (
        <p className="dash-setup__help" data-testid="concierge-reading">
          Reading… this makes real requests and is paced, so it takes a few seconds.
        </p>
      )}

      {step.options.length > VISIBLE_OPTIONS && (
        <input
          className="dash-setup__text"
          value={filter}
          disabled={busy}
          placeholder={`Filter ${step.options.length} options`}
          aria-label="Filter the options"
          data-testid="concierge-filter"
          onChange={(event) => setFilter(event.target.value)}
        />
      )}

      <ul className="dash-setup__options">
        {visible.map((option) => {
          const on = chosen.includes(option.value);
          return (
            <li key={option.value}>
              <button
                type="button"
                className="dash-setup__option"
                data-on={on ? "true" : "false"}
                disabled={busy}
                aria-pressed={on}
                onClick={() => {
                  // A single-choice question answers on click: one tap, not a
                  // tap and then a second one on a button labelled Continue.
                  if (step.multiple) {
                    setChosen((current) =>
                      current.includes(option.value)
                        ? current.filter((existing) => existing !== option.value)
                        : [...current, option.value],
                    );
                  } else onAnswer([option.value], false);
                }}
              >
                <span className="dash-setup__option-name">
                  {option.label}
                  {option.recommended && (
                    <span className="dash-setup__suggested"> · suggested</span>
                  )}
                </span>
                {option.description && (
                  <span className="dash-setup__option-meta">{option.description}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {hidden > 0 && (
        <button
          type="button"
          className="dash-setup__more"
          data-testid="concierge-more"
          onClick={() => setShowAll(true)}
        >
          Show {hidden} more
        </button>
      )}
      {needle && matching.length === 0 && (
        <p className="dash-setup__help">Nothing matches “{filter.trim()}”.</p>
      )}

      {step.freeText && (
        <input
          className="dash-setup__text"
          value={typed}
          disabled={busy}
          placeholder="Or type your own"
          data-testid="concierge-text"
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && typed.trim()) onAnswer([typed.trim()], false);
          }}
        />
      )}

      <div className="dash-row dash-row--end" style={{ marginTop: 10, gap: 6 }}>
        {onCancel && (
          <button className="dash-control" disabled={busy} onClick={onCancel}>
            Back
          </button>
        )}
        {step.skippable && (
          <button
            className="dash-control"
            disabled={busy}
            data-testid="concierge-skip"
            onClick={() => onAnswer([], true)}
          >
            No thanks
          </button>
        )}
        {(step.multiple || step.freeText) && (
          <button
            className="dash-control"
            disabled={busy || values.length === 0}
            data-testid="concierge-next"
            onClick={() => onAnswer(values, false)}
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * Every decision about the widget, behind one control.
 *
 * A disclosure rather than a row of chips, for three reasons. It says what it
 * is — "Settings" is a word people already know, where a pill reading
 * "VIEW · Bar chart" is a puzzle. It has a summary, so the state of the widget
 * is legible without opening anything. And it collapses, so the eleven
 * decisions a complex widget carries do not push the preview off the screen.
 *
 * The rows are one per decision and full width, with the value on the right —
 * which is what a settings list looks like everywhere else, and therefore what
 * somebody expects to be able to click.
 *
 * Nothing here understands any option. A panel that knew what a "category"
 * was would be a second place deciding which fields can be one, and the two
 * would drift; every option and its label came from the server.
 */
const SettingsPanel = ({
  controls,
  busy,
  open,
  onToggle,
  onEdit,
}: {
  readonly controls: readonly ConciergeControl[];
  readonly busy: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onEdit: (stepId: string) => void;
}): JSX.Element => {
  /*
   * What still blocks a widget, counted in the summary.
   *
   * Visible without opening the panel, because a required decision nobody has
   * made is the one thing here somebody has to act on — and a disclosure that
   * hides the reason the Add button is disabled is worse than no disclosure.
   */
  const missing = controls.filter((control) => control.required && !control.settled);

  return (
    <section className="dash-settings" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="dash-settings__toggle"
        aria-expanded={open}
        onClick={onToggle}
        data-testid="concierge-settings"
      >
        <span className="dash-settings__chevron" aria-hidden="true">
          ▸
        </span>
        <span className="dash-settings__label">Settings</span>
        <span className="dash-settings__summary">
          {missing.length > 0
            ? `${missing.length} still needed`
            : `${controls.length} adjustable`}
        </span>
      </button>

      {open && (
        <ul className="dash-settings__list" data-testid="concierge-settings-list">
          {controls.map((control) => (
            <li key={control.stepId}>
              <button
                type="button"
                className="dash-settings__row"
                data-unset={control.settled ? "false" : "true"}
                data-required={control.required ? "true" : "false"}
                disabled={busy}
                data-testid={`concierge-chip-${control.stepId}`}
                onClick={() => onEdit(control.stepId)}
              >
                <span className="dash-settings__name">{controlLabel(control)}</span>
                <span className="dash-settings__value">{controlValue(control)}</span>
                <span className="dash-settings__go" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};


/**
 * The other ways these widgets could be shown, as pictures.
 *
 * Deliberately abstract: grey bars and the real widget names, never invented
 * field values or plausible-looking rows. A realistic mock of an arrangement
 * that turns out not to work is exactly the confident-and-wrong failure this
 * whole area exists to remove — and the mocks cost nothing to draw, which is
 * the point of their being mocks rather than live previews.
 *
 * The recommended arrangement is already applied and previewing live above.
 * These are alternates, so nothing here ever blocks: a person who does not
 * care never has to notice there was a choice.
 */
const MOCKS: Record<string, JSX.Element> = {
  tabs: (
    <svg viewBox="0 0 48 32" className="dash-arrange__mock" aria-hidden="true">
      <rect x="2" y="3" width="14" height="5" rx="1" className="dash-arrange__on" />
      <rect x="18" y="3" width="14" height="5" rx="1" className="dash-arrange__off" />
      <rect x="2" y="11" width="44" height="18" rx="1" className="dash-arrange__body" />
    </svg>
  ),
  row: (
    <svg viewBox="0 0 48 32" className="dash-arrange__mock" aria-hidden="true">
      <rect x="2" y="3" width="21" height="26" rx="1" className="dash-arrange__body" />
      <rect x="25" y="3" width="21" height="26" rx="1" className="dash-arrange__body" />
    </svg>
  ),
  stack: (
    <svg viewBox="0 0 48 32" className="dash-arrange__mock" aria-hidden="true">
      <rect x="2" y="3" width="44" height="12" rx="1" className="dash-arrange__body" />
      <rect x="2" y="17" width="44" height="12" rx="1" className="dash-arrange__body" />
    </svg>
  ),
  list: (
    <svg viewBox="0 0 48 32" className="dash-arrange__mock" aria-hidden="true">
      <rect x="2" y="4" width="6" height="4" rx="1" className="dash-arrange__on" />
      <rect x="10" y="4" width="36" height="4" rx="1" className="dash-arrange__body" />
      <rect x="2" y="11" width="6" height="4" rx="1" className="dash-arrange__off" />
      <rect x="10" y="11" width="36" height="4" rx="1" className="dash-arrange__body" />
      <rect x="2" y="18" width="6" height="4" rx="1" className="dash-arrange__on" />
      <rect x="10" y="18" width="36" height="4" rx="1" className="dash-arrange__body" />
      <rect x="2" y="25" width="6" height="4" rx="1" className="dash-arrange__off" />
      <rect x="10" y="25" width="36" height="4" rx="1" className="dash-arrange__body" />
    </svg>
  ),
  merged: (
    <svg viewBox="0 0 48 32" className="dash-arrange__mock" aria-hidden="true">
      <rect x="2" y="6" width="20" height="4" rx="1" className="dash-arrange__on" />
      <rect x="24" y="6" width="22" height="4" rx="1" className="dash-arrange__off" />
      <rect x="2" y="13" width="20" height="4" rx="1" className="dash-arrange__on" />
      <rect x="24" y="13" width="22" height="4" rx="1" className="dash-arrange__off" />
      <rect x="2" y="20" width="20" height="4" rx="1" className="dash-arrange__on" />
      <rect x="24" y="20" width="22" height="4" rx="1" className="dash-arrange__off" />
    </svg>
  ),
};

const ArrangementChips = ({
  options,
  busy,
  onPick,
}: {
  readonly options: readonly ArrangementOption[];
  readonly busy: boolean;
  readonly onPick: (id: ArrangementOption["id"]) => void;
}): JSX.Element | null => {
  // One option is whatever is already applied, so a single entry is no choice.
  if (options.length < 2) return null;

  return (
    <section className="dash-arrange" data-testid="concierge-arrangements">
      <span className="dash-arrange__label">or show them as</span>
      <ul className="dash-arrange__list">
        {options
          .filter((option) => !option.applied)
          .map((option) => (
            <li key={option.id}>
              <button
                type="button"
                className="dash-arrange__chip"
                disabled={busy}
                title={option.description}
                data-testid={`concierge-arrangement-${option.id}`}
                onClick={() => onPick(option.id)}
              >
                {MOCKS[option.id]}
                <span className="dash-arrange__name">{option.label}</span>
                {/*
                 * The price, on the offer rather than discovered afterwards —
                 * the same rule the join options follow. Most arrangements read
                 * exactly the same endpoints and cost nothing, and saying so is
                 * worth more than saying nothing.
                 */}
                <span className="dash-arrange__cost">
                  {option.extraRequests === 0
                    ? "no extra requests"
                    : `${option.extraRequests} extra request${option.extraRequests === 1 ? "" : "s"}`}
                </span>
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
};

export const ConciergeCard = ({
  dashboardId,
  revision = 0,
  onAdded,
  onDismissed,
  onOpenPanel,
  onActiveChange,
  startedHere = false,
}: ConciergeCardProps): JSX.Element | null => {
  const [state, setState] = useState<ConciergeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which control is open for editing. Null while the card is just showing. */
  const [editing, setEditing] = useState<string | null>(null);
  /*
   * Closed by default, and deliberately.
   *
   * The preview is the thing to look at; a panel of eleven controls opened on
   * arrival buries it and reads as a form to fill in — which is the experience
   * the conversational flow replaced.
   */
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * Swap the arrangement, and say so if it could not be done.
   *
   * Some swaps re-read the fields through a model, so this can take a moment —
   * `busy` disables the chips meanwhile rather than letting two swaps race and
   * leave the draft describing neither.
   */
  const pickArrangement = useCallback(
    async (arrangement: ArrangementOption["id"]) => {
      setBusy(true);
      setError(null);
      try {
        setState(await api.setArrangement(dashboardId, arrangement));
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [dashboardId],
  );

  const load = useCallback(async () => {
    try {
      setState(await api.concierge(dashboardId));
    } catch (cause) {
      // A missing setup is not an error worth showing; the card just stays away.
      setState({ active: false });
      if (cause instanceof ApiError && cause.status !== 404) setError(cause.message);
    }
  }, [dashboardId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  /*
   * A setup you are in, as opposed to one you left lying around.
   *
   * Drafts are durable on purpose — losing eight answers to a server restart
   * is the thing durability exists to prevent. But durable and *abandoned* are
   * different states, and for a long time nothing distinguished them: every
   * draft was treated as abandoned, so a setup the assistant had begun one
   * second earlier was presented as an unfinished job to resume or discard.
   * That is the "why is it asking me to resume something I just started"
   * problem, and it happened on **every** chat-started build.
   *
   * Three signals, any one of which is enough:
   *
   * - `startedHere` — this tab watched the action that created it.
   * - `startedAt` within a couple of minutes. Covers a missed action event, a
   *   reload mid-setup, and the card mounting after the fact.
   * - the sessionStorage mark, which is what makes engagement survive a reload
   *   and not survive closing the tab.
   *
   * The resume card is left for what it was written for: yesterday's draft, in
   * a new tab, with no context for the question it would otherwise ask.
   */
  const engagedKey = state?.active ? `dash.concierge.engaged.${state.draftId}` : null;
  const [engaged, setEngaged] = useState(false);
  const startedAt = state?.active ? state.startedAt : null;
  useEffect(() => {
    if (!engagedKey) return;
    const fresh =
      startedHere ||
      (startedAt !== null && Date.now() - Date.parse(startedAt) < FRESH_MS);
    if (fresh) {
      remember(engagedKey);
      setEngaged(true);
      return;
    }
    try {
      setEngaged(window.sessionStorage.getItem(engagedKey) === "1");
    } catch {
      // Private modes and embedded frames can refuse storage. Treating that as
      // "not engaged" only ever costs one extra click.
      setEngaged(false);
    }
  }, [engagedKey, startedHere, startedAt]);

  const engage = (): void => {
    if (engagedKey) remember(engagedKey);
    setEngaged(true);
  };

  // The column only widens for a setup somebody is actually in.
  const active = state?.active === true && engaged;
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  if (!state?.active) return null;

  const run = async (work: () => Promise<ConciergeState | null>): Promise<void> => {
    setBusy(true);
    // Cleared before the work, not after, so a failure the work itself reports
    // — a read that did not complete — survives to be shown.
    setError(null);
    try {
      const next = await work();
      if (next) setState(next);
      else await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // A 409 means the card was stale, so re-read rather than leaving a
      // question on screen the server has already moved past.
      if (cause instanceof ApiError && cause.status === 409) await load();
    } finally {
      setBusy(false);
    }
  };

  /** Answering the question the server is actually asking. */
  /*
   * Picked up deliberately, not thrust in front of somebody.
   *
   * One line and two buttons — deliberately not the question card, because the
   * whole problem is a question arriving with no context for why it is being
   * asked.
   */
  if (!engaged) {
    const what = state.summary?.title || state.intent || "a widget";
    return (
      <div className="dash-setup" data-testid="concierge-resume">
        <div className="dash-setup__head">
          <span className="dash-setup__badge">Unfinished</span>
        </div>
        <p className="dash-setup__help">
          You have a widget setup in progress — {what}. Pick it up where you left off, or
          throw it away.
        </p>
        <div className="dash-row dash-row--end" style={{ marginTop: 10, gap: 6 }}>
          <button
            className="dash-control"
            data-testid="concierge-discard-stale"
            onClick={() =>
              void run(async () => {
                await api.cancelSetup(dashboardId);
                onDismissed?.();
                return { active: false };
              })
            }
          >
            Discard
          </button>
          <button className="dash-control" data-testid="concierge-resume-go" onClick={engage}>
            Resume
          </button>
        </div>
      </div>
    );
  }

  const answer = (stepId: string, values: string[], skip: boolean): void => {
    void run(async () => {
      const next = await api.answerStep(dashboardId, stepId, values, skip);
      // Two answers do something rather than record something. The panel is
      // opened here because the card cannot take a credential itself.
      if (next.open === "connections") onOpenPanel?.("connections");
      if (next.readFailed) setError(next.readFailed);
      return next;
    });
  };

  /** Changing a decision that was already made. */
  const editControl = (stepId: string, values: string[], skip: boolean): void => {
    void run(async () => {
      const next = await api.reviseSetup(
        dashboardId,
        skip ? { skip: [stepId] } : patchFor(stepId, values),
      );
      if (next.rejected.length > 0) {
        setError(next.rejected.map((entry) => entry.reason).join("; "));
      }
      setEditing(null);
      return next;
    });
  };

  const openControl = state.controls.find((control) => control.stepId === editing);

  return (
    <div
      className="dash-setup"
      data-mode={state.mode}
      data-preview={state.widget ? "true" : "false"}
      data-testid="concierge-card"
    >
      <div className="dash-setup__head">
        <span className="dash-setup__badge">
          {state.widget ? "Building a widget" : "Setting up a widget"}
        </span>
        {!state.widget && state.step && state.remaining > 1 && (
          <span className="dash-setup__count">
            {state.remaining} question{state.remaining === 1 ? "" : "s"} to go
          </span>
        )}
      </div>

      {/*
       * The preview, whenever there is something to preview.
       *
       * `WidgetShell` with no remove or customise handlers, so it draws no
       * control it could not honour — this widget is not on a board yet.
       */}
      {state.widget && (
        <div className="dash-setup__preview" data-testid="concierge-preview">
          {/*
           * Every widget the setup will write, not just the first.
           *
           * A setup usually produces one and this is a list of one. When the
           * request was for separate things seen together it produces two, and
           * previewing only the first would be the same failure the whole
           * change exists to fix — the user told the second one was there
           * while looking at a card that shows one.
           */}
          {(state.widgets.length > 0 ? state.widgets : [state.widget]).map((entry) => (
            <WidgetShell key={entry.id} widget={entry} />
          ))}
          {state.group && state.widgets.length > 1 && (
            <p className="dash-setup__frame" data-testid="concierge-frame">
              {`Shown together as "${state.group.title}"`}
            </p>
          )}
        </div>
      )}

      {/*
       * The alternates, beside the thing itself.
       *
       * Never a question and never a gate: what is on screen is what happens
       * if nobody touches these, which is the same rule `choiceBetween`
       * follows. They appear only when there is genuinely more than one way to
       * show what was asked for, so an ordinary one-widget build never sees
       * them.
       */}
      {state.widget && (
        <ArrangementChips options={state.arrangements} busy={busy} onPick={pickArrangement} />
      )}

      {/*
       * The decisions, behind one disclosure, directly under the thing they
       * describe.
       *
       * They used to be a wrapped row of pill buttons with no heading, no
       * grouping and an affordance you had to already know about. Order
       * matters as much as the grouping did: the preview is what somebody is
       * judging, so it comes first and the controls sit beneath it, in reach
       * without being in the way. Asking for a change in the conversation is
       * still the main path — this is for somebody who would rather reach in
       * and set it, which is why it is closed by default.
       */}
      {!state.step && !openControl && state.controls.length > 0 && (
        <SettingsPanel
          controls={state.controls}
          busy={busy}
          open={settingsOpen}
          onToggle={() => setSettingsOpen((value) => !value)}
          onEdit={setEditing}
        />
      )}

      <div className="dash-setup__body">

        {/* One thing at a time: an open control, else a question, else the card. */}
        {openControl ? (
          <Question
            key={openControl.stepId}
            // Anything not required can be turned off from its own control,
            // whether or not the wizard would have offered to skip it.
            step={openControl.required ? openControl : { ...openControl, skippable: true }}
            busy={busy}
            onAnswer={(values, skip) => editControl(openControl.stepId, values, skip)}
            onCancel={() => setEditing(null)}
          />
        ) : state.step ? (
          <Question
            key={state.step.stepId}
            step={state.step}
            busy={busy}
            onAnswer={(values, skip) => answer(state.step!.stepId, values, skip)}
          />
        ) : (
          <>
            {state.summary && <p className="dash-setup__help">{state.summary.headline}</p>}

            {!state.ready && state.missing.length > 0 && (
              <p className="dash-setup__help">
                Not buildable yet — it still needs{" "}
                {state.missing.map((piece) => piece.stepId).join(", ")}. Say what you want to
                see, or set it below.
              </p>
            )}

            {/*
             * Names both ways of changing it, in that order. The conversation
             * is the better one — it can weigh a request and suggest something
             * — and Settings is there for when somebody would rather just set
             * the thing themselves.
             */}
            {state.widget && (
              <p className="dash-setup__help">
                Ask for changes below, or open Settings to adjust it directly.
              </p>
            )}

            {/*
             * Shown before the confirm, never after. A join that can repeat a
             * row turns a total into a number that is wrong and looks right,
             * and reading it once in good faith is the failure.
             */}
            {state.warnings.map((warning) => (
              <p key={warning} className="dash-setup__warn">
                {warning}
              </p>
            ))}
            {state.errors.map((message) => (
              <p key={message} className="dash-setup__error">
                {message}
              </p>
            ))}
            {state.filters.length > 0 && (
              <p className="dash-setup__help">
                This also adds a dashboard filter: {state.filters.join(", ")}.
              </p>
            )}
            {state.summary && (
              <p className="dash-setup__help">
                {state.summary.requests} request
                {state.summary.requests === 1 ? "" : "s"} to render
                {state.summary.onOpen > 0
                  ? `, ${state.summary.onOpen} more when a row is opened`
                  : ""}
                .
              </p>
            )}
          </>
        )}

        {error && <p className="dash-setup__error">{error}</p>}

        {!openControl && !state.step && (
          <div className="dash-row dash-row--end" style={{ marginTop: 10, gap: 6 }}>
            <button className="dash-control" disabled={busy} onClick={() => void run(async () => {
              await api.cancelSetup(dashboardId);
              onDismissed?.();
              return { active: false };
            })}>
              Discard
            </button>
            <button
              className="dash-control"
              disabled={busy || !state.ready}
              data-testid="concierge-confirm"
              onClick={() =>
                void run(async () => {
                  const result = await api.confirmSetup(dashboardId);
                  onAdded(result.widgetId);
                  return { active: false };
                })
              }
            >
              Add it to the board
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
