import { ROLE_PERMISSIONS, type AgentSpec, type Block, type CalendarEvent, type Principal, type SchedulingProfile, type WorkflowSpec } from "@freebirdai/dash-spec";
import { Button, ErrorState } from "@freebirdai/dash-components";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type HostOccurrence } from "../../api.js";
import { isTypingTarget } from "../../editing.js";
import type { Route } from "../../route.js";
import { AgendaView } from "./AgendaView.jsx";
import { CalendarLegend } from "./CalendarLegend.jsx";
import { ChevronLeft, ChevronRight, Segmented } from "./controls.jsx";
import { EntryFormSheet } from "./EntryFormSheet.jsx";
import { BookingSheet } from "./BookingSheet.jsx";
import { EntrySheet } from "./EntrySheet.jsx";
import { blankForm, formOf, type EntryForm } from "./form.js";
import { MonthView } from "./MonthView.jsx";
import {
  CALENDAR_VIEWS,
  DEFAULT_FILTER,
  VIEW_LABELS,
  byDay,
  dayKey,
  keepEntry,
  legendOf,
  ownerOf,
  periodLabel,
  startOfDay,
  stepAnchor,
  viewRange,
  type CalendarFilter,
  type CalendarView,
  type Person,
} from "./model.js";
import { WeekView } from "./WeekView.jsx";

const VIEW_KEY = "dash.calendar.view";
const REFRESH_MS = 60_000;

/** The view last used here; the agenda on a narrow screen the first time. Storage may be refused: then the default. */
const storedView = (): CalendarView => {
  try {
    const held = window.localStorage.getItem(VIEW_KEY);
    if (held && (CALENDAR_VIEWS as readonly string[]).includes(held)) return held as CalendarView;
  } catch {
    /* Private mode, or storage switched off. */
  }
  return typeof window !== "undefined" && window.innerWidth < 720 ? "agenda" : "month";
};

const keepView = (view: CalendarView): void => {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* Not kept; the next visit starts on the default. */
  }
};

/**
 * The calendar itself: the toolbar, the month, week or agenda, the legend
 * that filters it, and the sheets that open an entry or add one.
 *
 * Reads only the period in view, again every minute while open, so an entry
 * a workflow puts on the calendar appears without a reload. Keys: T for
 * today, M / W / A for the views, ← and → to step, N for a new entry.
 */
