import { AdapterRegistry, ProxyAdapter } from "@freebirdai/dash-adapters";
import { Dashboard, DashStyleSheet, RecordPage } from "@freebirdai/dash-react";
import type { StoredPresentations } from "@freebirdai/dash-react";
import type {
  ConnectionSpec,
  DashboardSpec,
  FieldLabels,
  LayoutCell,
  Presentation,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import { connectionSchema, parseDashboard } from "@freebirdai/dash-spec";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api.js";
import { ChatColumn } from "./ChatColumn.jsx";
import { ConnectionManager } from "./ConnectionManager.jsx";
import { autoArrange, isTypingTarget } from "./editing.js";
import { createLayoutSaver } from "./layoutSave.js";
import { type Route, currentRoute, navigate, onRouteChange } from "./route.js";
import { TopNav } from "./TopNav.jsx";
import { PresentationEditor } from "./PresentationEditor.jsx";
import { WidgetLibrary } from "./WidgetLibrary.jsx";

export interface DashboardSummary {
  id: string;
  title: string;
}

/**
 * Server-backed dashboards: specs and connections both come from the API.
 *
 * The dashboard is chosen from whatever the server has, rather than being
 * hardcoded — dropping a new spec in `dashboards/` has to be enough to see it.
 */
const useLiveDashboard = (
  reloadToken: number,
  selectedId: string | null,
): {
  dashboard: DashboardSpec | null;
  registry: AdapterRegistry | null;
  connections: ConnectionSpec[];
  /** connection id → what that API calls its fields. */
  labels: Record<string, FieldLabels>;
  available: DashboardSummary[];
  error: string | null;
} => {
  const [state, setState] = useState<{
    dashboard: DashboardSpec | null;
    registry: AdapterRegistry | null;
    connections: ConnectionSpec[];
    labels: Record<string, FieldLabels>;
    available: DashboardSummary[];
    error: string | null;
  }>({
    dashboard: null,
    registry: null,
    connections: [],
    labels: {},
    available: [],
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [listResponse, connectionsResponse] = await Promise.all([
          fetch("/api/dashboards"),
          fetch("/api/connections"),
        ]);
        const available = (await listResponse.json()) as DashboardSummary[];

        /*
         * No boards is a normal state, not a failure — it is what a fresh
         * install looks like. The caller renders the empty state for it.
         */
        if (available.length === 0) {
          if (!cancelled) {
            setState({
              dashboard: null,
              registry: null,
              connections: [],
              labels: {},
              available: [],
              error: null,
            });
          }
          return;
        }

        const wanted = available.find((entry) => entry.id === selectedId) ?? available[0]!;
        const dashboardResponse = await fetch(`/api/dashboards/${wanted.id}`);
        if (!dashboardResponse.ok) throw new Error(`could not load dashboard "${wanted.id}"`);

        const parsed = parseDashboard(await dashboardResponse.json());
        if (!parsed.ok) throw new Error(parsed.errors.join("; "));

        const raw = (await connectionsResponse.json()) as unknown[];
        const registry = new AdapterRegistry().register(new ProxyAdapter("rest"));
        const connections: ConnectionSpec[] = [];
        /*
         * Read off the response rather than out of the parsed connection.
         *
         * The lexicon is a fact about the API, not part of what a connection
         * *is*, so the server resolves it from the catalog on every read and
         * `connectionSchema` — correctly — knows nothing about it.
         */
        const labels: Record<string, FieldLabels> = {};
        for (const entry of raw) {
          const connection = connectionSchema.safeParse(entry);
          if (connection.success) {
            registry.addConnection(connection.data);
            connections.push(connection.data);
            const carried = (entry as { labels?: unknown }).labels;
            if (carried && typeof carried === "object") {
              labels[connection.data.id] = carried as FieldLabels;
            }
          }
        }

        if (!cancelled) {
          setState({
            dashboard: parsed.value!,
            registry,
            connections,
            labels,
            available,
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            dashboard: null,
            registry: null,
            connections: [],
            labels: {},
            available: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken, selectedId]);

  return state;
};

/**
 * The row field a widget's drill-down keys on.
 *
 * A URL carries one identifier and no field name, so this is how a cold load
 * turns it back into something `{{row.X}}` can interpolate. Falls back to
 * "Id", which is what every API this has met so far calls it — and when the
 * guess is wrong the page says the link is unusable rather than guessing again.
 */
const recordIdField = (dashboard: DashboardSpec, widgetId: string): string => {
  const params = dashboard.widgets.find((widget) => widget.id === widgetId)?.drilldown?.params ?? {};
  for (const value of Object.values(params)) {
    const match = /\{\{\s*row\.([^}\s|]+)/.exec(value);
    if (match?.[1]) return match[1];
  }
  return "Id";
};

/**
 * The row a record page should render.
 *
 * The row kept from an in-session click is only usable for the record it came
 * from. Following a link, editing the address, or opening a second record
 * changes the URL without clearing it, and reusing it then renders the
 * *previous* record under the new record's address — which is worse than
 * having no row at all, because nothing looks wrong.
 */
const rowForRoute = (
  dashboard: DashboardSpec,
  widgetId: string,
  recordId: string,
  known: Record<string, unknown> | null,
): Record<string, unknown> => {
  const field = recordIdField(dashboard, widgetId);
  if (known && String(known[field] ?? "") === recordId) return known;
  // Everything a link can carry: the identifier, under the name the
  // drill-down interpolates.
  return { [field]: recordId };
};

const App = (): JSX.Element => {
  const [reloadToken, setReloadToken] = useState(0);
  /** A failed removal, which otherwise leaves the widget there for no reason. */
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  /** The widget whose look is being edited, by id. */
  const [customising, setCustomising] = useState<string | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [dashboardId, setDashboardId] = useState<string | null>(null);

  /*
   * The address bar is the source of truth for which record is open.
   *
   * Holding it in component state instead would give a record no URL, and the
   * browser's own Back button would leave the app rather than closing the
   * record — which is the thing people actually press.
   */
  const [route, setRoute] = useState<Route>(() => currentRoute());
  useEffect(() => onRouteChange(() => setRoute(currentRoute())), []);

  // A board named in the URL wins over whatever was picked before.
  useEffect(() => {
    if (route.dashboardId && route.dashboardId !== dashboardId) setDashboardId(route.dashboardId);
  }, [route, dashboardId]);

  const live = useLiveDashboard(reloadToken, dashboardId);

  const reload = (): void => setReloadToken((token) => token + 1);

  /** Create a board and land on it, so the click has a visible result. */
  const createDashboard = async (): Promise<void> => {
    const response = await fetch("/api/dashboards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New tab" }),
    });
    if (!response.ok) return;
    const created = (await response.json()) as DashboardSummary;
    setDashboardId(created.id);
    reload();
  };

  const renameDashboard = async (id: string, title: string): Promise<void> => {
    const current = await fetch(`/api/dashboards/${id}`).then((r) => (r.ok ? r.json() : null));
    if (!current) return;
    await fetch(`/api/dashboards/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...current, title }),
    });
    reload();
  };

  const deleteDashboard = async (id: string): Promise<void> => {
    await fetch(`/api/dashboards/${id}`, { method: "DELETE" });
    // Stop pointing at something that no longer exists; the loader falls back
    // to whatever is left.
    if (dashboardId === id) setDashboardId(null);
    reload();
  };

  /**
   * Append the widget to the dashboard that is open, and reload it.
   *
   * Deliberately the open board rather than the widget's own connection: a
   * board that mixes sources is something to want later, and forcing widgets
   * apart now would be a rule to undo. Each connection gets its own board on
   * the server, so the picker is enough to keep things separate while testing.
   */
  const addWidget = async (widget: WidgetSpec, confirmed: string[]): Promise<void> => {
    if (!live.dashboard) throw new Error("There is no dashboard open to add this to.");

    /*
     * A suggestion's id is deterministic by design — a given pairing gets the
     * same id every time it is offered — so adding one twice collides and
     * the server refuses the whole save. Suffixing here is the same thing
     * connections already do for a duplicate name.
     */
    const taken = new Set(live.dashboard.widgets.map((item) => item.id));
    let id = widget.id;
    for (let suffix = 2; taken.has(id); suffix++) id = `${widget.id}-${suffix}`;

    const next = {
      ...live.dashboard,
      widgets: [...live.dashboard.widgets, { ...widget, id, confirmed }],
    };
    const response = await fetch(`/api/dashboards/${live.dashboard.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });

    if (!response.ok) {
      /*
       * A save that fails silently is the worst outcome available: the widget
       * is not there, nothing said so, and the obvious response is to click
       * again — which fails the same way. Surface the server's own words; it
       * already phrases these for a person to read.
       */
      const body = (await response.json().catch(() => null)) as
        | { error?: string; detail?: unknown }
        | null;
      const detail = Array.isArray(body?.detail) ? ` (${body.detail.join("; ")})` : "";
      throw new Error(`${body?.error ?? `Could not save (${response.status})`}${detail}`);
    }

    setReloadToken((token) => token + 1);
  };

  /**
   * Write the whole spec, through the same guarded path a layout save uses.
   *
   * The editor changes a widget or the board's own look, and both are edits to
   * the same document a drag writes — so they go through one writer rather
   * than each growing its own `fetch` and its own idea of concurrency.
   */
  const saveDashboard = async (next: DashboardSpec): Promise<void> => {
    layoutSaver.save(next, next.layout.cells);
    layoutSaver.flush();
  };

  /**
   * Take a widget off the board.
   *
   * The layout cell goes with it. Leaving it behind would reserve the space
   * for an id nothing renders, and the packer would lay the survivors out
   * around a hole.
   */
  const removeWidget = async (widgetId: string): Promise<void> => {
    if (!live.dashboard) return;
    setRemoveError(null);
    const next = {
      ...live.dashboard,
      widgets: live.dashboard.widgets.filter((widget) => widget.id !== widgetId),
      layout: {
        ...live.dashboard.layout,
        cells: live.dashboard.layout.cells.filter((cell) => cell.widgetId !== widgetId),
      },
    };

    const response = await fetch(`/api/dashboards/${live.dashboard.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    // Same reasoning as the save above: a removal that silently fails leaves
    // the widget on screen and no reason why.
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setRemoveError(body?.error ?? `Could not remove that widget (${response.status})`);
      return;
    }
    setReloadToken((token) => token + 1);
  };

  /*
   * How things look, from the parts registry.
   *
   * Fetched once and kept beside the spec rather than inside it: a look is not
   * part of what a dashboard *is*, and a self-hoster who restyles every table
   * should not find that change written into each board's JSON.
   */
  const [stored, setStored] = useState<StoredPresentations>({});
  const [themeTokens, setThemeTokens] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/presentation");
        if (!response.ok) return;
        const body = (await response.json()) as {
          presentation?: Record<string, Presentation>;
          theme?: Record<string, string>;
        };
        if (!cancelled) {
          setStored(body.presentation ?? {});
          setThemeTokens(body.theme ?? {});
        }
      } catch {
        // The shipped look is a complete answer, so a failure here costs
        // customisation rather than the dashboard. Nothing to say.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const presentationSources = useMemo(
    () => ({ stored, board: live.dashboard?.presentation }),
    [stored, live.dashboard],
  );

  /*
   * Where the user put things, saved.
   *
   * `live.dashboard` is read through a ref rather than captured: a save is
   * debounced by a second, and in that window the chat can add a widget or a
   * removal can land. Closing over the spec as it looked when the drag ended
   * would write that stale copy back and undo whichever change was newer.
   */
  const dashboardRef = useRef(live.dashboard);
  dashboardRef.current = live.dashboard;

  const [layoutError, setLayoutError] = useState<string | null>(null);

  /**
   * The version of the board this client last saw.
   *
   * Every save bumps `updatedAt` on the server, so quoting the copy that
   * arrived with the page would be stale from the second drag onwards and
   * every one after the first would conflict with itself. Tracking what we
   * actually wrote is what makes the guard catch *other* writers only.
   */
  const versionRef = useRef<string | undefined>(live.dashboard?.updatedAt);
  useEffect(() => {
    versionRef.current = live.dashboard?.updatedAt;
  }, [live.dashboard]);

  const layoutSaver = useMemo(
    () =>
      createLayoutSaver({
        put: async (next) => {
          const response = await fetch(`/api/dashboards/${next.id}`, {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              /*
               * The version this save is based on. The assistant writes the
               * same document, so without this a drag that started before a
               * chat edit would land after it and erase it.
               */
              ...(versionRef.current ? { "if-match": versionRef.current } : {}),
            },
            body: JSON.stringify(next),
            // Survives the tab closing mid-flight, which is the one moment a
            // layout save is most likely to be in the air.
            keepalive: true,
          });
          if (response.ok) {
            const saved = (await response.json().catch(() => null)) as
              | { updatedAt?: string }
              | null;
            // Move to the version we just created, so the next save is
            // measured against our own write rather than a stale one.
            if (saved?.updatedAt) versionRef.current = saved.updatedAt;
            setLayoutError(null);
            return;
          }

          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          if (response.status === 409) {
            /*
             * Somebody else got there first. Re-reading is the only honest
             * move: this copy of the board is out of date, so re-sending it
             * would overwrite whatever the other writer did.
             */
            setLayoutError(
              "This board changed somewhere else, so your last move was not saved. Reloaded it.",
            );
            reload();
            return;
          }
          throw new Error(body?.error ?? `Could not save this layout (${response.status})`);
        },
        onError: setLayoutError,
      }),
    [],
  );

  /*
   * Anything still debounced when the page goes away is written immediately.
   * Without this, the last drag before a reload is the one that disappears —
   * which reads exactly like the bug this replaced.
   */
  useEffect(() => {
    const onLeave = (): void => {
      layoutSaver.flush();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      layoutSaver.flush();
    };
  }, [layoutSaver]);

  /*
   * Rearranging is a mode you enter on purpose.
   *
   * The grid used to be draggable all the time, which meant every pointer
   * press on a widget header was a potential accidental move. Gating it also
   * gives the affordances somewhere honest to live: handles, the dot grid and
   * the guard overlay only make sense while the board is being edited.
   */
  const [arranging, setArranging] = useState(false);

  /**
   * The result of a tidy-up, held until the server catches up.
   *
   * The board renders from `live.dashboard`, so re-packing without this would
   * write new positions and leave the screen showing the old ones. Scoped to a
   * dashboard id and dropped the moment a fresh copy arrives, so the server
   * stays the source of truth and this is only ever a bridge.
   */
  /** True while the assistant is building a widget, so the column has room. */
  const [building, setBuilding] = useState(false);
  /**
   * The widget just added by the assistant.
   *
   * Held only long enough to scroll to it and ring it once — on a board with
   * twelve tiles the new one is otherwise indistinguishable, and being dropped
   * into arrange mode with nothing indicating what to arrange is worse than
   * not being dropped into it at all.
   */
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const [arranged, setArranged] = useState<{ id: string; cells: LayoutCell[] } | null>(null);
  useEffect(() => setArranged(null), [live.dashboard]);

  // Switching boards leaves edit mode: the arrangement being worked on is not
  // the one now on screen.
  useEffect(() => setArranging(false), [live.dashboard?.id]);

  /**
   * Open the conversation, and make sure there is something to converse with.
   *
   * With a model configured this only opens the column — the assistant starts
   * the setup itself once it knows what the user wants, which is the whole
   * point of leading with a question rather than a form.
   *
   * With no model there is nobody to ask, so this starts the deterministic
   * wizard instead. Without it the button would open an empty chat that cannot
   * answer, which is a worse dead end than the one it replaced.
   */
  const askAssistant = async (): Promise<void> => {
    const board = live.dashboard;
    if (!board) return;
    try {
      const models = await api.models();
      const hasModel = models.providers.anthropic || models.providers.openai;
      if (!hasModel) await api.startSetup(board.id, undefined, "wizard");
    } catch {
      // A failure here is not worth blocking on: open the column either way
      // and let whatever is wrong surface where it can be read.
    }
    setChatOpen(true);
  };

  /*
   * Put the newly built widget in front of the user.
   *
   * Runs off the board actually containing it rather than off a timer: the
   * confirm writes server-side and the reload that follows is asynchronous, so
   * the tile does not exist at the moment it is announced.
   */
  useEffect(() => {
    if (!justAdded) return;

    /*
     * Waits for the tile rather than assuming it.
     *
     * The confirm writes server-side and the reload that follows is
     * asynchronous, so at the moment the widget is announced its tile does not
     * exist. Looking once and giving up meant the board silently never
     * scrolled — and a re-run keyed on the dashboard object only helps if that
     * object's identity happens to change, which is not something this effect
     * should be relying on.
     *
     * A timer rather than `requestAnimationFrame`: rAF does not fire in a
     * window that is not compositing, and this has to work in a background tab
     * as well as a foreground one.
     */
    let attempts = 0;
    let clear = 0;
    const look = (): void => {
      const tile = document.querySelector(`[data-widget-id="${justAdded}"]`);
      if (!tile) {
        // Roughly three seconds. Beyond that the widget is not coming, and a
        // ring on a tile nobody is looking at any more is just noise.
        if (attempts++ < 30) clear = window.setTimeout(look, 100);
        else setJustAdded(null);
        return;
      }
      tile.setAttribute("data-just-added", "true");
      tile.scrollIntoView({ behavior: "smooth", block: "center" });
      clear = window.setTimeout(() => {
        tile.removeAttribute("data-just-added");
        setJustAdded(null);
      }, 2600);
    };
    look();
    return () => window.clearTimeout(clear);
  }, [justAdded]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // A single-letter shortcut must never fire while someone is typing.
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "e" || event.key === "E") {
        if (!dashboardRef.current) return;
        event.preventDefault();
        setArranging((value) => !value);
      } else if (event.key === "Escape") {
        setArranging((value) => (value ? false : value));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Re-pack the board with the deterministic placer.
   *
   * Written straight through rather than debounced: this is one deliberate
   * click, not a burst of drags, and leaving it in flight invites a reload to
   * arrive first and visibly undo it.
   */
  const tidyUp = (): void => {
    const current = dashboardRef.current;
    if (!current) return;

    const { cells, dropped } = autoArrange(current);
    setLayoutError(
      dropped.length > 0
        ? `Could not place ${dropped.length} widget(s): ${dropped
            .map((entry) => entry.reason)
            .join("; ")}`
        : null,
    );
    setArranged({ id: current.id, cells });
    layoutSaver.save(current, cells);
    layoutSaver.flush();
  };

  /**
   * Open a record as a page.
   *
   * The URL carries the record's identifier only, so the field the drill-down
   * keys on has to be worked out here rather than guessed at on the way back.
   * `RecordPage` says so plainly when a link cannot supply what a drill-down
   * needs, instead of firing a request that will 404.
   */
  const openRecordPage = (widgetId: string, row: Record<string, unknown>): void => {
    const board = dashboardRef.current;
    if (!board) return;
    const widget = board.widgets.find((entry) => entry.id === widgetId);
    const params = widget?.drilldown?.params ?? {};
    const first = Object.values(params)
      .flatMap((value) => [...value.matchAll(/\{\{\s*row\.([^}\s|]+)/g)])
      .map((match) => match[1])
      .find((field): field is string => Boolean(field));
    const value = first ? row[first] : undefined;
    if (value === undefined || value === null) return;

    setRecordRow(row);
    navigate({
      kind: "record",
      dashboardId: board.id,
      widgetId,
      recordId: String(value),
    });
  };

  /**
   * The row a record page was opened from, when it was opened in this session.
   *
   * A cold load has only the identifier from the URL, and the page is honest
   * about what that cannot do. Keeping the real row when we have it means the
   * common path — click a row, go wide — loses nothing.
   */
  const [recordRow, setRecordRow] = useState<Record<string, unknown> | null>(null);

  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );

  const toggleTheme = (): void => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    // Matches `--dash-plane` in each mode, so the page behind the shell is the
    // same colour as the shell's own background rather than a seam.
    document.body.style.background = next === "dark" ? "#0c100e" : "#f6f7f6";
    setTheme(next);
  };

  /*
   * The modals ride in the dashboard's toolbar slot alongside the chat column.
   * All three are fixed-position, so where they sit in the tree does not
   * affect how they render — but being inside the provider is what lets the
   * chat drive the view.
   */
  const overlays = (
    <>
      <ChatColumn
        open={chatOpen}
        onToggle={setChatOpen}
        dashboardId={live.dashboard?.id ?? null}
        onBuildingChange={setBuilding}
        onDashboardChanged={reload}
        /*
         * Straight into arranging, with the new tile named.
         *
         * The widget is written before this runs but the board has not
         * re-read yet, so the scroll waits on the tile appearing rather than
         * guessing at a delay.
         */
        onWidgetAdded={(widgetId) => {
          setJustAdded(widgetId);
          setArranging(true);
        }}
        onSwitchDashboard={setDashboardId}
        /*
         * `open_add_widget` now lands on the palette rather than a second
         * proposer. The assistant builds widgets itself; the panel it opens is
         * the one for picking a component by hand.
         */
        onOpenPanel={(panel) =>
          panel === "connections" ? setConnectionsOpen(true) : setLibraryOpen(true)
        }
      />
      {connectionsOpen && (
        <ConnectionManager
          onClose={() => setConnectionsOpen(false)}
          onChanged={reload}
          // One click from "this endpoint can be clicked into" to a widget
          // that does it. Nothing is confirmed by hand, so `confirmed` is
          // empty — the offer was derived, not guessed at.
          {...(live.dashboard ? { onCreateWidget: (widget) => addWidget(widget, []) } : {})}
        />
      )}
      {customising && live.dashboard && (() => {
        const target = live.dashboard.widgets.find((widget) => widget.id === customising);
        if (!target) return null;
        return (
          <PresentationEditor
            widget={target}
            dashboard={live.dashboard}
            onSaveDashboard={saveDashboard}
            onChanged={reload}
            onClose={() => setCustomising(null)}
          />
        );
      })()}
      {libraryOpen && live.dashboard && (
        <WidgetLibrary
          connections={live.connections}
          takenIds={new Set(live.dashboard.widgets.map((widget) => widget.id))}
          onSave={(widget) => addWidget(widget, [])}
          onClose={() => setLibraryOpen(false)}
        />
      )}
    </>
  );

  const nav = (
    <TopNav
      tabs={live.available}
      activeId={live.dashboard?.id ?? null}
      onSelect={setDashboardId}
      onCreate={() => void createDashboard()}
      onRename={(id, title) => void renameDashboard(id, title)}
      onDelete={(id) => void deleteDashboard(id)}
      onConnect={() => setConnectionsOpen(true)}
      onAddWidget={() => setLibraryOpen(true)}
      onAskAssistant={() => void askAssistant()}
      addWidgetDisabled={!live.dashboard}
      layoutEditing={arranging}
      onToggleLayoutEditing={setArranging}
      layoutEditingDisabled={!live.dashboard}
      chatOpen={chatOpen}
      onToggleChat={setChatOpen}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );

  /*
   * Nothing connected yet.
   *
   * The shell is real and present — nav, assistant, the lot — because the app
   * is not broken, it simply has no data. Only the two things worth doing are
   * offered, and the assistant is one of them: it can open the same panels.
   */
  if (!live.error && live.available.length === 0) {
    return (
      <div
      className="dash-shell"
      data-chat={chatOpen ? "open" : "closed"}
      data-building={building ? "true" : "false"}
    >
        <div className="dash-root">
          {nav}
          <div className="dash-page">
            <div className="dash-empty" data-testid="empty-state">
              <span className="dash-empty__mark" aria-hidden="true">
                ⚯
              </span>
              <h2 className="dash-empty__title">Connect an API to get started</h2>
              <p className="dash-empty__body">
                Point Dash at an API and it will read what that API can do — which endpoints
                list records, how they relate, what a row contains — then offer widgets built
                from it. Nothing is sent anywhere but the API you name.
              </p>
              <div className="dash-empty__actions">
                <button
                  className="dash-control dash-btn--primary"
                  onClick={() => setConnectionsOpen(true)}
                  data-testid="empty-connect"
                >
                  ⚯ Connect an API
                </button>
                <button
                  className="dash-control"
                  onClick={() => setChatOpen(true)}
                  data-testid="empty-ask"
                >
                  ✦ Ask the assistant
                </button>
              </div>
            </div>
          </div>
          {overlays}
        </div>
      </div>
    );
  }

  if (live.error) {
    return (
      <div
      className="dash-shell"
      data-chat={chatOpen ? "open" : "closed"}
      data-building={building ? "true" : "false"}
    >
        <div className="dash-root">
          {nav}
          <div className="dash-page">
            <p className="dash-page__description" data-testid="live-error">
              {live.error}
            </p>
          </div>
          {overlays}
        </div>
      </div>
    );
  }

  if (!live.dashboard || !live.registry) {
    return (
      <div
      className="dash-shell"
      data-chat={chatOpen ? "open" : "closed"}
      data-building={building ? "true" : "false"}
    >
        <div className="dash-root">
          {nav}
          <div className="dash-page">
            <p className="dash-page__description">Loading…</p>
          </div>
        </div>
      </div>
    );
  }

  /*
   * Captured after the guard above, because a closure does not carry the
   * narrowing: `onBack` reads the id long after this render decided the
   * dashboard was present.
   */
  const board = live.dashboard;

  /*
   * `overlays` rides in the `toolbar` slot so the chat renders inside the
   * dashboard's provider and can drive the view itself. The nav sits outside
   * it — it needs no dashboard context — and the shell wrapper is what moves
   * the board out from under the chat column.
   */
  return (
    <div
      className="dash-shell"
      data-chat={chatOpen ? "open" : "closed"}
      data-building={building ? "true" : "false"}
    >
      <div className="dash-root">
        <DashStyleSheet tokens={themeTokens} />
        {nav}
        {removeError && (
          <p className="dash-callout dash-callout--bad" data-testid="remove-error">
            {removeError}
          </p>
        )}
        {layoutError && (
          <p className="dash-callout dash-callout--bad" data-testid="layout-error">
            {layoutError}
          </p>
        )}
        <Dashboard
          key={live.dashboard.id}
          /*
           * The record page renders *through* the dashboard rather than beside
           * it: it needs the board's widgets to find its drill-down, and the
           * query cache so a record opened from a row it already fetched costs
           * no second request.
           */
          {...(route.kind === "record" && route.widgetId
            ? {
                record: {
                  widgetId: route.widgetId,
                  row: rowForRoute(board, route.widgetId, route.recordId, recordRow),
                  onBack: () => navigate({ kind: "board", dashboardId: board.id }),
                },
              }
            : {})}
          dashboard={
            arranged?.id === live.dashboard.id
              ? {
                  ...live.dashboard,
                  layout: { ...live.dashboard.layout, cells: arranged.cells },
                }
              : live.dashboard
          }
          registry={live.registry}
          toolbar={overlays}
          presentation={presentationSources}
          labels={live.labels}
          editing={arranging}
          onEditingChange={setArranging}
          onAutoArrange={tidyUp}
          onLayoutChange={(cells) => {
            const current = dashboardRef.current;
            if (current) layoutSaver.save(current, cells);
          }}
          onRemoveWidget={(widgetId) => void removeWidget(widgetId)}
          onCustomiseWidget={setCustomising}
          onOpenRecordPage={openRecordPage}
        />
      </div>
    </div>
  );
};

/**
 * Reuse the root across hot reloads.
 *
 * Calling `createRoot` again on a container that already has one leaves two
 * roots rendering into the same div; they fight, and the losing tree throws
 * inside whatever provider it was in. That was the source of a console full of
 * Context.Provider errors during development.
 */
const container = document.getElementById("root")!;
const global = window as typeof window & { __dashRoot?: ReturnType<typeof createRoot> };
const root = global.__dashRoot ?? createRoot(container);
global.__dashRoot = root;

/*
 * The stylesheet mounts above `App`, not inside `<Dashboard>`.
 *
 * It used to arrive with the dashboard, which held while a dashboard was
 * always on screen. It no longer is — the empty state renders the nav and
 * nothing else — and without this that state comes up with no theme tokens
 * at all: transparent chrome on a bare white page.
 */
root.render(
  <StrictMode>
    {/*
      * The base sheet, with no stored tokens.
      *
      * It mounts above `App` so the empty state has theme variables too, and
      * `App` mounts a second, token-carrying copy once it has read them — both
      * write the same element, so the later one simply wins.
      */}
    <DashStyleSheet />
    <App />
  </StrictMode>,
);
