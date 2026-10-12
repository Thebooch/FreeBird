// @vitest-environment happy-dom
import { AdapterRegistry, InlineAdapter } from "@freebirdai/connect/adapters";
import { executeWidget } from "@freebirdai/dash-runtime";
import { connectionSchema, parseDashboard, resolveRange, widgetSchema } from "@freebirdai/dash-spec";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetShell } from "./WidgetShell.jsx";
import { DashboardProvider } from "./context.jsx";
import { drillColumns, statDrill } from "./drill.js";

/**
 * A number tile, opened.
 *
 * The promise a clickable number makes is that the list behind it is the
 * list it counted. The list is the tile's own request with the counting taken
 * off, so these check that the two agree rather than trusting that they do.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEASES = [
  { Id: 1, Tenant: "Ada Park", Status: "Active", Rent: 1200, CreatedAt: "2026-01-01" },
  { Id: 2, Tenant: "Ben Ito", Status: "Active", Rent: 950, CreatedAt: "2026-01-02" },
  { Id: 3, Tenant: "Cy Moss", Status: "Ended", Rent: 1100, CreatedAt: "2026-01-03" },
  { Id: 4, Tenant: "Di Lund", Status: "Active", Rent: 1400, CreatedAt: "2026-01-04" },
];

const tile = (agg: string, pipeline?: unknown[]) =>
  widgetSchema.parse({
    id: "active-leases",
    title: "Active leases",
    component: "stat",
    source: { connection: "api", op: "leases" },
    pipeline: pipeline ?? [
      { op: "extract", path: "$[*]" },
      { op: "filter", where: "Status == 'Active'" },
      { op: "derive", fields: { _all: "1" } },
      { op: "group", by: [{ field: "_all" }], agg: { total: agg } },
    ],
    roles: { value: "total" },
  });

const NOW = 1_700_000_000_000;
const PARAMS = { range: resolveRange({ preset: "30d", now: NOW }), filters: {} };

describe("statDrill", () => {
  it("lists exactly as many rows as a count tile says", () => {
    const widget = tile("count()");
    const drill = statDrill(widget)!;
    expect(drill).not.toBeNull();
    expect(drill.spec.pipeline.some((step) => step.op === "group")).toBe(false);

    const counted = executeWidget(widget, LEASES, { now: NOW, params: PARAMS, timeZone: "UTC" });
    const listed = executeWidget(drill.spec, LEASES, { now: NOW, params: PARAMS, timeZone: "UTC" });
    expect(listed.rows.length).toBe(counted.rows[0]?.["total"]);
    expect(listed.rows.length).toBe(3);
  });

  it("keeps the summed column among a sum tile's columns", () => {
    const drill = statDrill(tile("sum(Rent)"))!;
    expect(drill.measure).toEqual({ fn: "sum", field: "Rent" });
    const columns = drillColumns(
      [
        { name: "Id", valueType: "numeric" },
        { name: "Tenant", valueType: "text" },
        { name: "Status", valueType: "categorical" },
        { name: "CreatedAt", valueType: "temporal" },
        { name: "Rent", valueType: "numeric" },
      ],
      undefined,
      drill.measure,
    );
    expect(columns).toContain("Rent");
    expect(columns).toContain("Tenant");
    // Plumbing stays out while there is something readable to show.
    expect(columns).not.toContain("Id");
    expect(columns).not.toContain("CreatedAt");
  });

  it("offers nothing for a number that is not taken over all the rows", () => {
    expect(statDrill(tile("avg(Rent)"))).toBeNull();
    const monthly = tile("count()", [
      { op: "extract", path: "$[*]" },
      { op: "group", by: [{ field: "Status" }], agg: { total: "count()" } },
    ]);
    expect(statDrill(monthly)).toBeNull();
  });
});

describe("number tile in the shell", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  const mount = async (agg: string): Promise<HTMLElement> => {
    const widget = tile(agg);
    const dashboard = parseDashboard({
      id: "board",
      title: "Board",
      params: { defaultRange: "30d", timeZone: "UTC", filters: [] },
      widgets: [widget],
    }).value!;
    const connection = connectionSchema.parse({
      id: "api",
      title: "API",
      kind: "inline",
      ops: [{ id: "leases", title: "Leases", path: "/leases" }],
    });
    const adapter = new InlineAdapter();
    adapter.register("api", "leases", () => LEASES);
    const registry = new AdapterRegistry().register(adapter).addConnection(connection);

    host = document.createElement("div");
    host.className = "dash-root";
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(DashboardProvider, {
          dashboard,
          registry,
          now: NOW,
          children: createElement(WidgetShell, { widget }),
        }),
      );
    });
    // Let the inline read land and the pipeline run.
    for (let i = 0; i < 5 && !host.querySelector("[data-testid=stat-drill-open]"); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    return host;
  };

  it("opens the rows a count tile counted, one table row each", async () => {
    const page = await mount("count()");
    const button = page.querySelector<HTMLButtonElement>("[data-testid=stat-drill-open]");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-label")).toBe("Show the 3 records");

    await act(async () => button!.click());
    for (let i = 0; i < 5 && page.querySelectorAll("[data-testid=stat-drill] tbody tr").length === 0; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    const rows = page.querySelectorAll("[data-testid=stat-drill] tbody tr");
    expect(rows.length).toBe(3);
  });

  it("makes the whole card the target, with the menus kept above it", async () => {
    const page = await mount("count()");
    // The card carries the marker the stretched button and the raised menus key off.
    expect(page.querySelector(".dash-widget")?.getAttribute("data-drill")).toBe("true");
    expect(page.querySelector(".dash-widget [data-testid=stat-drill-open]")).not.toBeNull();
    // No "stale" badge: the footer says how long ago it was read.
    expect(page.querySelector(".dash-badge")?.textContent ?? "").not.toContain("stale");
  });

  it("shows a sum tile's total at the foot of its list", async () => {
    const page = await mount("sum(Rent)");
    await act(async () => page.querySelector<HTMLButtonElement>("[data-testid=stat-drill-open]")!.click());
    for (let i = 0; i < 5 && !page.querySelector("[data-testid=stat-drill-total]"); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(page.querySelector("[data-testid=stat-drill-total]")?.textContent).toContain("3,550");
  });

  it("draws the widget's menu outside the card, so the card cannot clip it", async () => {
    const page = await mount("count()");
    const trigger = page.querySelector<HTMLButtonElement>("[data-testid=actions-active-leases]");
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());

    const list = page.querySelector(".dash-menu__list");
    expect(list).not.toBeNull();
    expect(list!.getAttribute("data-floating")).toBe("true");
    expect(list!.closest(".dash-widget")).toBeNull();
    expect(list!.parentElement).toBe(page);
  });
});
