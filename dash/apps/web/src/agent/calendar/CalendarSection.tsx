import { Tabs } from "@freebirdai/dash-components";
import type { Route } from "../../route.js";
import { CalendarBoard } from "./CalendarBoard.jsx";

/**
 * The Calendar section on the Agent side.
 *
 * Its tabs are addresses (`#/agent/calendar/<tab>`), so a reload lands on the
 * tab you were on and Back steps through them. The calendar itself is the
 * first; scheduling's setup (appointment types, blocks, people and pools)
 * sits beside it as each part arrives.
 */

export const CALENDAR_TABS = [{ id: "calendar", label: "Calendar" }] as const;
export type CalendarTab = (typeof CALENDAR_TABS)[number]["id"];

export const CalendarSection = ({
  tab,
  onNavigate,
}: {
  readonly tab: string | null;
  readonly onNavigate: (route: Route) => void;
}): JSX.Element => {
  const active: CalendarTab = CALENDAR_TABS.some((one) => one.id === tab) ? (tab as CalendarTab) : "calendar";
  return (
    <div className="dash-cal-page" data-testid="calendar-section">
      <header className="dash-cal-page__head">
        <div>
          <h1 className="dash-cal-page__title">Calendar</h1>
          <p className="dash-cal-page__lede">Everything your agents, workflows and team have scheduled, each in its owner's colour.</p>
        </div>
      </header>
      {CALENDAR_TABS.length > 1 && (
        <div className="dash-cal-page__tabs">
          <Tabs
            label="Calendar"
            tabs={CALENDAR_TABS}
            activeId={active}
            onSelect={(id) => onNavigate({ kind: "agent", section: "calendar", ...(id === "calendar" ? {} : { id }) })}
          />
        </div>
      )}
      {active === "calendar" && <CalendarBoard onNavigate={onNavigate} />}
    </div>
  );
};
