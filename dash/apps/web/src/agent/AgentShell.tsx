import { EmptyState } from "@freebirdai/dash-components";
import { AGENT_SECTIONS, type AgentSection, type Route } from "../route.js";
import { AgentsSection } from "./AgentsSection.jsx";
import { CalendarSection } from "./calendar/CalendarSection.jsx";
import { OverviewSection } from "./overview/OverviewSection.jsx";
import { WorkflowsSection } from "./workflows/WorkflowsSection.jsx";

/**
 * The Agent side of the app: fixed sections in place of boards.
 *
 * Which section shows is decided by the route (`#/agent/<section>`), so a
 * reload lands where you were and Back steps through them. A section that is
 * not built yet shows what will live there, so the slot already exists when
 * the step that fills it arrives.
 */

export const SECTION_TITLES: Readonly<Record<AgentSection, string>> = {
  overview: "Overview",
  workflows: "Workflows",
  agents: "Agents",
  calendar: "Calendar",
};

export const AGENT_NAV_SECTIONS = AGENT_SECTIONS.map((id) => ({ id, title: SECTION_TITLES[id] }));

/** What an unbuilt section says it will hold. */
const COMING: Readonly<Partial<Record<AgentSection, { glyph: string; body: string }>>> = {};

export const AgentShell = ({
  route,
  onNavigate,
}: {
  readonly route: Extract<Route, { kind: "agent" }>;
  readonly onNavigate: (route: Route) => void;
}): JSX.Element => {
  const coming = COMING[route.section];
  return (
    <div className="dash-page dash-agent" data-testid={`agent-section-${route.section}`}>
      <div className="dash-agent__inner">
        {route.section === "overview" ? (
          <OverviewSection onNavigate={onNavigate} />
        ) : route.section === "agents" ? (
          <AgentsSection selected={route.id ?? null} onNavigate={onNavigate} />
        ) : route.section === "workflows" ? (
          <WorkflowsSection selected={route.id ?? null} onNavigate={onNavigate} />
        ) : route.section === "calendar" ? (
          <CalendarSection tab={route.id ?? null} onNavigate={onNavigate} />
        ) : (
          <EmptyState
            glyph={coming?.glyph ?? "✦"}
            title={`${SECTION_TITLES[route.section]}: coming soon`}
            body={coming?.body ?? ""}
          />
        )}
      </div>
    </div>
  );
};
