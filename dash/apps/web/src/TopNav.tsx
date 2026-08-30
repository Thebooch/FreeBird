import { useEffect, useRef, useState } from "react";
import { ModelPicker } from "./ModelPicker.jsx";

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
 * widget, arrange, connect, models, theme — sits behind the overflow menu, so
 * the two controls you actually navigate with are not competing with four
 * that you do not.
 *
 * Every control here is also an action the assistant can call. A thing you can
 * click and cannot ask for is a thing the chat will be blamed for not doing.
 */

export interface NavTab {
  readonly id: string;
  readonly title: string;
}

export interface TopNavProps {
  readonly tabs: readonly NavTab[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
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
          ✕
        </button>
      )}
    </span>
  );
};

export const TopNav = ({
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
  chatOpen,
  onToggleChat,
  theme,
  onToggleTheme,
}: TopNavProps): JSX.Element => {
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

  // Nothing to edit once the last board is gone.
  useEffect(() => {
    if (tabs.length === 0) setEditing(false);
  }, [tabs.length]);

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
        <span className="dash-nav__mark" aria-hidden="true" />
        FreeBird&nbsp;Dash
      </span>

      <div className="dash-nav__rail" ref={railRef} role="tablist" aria-label="Dashboards">
        {tabs.length === 0 ? (
          <span className="dash-nav__hint">No dashboards yet</span>
        ) : editing ? (
          tabs.map((tab) => (
            <EditableTab key={tab.id} tab={tab} onRename={onRename} onDelete={onDelete} />
          ))
        ) : (
          tabs.map((tab) => (
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

        <button
          type="button"
          className="dash-nav__add"
          onClick={onCreate}
          data-testid="nav-new-tab"
        >
          ＋ New tab
        </button>
      </div>

      <div className="dash-nav__actions">
        {tabs.length > 0 && (
          <button
            type="button"
            className="dash-nav__icon"
            data-on={editing}
            onClick={() => setEditing((value) => !value)}
            title={editing ? "Done editing" : "Rename or remove tabs"}
            aria-label={editing ? "Done editing" : "Edit tabs"}
            data-testid="nav-edit"
          >
            {editing ? "✓" : "✎"}
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
            ⋯
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
                disabled={addWidgetDisabled}
                data-testid="add-widget"
              >
                ✚ Add a widget
              </button>
              <button
                type="button"
                role="menuitem"
                className="dash-nav__item"
                data-on={layoutEditing}
                onClick={pick(() => onToggleLayoutEditing(!layoutEditing))}
                disabled={layoutEditingDisabled}
                title={
                  layoutEditing
                    ? "Stop rearranging (Esc)"
                    : "Move and resize the widgets on this board (E)"
                }
                data-testid="toggle-arrange"
              >
                {layoutEditing ? "✓ Done arranging" : "⊞ Arrange"}
              </button>
              <button
                type="button"
                role="menuitem"
                className="dash-nav__item"
                onClick={pick(onConnect)}
                data-testid="open-connections"
              >
                ⚯ Connect an API
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
                {theme === "dark" ? "☀ Light theme" : "☾ Dark theme"}
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="dash-nav__icon"
          data-on={chatOpen}
          onClick={() => onToggleChat(!chatOpen)}
          title={chatOpen ? "Close the assistant" : "Open the assistant"}
          aria-label={chatOpen ? "Close the assistant" : "Open the assistant"}
          data-testid="nav-chat-toggle"
        >
          ✦
        </button>
      </div>
    </header>
  );
};
