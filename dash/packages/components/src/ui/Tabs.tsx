import { useRef } from "react";

/**
 * A tab strip.
 *
 * Roving tabindex, not a tab stop per tab: the pattern for a tablist is one
 * stop for the whole set with the arrows moving inside it, so a keyboard user
 * passing a record with six related collections does not have to press Tab six
 * times to get past them.
 */

export interface TabDef {
  readonly id: string;
  readonly label: string;
  /** A row count or similar, shown small beside the label. */
  readonly meta?: string;
}

export const Tabs = ({
  tabs,
  activeId,
  onSelect,
  label,
}: {
  readonly tabs: readonly TabDef[];
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
  readonly label: string;
}): JSX.Element => {
  const stripRef = useRef<HTMLDivElement>(null);

  const move = (from: number, step: number): void => {
    if (tabs.length === 0) return;
    const next = (from + step + tabs.length) % tabs.length;
    const target = tabs[next];
    if (!target) return;
    onSelect(target.id);
    // Selection follows focus here, which is the right call when switching is
    // cheap — every pane is already fetched or cached.
    stripRef.current
      ?.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(target.id)}"]`)
      ?.focus();
  };

  return (
    <div className="dash-tabs" role="tablist" aria-label={label} ref={stripRef}>
      {tabs.map((tab, index) => {
        const selected = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="dash-tabs__tab"
            data-tab-id={tab.id}
            data-selected={selected ? "true" : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                move(index, -1);
              } else if (event.key === "Home") {
                event.preventDefault();
                move(index, -index);
              } else if (event.key === "End") {
                event.preventDefault();
                move(index, tabs.length - 1 - index);
              }
            }}
          >
            {tab.label}
            {tab.meta && <span className="dash-tabs__meta">{tab.meta}</span>}
          </button>
        );
      })}
    </div>
  );
};
