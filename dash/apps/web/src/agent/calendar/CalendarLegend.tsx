import type { CalendarKind } from "@freebirdai/dash-spec";
import { Check } from "./controls.jsx";
import { KIND_LABELS, colorVar, type CalendarFilter, type OwnerInfo } from "./model.js";

/**
 * The calendars on the page and what is shown of them.
 *
 * The legend is the filter: each owner's colour is its checkbox, so turning
 * an agent off and finding out which colour is whose are the same act. Below
 * it, which kinds of entry show and whether finished ones do.
 */
export const CalendarLegend = ({
  owners,
  filter,
  onFilter,
  stats,
}: {
  readonly owners: ReadonlyArray<OwnerInfo & { readonly count: number }>;
  readonly filter: CalendarFilter;
  readonly onFilter: (filter: CalendarFilter) => void;
  readonly stats: { readonly entries: number; readonly deadlines: number; readonly tentative: number; readonly today: number };
}): JSX.Element => {
  const toggleOwner = (key: string) => {
    const hidden = new Set(filter.hidden);
    if (hidden.has(key)) hidden.delete(key);
    else hidden.add(key);
    onFilter({ ...filter, hidden });
  };
  const toggleKind = (kind: CalendarKind) => {
    const kinds = new Set(filter.kinds);
    if (kinds.has(kind)) kinds.delete(kind);
    else kinds.add(kind);
    onFilter({ ...filter, kinds });
  };
  const row = (key: string, name: string, color: string, on: boolean, toggle: () => void, count?: number) => (
    <label key={key} className="dash-cal-legend__row" data-off={on ? undefined : "true"} style={{ ["--cal-color" as string]: color }}>
      <input type="checkbox" checked={on} onChange={toggle} />
      <span className="dash-cal-legend__box" aria-hidden="true">
        <Check />
      </span>
      <span className="dash-cal-legend__name">{name}</span>
      {count !== undefined && <span className="dash-cal-legend__count">{count}</span>}
    </label>
  );

  return (
    <aside className="dash-cal-legend" aria-label="Calendars and filters" data-testid="calendar-legend">
      <div className="dash-cal-legend__stats">
        <div className="dash-cal-legend__stat">
          <span className="dash-cal-legend__stat-value">{stats.today}</span>
          <span className="dash-cal-legend__stat-label">Today</span>
        </div>
        <div className="dash-cal-legend__stat">
          <span className="dash-cal-legend__stat-value">{stats.entries}</span>
          <span className="dash-cal-legend__stat-label">In view</span>
        </div>
        <div className="dash-cal-legend__stat">
          <span className="dash-cal-legend__stat-value">{stats.deadlines}</span>
          <span className="dash-cal-legend__stat-label">Deadlines</span>
        </div>
        <div className="dash-cal-legend__stat">
          <span className="dash-cal-legend__stat-value">{stats.tentative}</span>
          <span className="dash-cal-legend__stat-label">Pending</span>
        </div>
      </div>
      <div className="dash-cal-legend__groups">
        <div className="dash-cal-legend__group">
          <h3 className="dash-cal-legend__title">
            Calendars
            {filter.hidden.size > 0 && (
              <button type="button" className="dash-cal-legend__reset" onClick={() => onFilter({ ...filter, hidden: new Set() })}>
                Show all
              </button>
            )}
          </h3>
          {owners.length === 0 ? (
            <p className="dash-cal-legend__empty">Nobody has anything in view.</p>
          ) : (
            owners.map((owner) => row(owner.key, owner.name, colorVar(owner.color), !filter.hidden.has(owner.key), () => toggleOwner(owner.key), owner.count))
          )}
        </div>
        <div className="dash-cal-legend__group">
          <h3 className="dash-cal-legend__title">Show</h3>
          {(["event", "deadline", "appointment"] as const).map((kind) =>
            row(kind, `${KIND_LABELS[kind]}s`, "var(--dash-accent)", filter.kinds.has(kind), () => toggleKind(kind)),
          )}
          {row("done", "Done", "var(--dash-accent)", filter.showDone, () => onFilter({ ...filter, showDone: !filter.showDone }))}
          {row("cancelled", "Cancelled", "var(--dash-accent)", filter.showCancelled, () => onFilter({ ...filter, showCancelled: !filter.showCancelled }))}
        </div>
      </div>
    </aside>
  );
};
