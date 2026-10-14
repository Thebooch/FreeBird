import { describeSchedule, WEEKDAY_NAMES, type AgentSpec, type DashboardSpec, type Report } from "@freebirdai/dash-spec";
import { Button, Field } from "@freebirdai/dash-components";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ReportEmailStatus, type ReportPreview, type ReportView } from "../api.js";
import { Segmented, Switch } from "../agent/calendar/controls.jsx";
import { formOf, includesLine, inputOf, type ReportForm, type ScheduleChoice } from "./form.js";

/**
 * Timed reports for the tab that is open, from the ⋯ menu beside Arrange.
 *
 * Two views in one sheet. The list: every report that draws from this tab or
 * its widgets, each with its schedule, who gets it, and when it next goes,
 * with Send now, Edit, pause and delete. The editor: a name, the whole tab or
 * some of its widgets (only this tab's are offered, to keep it short), how
 * often, who gets it, and a summary on top or not; with a preview of the
 * exact email before anything is saved.
 *
 * Without email set up on the server, reports can still be made and
 * previewed, and the sheet says why nothing is sent.
 */

type View = { readonly kind: "list" } | { readonly kind: "edit"; readonly report?: Report };

const when = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const zones = (current: string): string[] => {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  return [...new Set([current, "UTC", ...all])];
};

export const ReportsSheet = ({ dashboard, onClose }: { readonly dashboard: DashboardSpec; readonly onClose: () => void }): JSX.Element => {
  const [view, setView] = useState<View>({ kind: "list" });
  const [reports, setReports] = useState<ReportView[] | null>(null);
  const [email, setEmail] = useState<ReportEmailStatus | null>(null);
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const answer = await api.reports(dashboard.id);
      setReports(answer.reports);
      setEmail(answer.email);
    } catch (cause) {
      setError(message(cause));
    }
  }, [dashboard.id]);

  useEffect(() => {
    void load();
    api.agents().then(setAgents, () => setAgents([]));
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dash-sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="dash-sheet dash-reports"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reports-title"
        style={{ width: view.kind === "edit" ? "min(980px, 100%)" : "min(560px, 100%)" }}
        onClick={(event) => event.stopPropagation()}
        data-testid="reports-sheet"
      >
        <header className="dash-sheet__head">
          <div className="dash-sheet__trail">
            {view.kind === "edit" ? (
              <>
                <button type="button" className="dash-sheet__crumb" onClick={() => setView({ kind: "list" })}>
                  Reports
                </button>
                <span className="dash-sheet__crumb-sep">/</span>
                <span>{dashboard.title}</span>
              </>
            ) : (
              <span>{dashboard.title}</span>
            )}
          </div>
          <div className="dash-sheet__bar">
            <h2 id="reports-title" className="dash-sheet__title">
              {view.kind === "list" ? "Reports" : view.report ? `Edit ${view.report.name}` : "New report"}
            </h2>
            <Button tone="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>

        {view.kind === "list" ? (
          <ReportList
            dashboard={dashboard}
            reports={reports}
            email={email}
            agents={agents}
            error={error}
            notice={notice}
            onNew={() => {
              setNotice(null);
              setView({ kind: "edit" });
            }}
            onEdit={(report) => {
              setNotice(null);
              setView({ kind: "edit", report });
            }}
            onChanged={(line) => {
              setNotice(line);
              void load();
            }}
          />
        ) : (
          <ReportEditor
            dashboard={dashboard}
            {...(view.report ? { report: view.report } : {})}
            email={email}
            agents={agents}
            onCancel={() => setView({ kind: "list" })}
            onSaved={(line) => {
              setNotice(line);
              setView({ kind: "list" });
              void load();
            }}
          />
        )}
      </div>
    </div>
  );
};

/* ── the list ──────────────────────────────────────────────────────────── */

const EmailCallout = ({ email }: { readonly email: ReportEmailStatus | null }): JSX.Element | null =>
  email && !email.ready ? (
    <p className="dash-cal-sheet__callout" role="status" data-testid="reports-email-off">
      Reports can be made and previewed, but not sent yet. {email.reason}
    </p>
  ) : null;

