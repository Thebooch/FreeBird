import { AdapterRegistry, ProxyAdapter } from "@freebirdai/dash-adapters";
import { Dashboard } from "@freebirdai/dash-react";
import type { EntityLinkView, FieldLabels } from "@freebirdai/dash-spec";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type BoardLayout,
  type ConnectionSummary,
  type OnboardingState,
  type WidgetCheck,
} from "./api.js";

/**
 * Setting up a connection's first dashboards, from any point.
 *
 * Every step is saved on the server as it happens, so this screen can be
 * closed and reopened anywhere — half way through preparing the API, with
 * parts ticked, with a preview on screen, or after a create that was cut off
 * — and it picks up exactly there. Reached as the wizard's last step, or from
 * a connection's **Dashboards** button at any time afterwards.
 *
 * Four things happen here, in order:
 *
 * 1. **Preparing the API**, once for everybody who ever connects it: what the
 *    software is, which parts it divides into, what each part opens with.
 *    One step per request, with progress, resumed automatically once begun.
 * 2. **Choosing** which parts, and one tab or a tab each.
 * 3. **Previewing** the boards exactly as they would be, each widget tried
 *    against this account first — so nothing is created that cannot load.
 * 4. **Creating** exactly what was previewed.
 */

/** How many parts start ticked. Everything ticked is eight tabs, not a start. */
const PRECHECKED = 2;

const checkLine = (check: WidgetCheck): string =>
  check.status === "unchecked"
    ? `${check.title}: ${check.message}`
    : `${check.title} is left off: ${check.message}`;

