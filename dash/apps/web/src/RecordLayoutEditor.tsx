import { Button, Checkbox, Field, Toolbar } from "@freebirdai/dash-components";
import type { DashboardSpec, EntityPageView, RecordOverride } from "@freebirdai/dash-spec";
import { useState } from "react";
import { api } from "./api.js";

/**
 * Rearranging a record's page.
 *
 * The scope switch is the whole point, and it is the same one the look editor
 * has. A record page is built in layers — what the code guesses, what the
 * record type says, and what one widget wanted differently — and the useful
 * question is never "change this page" but *which of those* to change:
 *
 * - **Everywhere** writes the record type's own layout, so every route into a
 *   record arrives at the same page and every widget inherits the improvement.
 *   This is the one to reach for almost always.
 * - **Only from this widget's rows** writes just the difference against the
 *   widget whose row opened the page, and is offered only when a row did open
 *   it. A link from another record carries no origin and always opens the
 *   plain page, which is what makes a linked record the same page for
 *   everybody who reaches it.
 *
 * Only the difference is stored either way. A widget that keeps a whole copy
 * of a layout freezes it as it was the day it was written — which is what
 * per-widget drill-downs did, and why every improvement to a record view had
 * to be made again for every widget that opened one.
 */
export type LayoutScope = "everywhere" | "widget";

const MAX_FACTS = 4;

