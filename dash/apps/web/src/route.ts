/**
 * Where you are, in the address bar.
 *
 * Hand-rolled rather than a router dependency, for the same reason this repo
 * hand-rolls its JSONPath and its env loader: the whole surface is two shapes
 * and a `popstate` listener, and a routing library would bring a component
 * model, a data-loading opinion and a major-version treadmill to hold them.
 *
 * Hash-based so a self-hoster can serve the app from a plain static directory
 * with no rewrite rule. A path-based URL 404s on refresh unless the server is
 * configured for it, and "works until you reload" is a bad trade for tidier
 * addresses.
 */

export type Route =
  | { readonly kind: "board"; readonly dashboardId: string | null }
  | {
      readonly kind: "record";
      readonly dashboardId: string;
      readonly widgetId: string;
      /** The record's identifier, as it appeared in the row. */
      readonly recordId: string;
    };

export const BOARD_ROUTE: Route = { kind: "board", dashboardId: null };

/**
 * Read a route out of a hash.
 *
 * Anything unrecognised is the board rather than an error page: a stale or
 * hand-edited link should land somewhere useful, not somewhere apologetic.
 */
export const parseRoute = (hash: string): Route => {
  const parts = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter((part) => part !== "")
    .map(decodeURIComponent);

  if (parts[0] !== "d" || !parts[1]) return BOARD_ROUTE;
  const dashboardId = parts[1];

  if (parts[2] === "w" && parts[3] && parts[4] === "r" && parts[5]) {
    return { kind: "record", dashboardId, widgetId: parts[3], recordId: parts[5] };
  }
  return { kind: "board", dashboardId };
};

export const routeToHash = (route: Route): string => {
  if (route.kind === "board") {
    return route.dashboardId ? `#/d/${encodeURIComponent(route.dashboardId)}` : "#/";
  }
  return (
    `#/d/${encodeURIComponent(route.dashboardId)}` +
    `/w/${encodeURIComponent(route.widgetId)}` +
    `/r/${encodeURIComponent(route.recordId)}`
  );
};

export const currentRoute = (): Route =>
  parseRoute(typeof window === "undefined" ? "" : window.location.hash);

/**
 * Go somewhere, leaving a way back.
 *
 * `pushState` rather than assigning `location.hash`, so the entry carries our
 * own state and the browser's Back button steps through record views the way
 * it steps through anything else.
 */
export const navigate = (route: Route, replace = false): void => {
  const url = routeToHash(route);
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  // `pushState` does not fire `popstate`, so the app is told directly.
  window.dispatchEvent(new Event("dash:route"));
};

/** Subscribe to route changes, from the Back button or from `navigate`. */
export const onRouteChange = (listener: () => void): (() => void) => {
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  window.addEventListener("dash:route", listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
    window.removeEventListener("dash:route", listener);
  };
};
