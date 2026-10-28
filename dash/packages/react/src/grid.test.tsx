// @vitest-environment happy-dom
import { AdapterRegistry, InlineAdapter } from "@freebirdai/connect/adapters";
import { connectionSchema, dashboardSchema, widgetSchema } from "@freebirdai/dash-spec";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardGrid } from "./DashboardGrid.jsx";
import { DashboardProvider } from "./context.jsx";

/**
 * The grid, resized.
 *
 * A width animates — the chat docking, the window dragged — and the grid is
 * handed every frame of it. Nothing inside a tile reads the grid's width (a
 * chart that cares measures itself), so a frame that re-rendered every tile
 * did a board's worth of work for nothing: on a board with a long table, that
 * is what made the chat's animation stall.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shellRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("./WidgetShell.jsx", async (original) => ({
  ...(await original<typeof import("./WidgetShell.jsx")>()),
  WidgetShell: () => {
    shellRenders.count++;
    return null;
  },
}));

const widget = (id: string) =>
  widgetSchema.parse({
    id,
    title: id,
    component: "table",
    source: { connection: "local", op: "rows" },
    roles: { columns: ["name"] },
  });

const registry = new AdapterRegistry().register(new InlineAdapter()).addConnection(
  connectionSchema.parse({
    id: "local",
    title: "Local",
    kind: "inline",
    ops: [{ id: "rows", title: "Rows", path: "/rows" }],
  }),
);

const dashboard = dashboardSchema.parse({
  id: "ops",
  title: "Ops",
  widgets: [widget("a"), widget("b")],
  layout: {
    cells: [
      { widgetId: "a", x: 0, y: 0, w: 6, h: 6 },
      { widgetId: "b", x: 6, y: 0, w: 6, h: 6 },
    ],
  },
});

/** The width every element reports, and the observers to tell when it moves. */
let width = 1000;
const observers: Array<() => void> = [];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  shellRenders.count = 0;
  observers.length = 0;
  width = 1000;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        observers.push(this.callback);
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  // Tiles mount at once rather than waiting to scroll into view.
  vi.stubGlobal("IntersectionObserver", undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DashboardGrid", () => {
  it("moves its tiles to a new width without re-rendering what is in them", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        createElement(DashboardProvider, {
          dashboard,
          registry,
          children: createElement(DashboardGrid),
        }),
      );
    });

    const cell = () => host!.querySelector<HTMLElement>('[data-widget-id="b"]')!;
    expect(cell()).not.toBeNull();
    const rendered = shellRenders.count;
    expect(rendered).toBeGreaterThan(0);
    const placedAt = cell().style.transform;

    for (const next of [1100, 1200, 1300]) {
      width = next;
      act(() => observers.forEach((notify) => notify()));
    }

    // The grid did take the new width: the second tile moved right.
    expect(cell().style.transform).not.toBe(placedAt);
    expect(shellRenders.count).toBe(rendered);
  });
});
