import type { CalendarEvent } from "@freebirdai/dash-spec";
import { Button, Field } from "@freebirdai/dash-components";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api.js";
import { Segmented, Switch } from "./controls.jsx";
import { inputOf, type EntryForm } from "./form.js";

/**
 * Add an entry, or change one, in a sheet beside the calendar.
 *
 * Dates and times are the reader's own; the form turns them into instants
 * (`form.ts`). A whole-day entry can run over several days; a deadline is a
 * moment and has no end. Saving a workflow's entry pins it, which the entry's
 * own sheet has already said.
 */
export const EntryFormSheet = ({
  initial,
  editing,
  owners,
  onClose,
  onSaved,
}: {
  readonly initial: EntryForm;
  /** The entry being changed; absent for a new one. */
  readonly editing?: CalendarEvent;
  readonly owners: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onClose: () => void;
  readonly onSaved: (entry: CalendarEvent) => void;
}): JSX.Element => {
  const [form, setForm] = useState<EntryForm>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof EntryForm>(key: K, value: EntryForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    const result = inputOf(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(editing ? await api.updateCalendarEntry(editing.id, result.input) : await api.addCalendarEntry(result.input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dash-sheet-backdrop" onClick={onClose} role="presentation">
      <form
        className="dash-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-form-title"
        style={{ width: "min(520px, 100%)" }}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        data-testid="calendar-entry-form"
      >
        <header className="dash-sheet__head">
          <div className="dash-sheet__trail">Calendar</div>
          <div className="dash-sheet__bar">
            <h2 id="calendar-form-title" className="dash-sheet__title">
              {editing ? "Edit entry" : "New entry"}
            </h2>
            <Button tone="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>
        <div className="dash-sheet__body">
          <div className="dash-cal-form">
            <Field label="Title">
              {(id) => (
                <input
                  id={id}
                  ref={titleRef}
                  value={form.title}
                  maxLength={200}
                  placeholder="Walkthrough at Maple Court"
                  onChange={(event) => set("title", event.target.value)}
                  data-testid="calendar-form-title"
                />
              )}
            </Field>
            <div className="dash-cal-form__inline">
              <div className="dash-cal-form__group">
                <span className="dash-cal-form__label" id="calendar-form-type">
                  Type
                </span>
                <Segmented
                  label="Type"
                  value={form.kind}
                  options={[
                    { value: "event", label: "Event", hint: "Something that takes time" },
                    { value: "deadline", label: "Deadline", hint: "A moment something is due" },
                  ]}
                  onChange={(kind) => set("kind", kind)}
                />
              </div>
              <Switch checked={form.allDay} onChange={(allDay) => set("allDay", allDay)} label="All day" testId="calendar-form-allday" />
            </div>
            <div className="dash-cal-form__row">
              <Field label={form.allDay ? "First day" : "Date"}>
                {(id) => <input id={id} type="date" value={form.date} required onChange={(event) => set("date", event.target.value)} data-testid="calendar-form-date" />}
              </Field>
              {form.allDay ? (
                form.kind === "event" && (
                  <Field label="Last day" hint="Leave empty for one day.">
                    {(id) => <input id={id} type="date" value={form.endDate} min={form.date} onChange={(event) => set("endDate", event.target.value)} />}
                  </Field>
                )
              ) : (
                <>
                  <Field label={form.kind === "deadline" ? "Due at" : "Starts"}>
                    {(id) => <input id={id} type="time" value={form.start} required onChange={(event) => set("start", event.target.value)} data-testid="calendar-form-start" />}
                  </Field>
                  {form.kind === "event" && (
                    <Field label="Ends">
                      {(id) => <input id={id} type="time" value={form.end} required onChange={(event) => set("end", event.target.value)} data-testid="calendar-form-end" />}
                    </Field>
                  )}
                </>
              )}
            </div>
            <Field label="Owner" hint="Whose calendar it goes on. An agent's entries wear its colour.">
              {(id) => (
                <select id={id} value={form.owner} onChange={(event) => set("owner", event.target.value)}>
                  {owners.map((owner) => (
                    <option key={owner.value} value={owner.value}>
                      {owner.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Notes">
              {(id) => <textarea id={id} value={form.notes} maxLength={4000} placeholder="Anything the team should know" onChange={(event) => set("notes", event.target.value)} />}
            </Field>
            {error && (
              <p className="dash-cal-form__error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
        <footer className="dash-cal-sheet__foot">
          <span className="dash-hint">{editing?.workflow ? "Saving pins this entry." : ""}</span>
          <div className="dash-cal-sheet__foot-group">
            <Button tone="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button tone="primary" type="submit" busy={saving} testId="calendar-form-save">
              {editing ? "Save changes" : "Add entry"}
            </Button>
          </div>
        </footer>
      </form>
    </div>
  );
};