export const ConnectionOnboarding = ({
  connection,
  onOpen,
  onDone,
  onChanged,
  onRhythm,
}: {
  connection: ConnectionSummary;
  /** Open one of the boards that were made. */
  onOpen: (dashboardId: string) => void;
  /** Leave this screen, set up or not. */
  onDone: () => void;
  /** Tell the rest of the app the boards changed. */
  onChanged: () => void;
  /** The next question: how often each endpoint is checked. */
  onRhythm?: (() => void) | undefined;
}): JSX.Element => {
  const [status, setStatus] = useState<OnboardingState | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [layout, setLayout] = useState<BoardLayout>("per-category");
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepNote, setStepNote] = useState<string | null>(null);
  const [activeBoard, setActiveBoard] = useState(0);
  const mounted = useRef(true);

  /*
   * The preview renders through the same proxy a board does, so it reads the
   * rows the access check just put in the server's cache and costs nothing.
   */
  const registry = useMemo(
    () => new AdapterRegistry().register(new ProxyAdapter(connection.kind)).addConnection(connection),
    [connection],
  );

  /*
   * What the server publishes beside a connection — field labels, which
   * fields point at other records, which endpoints read the time range — so
   * a previewed board names its references the way the real one will,
   * rather than showing ids a finished board would never show.
   */
  const published = connection as ConnectionSummary & {
    labels?: FieldLabels;
    entityLinks?: EntityLinkView[];
    rangeOps?: string[];
  };
  const previewContext = useMemo(
    () => ({
      ...(published.labels ? { labels: { [connection.id]: published.labels } } : {}),
      ...(published.entityLinks ? { entityLinks: { [connection.id]: published.entityLinks } } : {}),
      ...(published.rangeOps ? { rangeOps: { [connection.id]: published.rangeOps } } : {}),
    }),
    [connection.id, published.labels, published.entityLinks, published.rangeOps],
  );

  const accept = (next: OnboardingState, keepChoices = false): void => {
    setStatus(next);
    if (keepChoices) return;
    const saved = next.setup.choices;
    if (saved) {
      setChosen([...saved.categories]);
      setLayout(saved.layout);
      return;
    }
    /*
     * The parts the pass ranked highest, ticked. The pass orders its answer
     * most-wanted first, so the top of that order is the defensible default.
     */
    setChosen((previous) =>
      previous.length > 0
        ? previous
        : next.categories
            .filter((category) => category.available)
            .slice(0, PRECHECKED)
            .map((category) => category.id),
    );
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof Error ? caught.message : "Setup could not finish. Try again.");
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  /**
   * Take preparation steps until nothing is left, or one fails.
   *
   * A failed step stops the loop rather than spinning on it: the part it was
   * on is marked, everything else is kept, and **Try again** picks it up.
   */
  const prepareAll = async (alive: () => boolean = () => mounted.current): Promise<void> => {
    setPreparing(true);
    setStepNote(null);
    try {
      for (let turn = 0; turn < 50 && alive(); turn++) {
        const next = await api.prepareOnboarding(connection.id);
        if (!alive()) return;
        accept(next, true);
        if (!next.step.ok) {
          setStepNote(next.step.error ?? "One step did not finish.");
          break;
        }
        if (next.step.step === "none" || (next.state?.remaining ?? 0) === 0) break;
      }
      /* Ticks the defaults once there are parts to tick. */
      if (alive()) accept(await api.onboarding(connection.id));
    } finally {
      if (alive()) setPreparing(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    /*
     * This mount's own flag, not the shared ref: a mount that is undone and
     * redone — React's strict mode does exactly that — must not leave the
     * first one's loop running beside the second's. The server would refuse
     * the second as already running, and the screen would show that as an
     * error.
     */
    let cancelled = false;
    const alive = (): boolean => !cancelled && mounted.current;
    void run(async () => {
      const next = await api.onboarding(connection.id);
      if (!alive()) return;
      accept(next);
      /*
       * Resumed on its own once it has begun — somebody who closed this half
       * way should come back to it finishing, not to a button. Beginning is
       * a click, because it spends model tokens.
       */
      const state = next.state;
      const settled = next.setup.status === "creating" || next.setup.status === "complete";
      if (
        state &&
        !state.describing &&
        state.divided &&
        !state.stale &&
        state.remaining > 0 &&
        state.canRun &&
        !settled
      ) {
        await prepareAll(alive);
      }
    });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
    // One setup per connection; everything else is read back from the server.
  }, [connection.id]);

  /*
   * While the record types are still being described, look again every few
   * seconds, so the screen moves on by itself when they are done rather than
   * sitting on a message that has stopped being true.
   */
  const describingNow = status?.state?.describing === true;
  useEffect(() => {
    if (!describingNow) return;
    const timer = window.setInterval(() => {
      void api
        .onboarding(connection.id)
        .then((next) => {
          if (mounted.current) accept(next, true);
        })
        .catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
    // accept is stable in effect; only the flag and the connection matter.
  }, [describingNow, connection.id]);

  const state = status?.state ?? null;
  const setup = status?.setup;
  const offers = status?.categories ?? [];
  const ready = offers.filter((offer) => offer.status === "ready").length;
  const picked = offers.filter((offer) => chosen.includes(offer.id));
  const effectiveLayout: BoardLayout = chosen.length > 1 ? layout : "per-category";

  /* A preview is of the choices on record; change them and it is of nothing. */
  const previewCurrent =
    setup?.preview !== undefined &&
    setup.choices !== undefined &&
    setup.choices.categories.join("|") === chosen.join("|") &&
    (chosen.length > 1 ? setup.choices.layout === layout : true);
  const preview = previewCurrent ? setup?.preview : undefined;

  const previewBoards = (): Promise<void> =>
    run(async () => {
      await api.chooseOnboarding(connection.id, { categories: chosen, layout: effectiveLayout });
      accept(await api.previewOnboarding(connection.id), true);
      setActiveBoard(0);
    });

  const create = (): Promise<void> =>
    run(async () => {
      const previewId = setup?.preview?.id;
      if (!previewId) return;
      accept(await api.commitOnboarding(connection.id, previewId), true);
      onChanged();
    });

  const restart = (): Promise<void> =>
    run(async () => {
      accept(await api.restartOnboarding(connection.id));
    });

  const skip = (): Promise<void> =>
    run(async () => {
      await api.skipOnboarding(connection.id);
      onChanged();
      onDone();
    });

  const needsGate = state !== null && !state.describing && (!state.divided || state.stale);
  const settledStatus = setup?.status;

  return (
    <section data-testid="connection-onboarding" aria-busy={busy || preparing}>
      <h4>What do you want from {status?.title ?? connection.title}?</h4>
      {status?.profile && (
        <p className="dash-page__description" data-testid="onboarding-profile">
          {status.profile.summary}
        </p>
      )}

      {error && (
        <p role="alert" className="dash-callout dash-callout--bad" data-testid="onboarding-error">
          {error}
        </p>
      )}
      {status?.reason && (
        <p className="dash-callout" data-testid="onboarding-reason">
          {status.reason}
        </p>
      )}

      {preparing && (
        <p role="status" className="dash-hint" data-testid="onboarding-progress">
          {state?.divided
            ? `Preparing starting dashboards — ${ready} of ${offers.length} part(s) ready…`
            : "Working out what this API is for…"}
        </p>
      )}

      {/*
       * The gate, in the same shape as the map gate: what it buys, what it
       * costs, and that it is paid once. The question is about the API rather
       * than this account, which is exactly why the answer is worth sharing.
       */}
      {needsGate && !preparing && settledStatus !== "creating" && (
        <div className="dash-callout" data-testid="onboarding-gate">
          <p>
            <strong>
              {state!.stale
                ? "This API has changed since its parts were worked out."
                : "Nobody has worked out what this API is for yet."}
            </strong>
          </p>
          <p className="dash-hint">
            {status?.title ?? "This API"} has {state!.entities} kind(s) of record. Working it out
            reads them once and answers two things: what this software is, and which parts it
            divides into &mdash; leasing, maintenance, accounting, whatever this one&rsquo;s own
            are. Then, for each part, which widgets a dashboard of it should open with.
          </p>
          <p className="dash-hint">
            It makes <strong>no requests against your API</strong>. The cost is AI usage, and it
            is paid once &mdash; the answer describes the API rather than your account, so
            everybody who connects this API afterwards starts where you finished.
          </p>
          <div className="dash-row dash-row--end" style={{ marginTop: 8 }}>
            <button
              className="dash-control dash-control--primary"
              data-testid="onboarding-divide"
              disabled={busy || !state!.canRun || state!.entities === 0}
              onClick={() => void run(() => prepareAll())}
            >
              {state!.stale ? "Work it out again" : "Work out what this API is for"}
            </button>
          </div>
        </div>
      )}

      {stepNote && !preparing && (
        <div className="dash-callout" data-testid="onboarding-step-failed">
          <p>{stepNote}</p>
          <p className="dash-hint">
            Everything before it is kept. Trying again picks up where it stopped.
          </p>
          <div className="dash-row dash-row--end" style={{ marginTop: 8 }}>
            <button
              className="dash-control"
              data-testid="onboarding-retry"
              disabled={busy || !state?.canRun}
              onClick={() => void run(() => prepareAll())}
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {settledStatus === "complete" && (
        <div className="dash-callout dash-callout--good" data-testid="onboarding-complete">
          <p>
            <strong>Your dashboards are ready.</strong>
          </p>
          <div className="dash-row" style={{ flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {(status?.boards ?? []).map((board) => (
              <button
                key={board.dashboard}
                className="dash-control"
                data-testid={`onboarding-open-${board.dashboard}`}
                onClick={() => onOpen(board.dashboard)}
              >
                Open {board.title} ({board.widgets} widget{board.widgets === 1 ? "" : "s"})
              </button>
            ))}
          </div>
          {(setup?.notes.length ?? 0) > 0 && (
            <ul className="dash-hint" data-testid="onboarding-notes">
              {setup!.notes.slice(0, 6).map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <p className="dash-hint">
            Setting it up again makes new tabs and leaves these alone, so nothing you arrange is
            lost.
          </p>
        </div>
      )}

      {settledStatus === "creating" && (
        <div className="dash-callout" data-testid="onboarding-interrupted">
          <p>
            <strong>Creating these dashboards was interrupted.</strong> Finishing makes the same
            tabs, and leaves any that were already made exactly as they are.
          </p>
          <div className="dash-row dash-row--end" style={{ marginTop: 8, gap: 8 }}>
            <button className="dash-control" disabled={busy} onClick={() => void restart()}>
              Start another set instead
            </button>
            <button
              className="dash-control dash-control--primary"
              data-testid="onboarding-finish"
              disabled={busy}
              onClick={() => void create()}
            >
              Finish creating them
            </button>
          </div>
        </div>
      )}

      {settledStatus !== "complete" &&
        settledStatus !== "creating" &&
        state?.divided &&
        !state.stale &&
        offers.length > 0 && (
          <>
            <p className="dash-page__description">
              Tick the parts you want. Each one becomes a dashboard, already filled in and checked
              against your account before anything is made.
            </p>
            <ul className="dash-checklist" data-testid="onboarding-categories">
              {offers.map((offer) => (
                <li key={offer.id}>
                  <label>
                    <input
                      type="checkbox"
                      data-testid={`category-${offer.id}`}
                      disabled={!offer.available || busy}
                      checked={chosen.includes(offer.id)}
                      onChange={(event) =>
                        setChosen((previous) =>
                          event.target.checked
                            ? offers
                                .map((one) => one.id)
                                .filter((id) => id === offer.id || previous.includes(id))
                            : previous.filter((id) => id !== offer.id),
                        )
                      }
                    />
                    <span>
                      <span className="dash-checklist__name">{offer.title}</span>
                      <div className="dash-checklist__meta">
                        {offer.description ? `${offer.description} ` : ""}
                        {offer.available
                          ? `${offer.recordTypes} record type(s) · opens with ${offer.widgets} widget(s): ${offer.opensWith.join(", ")}`
                          : offer.status === "pending" && preparing
                            ? "Preparing…"
                            : (offer.unavailable ?? "Nothing could be built for this part.")}
                      </div>
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {/*
             * Only worth asking with two or more parts ticked. With one there
             * is nothing to combine.
             */}
            {chosen.length > 1 && (
              <div className="dash-callout" data-testid="onboarding-layout">
                <p>
                  <strong>One {status?.title ?? "combined"} tab, or a tab each?</strong>
                </p>
                <label style={{ display: "block", marginTop: 6 }}>
                  <input
                    type="radio"
                    name="dash-tab-layout"
                    data-testid="layout-per-category"
                    checked={layout === "per-category"}
                    onChange={() => setLayout("per-category")}
                  />{" "}
                  A tab each &mdash; {picked.map((offer) => offer.title).join(", ")}
                </label>
                <label style={{ display: "block", marginTop: 4 }}>
                  <input
                    type="radio"
                    name="dash-tab-layout"
                    data-testid="layout-single"
                    checked={layout === "single"}
                    onChange={() => setLayout("single")}
                  />{" "}
                  One tab called {status?.title ?? "this connection"}, with the most important
                  widgets from each
                </label>
              </div>
            )}

            {preview && (
              <div data-testid="onboarding-preview" style={{ marginTop: 12 }}>
                {preview.checks.filter((check) => check.status !== "ready").length > 0 && (
                  <ul className="dash-hint" data-testid="onboarding-checks">
                    {preview.checks
                      .filter((check) => check.status !== "ready")
                      .map((check) => (
                        <li key={`${check.category}-${check.widget}`}>{checkLine(check)}</li>
                      ))}
                  </ul>
                )}
                {preview.notes.length > 0 && (
                  <ul className="dash-hint" data-testid="onboarding-preview-notes">
                    {preview.notes.slice(0, 5).map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
                {preview.boards.length === 0 ? (
                  <p className="dash-callout">
                    None of these widgets could be built against your account. Choose other parts,
                    or check again later.
                  </p>
                ) : (
                  <>
                    {preview.boards.length > 1 && (
                      <div className="dash-row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {preview.boards.map((one, index) => (
                          <button
                            key={one.board.id}
                            className="dash-control"
                            aria-pressed={activeBoard === index}
                            onClick={() => setActiveBoard(index)}
                          >
                            {one.board.title}
                          </button>
                        ))}
                      </div>
                    )}
                    {preview.boards[activeBoard] && (
                      <div style={{ minWidth: 0, marginTop: 12 }} data-testid="onboarding-preview-board">
                        <Dashboard
                          key={preview.boards[activeBoard]!.board.id}
                          dashboard={preview.boards[activeBoard]!.board}
                          registry={registry}
                          {...previewContext}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="dash-row dash-row--end" style={{ marginTop: 12, gap: 8 }}>
              <button
                className="dash-control"
                data-testid="onboarding-skip"
                disabled={busy}
                onClick={() => void skip()}
              >
                Skip for now
              </button>
              <button
                className={`dash-control ${preview ? "" : "dash-control--primary"}`}
                data-testid="onboarding-preview-button"
                disabled={busy || preparing || chosen.length === 0}
                onClick={() => void previewBoards()}
              >
                {busy && !preview
                  ? "Checking against your account…"
                  : preview
                    ? "Check again"
                    : "Preview"}
              </button>
              {preview && (
                <button
                  className="dash-control dash-control--primary"
                  data-testid="onboarding-build"
                  disabled={busy || preview.boards.length === 0}
                  onClick={() => void create()}
                >
                  {preview.boards.length > 1 ? `Make ${preview.boards.length} tabs` : "Make my dashboard"}
                </button>
              )}
            </div>
          </>
        )}

      {settledStatus === "complete" && (
        <div className="dash-row dash-row--end" style={{ marginTop: 12, gap: 8 }}>
          <button
            className="dash-control"
            data-testid="onboarding-restart"
            disabled={busy}
            onClick={() => void restart()}
          >
            Create another set
          </button>
          {/*
           * The last question — how often each endpoint is checked — is
           * reachable without redoing the first ones.
           */}
          <button
            className="dash-control dash-control--primary"
            data-testid="onboarding-close"
            onClick={onRhythm ?? onDone}
          >
            {onRhythm ? "Next: how often we check for new data" : "Done"}
          </button>
        </div>
      )}

      {(needsGate || (state === null && status !== null)) && settledStatus !== "complete" && (
        <div className="dash-row dash-row--end" style={{ marginTop: 12 }}>
          <button className="dash-control" data-testid="onboarding-skip" onClick={() => void skip()}>
            Skip for now
          </button>
        </div>
      )}
    </section>
  );
};