export const RecordLayoutEditor = ({
  page,
  connection,
  dashboard,
  widgetId,
  onSaveDashboard,
  onChanged,
  onClose,
}: {
  readonly page: EntityPageView;
  readonly connection: string;
  readonly dashboard: DashboardSpec;
  /** The widget whose row opened this page, when one did. */
  readonly widgetId?: string | undefined;
  readonly onSaveDashboard: (next: DashboardSpec) => Promise<void>;
  readonly onChanged: () => void;
  readonly onClose: () => void;
}): JSX.Element => {
  const widget = widgetId ? dashboard.widgets.find((one) => one.id === widgetId) : undefined;
  const stored: RecordOverride | undefined = widget?.record;

  const [scope, setScope] = useState<LayoutScope>(widget ? "widget" : "everywhere");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * What each scope starts from, which is not the same thing.
   *
   * The widget scope starts from what that widget stored *over* the shared
   * page; everywhere starts from the shared page itself. Reading one and
   * writing the other is how an editor quietly copies a whole layout into a
   * widget that only wanted one thing changed.
   */
  const startingAt = (
    at: LayoutScope,
  ): {
    facts: readonly string[];
    hidden: readonly string[];
    sections: readonly string[];
    assigned: Readonly<Record<string, string>>;
  } => ({
    facts: at === "widget" ? (stored?.facts ?? page.facts) : page.facts,
    hidden: at === "widget" ? (stored?.hide ?? []) : [],
    sections: at === "widget" ? (stored?.sections ?? page.sections.map((one) => one.id)) : [],
    /** Which heading each field currently sits under. */
    assigned: Object.fromEntries(
      page.groups.flatMap((group) => group.fields.map((path) => [path, group.title])),
    ),
  });

  const start = startingAt(widget ? "widget" : "everywhere");

  const [facts, setFacts] = useState<readonly string[]>(start.facts);
  const [hidden, setHidden] = useState<readonly string[]>(start.hidden);
  const [sections, setSections] = useState<readonly string[]>(start.sections);
  const [assigned, setAssigned] = useState<Readonly<Record<string, string>>>(start.assigned);
  /** Whether anybody actually moved a field, which decides whether to store. */
  const [regrouped, setRegrouped] = useState(false);
  const [newGroup, setNewGroup] = useState("");

  const shownFields = page.fields.filter((field) => !hidden.includes(field.path));
  const full = facts.length >= MAX_FACTS;

  /** Every group a field could be put in: the ones that exist, plus any added. */
  const titles = new Set([...page.groups.map((group) => group.title), ...Object.values(assigned)]);
  titles.delete("");

  const assign = (path: string, title: string): void => {
    setRegrouped(true);
    setAssigned((previous) => ({ ...previous, [path]: title }));
  };

  const move = (id: string, by: number): void =>
    setSections((previous) => {
      const at = previous.indexOf(id);
      const to = at + by;
      if (at < 0 || to < 0 || to >= previous.length) return previous;
      const next = [...previous];
      const [held] = next.splice(at, 1);
      next.splice(to, 0, held!);
      return next;
    });

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (scope === "everywhere") {
        /*
         * Nothing regrouped means nothing stored, which is the difference
         * between an override and a copy. The page falls back to grouping by
         * what the describing pass recorded, so writing that fallback back as
         * an explicit list would freeze the grouping as it is today — and a
         * later re-description that adds a field would leave it out of every
         * group forever.
         */
        const groups = regrouped
          ? [...titles]
              .map((title) => ({
                title,
                fields: page.fields
                  .filter((field) => (assigned[field.path] ?? "") === title)
                  .map((field) => field.path),
              }))
              .filter((group) => group.fields.length > 0)
          : [];
        await api.putRecordLayout(connection, page.entity, { facts: [...facts], groups });
      } else if (widget) {
        // Only what differs, and nothing where nothing differs — an override
        // of empty arrays would read as "show no facts" rather than "inherit".
        const override: RecordOverride = {
          ...(facts.length > 0 ? { facts: [...facts] } : {}),
          ...(hidden.length > 0 ? { hide: [...hidden] } : {}),
          ...(sections.length > 0 ? { sections: [...sections] } : {}),
        };
        await onSaveDashboard({
          ...dashboard,
          widgets: dashboard.widgets.map((one) =>
            one.id === widget.id ? { ...one, record: override } : one,
          ),
        });
      }
      onChanged();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const one = page.name.one.toLowerCase();

  return (
    <div
      className="dash-inspector-backdrop"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="dash-inspector"
        role="dialog"
        aria-modal="true"
        aria-label={`Layout of a ${page.name.one}`}
      >
        <div className="dash-inspector__head">
          <h3 className="dash-inspector__title">Layout of a {one}</h3>
          <button
            className="dash-iconbtn"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="dash-inspector__body">
          {error && <div className="dash-callout dash-callout--bad">{error}</div>}

          <Field label="Change it">
            {(id) => (
              <select
                id={id}
                className="dash-control"
                value={scope}
                onChange={(event) => {
                  const next = event.target.value as LayoutScope;
                  setScope(next);
                  /*
                   * Each scope edits a different layer, and they start from
                   * different places — so ticks made against one would be a
                   * lie against the other.
                   */
                  const from = startingAt(next);
                  setFacts(from.facts);
                  setHidden(from.hidden);
                  setSections(from.sections);
                  setAssigned(from.assigned);
                  setRegrouped(false);
                }}
                data-testid="layout-scope"
              >
                <option value="everywhere">Everywhere a {one} is opened</option>
                {widget && <option value="widget">Only from this widget&rsquo;s rows</option>}
              </select>
            )}
          </Field>

          <p className="dash-hint">
            {scope === "everywhere"
              ? `Every way into a ${one} — a link from another record, a shared address, any widget's row — opens this same page.`
              : `Only this widget's rows open this version. A link to the same ${one} from anywhere else opens the shared page.`}
          </p>

          <section className="dash-sheet__section">
            <h4 className="dash-sheet__sub">Facts at the top</h4>
            <p className="dash-hint">
              Up to {MAX_FACTS}, shown beside the name. {facts.length} chosen.
            </p>
            {shownFields.map((field) => (
              <Checkbox
                key={field.path}
                label={field.label}
                {...(field.description ? { meta: field.description } : {})}
                checked={facts.includes(field.path)}
                disabled={full && !facts.includes(field.path)}
                onChange={(on) =>
                  setFacts((previous) =>
                    on
                      ? [...previous, field.path].slice(0, MAX_FACTS)
                      : previous.filter((path) => path !== field.path),
                  )
                }
                testId={`fact-${field.path}`}
              />
            ))}
          </section>

          {scope === "everywhere" && (
            <section className="dash-sheet__section" data-testid="layout-groups">
              <h4 className="dash-sheet__sub">Grouped under</h4>
              <p className="dash-hint">
                The headings the fields are gathered under, further down the page. Left alone, they
                follow whatever the describing pass recorded — so a field added later joins its
                group on its own.
              </p>
              {page.fields.map((field) => (
                <Field key={field.path} label={field.label}>
                  {(id) => (
                    <select
                      id={id}
                      className="dash-control"
                      value={assigned[field.path] ?? ""}
                      onChange={(event) => assign(field.path, event.target.value)}
                      data-testid={`group-${field.path}`}
                    >
                      <option value="">No heading</option>
                      {[...titles].map((title) => (
                        <option key={title} value={title}>
                          {title}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ))}
              <Field label="Add a heading">
                {(id) => (
                  <div className="dash-row">
                    <input
                      id={id}
                      type="text"
                      className="dash-control"
                      value={newGroup}
                      placeholder="Contact"
                      onChange={(event) => setNewGroup(event.target.value)}
                      data-testid="layout-new-group"
                    />
                    <Button
                      disabled={newGroup.trim() === "" || titles.has(newGroup.trim())}
                      onClick={() => {
                        /*
                         * A heading exists only once a field is under it —
                         * there is no such thing as an empty group on a page,
                         * and storing one would render a heading with nothing
                         * beneath it.
                         */
                        const first = page.fields.find((field) => !assigned[field.path]);
                        if (first) assign(first.path, newGroup.trim());
                        setNewGroup("");
                      }}
                    >
                      Add
                    </Button>
                  </div>
                )}
              </Field>
            </section>
          )}

          {scope === "widget" && (
          <section className="dash-sheet__section">
            <h4 className="dash-sheet__sub">Leave off</h4>
            <p className="dash-hint">
              Fields this widget&rsquo;s version of the page leaves out. The shared page still shows
              them, and so do the records themselves.
            </p>
            {page.fields.map((field) => (
              <Checkbox
                key={field.path}
                label={field.label}
                checked={hidden.includes(field.path)}
                onChange={(on) => {
                  setHidden((previous) =>
                    on
                      ? [...previous, field.path]
                      : previous.filter((path) => path !== field.path),
                  );
                  /*
                   * A field that is off cannot also be a fact at the top: the
                   * pane would bind a column the pipeline no longer selects,
                   * and that renders as "this view no longer matches its
                   * data" — a defect here, blamed on the reader's data.
                   */
                  if (on) setFacts((chosen) => chosen.filter((path) => path !== field.path));
                }}
                testId={`hide-${field.path}`}
              />
            ))}
          </section>
          )}

          {scope === "widget" && page.sections.length > 0 && (
            <section className="dash-sheet__section" data-testid="layout-sections">
              <h4 className="dash-sheet__sub">Related collections</h4>
              <p className="dash-hint">Which of them appear below the record, and in what order.</p>
              {page.sections.map((section) => {
                const at = sections.indexOf(section.id);
                return (
                  <div className="dash-row" key={section.id}>
                    <Checkbox
                      label={section.title}
                      meta={
                        section.cost === "partial"
                          ? "Read by a capped scan, so it may be incomplete"
                          : "One filtered request"
                      }
                      checked={at >= 0}
                      onChange={(on) =>
                        setSections((previous) =>
                          on
                            ? [...previous, section.id]
                            : previous.filter((id) => id !== section.id),
                        )
                      }
                      testId={`section-${section.id}`}
                    />
                    {at >= 0 && (
                      <>
                        <button
                          className="dash-iconbtn"
                          aria-label={`Move ${section.title} up`}
                          disabled={at === 0}
                          onClick={() => move(section.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          className="dash-iconbtn"
                          aria-label={`Move ${section.title} down`}
                          disabled={at === sections.length - 1}
                          onClick={() => move(section.id, 1)}
                        >
                          ↓
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </section>
          )}
        </div>

        <Toolbar>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            busy={busy}
            onClick={() => void save()}
            testId="layout-save"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </Toolbar>
      </div>
    </div>
  );
};
