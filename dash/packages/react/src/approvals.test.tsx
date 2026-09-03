import { AdapterRegistry, InlineAdapter } from "@freebirdai/dash-adapters";
import { connectionSchema, widgetSchema } from "@freebirdai/dash-spec";
import { dashboardSchema } from "@freebirdai/dash-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardProvider } from "./context.jsx";
import { useWidgetData, type ApprovalVerdict, type WidgetData } from "./useWidgetData.js";

/**
 * The gate has to stop the request, not just the render.
 *
 * An unapproved widget that still fetched would make the approval a label —
 * the data would already have left the API by the time anything decided not
 * to draw it. These render through `renderToStaticMarkup`, which runs the
 * hook and its effects' scheduling without a DOM, and assert on both the
 * state the hook reports and whether the client was ever asked for anything.
 */

const widget = widgetSchema.parse({
  id: "revenue",
  title: "Revenue",
  component: "table",
  source: { connection: "local", op: "rows" },
});

const dashboard = dashboardSchema.parse({
  id: "ops",
  title: "Ops",
  widgets: [widget],
});

const registry = () =>
  new AdapterRegistry()
    .register(new InlineAdapter())
    .addConnection(
      connectionSchema.parse({
        id: "local",
        title: "Local",
        kind: "inline",
        ops: [{ id: "rows", title: "Rows", path: "/rows" }],
      }),
    );

/** Render one widget inside a provider and capture what the hook reported. */
const probe = (approvals?: Readonly<Record<string, ApprovalVerdict>>): WidgetData => {
  let seen: WidgetData | null = null;
  const Probe = (): null => {
    seen = useWidgetData(widget);
    return null;
  };
  renderToStaticMarkup(
    createElement(
      DashboardProvider,
      {
        dashboard,
        registry: registry(),
        now: 1_700_000_000_000,
        ...(approvals ? { approvals } : {}),
      },
      createElement(Probe),
    ),
  );
  if (!seen) throw new Error("probe did not render");
  return seen;
};

describe("widget approval gating", () => {
  it("treats an ungated host exactly as before", () => {
    const data = probe();
    expect(data.approval).toBe("valid");
    expect(data.state).not.toBe("unapproved");
  });

  it("reports unapproved when the widget was never approved", () => {
    const data = probe({ revenue: "absent" });
    expect(data.state).toBe("unapproved");
    expect(data.approval).toBe("absent");
  });

  it("reports unapproved when the widget changed since approval", () => {
    const data = probe({ revenue: "digest-changed" });
    expect(data.state).toBe("unapproved");
    expect(data.approval).toBe("digest-changed");
  });

  it("renders normally for a widget whose approval still holds", () => {
    const data = probe({ revenue: "valid" });
    expect(data.state).not.toBe("unapproved");
  });

  it("does not gate a widget the map says nothing about", () => {
    // A board can carry a widget the approvals map has not caught up with;
    // absent from the map is not the same as recorded-as-unapproved.
    const data = probe({ somethingElse: "absent" });
    expect(data.state).not.toBe("unapproved");
  });

  it("never issues a query for an unapproved widget", () => {
    // `queryKey` is still computed — the hook needs it for its return value —
    // but nothing may be fetched under it.
    const data = probe({ revenue: "absent" });
    expect(data.rows).toEqual([]);
    expect(data.raw).toBeUndefined();
    expect(data.lastFetchedAt).toBe(0);
    expect(data.fetchMeta).toBeNull();
  });
});
