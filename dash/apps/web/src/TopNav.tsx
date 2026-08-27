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
  /** The model-driven path, kept separate from the deterministic picker. */
  readonly onAskAssistant: () => void;
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
  onAskAssistant,
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
  const railRef = useRef<HTMLDivElement>(null);

  // Nothing to edit once the last board is gone.
  useEffect(() => {
    if (tabs.length === 0) setEditing(false);
  }, [tabs.length]);

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
        <button
          className="dash-control"
          onClick={onAddWidget}
          disabled={addWidgetDisabled}
          data-testid="add-widget"
        >
          ✚ Widget
        </button>
        <button
          className="dash-control"
          onClick={onAskAssistant}
          disabled={addWidgetDisabled}
          title="Describe what you want and build it in the conversation"
          data-testid="suggest-widget"
        >
          ✦ Describe
        </button>
        <button
          className="dash-control"
          data-on={layoutEditing}
          onClick={() => onToggleLayoutEditing(!layoutEditing)}
          disabled={layoutEditingDisabled}
          title={
            layoutEditing
              ? "Stop rearranging (Esc)"
              : "Move and resize the widgets on this board (E)"
          }
          data-testid="toggle-arrange"
        >
          {layoutEditing ? "✓ Done" : "⊞ Arrange"}
        </button>
        <button className="dash-control" onClick={onConnect} data-testid="open-connections">
          ⚯ Connect an API
        </button>
        <ModelPicker />
        <button className="dash-control" onClick={onToggleTheme} data-testid="theme-toggle">
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <button
          className="dash-control"
          data-on={chatOpen}
          onClick={() => onToggleChat(!chatOpen)}
          data-testid="nav-chat-toggle"
        >
          ✦ Assistant
        </button>
      </div>
    </header>
  );
};