export const CalendarBoard = ({
  onNavigate,
  people = new Map(),
  hosts = [],
  blocks = [],
}: {
  readonly onNavigate: (route: Route) => void;
  /** Members' names and colours, where the scheduling profiles know them. */
  readonly people?: ReadonlyMap<string, Person>;
  /** The people whose blocks the week view can show. */
  readonly hosts?: readonly SchedulingProfile[];
  readonly blocks?: readonly Block[];
}): JSX.Element => {
  const [view, setViewState] = useState<CalendarView>(storedView);
  const [anchor, setAnchor] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [entries, setEntries] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSpec[]>([]);
  const [me, setMe] = useState<Principal | null>(null);
  const [filter, setFilter] = useState<CalendarFilter>(DEFAULT_FILTER);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ readonly form: EntryForm; readonly entry?: CalendarEvent } | null>(null);
  const [token, setToken] = useState(0);
  const [bandsFor, setBandsFor] = useState<string>("");
  const [occurrences, setOccurrences] = useState<HostOccurrence[]>([]);

  const setView = useCallback((next: CalendarView) => {
    setViewState(next);
    keepView(next);
  }, []);

  /* Who is who, once. */
  useEffect(() => {
    void api.agents(true).then(setAgents, () => undefined);
    void api.workflows().then(setWorkflows, () => undefined);
    void api.me().then((who) => setMe(who.principal), () => undefined);
  }, []);

  /* The period in view, and again every minute. */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .calendar(viewRange(view, anchor))
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setError(null);
      })
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => !cancelled && setLoading(false));
    const timer = setTimeout(() => {
      setNow(Date.now());
      setToken((n) => n + 1);
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view, anchor, token]);

  /* Whose blocks the week shows: yours when you take bookings, else the first person who does. */
  useEffect(() => {
    if (bandsFor || hosts.length === 0) return;
    setBandsFor(hosts.find((one) => one.member === me?.userId)?.member ?? hosts[0]!.member);
  }, [hosts, me, bandsFor]);

  /* The week's block occurrences, for the bands behind it. */
  useEffect(() => {
    if (view !== "week" || !bandsFor) {
      setOccurrences([]);
      return;
    }
    let cancelled = false;
    const range = viewRange(view, anchor);
    void api.occurrences(range.from, range.to).then((list) => !cancelled && setOccurrences(list), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [view, anchor, bandsFor, token]);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const workflowById = useMemo(() => new Map(workflows.map((workflow) => [workflow.id, workflow])), [workflows]);
  const owner = useCallback((entry: CalendarEvent) => ownerOf(entry, agentById, people, me?.userId), [agentById, people, me]);
  const visible = useMemo(() => entries.filter((entry) => keepEntry(entry, filter)), [entries, filter]);
  const legend = useMemo(() => legendOf(entries, owner), [entries, owner]);
  const canManage = me ? ROLE_PERMISSIONS[me.role].includes("calendar.manage") : false;
  const mine = me ? `member:${me.userId}` : "";

  const stats = useMemo(() => {
    const today = byDay(visible, [startOfDay(now)]).get(dayKey(now)) ?? [];
    return {
      entries: visible.length,
      deadlines: visible.filter((entry) => entry.kind === "deadline" && entry.status === "open").length,
      tentative: visible.filter((entry) => entry.status === "tentative").length,
      today: today.length,
    };
  }, [visible, now]);

  const ownerOptions = useMemo(
    () => [
      ...(me ? [{ value: mine, label: people.get(me.userId)?.name ? `${people.get(me.userId)!.name} (you)` : "Me" }] : []),
      ...[...people.entries()].filter(([id]) => id !== me?.userId).map(([id, person]) => ({ value: `member:${id}`, label: person.name })),
      ...agents.filter((agent) => !agent.archived).map((agent) => ({ value: `agent:${agent.id}`, label: `${agent.name} (agent)` })),
    ],
    [agents, me, mine, people],
  );

  const open = openId ? (entries.find((entry) => entry.id === openId) ?? null) : null;
  const startNew = useCallback((at: number, whole = false) => setEditing({ form: blankForm(at, mine, whole) }), [mine]);

  /* Keys, when nothing is being typed and no sheet is open. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || openId || editing) return;
      const key = event.key.toLowerCase();
      if (key === "t") setAnchor(Date.now());
      else if (key === "m") setView("month");
      else if (key === "w") setView("week");
      else if (key === "a") setView("agenda");
      else if (event.key === "ArrowLeft") setAnchor((at) => stepAnchor(view, at, -1));
      else if (event.key === "ArrowRight") setAnchor((at) => stepAnchor(view, at, 1));
      else if (key === "n" && canManage) startNew(Date.now());
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view, openId, editing, canManage, startNew, setView]);

  const replace = (next: CalendarEvent) => setEntries((list) => (list.some((one) => one.id === next.id) ? list.map((one) => (one.id === next.id ? next : one)) : [...list, next]));

  const sourceOf = (entry: CalendarEvent): string =>
    entry.workflow
      ? `Workflow · ${workflowById.get(entry.workflow)?.name ?? "removed"}${entry.pinned ? " · pinned" : ""}`
      : entry.booking
        ? "Booking"
        : entry.createdBy
          ? entry.createdBy === me?.userId
            ? "Added by you"
            : `Added by ${people.get(entry.createdBy)?.name ?? entry.createdBy}`
          : "Calendar";

  const period = periodLabel(view, anchor);
  const stepLabel = view === "month" ? "month" : view === "week" ? "week" : "30 days";

  return (
    <div className="dash-cal" data-testid="calendar-board">
      <div className="dash-cal__main">
        <div className="dash-cal__toolbar">
          <div className="dash-cal__nav">
            <Button size="sm" onClick={() => setAnchor(Date.now())} title="Today (T)">
              Today
            </Button>
            <div className="dash-cal__steppers">
              <button type="button" className="dash-cal__step" onClick={() => setAnchor((at) => stepAnchor(view, at, -1))} aria-label={`Previous ${stepLabel}`} title={`Previous ${stepLabel} (←)`}>
                <ChevronLeft />
              </button>
              <button type="button" className="dash-cal__step" onClick={() => setAnchor((at) => stepAnchor(view, at, 1))} aria-label={`Next ${stepLabel}`} title={`Next ${stepLabel} (→)`}>
                <ChevronRight />
              </button>
            </div>
            <h2 className="dash-cal__period" aria-live="polite" data-testid="calendar-period">
              {period}
            </h2>
            {loading && <span className="dash-cal__sync" role="status" aria-label="Loading" />}
          </div>
          <div className="dash-cal__actions">
            <Segmented label="View" value={view} options={CALENDAR_VIEWS.map((value) => ({ value, label: VIEW_LABELS[value], hint: `${VIEW_LABELS[value]} (${value[0]!.toUpperCase()})` }))} onChange={setView} testId="calendar-view" />
            {canManage && (
              <Button tone="primary" onClick={() => startNew(Date.now())} title="New entry (N)" testId="calendar-new">
                New entry
              </Button>
            )}
          </div>
        </div>
        {error && entries.length === 0 ? (
          <ErrorState message={error} onRetry={() => setToken((n) => n + 1)} />
        ) : (
          <>
            {error && <p className="dash-cal-form__error dash-cal__notice">{error}</p>}
            {view === "month" ? (
              <MonthView
                anchor={anchor}
                now={now}
                entries={visible}
                ownerOf={owner}
                onOpen={(entry) => setOpenId(entry.id)}
                onDay={(day) => {
                  setAnchor(day);
                  setView("week");
                }}
                {...(canManage ? { onAdd: (day: number) => startNew(day, true) } : {})}
              />
            ) : view === "week" ? (
              <WeekView
                anchor={anchor}
                now={now}
                entries={visible}
                ownerOf={owner}
                onOpen={(entry) => setOpenId(entry.id)}
                bands={occurrences.filter((one) => one.host === bandsFor)}
                blocks={blocks}
                {...(canManage ? { onAddAt: (at: number) => startNew(at) } : {})}
              />
            ) : (
              <AgendaView anchor={anchor} now={now} entries={visible} ownerOf={owner} sourceOf={sourceOf} onOpen={(entry) => setOpenId(entry.id)} {...(canManage ? { onAdd: () => startNew(Date.now()) } : {})} />
            )}
          </>
        )}
      </div>
      <CalendarLegend
        owners={legend}
        filter={filter}
        onFilter={setFilter}
        stats={stats}
        {...(hosts.length > 0 ? { blocksFor: { value: bandsFor, options: hosts.map((one) => ({ value: one.member, label: one.displayName })), onChange: setBandsFor, shown: view === "week" } } : {})}
      />

      {open?.booking && <BookingSheet id={open.booking} people={people} canManage={canManage} onClose={() => setOpenId(null)} onChanged={() => setToken((n) => n + 1)} />}
      {open && !open.booking && (
        <EntrySheet
          entry={open}
          owner={owner(open)}
          {...(open.workflow && workflowById.get(open.workflow) ? { workflowName: workflowById.get(open.workflow)!.name } : {})}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onEdit={(entry) => {
            setOpenId(null);
            setEditing({ form: formOf(entry, mine), entry });
          }}
          onChanged={(next) => {
            if (next) replace(next);
            else {
              setEntries((list) => list.filter((one) => one.id !== open.id));
              setOpenId(null);
            }
          }}
          onNavigate={onNavigate}
        />
      )}
      {editing && (
        <EntryFormSheet
          initial={editing.form}
          {...(editing.entry ? { editing: editing.entry } : {})}
          owners={ownerOptions.length > 0 ? ownerOptions : [{ value: mine, label: "Me" }]}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            replace(saved);
            setEditing(null);
            setOpenId(saved.id);
          }}
        />
      )}
    </div>
  );
};
