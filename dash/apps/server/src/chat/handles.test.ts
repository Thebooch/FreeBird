import { type DashboardSpec, dashboardSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { pageFor, resolveHandle, selectorFor, workspaceHandles } from "./handles.js";

const widget = (id: string, title = id) => ({
  id,
  title,
  component: "table",
  source: { connection: "acme", op: "list_things" },
  pipeline: [{ op: "extract", path: "$.data" }],
  roles: { columns: ["name"] },
});

const board = (id: string, title: string, widgets: unknown[] = []): DashboardSpec =>
  dashboardSchema.parse({ id, title, widgets, layout: { cells: [] } });

describe("workspaceHandles", () => {
  it("keeps the widget's own id when it is unique across the workspace", () => {
    const handles = workspaceHandles(
      [board("ops", "Ops", [widget("leases")]), board("fin", "Finance", [widget("rent")])],
      "ops",
    );
    expect(handles.map((h) => h.handle)).toEqual(["leases", "rent"]);
  });

  it("qualifies by tab when the same widget id exists on two boards", () => {
    const handles = workspaceHandles(
      [board("ops", "Ops", [widget("leases")]), board("fin", "Finance", [widget("leases")])],
      "ops",
    );
    expect(handles.map((h) => h.handle)).toEqual(["leases--ops", "leases--fin"]);
    // Qualifying one does not rename the other tab's unrelated widgets.
    expect(handles.every((h) => h.widgetId === "leases")).toBe(true);
  });

  it("marks which board is the one being discussed", () => {
    const handles = workspaceHandles(
      [board("ops", "Ops", [widget("a")]), board("fin", "Finance", [widget("b")])],
      "fin",
    );
    expect(handles.map((h) => h.current)).toEqual([false, true]);
  });

  it("steps aside rather than colliding when a widget is named like a qualified handle", () => {
    const handles = workspaceHandles(
      [
        board("ops", "Ops", [widget("leases"), widget("leases--fin")]),
        board("fin", "Finance", [widget("leases")]),
      ],
      "ops",
    );
    const ids = handles.map((h) => h.handle);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("produces citation ids the marker syntax accepts", () => {
    const handles = workspaceHandles(
      [board("ops", "Ops", [widget("leases")]), board("fin", "Finance", [widget("leases")])],
      "ops",
    );
    // CITE_MARKER_RE is /\[\[cite:([a-zA-Z0-9_-]+)\]\]/ — a handle carrying
    // anything else would be stripped from the reply and silently dropped.
    for (const h of handles) expect(h.handle).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("never uses the action tool separator", () => {
    const handles = workspaceHandles(
      [board("ops", "Ops", [widget("leases")]), board("fin", "Finance", [widget("leases")])],
      "ops",
    );
    for (const h of handles) expect(h.handle).not.toContain("__");
  });
});

describe("resolveHandle", () => {
  const handles = workspaceHandles(
    [
      board("ops", "Ops", [widget("leases"), widget("rent")]),
      board("fin", "Finance", [widget("leases")]),
    ],
    "ops",
  );

  it("resolves an exact handle", () => {
    expect(resolveHandle(handles, "leases--fin")?.dashboardId).toBe("fin");
  });

  it("resolves a bare widget id when only one widget carries it", () => {
    expect(resolveHandle(handles, "rent")?.dashboardId).toBe("ops");
  });

  it("refuses a bare widget id that two tabs share", () => {
    // Guessing which "leases" was meant is how a widget on the wrong tab gets
    // removed; the caller reports the ambiguity instead.
    expect(resolveHandle(handles, "leases")).toBeNull();
  });

  it("refuses an id nothing carries", () => {
    expect(resolveHandle(handles, "invented")).toBeNull();
  });
});

describe("anchors", () => {
  it("points at the grid cell attribute the app already renders", () => {
    expect(selectorFor("leases")).toBe('[data-widget-id="leases"]');
  });

  it("points at the app's own hash route for the tab", () => {
    expect(pageFor("finance")).toBe("#/d/finance");
  });

  it("escapes a dashboard id that would otherwise break the route", () => {
    expect(pageFor("a b/c")).toBe("#/d/a%20b%2Fc");
  });
});
