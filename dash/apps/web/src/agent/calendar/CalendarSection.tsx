import { Tabs } from "@freebirdai/dash-components";
import { useEffect, useMemo, useState } from "react";
import { api, type SchedulingOverview } from "../../api.js";
import type { Route } from "../../route.js";
import { CalendarBoard } from "./CalendarBoard.jsx";
import { memberColor, type Person } from "./model.js";
import { BlocksTab } from "./scheduling/BlocksTab.jsx";
import { PeopleTab } from "./scheduling/PeopleTab.jsx";
import { SettingsTab } from "./scheduling/SettingsTab.jsx";
import { TypesTab } from "./scheduling/TypesTab.jsx";
import type { DashScreen } from "@freebirdai/dash-spec";
import { useChatScreen } from "../chatScreen.js";

/**
 * The Calendar section on the Agent side.
 *
 * Its tabs are addresses (`#/agent/calendar/<tab>`), so a reload lands on the
 * tab you were on and Back steps through them: the calendar itself, then
 * scheduling's setup — appointment types, blocks, the people and pools whose
 * time is booked, and the workspace's defaults.
 */

export const CALENDAR_TABS = [
  { id: "calendar", label: "Calendar" },
  { id: "types", label: "Appointment types" },
  { id: "blocks", label: "Blocks" },
  { id: "people", label: "People & pools" },
  { id: "settings", label: "Settings" },
] as const;
export type CalendarTab = (typeof CALENDAR_TABS)[number]["id"];

/** The chat's screens each tab shows. */
const TAB_SCREENS: Readonly<Record<CalendarTab, readonly DashScreen[]>> = {
  calendar: ["calendar", "bookings"],
  types: ["types"],
  blocks: ["blocks"],
  people: ["people"],
  settings: ["settings"],
};

const LEDES: Readonly<Record<CalendarTab, string>> = {
  calendar: "Everything your agents, workflows and team have scheduled, each in its owner's colour.",
  types: "What people can book: how long it takes, who hosts it, and whether it needs approval.",
  blocks: "Rules for who can book at which times, placed on calendars.",
  people: "Whose time can be booked, and how a pool shares the work.",
  settings: "The defaults every booking starts from.",
};

export const CalendarSection = ({
  tab,
  onNavigate,
}: {
  readonly tab: string | null;
  readonly onNavigate: (route: Route) => void;
}): JSX.Element => {
  const active: CalendarTab = CALENDAR_TABS.some((one) => one.id === tab) ? (tab as CalendarTab) : "calendar";
  /* The tab on screen is what the chat takes "this" and "here" to mean. */
  useChatScreen(TAB_SCREENS[active]);
  const [setup, setSetup] = useState<SchedulingOverview | null>(null);

  /* Who is who on the calendar: people's names and colours, read again when the tab changes. */
  useEffect(() => {
    void api.scheduling().then(setSetup, () => undefined);
  }, [active]);

  const people = useMemo(
    () => new Map<string, Person>((setup?.profiles ?? []).map((profile) => [profile.member, { name: profile.displayName, color: profile.color ?? memberColor(profile.member) }])),
    [setup],
  );

  return (
    <div className="dash-cal-page" data-testid="calendar-section">
      <header className="dash-cal-page__head">
        <div>
          <h1 className="dash-cal-page__title">Calendar</h1>
          <p className="dash-cal-page__lede">{LEDES[active]}</p>
        </div>
      </header>
      <div className="dash-cal-page__tabs">
        <Tabs
          label="Calendar"
          tabs={CALENDAR_TABS}
          activeId={active}
          onSelect={(id) => onNavigate({ kind: "agent", section: "calendar", ...(id === "calendar" ? {} : { id }) })}
        />
      </div>
      {active === "calendar" && <CalendarBoard onNavigate={onNavigate} people={people} hosts={setup?.profiles ?? []} blocks={setup?.blocks ?? []} />}
      {active === "types" && <TypesTab />}
      {active === "blocks" && <BlocksTab />}
      {active === "people" && <PeopleTab />}
      {active === "settings" && <SettingsTab />}
    </div>
  );
};
