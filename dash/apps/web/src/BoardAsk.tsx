import { useOptionalDashboard } from "@freebirdai/dash-react";
import { useEffect } from "react";
import { navigate, type Route } from "./route.js";

/**
 * Does what a board's address asks for: `?range=30d` shows the tab for that
 * period, `?panel=connections` opens the Connections panel.
 *
 * This is how "show me the leases widget for last month" lands. The chat says
 * where to go in the app's own addresses, guide's client goes there as it
 * follows a chip, and this applies it like a person using the range control
 * would. The address is then put back to the plain tab, so the range control
 * stays the one place the period is chosen and Back does not undo it twice.
 *
 * Rendered inside the dashboard's provider (with the overlays), since that is
 * where the range lives. The address changes before another tab has loaded, so
 * this waits until the board it is in is the one the address names; applying
 * it a moment early would set the range on the tab being left.
 */
export const BoardAsk = ({ route, onOpenConnections }: { readonly route: Route; readonly onOpenConnections: () => void }): null => {
  const dashboard = useOptionalDashboard();
  const setPreset = dashboard?.setPreset;
  const range = route.kind === "board" ? route.range : undefined;
  const panel = route.kind === "board" ? route.panel : undefined;
  const dashboardId = route.kind === "board" ? route.dashboardId : null;
  const showing = dashboard?.dashboard.id ?? null;
  useEffect(() => {
    if (!range && !panel) return;
    if (range && (!setPreset || (dashboardId !== null && showing !== dashboardId))) return;
    if (range && setPreset) setPreset(range);
    if (panel === "connections") onOpenConnections();
    navigate({ kind: "board", dashboardId }, true);
  }, [range, panel, dashboardId, showing, setPreset, onOpenConnections]);
  return null;
};
