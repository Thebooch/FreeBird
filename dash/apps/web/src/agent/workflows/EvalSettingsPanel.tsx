import { Button } from "@freebirdai/dash-components";
import { useCallback, useEffect, useState } from "react";
import { api, type EvalJudge, type EvalSettings } from "../../api";

/**
 * Evals for the whole workspace: the weekly summary (on or off, who gets it,
 * send it now), and the Tone judge, whose verdicts are shown only once it
 * agrees often enough with the team's own approvals.
 */

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const EvalSettingsPanel = (): JSX.Element | null => {
  const [settings, setSettings] = useState<EvalSettings | null>(null);
  const [judges, setJudges] = useState<EvalJudge[]>([]);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void Promise.all([api.evalSettings(), api.evalJudges()]).then(
      ([held, listed]) => {
        setSettings(held);
        setJudges(listed);
        setTo(held.weekly.to.join(", "));
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, []);
  useEffect(load, [load]);
  if (!settings) return error ? <p className="dash-callout dash-callout--bad">{error}</p> : null;

  const run = (name: string, work: () => Promise<string | void>) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    void work()
      .then((said) => {
        if (said) setNotice(said);
        load();
      }, (cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(null));
  };
  const recipients = to
    .split(/[,\s]+/)
    .map((one) => one.trim())
    .filter(Boolean);
  const tone = judges.find((one) => one.id === "tone");

  return (
    <div className="dash-evals" data-testid="eval-settings">
      <strong>Evals</strong>
      <label className="dash-reach__check">
        <input
          type="checkbox"
          checked={settings.weekly.enabled}
          onChange={(event) => run("weekly", async () => void (await api.putEvalSettings({ weekly: { enabled: event.target.checked, to: settings.weekly.to } })))}
          data-testid="eval-weekly"
        />{" "}
        Email a weekly summary: tests, checks that failed on real tasks, what people approved, the inbound screen
      </label>
      <div className="dash-reach__add">
        <input className="dash-tool__when" aria-label="Summary recipients" placeholder="Everyone on the team, or a list of emails" value={to} onChange={(event) => setTo(event.target.value)} />
        <Button size="sm" busy={busy === "to"} onClick={() => run("to", async () => void (await api.putEvalSettings({ weekly: { enabled: settings.weekly.enabled, to: recipients } })))}>
          Save
        </Button>
        <Button size="sm" tone="ghost" busy={busy === "send"} onClick={() => run("send", async () => `Sent to ${(await api.sendEvalSummary()).sent}.`)} testId="eval-send-now">
          Send now
        </Button>
      </div>
      {settings.lastSentAt && <span className="dash-hint">Last sent {new Date(settings.lastSentAt).toLocaleDateString()}.</span>}
      {tone && (
        <>
          <span className="dash-hint" data-testid="eval-tone">
            Tone judge:{" "}
            {tone.calibration
              ? `agrees with your team ${Math.round(tone.calibration.agreement * 100)}% of ${tone.calibration.examples} times. ${tone.shown ? "Its verdicts are shown in tests." : `Its verdicts show once it agrees ${Math.round(tone.needed.agreement * 100)}% over ${tone.needed.examples} or more.`}`
              : "not calibrated yet. It learns what your team sends from the messages you approve, edit and decline."}
          </span>
          <div className="dash-row">
            <Button
              size="sm"
              busy={busy === "calibrate"}
              title="Reads up to 30 recent approved, edited or declined messages with the AI model: it spends a model call on each"
              onClick={() => run("calibrate", async () => void (await api.calibrateTone()))}
              testId="eval-calibrate"
            >
              Calibrate on recent approvals
            </Button>
          </div>
        </>
      )}
      {notice && <span className="dash-hint">{notice}</span>}
      {error && <p className="dash-callout dash-callout--bad">{error}</p>}
    </div>
  );
};
