import { AdapterRegistry, InlineAdapter } from "@freebirdai/dash-adapters";
import { connectionSchema, dashboardSchema, widgetSchema } from "@freebirdai/dash-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WidgetGroup } from "./WidgetGroup.jsx";
import { DashboardProvider } from "./context.jsx";

/**
 * What a group frame actually puts in the tree.
 *
 * The load-bearing assertion here is the cost one. `useWidgetData` fetches on
 * mount and takes no `enabled` flag, and `LazyWidget` cannot stand in for
 * visibility: its `nearViewport` check reads `getBoundingClientRect`, and a
 * `display:none` element reports a zero rect at the origin — which satisfies
 * the near-viewport test. So a frame that hid its inactive members with CSS
 * would fetch every one of them the moment it opened, and keep polling any
 * that declare `refresh.every`, for a tab nobody is looking at.
 *
 * The only defence is to keep them out of the tree, and the only way to know
 * that is still true is to look at the tree.
 */

const widget = (id: string, title: string) =>
  widgetSchema.parse({
    id,
    title,
    component: "table",
    source: { connection: "local", op: "rows" },
    roles: { columns: ["name"] },
  });

const properties = widget("properties", "Properties");
const listings = widget("listings", "Listings");

const registry = () =>
  new AdapterRegistry().register(new InlineAdapter()).addConnection(
    connectionSchema.parse({
      id: "local",
      title: "Local",
      kind: "inline",
      ops: [{ id: "rows", title: "Rows", path: "/rows" }],
    }),
  );

const render = (display: "tabs" | "row" | "stack"): string =>
  renderToStaticMarkup(
    createElement(DashboardProvider, {
      dashboard: dashboardSchema.parse({
        id: "ops",
        title: "Ops",
        widgets: [properties, listings],
        groups: [{ id: "both", title: "Portfolio", display }],
        layout: {
          cells: [
            { widgetId: "properties", x: 0, y: 0, w: 6, h: 6, group: "both" },
            { widgetId: "listings", x: 6, y: 0, w: 6, h: 6, group: "both" },
          ],
        },
      }),
      registry: registry(),
      now: 1_700_000_000_000,
      children: createElement(WidgetGroup, {
        group: { id: "both", title: "Portfolio", display },
        members: [properties, listings],
      }),
    }),
  );

describe("a group frame", () => {
  it("names itself once, above its members", () => {
    expect(render("tabs")).toContain("Portfolio");
  });

  describe("tabs", () => {
    const markup = render("tabs");

    it("offers every member as a tab", () => {
      expect(markup).toContain("Properties");
      expect(markup).toContain("Listings");
    });

    /*
     * The whole reason this file exists. Both titles appear above — in the tab
     * strip — so the strip cannot be the evidence. The panel is.
     */
    it("mounts only the active member", () => {
      const panel = markup.slice(markup.indexOf("dash-group__panel"));
      // Exactly one widget in the panel, and it is the first member. The
      // second is not rendered at all, so it never reaches `useWidgetData`
      // and never spends a request.
      expect(panel.match(/class="dash-widget"/g)).toHaveLength(1);
      expect(panel).not.toContain("Listings");
    });

    it("hides the member's own title, which the tab already carries", () => {
      const panel = markup.slice(markup.indexOf("dash-group__panel"));
      expect(panel).not.toContain("dash-widget__title");
    });
  });

  describe("a row", () => {
    const markup = render("row");

    it("mounts every member, because every one is on screen", () => {
      expect(markup.split("dash-group__member").length - 1).toBe(2);
    });

    it("keeps each member's title, or they are unlabelled", () => {
      expect(markup).toContain("dash-widget__title");
    });

    it("renders no tab strip", () => {
      expect(markup).not.toContain("dash-group__panel");
    });
  });

  it("quiets each member's border so the frame owns the card", () => {
    expect(render("row")).toContain('data-border="off"');
  });
});
