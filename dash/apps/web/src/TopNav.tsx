import { Icon } from "@freebirdai/dash-components";
import { useEffect, useRef, useState } from "react";
import { ModelPicker } from "./ModelPicker.jsx";
import logo from "./assets/freebird-logo.png";
import { barFor, barOf, barsOf, stepBar } from "./tabBars.js";

/**
 * The workspace nav: which board you are on, and everywhere you can go next.
 *
 * Modelled on the FreeBird demo's workspace bar — pill tabs, an edit
 * affordance, a dashed "add" — over Dash's own concept of a board rather than
 * a second one. The demo cycles between several named bars with shoulder
 * buttons; there is only one kind of tab here, so that chrome would never
 * appear. `groups` is the seam for it: give it names later and the cycler is
 * an addition rather than a rewrite.
 *
 * The bar itself is deliberately thin: tabs, the way to make one, the way to
 * rename them, and the assistant. Everything you touch once a session — add a
 * widget, arrange, reports, connect, models, theme — sits behind the overflow menu, so
 * the two controls you actually navigate with are not competing with four
 * that you do not.
 *
 * Every control here is also an action the assistant can call. A thing you can
 * click and cannot ask for is a thing the chat will be blamed for not doing.
 */

export interface NavTab {
  readonly id: string;
  readonly title: string;
  /** Which tab bar it sits on (`tabBars.ts`). Absent: the first. */
  readonly bar?: number | undefined;
}

/** Which half of the app the bar is for: the user's own boards, or the agent's fixed sections. */
export type NavMode = "dash" | "comms" | "agent";

const MODES: ReadonlyArray<{ readonly id: NavMode; readonly label: string }> = [
  { id: "dash", label: "Dash" },
  { id: "comms", label: "Comms" },
  { id: "agent", label: "Agent" },
];