const ReportList = ({
  dashboard,
  reports,
  email,
  agents,
  error,
  notice,
  onNew,
  onEdit,
  onChanged,
}: {
  readonly dashboard: DashboardSpec;
  readonly reports: ReportView[] | null;
  readonly email: ReportEmailStatus | null;
  readonly agents: readonly AgentSpec[];
  readonly error: string | null;
  readonly notice: string | null;
  readonly onNew: () => void;
  readonly onEdit: (report: Report) => void;
  readonly onChanged: (line: string | null) => void;
}): JSX.Element => {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const act = async (key: string, run: () => Promise<string | null>) => {
    setBusy(key);
    setProblem(null);
    try {
      onChanged(await run());
    } catch (cause) {
      setProblem(message(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="dash-sheet__body">
        <EmailCallout email={email} />
        {notice && (
          <p className="dash-reports__notice" role="status">
            {notice}
          </p>
        )}
        {(error ?? problem) && (
          <p className="dash-cal-form__error" role="alert">
            {error ?? problem}
          </p>
        )}
        {reports === null ? (
          <p className="dash-hint">Loading…</p>
        ) : reports.length === 0 ? (
          <div className="dash-reports__empty">
            <p>No reports for this tab yet.</p>
            <p className="dash-hint">Email the whole tab, or a few of its widgets, every day, week or month. Each one comes with a short written summary unless you turn it off.</p>
          </div>
        ) : (
          <ul className="dash-reports__list" data-testid="reports-list">
            {reports.map((report) => {
              const agent = agents.find((one) => one.id === report.agentId);
              const reach = report.recipients.filter((one) => !report.optedOut.includes(one)).length;
              return (
                <li key={report.id} className="dash-reports__item" data-enabled={report.enabled ? "true" : "false"}>
                  <div className="dash-reports__item-head">
                    <div className="dash-reports__item-title">
                      <span className="dash-reports__name">{report.name}</span>
                      <span className="dash-reports__meta">
                        {includesLine(report, dashboard)} · {describeSchedule(report.schedule)} · to {reach} {reach === 1 ? "person" : "people"}
                        {agent ? ` · from ${agent.name}` : ""}
                      </span>
                      <span className="dash-reports__meta">
                        {report.enabled ? (report.nextAt ? `Next: ${when(report.nextAt)}` : "Not scheduled") : "Paused"}
                        {report.lastSentAt ? ` · Last sent ${when(report.lastSentAt)}` : " · Not sent yet"}
                      </span>
                    </div>
                    <Switch
                      checked={report.enabled}
                      label={report.enabled ? "On" : "Paused"}
                      disabled={busy !== null}
                      onChange={(enabled) => void act(`toggle:${report.id}`, async () => (await api.updateReport(report.id, { enabled }), enabled ? `${report.name} is on.` : `${report.name} is paused.`))}
                    />
                  </div>
                  <div className="dash-reports__actions">
                    <Button
                      size="sm"
                      busy={busy === `send:${report.id}`}
                      disabled={busy !== null || email?.ready === false}
                      title={email?.ready === false ? "Email isn't set up on this server" : "Send it to everyone on it now"}
                      onClick={() =>
                        void act(`send:${report.id}`, async () => {
                          const sent = await api.sendReport(report.id);
                          if (sent.status === "failed") throw new Error(`${report.name} was not sent: ${sent.error ?? "nothing went out."}`);
                          return sent.status === "partial"
                            ? `${report.name} reached ${sent.recipients.length}; ${sent.failures.map((one) => `${one.to} (${one.error})`).join(", ")} could not be reached.`
                            : `${report.name} was sent to ${sent.recipients.length} ${sent.recipients.length === 1 ? "person" : "people"}.`;
                        })
                      }
                      testId={`report-send-${report.id}`}
                    >
                      Send now
                    </Button>
                    <Button size="sm" disabled={busy !== null} onClick={() => onEdit(report)} testId={`report-edit-${report.id}`}>
                      Edit
                    </Button>
                    {confirming === report.id ? (
                      <Button size="sm" tone="danger" busy={busy === `delete:${report.id}`} onClick={() => void act(`delete:${report.id}`, async () => (await api.removeReport(report.id), `${report.name} was deleted.`)).then(() => setConfirming(null))}>
                        Delete it?
                      </Button>
                    ) : (
                      <Button size="sm" tone="ghost" disabled={busy !== null} onClick={() => setConfirming(report.id)}>
                        Delete
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <footer className="dash-cal-sheet__foot">
        <span className="dash-hint">Reports on this tab and its widgets.</span>
        <Button tone="primary" onClick={onNew} testId="report-new">
          New report
        </Button>
      </footer>
    </>
  );
};

/* ── the editor ────────────────────────────────────────────────────────── */

const SCHEDULES: ReadonlyArray<{ readonly value: ScheduleChoice; readonly label: string }> = [
  { value: "day", label: "Daily" },
  { value: "weekday", label: "Weekdays" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

const ReportEditor = ({
  dashboard,
  report,
  email,
  agents,
  onCancel,
  onSaved,
}: {
  readonly dashboard: DashboardSpec;
  readonly report?: Report;
  readonly email: ReportEmailStatus | null;
  readonly agents: readonly AgentSpec[];
  readonly onCancel: () => void;
  readonly onSaved: (line: string) => void;
}): JSX.Element => {
  const [form, setForm] = useState<ReportForm>(() => formOf(dashboard, report));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"save" | "send" | null>(null);
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const set = <K extends keyof ReportForm>(key: K, value: ReportForm[K]) => setForm((previous) => ({ ...previous, [key]: value }));
  const zoneList = useMemo(() => zones(form.timezone), [form.timezone]);
  const optedOut = report?.optedOut ?? [];

  const showPreview = async () => {
    const result = inputOf(form, dashboard);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setPreviewing(true);
    try {
      setPreview(await api.previewReport({ ...result.input, ...(report ? { id: report.id } : {}) }));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPreviewing(false);
    }
  };

  const save = async (andSend: boolean) => {
    const result = inputOf(form, dashboard);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setSaving(andSend ? "send" : "save");
    try {
      const saved = report ? await api.updateReport(report.id, result.input) : await api.createReport(result.input);
      if (!andSend) {
        onSaved(`${saved.name} is saved. ${describeSchedule(saved.schedule)}.`);
        return;
      }
      const sent = await api.sendReport(saved.id);
      onSaved(sent.status === "failed" ? `${saved.name} is saved, but was not sent: ${sent.error ?? "nothing went out."}` : `${saved.name} is saved and was sent to ${sent.recipients.length} ${sent.recipients.length === 1 ? "person" : "people"}.`);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <div className="dash-sheet__body dash-reports__editor">
        <form
          className="dash-cal-form dash-reports__form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(false);
          }}
          data-testid="report-form"
        >
          <EmailCallout email={email} />
          <Field label="Name">
            {(id) => <input id={id} value={form.name} maxLength={120} onChange={(event) => set("name", event.target.value)} data-testid="report-name" />}
          </Field>

          <div className="dash-cal-form__group">
            <span className="dash-cal-form__label">What it sends</span>
            <Segmented
              label="What it sends"
              value={form.include}
              options={[
                { value: "tab", label: "Whole tab", hint: `Every widget on ${dashboard.title}` },
                { value: "widgets", label: "Pick widgets", hint: "Only the ones you tick" },
              ]}
              onChange={(include) => set("include", include)}
              testId="report-include"
            />
          </div>
          <Switch
            checked={form.summary}
            onChange={(summary) => set("summary", summary)}
            label="Write summaries"
            hint={form.include === "tab" ? "One summary of the tab, then a chart or list for each widget." : "A short summary for each widget, each followed by its chart or list."}
            testId="report-summary"
          />
          {form.include === "tab" && form.summary && (
            <Field label="Emphasize" hint="Optional. What the reader cares about most; the summary answers it first.">
              {(id) => (
                <textarea
                  id={id}
                  className="dash-reports__emphasis"
                  value={form.tabEmphasis}
                  maxLength={500}
                  placeholder="Did any work order sit open more than a week?"
                  onChange={(event) => set("tabEmphasis", event.target.value)}
                  data-testid="report-emphasis"
                />
              )}
            </Field>
          )}
          {form.include === "widgets" && (
            <fieldset className="dash-reports__widgets" data-testid="report-widgets">
              <legend className="dash-cal-form__label">Widgets on {dashboard.title}</legend>
              {dashboard.widgets.length === 0 && <p className="dash-hint">This tab has no widgets yet.</p>}
              {dashboard.widgets.map((widget) => {
                const picked = form.widgets.includes(widget.id);
                return (
                  <div key={widget.id} className="dash-reports__widget" data-picked={picked ? "true" : "false"}>
                    <label className="dash-reports__check">
                      <input
                        type="checkbox"
                        checked={picked}
                        onChange={(event) => set("widgets", event.target.checked ? [...form.widgets, widget.id] : form.widgets.filter((one) => one !== widget.id))}
                      />
                      <span>{widget.title}</span>
                    </label>
                    {picked && form.summary && (
                      <input
                        className="dash-reports__emphasis-line"
                        aria-label={`Emphasize for ${widget.title}`}
                        value={form.widgetEmphasis[widget.id] ?? ""}
                        maxLength={500}
                        placeholder="Emphasize (optional): did issue X come up?"
                        onChange={(event) => set("widgetEmphasis", { ...form.widgetEmphasis, [widget.id]: event.target.value })}
                      />
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}
          {form.kept.length > 0 && (
            <p className="dash-hint">
              It also sends {form.kept.length} {form.kept.length === 1 ? "piece" : "pieces"} from elsewhere, which stay as they are.
            </p>
          )}

          <div className="dash-cal-form__group">
            <span className="dash-cal-form__label">How often</span>
            <Segmented
              label="How often"
              value={form.every}
              options={form.every === "custom" ? [...SCHEDULES, { value: "custom", label: "Custom" }] : SCHEDULES}
              onChange={(every) => set("every", every)}
              testId="report-every"
            />
          </div>
          {form.every === "custom" ? (
            <Field label="Schedule" hint="A cron expression, read in the time zone below.">
              {(id) => <input id={id} value={form.cron} onChange={(event) => set("cron", event.target.value)} />}
            </Field>
          ) : (
            <div className="dash-cal-form__row">
              {form.every === "week" && (
                <Field label="Day">
                  {(id) => (
                    <select id={id} value={form.weekday} onChange={(event) => set("weekday", Number(event.target.value))}>
                      {WEEKDAY_NAMES.map((name, index) => (
                        <option key={name} value={index}>
                          {name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              {form.every === "month" && (
                <Field label="Day of the month">
                  {(id) => (
                    <select id={id} value={form.monthDay} onChange={(event) => set("monthDay", Number(event.target.value))}>
                      {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              <Field label="At">
                {(id) => <input id={id} type="time" value={form.time} required onChange={(event) => set("time", event.target.value)} data-testid="report-time" />}
              </Field>
            </div>
          )}
          <Field label="Time zone">
            {(id) => (
              <select id={id} value={form.timezone} onChange={(event) => set("timezone", event.target.value)}>
                {zoneList.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Send to" hint="Email addresses, separated by commas or new lines.">
            {(id) => (
              <textarea
                id={id}
                value={form.recipients}
                placeholder="pat@example.com, lee@example.com"
                onChange={(event) => set("recipients", event.target.value)}
                data-testid="report-recipients"
              />
            )}
          </Field>
          {optedOut.length > 0 && <p className="dash-hint">Unsubscribed, so never sent to: {optedOut.join(", ")}.</p>}

          <Field label="From" hint="Optional. An agent's name and colour on the email, and its voice in the summary.">
            {(id) => (
              <select id={id} value={form.agentId} onChange={(event) => set("agentId", event.target.value)}>
                <option value="">The workspace</option>
                {agents
                  .filter((agent) => !agent.archived || agent.id === form.agentId)
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>
          <Switch checked={form.enabled} onChange={(enabled) => set("enabled", enabled)} label="Send on its schedule" hint="Off keeps it, paused. Send now still works." />

          {error && (
            <p className="dash-cal-form__error" role="alert">
              {error}
            </p>
          )}
        </form>

        <section className="dash-reports__preview" aria-label="Preview" data-testid="report-preview">
          <div className="dash-reports__preview-head">
            <span className="dash-cal-form__label">{preview ? preview.subject : "Preview"}</span>
            <Button size="sm" busy={previewing} onClick={() => void showPreview()} testId="report-preview-button">
              {preview ? "Refresh" : "Show preview"}
            </Button>
          </div>
          {preview ? (
            <>
              {preview.warnings.length > 0 && (
                <ul className="dash-reports__warnings">
                  {preview.warnings.map((one) => (
                    <li key={one}>{one}</li>
                  ))}
                </ul>
              )}
              <iframe className="dash-reports__frame" title="The email" sandbox="" srcDoc={preview.html} />
            </>
          ) : (
            <p className="dash-hint">See the exact email, read from the widgets as they are now. Nothing is sent.</p>
          )}
        </section>
      </div>
      <footer className="dash-cal-sheet__foot">
        <Button tone="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <div className="dash-cal-sheet__foot-group">
          <Button busy={saving === "send"} disabled={saving !== null || email?.ready === false} onClick={() => void save(true)} testId="report-save-send">
            Save and send now
          </Button>
          <Button tone="primary" busy={saving === "save"} disabled={saving !== null} onClick={() => void save(false)} testId="report-save">
            {report ? "Save changes" : "Save report"}
          </Button>
        </div>
      </footer>
    </>
  );
};
