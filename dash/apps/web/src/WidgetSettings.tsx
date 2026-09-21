import { useCallback, useEffect, useState } from "react";
import { ProminentSettings, Question, SettingsPanel } from "./ConciergeCard.jsx";
import { api, type ConciergeControl, type WidgetSettings as Settings } from "./api";

/**
 * Changing a widget that is already on a board.
 *
 * The thing that could not be done. A widget's decisions lived on a draft, the
 * draft was destroyed the moment it was added, and the only setting a finished
 * widget had left was how it looked — so changing a column meant deleting it
 * and describing it again.
 *
 * What makes this possible is that the widget now carries the request it was
 * compiled from. Every control here is derived from that request and the
 * record type behind it, on the server, where the compiler is; answering one
 * writes the request back and compiles it again. So a setting and a sentence
 * in the chat do the same thing by the same route, rather than by two that
 * agree until the day one changes.
 *
 * Renders through the setup card's own components deliberately. A control and
 * a question are one thing seen from different ends, and a second set of them
 * would drift.
 */

/** Which decisions sit in the open rather than behind the disclosure. */
const PROMINENT = new Set(["title", "view"]);

export const WidgetSettings = ({
  dashboardId,
  widgetId,
  onChanged,
}: {
  readonly dashboardId: string;
  readonly widgetId: string;
  /** The board changed underneath: re-read it. */
  readonly onChanged: () => void;
}): JSX.Element | null => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = await api.widgetSettings(dashboardId, widgetId);
        if (!cancelled) setSettings(found);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dashboardId, widgetId]);

  const answer = useCallback(
    async (stepId: string, values: string[]): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const result = await api.answerWidget(dashboardId, widgetId, stepId, values);
        setSettings((current) => (current ? { ...current, controls: result.controls } : current));
        /*
         * Where the answer could not be honoured exactly, in the compiler's
         * own words. A widget that quietly did something other than what was
         * asked is the failure this whole layer exists to stop.
         */
        setNotes(result.notes);
        setEditing(null);
        onChanged();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [dashboardId, widgetId, onChanged],
  );

  if (error) return <p className="dash-callout dash-callout--bad">{error}</p>;
  if (!settings) return null;

  /*
   * A widget built before briefs existed, or one the setup card re-answered
   * afterwards. It keeps the settings it always had — how it looks, which is
   * the panel beside this one — and nothing here pretends otherwise.
   */
  if (!settings.brief) {
    return settings.unavailable ? (
      <p className="dash-hint" data-testid="settings-unavailable">
        {settings.unavailable}
      </p>
    ) : null;
  }

  const open_ = settings.controls.find((control) => control.stepId === editing);
  const prominent = settings.controls.filter((control) => PROMINENT.has(control.stepId));
  const rest = settings.controls.filter((control) => !PROMINENT.has(control.stepId));

  return (
    <section className="dash-setup__settings" data-testid="widget-settings">
      <h4 className="dash-sheet__sub">What it shows</h4>

      {notes.length > 0 && (
        <ul className="dash-notes" data-testid="settings-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {open_ ? (
        <Question
          key={open_.stepId}
          step={open_.required ? open_ : { ...open_, skippable: true }}
          value={open_.value}
          busy={busy}
          onAnswer={(values, skip) => void answer(open_.stepId, skip ? [] : values)}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <>
          <ProminentSettings controls={prominent} busy={busy} onEdit={setEditing} />
          <SettingsPanel
            controls={rest}
            busy={busy}
            open={open}
            onToggle={() => setOpen((value) => !value)}
            onEdit={setEditing}
          />
        </>
      )}
    </section>
  );
};