export interface TopNavProps {
  /** The Agent | Tabs switch. Absent hides it, and the bar is exactly what it was. */
  readonly mode?: NavMode;
  readonly onModeChange?: (mode: NavMode) => void;
  /** The fixed sections the bar shows in Agent mode: no adding, renaming or removing. */
  readonly sections?: readonly NavTab[];
  readonly activeSection?: string | null;
  readonly onSelectSection?: (id: string) => void;
  readonly tabs: readonly NavTab[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  /** Make a tab on this bar. */
  readonly onCreate: (bar: number) => void;
  readonly onRename: (id: string, title: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onConnect: () => void;
  readonly onAddWidget: () => void;
  readonly addWidgetDisabled?: boolean;
  /**
   * Rearranging the *board*, which is a different thing from renaming tabs.
   *
   * The nav already had an `editing` flag for tabs; these are deliberately
   * separate states with separate controls, because turning on the one that
   * lets you delete a tab is not the same decision as turning on the one that
   * lets you drag a widget.
   */
  readonly layoutEditing: boolean;
  readonly onToggleLayoutEditing: (editing: boolean) => void;
  readonly layoutEditingDisabled?: boolean;
  /** Timed reports for the open tab: what is sent, to whom, how often. Absent hides the item. */
  readonly onOpenReports?: () => void;
  readonly reportsDisabled?: boolean;
  readonly chatOpen: boolean;
  readonly onToggleChat: (open: boolean) => void;
  readonly theme: "light" | "dark";
  readonly onToggleTheme: () => void;
}

/** One tab in edit mode: rename in place, delete behind a confirm. */
const EditableTab = ({
  tab,
  onRename,
  onDelete,
}: {
  tab: NavTab;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}): JSX.Element => {
  const [draft, setDraft] = useState(tab.title);
  const [confirming, setConfirming] = useState(false);

  // A rename from elsewhere (the assistant, say) should win over a stale draft.
  useEffect(() => setDraft(tab.title), [tab.title]);

  const commit = (): void => {
    const next = draft.trim();
    if (next && next !== tab.title) onRename(tab.id, next);
    else setDraft(tab.title);
  };

  return (
    <span className="dash-nav__tab dash-nav__tab--editing">
      <input
        className="dash-nav__rename"
        value={draft}
        aria-label={`Rename ${tab.title}`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(tab.title);
            event.currentTarget.blur();
          }
        }}
      />
      {confirming ? (
        <button
          type="button"
          className="dash-nav__confirm"
          onClick={() => onDelete(tab.id)}
          onBlur={() => setConfirming(false)}
          data-testid={`nav-delete-confirm-${tab.id}`}
        >
          Delete?
        </button>
      ) : (
        <button
          type="button"
          className="dash-nav__x"
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${tab.title}`}
          data-testid={`nav-delete-${tab.id}`}
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
};

export const TopNav = ({
  mode = "dash",
  onModeChange,
  sections = [],
  activeSection = null,
  onSelectSection,
  tabs,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onConnect,
  onAddWidget,
  addWidgetDisabled,
  layoutEditing,
  onToggleLayoutEditing,
  layoutEditingDisabled,
  onOpenReports,
  reportsDisabled,
  chatOpen,
  onToggleChat,
  theme,
  onToggleTheme,
}: TopNavProps): JSX.Element => {
  const agentMode = mode === "agent";
  /* Boards belong to Dash alone: Comms and Agent have fixed content. */
  const boardless = mode !== "dash";
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /*
   * The model sheet renders inside the popover, so dismissing the popover
   * while it is up would take the sheet down with it. Held open behind it
   * instead — the sheet's own backdrop covers the menu anyway.
   */
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /*
   * Which tab bar is showing. It follows the open tab, and the arrows move it
   * without opening anything: a bar is browsed, then a tab on it is picked.
   */
  const bars = barsOf(tabs);
  const [shownBar, setShownBar] = useState(() => barFor(tabs, activeId));
  /* When the open tab, or its bar, changes: a rename or a new tab elsewhere leaves the bar being browsed. */
  const activeBar = barFor(tabs, activeId);
  useEffect(() => setShownBar(activeBar), [activeId, activeBar]);
  const onBar = tabs.filter((tab) => barOf(tab) === shownBar);
  const barIndex = Math.max(0, bars.indexOf(shownBar));

  /* Arrows at the rail's ends while its tabs are wider than it. */
  const [overflow, setOverflow] = useState({ left: false, right: false });
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    /* Kept when unchanged: the rail resizes on every frame the chat column animates, and a fresh object each time re-rendered the nav with it. */
    const measure = () => {
      const left = rail.scrollLeft > 1;
      const right = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1;
      setOverflow((previous) => (previous.left === left && previous.right === right ? previous : { left, right }));
    };
    measure();
    rail.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(rail);
    return () => {
      rail.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [onBar.length, shownBar, editing, mode]);
  const scrollRail = (direction: 1 | -1) => railRef.current?.scrollBy({ left: direction * Math.max(160, (railRef.current?.clientWidth ?? 0) * 0.6), behavior: "smooth" });

  // Nothing to edit once the last board on this bar is gone.
  useEffect(() => {
    if (onBar.length === 0) setEditing(false);
  }, [onBar.length]);

  // Click away or press Escape to dismiss, the way every other menu behaves.
  useEffect(() => {
    if (!menuOpen || modelSheetOpen) return;
    const away = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [menuOpen, modelSheetOpen]);

  /** Every item does its thing and gets out of the way. */
  const pick = (run: () => void) => (): void => {
    setMenuOpen(false);
    run();
  };

  /*
   * Closing the sheet closes the menu with it.
   *
   * Without this the menu comes back the moment the sheet goes, because the
   * click that dismissed the sheet lands before the away-listener is armed
   * again — so you would put the sheet away and find the menu still open
   * underneath, which is not what dismissing something means.
   */
  const onModelSheet = (open: boolean): void => {
    setModelSheetOpen(open);
    if (!open) setMenuOpen(false);
  };

  return (
    <header className="dash-nav">
      <span className="dash-nav__brand">
        <img className="dash-nav__mark" src={logo} alt="" aria-hidden="true" />
        <span className="dash-nav__name">FreeBird</span>
        {onModeChange && (
          <span className="dash-nav__switch" role="group" aria-label="Switch between Dash, Comms and the agent">
            {MODES.map((one) => (
              <button
                key={one.id}
                type="button"
                className="dash-nav__seg"
                aria-pressed={mode === one.id}
                data-active={mode === one.id}
                data-testid={`nav-mode-${one.id}`}
                onClick={() => mode !== one.id && onModeChange(one.id)}
              >
                {one.label}
              </button>
            ))}
          </span>
        )}
      </span>

      <div className="dash-nav__tabs">
      {overflow.left && (
        <button type="button" className="dash-nav__scroll" data-side="left" onClick={() => scrollRail(-1)} aria-label="Scroll tabs left" data-testid="nav-scroll-left">
          <Icon name="chevron-left" />
        </button>
      )}
      <div
        className="dash-nav__rail"
        ref={railRef}
        role="tablist"
        aria-label={agentMode ? "Agent sections" : boardless ? "Communications" : "Dashboards"}
      >
        {boardless ? (
          (agentMode ? sections : []).map((section) => (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={section.id === activeSection}
              className="dash-nav__tab"
              data-active={section.id === activeSection}
              data-testid={`nav-section-${section.id}`}
              onClick={() => onSelectSection?.(section.id)}
            >
              {section.title}
            </button>
          ))
        ) : onBar.length === 0 ? (
          <span className="dash-nav__hint">{tabs.length === 0 ? "No dashboards yet" : "Add a tab to start a new bar"}</span>
        ) : editing ? (
          onBar.map((tab) => (
            <EditableTab key={tab.id} tab={tab} onRename={onRename} onDelete={onDelete} />
          ))
        ) : (
          onBar.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              className="dash-nav__tab"
              data-active={tab.id === activeId}
              data-testid={`nav-tab-${tab.id}`}
              onClick={() => onSelect(tab.id)}
            >
              {tab.title}
            </button>
          ))
        )}
      </div>
      {overflow.right && (
        <button type="button" className="dash-nav__scroll" data-side="right" onClick={() => scrollRail(1)} aria-label="Scroll tabs right" data-testid="nav-scroll-right">
          <Icon name="chevron-right" />
        </button>
      )}
      </div>

      {/* Fixed at the rail's right edge, whatever the tabs do: a new tab on this bar, and the bars above and below. */}
      {!boardless && (
        <div className="dash-nav__bars">
          <button type="button" className="dash-nav__add" onClick={() => onCreate(shownBar)} data-testid="nav-new-tab">
            <Icon name="plus" size={14} />
            New tab
          </button>
          <span className="dash-nav__barnav" role="group" aria-label={`Tab bar ${barIndex + 1} of ${bars.length}`}>
            <button
              type="button"
              className="dash-nav__barstep"
              onClick={() => setShownBar(stepBar(bars, shownBar, 1))}
              disabled={barIndex >= bars.length - 1}
              title={barIndex === bars.length - 2 ? "The empty bar, to start a new one" : "Next tab bar"}
              aria-label="Next tab bar"
              data-testid="nav-bar-up"
            >
              <Icon name="chevron-up" size={12} />
            </button>
            <button
              type="button"
              className="dash-nav__barstep"
              onClick={() => setShownBar(stepBar(bars, shownBar, -1))}
              disabled={barIndex <= 0}
              title="Previous tab bar"
              aria-label="Previous tab bar"
              data-testid="nav-bar-down"
            >
              <Icon name="chevron-down" size={12} />
            </button>
          </span>
        </div>
      )}

      <div className="dash-nav__actions">
        {!boardless && onBar.length > 0 && (
          <button
            type="button"
            className="dash-nav__icon"
            data-on={editing}
            onClick={() => setEditing((value) => !value)}
            title={editing ? "Done editing" : "Rename or remove tabs"}
            aria-label={editing ? "Done editing" : "Edit tabs"}
            data-testid="nav-edit"
          >
            <Icon name={editing ? "check" : "pencil"} />
          </button>
        )}

        <div className="dash-nav__menu" ref={menuRef}>
          <button
            type="button"
            className="dash-nav__icon"
            data-on={menuOpen}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
            title="Widgets, layout, connections, models and theme"
            aria-label="More actions"
            data-testid="nav-menu"
          >
            <Icon name="ellipsis" />
          </button>

          {menuOpen && (
            <div
              className="dash-nav__pop"
              role="menu"
              /*
               * The sheet is a child of this popover, so it cannot be hidden
               * with `display` — that would take the sheet down too. The rows
               * and the panel chrome go instead, leaving an invisible box
               * holding the sheet.
               */
              data-sheet={modelSheetOpen ? "open" : "closed"}
              data-testid="nav-menu-pop"
            >
              <button
                type="button"
                role="menuitem"
                className="dash-nav__item"
                onClick={pick(onAddWidget)}
                disabled={addWidgetDisabled || boardless}
                data-testid="add-widget"
              >
                <Icon name="plus" />
                Add a widget
              </button>
              <button
                type="button"
                role="menuitem"
                className="dash-nav__item"
                data-on={layoutEditing}
                onClick={pick(() => onToggleLayoutEditing(!layoutEditing))}
                disabled={layoutEditingDisabled || boardless}
                title={
                  layoutEditing
                    ? "Stop rearranging (Esc)"
                    : "Move and resize the widgets on this board (E)"
                }
                data-testid="toggle-arrange"
              >
                <Icon name={layoutEditing ? "check" : "layout-grid"} />
                {layoutEditing ? "Done arranging" : "Arrange"}
              </button>
              {onOpenReports && (
                <button
                  type="button"
                  role="menuitem"
                  className="dash-nav__item"
                  onClick={pick(onOpenReports)}
                  disabled={reportsDisabled || boardless}
                  title="Email this tab, or some of its widgets, on a schedule"
                  data-testid="open-reports"
                >
                  <Icon name="mail" />
                  Reports
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="dash-nav__item"
                onClick={pick(onConnect)}
                data-testid="open-connections"
              >
                <Icon name="plug" />
                Connect an API
              </button>

              <div className="dash-nav__sep" role="separator" />

              {/*
                * Left mounted while its sheet is up — see `modelSheetOpen`.
                * It wears the menu row's dressing rather than the bar
                * button's, which is the whole reason it takes a class.
                */}
              <ModelPicker className="dash-nav__item" onOpenChange={onModelSheet} />
              <button
                type="button"
                role="menuitem"
                className="dash-nav__item"
                onClick={pick(onToggleTheme)}
                data-testid="theme-toggle"
              >
                <Icon name={theme === "dark" ? "sun" : "moon"} />
                {theme === "dark" ? "Light theme" : "Dark theme"}
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="dash-nav__icon"
          data-accent="true"
          data-on={chatOpen}
          onClick={() => onToggleChat(!chatOpen)}
          title={chatOpen ? "Close the assistant" : "Open the assistant"}
          aria-label={chatOpen ? "Close the assistant" : "Open the assistant"}
          data-testid="nav-chat-toggle"
        >
          <Icon name="sparkle" />
        </button>
      </div>
    </header>
  );
};
