import { Badge, Button } from "@freebirdai/dash-components";
import { TRUST_WORDS, type InboundSettings, type RequesterRule, type ScreenRecord } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useState } from "react";
import { api, type InboundReadiness } from "../../api";
import { when } from "./TaskCard.jsx";

/**
 * Emails the inbound screen held: each with why, and Release (it goes on as
 * if it had just arrived), Block sender and Trust sender. Shown in "Waiting
 * for you" and in Communications. The message itself is read in Comms.
 */

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const HeldEmails = ({ compact = false, onChanged }: { compact?: boolean; onChanged?: () => void }): JSX.Element | null => {
  const [held, setHeld] = useState<ScreenRecord[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void api.inboundScreens("held").then(setHeld, () => setHeld([]));
  }, []);
  useEffect(load, [load]);

  if (!held || held.length === 0) return null;
  const act = (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    void work()
      .then(() => {
        load();
        onChanged?.();
      }, (cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(null));
  };
  return (
    <div className="dash-evals" data-testid="held-emails">
      <strong>
        Held emails <span className="dash-hint">{held.length}</span>
      </strong>
      {!compact && <span className="dash-hint">The inbound screen held these before any agent or workflow read them.</span>}
      <ul className="dash-proposals">
        {held.map((one) => (
          <li key={one.id} className="dash-task" data-testid={`held-${one.id}`}>
            <div className="dash-task__head">
              <strong className="dash-task__title">{one.from}</strong>
              <Badge tone={one.requester.trust === "blocked" ? "danger" : "warn"}>{TRUST_WORDS[one.requester.trust]}</Badge>
            </div>
            <span className="dash-hint">
              {when(one.at)} · {one.signals.map((signal) => signal.detail).join("; ") || "the sender is blocked"}
            </span>
            <div className="dash-row">
              <Button size="sm" tone="primary" busy={busy === one.id} onClick={() => act(one.id, () => api.releaseInbound(one.id))} testId={`held-release-${one.id}`}>
                Release
              </Button>
              <Button size="sm" busy={busy === one.id} onClick={() => act(one.id, () => api.trustInbound(one.id))} testId={`held-trust-${one.id}`}>
                Trust sender
              </Button>
              <Button size="sm" tone="ghost" busy={busy === one.id} onClick={() => act(one.id, () => api.blockInbound(one.id))} testId={`held-block-${one.id}`}>
                Block sender
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="dash-callout dash-callout--bad">{error}</p>}
    </div>
  );
};

/**
 * While the screen only watches: the emails it would have held, each to mark
 * "Good catch" or "This was fine", and whether it has earned holding by the
 * thresholds here. Dash suggests the switch; a person makes it.
 */
const ScreenReview = ({ settings, onSave }: { settings: InboundSettings; onSave: (next: InboundSettings) => void }): JSX.Element => {
  const [flags, setFlags] = useState<ScreenRecord[]>([]);
  const [readiness, setReadiness] = useState<InboundReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void Promise.all([api.inboundToReview(), api.inboundReadiness()]).then(
      ([listed, ready]) => {
        setFlags(listed);
        setReadiness(ready);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, []);
  useEffect(load, [load, settings.holdWhen]);
  const review = (id: string, verdict: "good_catch" | "fine") => void api.reviewInbound(id, verdict).then(load, (cause: unknown) => setError(errorText(cause)));
  const holdWhen = settings.holdWhen;
  const number = (key: keyof InboundSettings["holdWhen"], value: string, scale = 1) => onSave({ ...settings, holdWhen: { ...holdWhen, [key]: Math.max(0, Number(value) || 0) / scale } });
  return (
    <div data-testid="inbound-review">
      {readiness && (
        <p className={readiness.ready ? "dash-callout" : "dash-hint"} data-testid="inbound-readiness">
          {readiness.ready ? (
            <>
              The screen has earned holding: {readiness.screened} emails over {readiness.days} days, {readiness.falseFlags === null ? "no flags raised" : `${Math.round(readiness.falseFlags * 100)}% of its flags marked fine`}.{" "}
              <Button size="sm" tone="primary" onClick={() => onSave({ ...settings, observeOnly: false })} testId="inbound-start-holding">
                Start holding
              </Button>
            </>
          ) : (
            <>Before it holds anything: {readiness.blockers.join(" ")}</>
          )}
        </p>
      )}
      <label className="dash-hint">
        Suggest holding after{" "}
        <input className="dash-tool__when dash-workflow__tiny" type="number" min={1} aria-label="Emails screened" value={holdWhen.minScreened} onChange={(event) => number("minScreened", event.target.value)} /> emails, over{" "}
        <input className="dash-tool__when dash-workflow__tiny" type="number" min={1} aria-label="Days watched" value={holdWhen.minDays} onChange={(event) => number("minDays", event.target.value)} /> days, with at most{" "}
        <input
          className="dash-tool__when dash-workflow__tiny"
          type="number"
          min={0}
          max={100}
          aria-label="Flags marked fine, percent"
          value={Math.round(holdWhen.maxFalseFlags * 100)}
          onChange={(event) => number("maxFalseFlags", event.target.value, 100)}
        />
        % of flags marked fine
      </label>
      {flags.length > 0 && (
        <ul className="dash-proposals">
          {flags.map((one) => (
            <li key={one.id} className="dash-task" data-testid={`flag-${one.id}`}>
              <span>
                <strong>{one.from}</strong> <span className="dash-hint">{when(one.at)} · would have been held: {one.signals.filter((signal) => signal.hold).map((signal) => signal.detail).join("; ")}</span>
              </span>
              <div className="dash-row">
                <Button size="sm" onClick={() => review(one.id, "good_catch")} testId={`flag-good-${one.id}`}>
                  Good catch
                </Button>
                <Button size="sm" tone="ghost" onClick={() => review(one.id, "fine")} testId={`flag-fine-${one.id}`}>
                  This was fine
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="dash-callout dash-callout--bad">{error}</p>}
    </div>
  );
};

/** The screen's own settings: observe-only, the per-sender limits, what it has seen, and who is trusted or blocked. */
export const InboundScreenSettings = (): JSX.Element | null => {
  const [settings, setSettings] = useState<InboundSettings | null>(null);
  const [rules, setRules] = useState<RequesterRule[]>([]);
  const [summary, setSummary] = useState<{ screened: number; wouldHold: number; held: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void Promise.all([api.inboundSettings(), api.inboundRules(), api.inboundSummary()]).then(
      ([held, listed, seen]) => {
        setSettings(held);
        setRules(listed);
        setSummary(seen);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, []);
  useEffect(load, [load]);
  if (error) return <p className="dash-callout dash-callout--bad">{error}</p>;
  if (!settings) return null;
  const save = (next: InboundSettings) => void api.putInboundSettings(next).then(setSettings, (cause: unknown) => setError(errorText(cause)));
  return (
    <div className="dash-evals" data-testid="inbound-settings">
      <strong>Inbound screen</strong>
      <span className="dash-hint">Checks each new email before an agent or workflow reads it. Values an email chose never drive an outside step on Auto.</span>
      <label className="dash-reach__check">
        <input type="checkbox" checked={!settings.observeOnly} onChange={(event) => save({ ...settings, observeOnly: !event.target.checked })} data-testid="inbound-hold" /> Hold emails a rule flags (off:
        watch and count only)
      </label>
      <label className="dash-reach__check">
        <input type="checkbox" checked={settings.outsideAgents} onChange={(event) => save({ ...settings, outsideAgents: event.target.checked })} data-testid="inbound-outside-agents" /> Let outside agents book and
        write to the team over MCP, as a stranger may on your public booking pages
      </label>
      {settings.outsideAgents && (
        <span className="dash-hint" data-testid="inbound-mcp-address">
          Their address: {window.location.origin}/api/public/&lt;workspace&gt;/mcp. Each request names the person it is for, and goes through the limits and sender rules here.
        </span>
      )}
      {summary && (
        <span className="dash-hint" data-testid="inbound-summary">
          Last 7 days: {summary.screened} screened, {summary.wouldHold} a rule would hold, {summary.held} held.
        </span>
      )}
      {settings.observeOnly && <ScreenReview settings={settings} onSave={save} />}
      <label className="dash-hint">
        Emails a day from one sender{" "}
        <input
          className="dash-tool__when dash-workflow__tiny"
          type="number"
          min={1}
          value={settings.limits.messagesPerDay}
          onChange={(event) => save({ ...settings, limits: { ...settings.limits, messagesPerDay: Math.max(1, Number(event.target.value) || 1) } })}
        />{" "}
        from one domain{" "}
        <input
          className="dash-tool__when dash-workflow__tiny"
          type="number"
          min={1}
          value={settings.limits.domainMessagesPerDay}
          onChange={(event) => save({ ...settings, limits: { ...settings.limits, domainMessagesPerDay: Math.max(1, Number(event.target.value) || 1) } })}
        />
      </label>
      {rules.length > 0 && (
        <ul className="dash-evals__events">
          {rules.map((rule) => (
            <li key={rule.key}>
              {rule.key.replace(/^(address|domain):/, "")} · {TRUST_WORDS[rule.trust]}{" "}
              <Button size="sm" tone="ghost" onClick={() => void api.removeInboundRule(rule.key).then(load, (cause: unknown) => setError(errorText(cause)))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
