import { AdapterRegistry, InlineAdapter } from "@freebirdai/dash-adapters";
import { connectionSchema, parseDashboard, widgetSchema } from "@freebirdai/dash-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardProvider } from "./context.jsx";
import type { DetailPane } from "./detail.js";
import { RecordView } from "./RecordView.jsx";

/**
 * The tiles a record page leads with.
 *
 * Each counts one of the record's related collections. `Stat` draws the figure
 * and nothing else — on a board the name comes from the widget's title bar,
 * which a pane has not got — so these rendered as bare numbers: a vendor page
 * led with "18" and no indication of eighteen *what*.
 */
const dashboard = parseDashboard({
  id: "board",
  title: "Board",
  params: { defaultRange: "30d", timeZone: "UTC", filters: [] },
  widgets: [],
}).value!;

const connection = connectionSchema.parse({
  id: "api",
  title: "API",
  kind: "inline",
  ops: [{ id: "notes", title: "Notes", path: "/notes" }],
});

const paneSpec = (id: string, title: string, component: string) =>
  widgetSchema.parse({
    id,
    title,
    component,
    source: { connection: "api", op: "notes" },
    pipeline:
      component === "stat"
        ? [
            { op: "extract", path: "$[*]" },
            { op: "derive", fields: { _all: "1" } },
            { op: "group", by: [{ field: "_all" }], agg: { total: "count()" } },
          ]
        : [{ op: "extract", path: "$[*]" }],
    ...(component === "stat" ? { roles: { value: "total" } } : {}),
  });

/**
 * A stat and the section it counts.
 *
 * `entityDetail` only ever emits a stat whose section is on the page — a
 * number with nothing behind it would have no request to compute it from — so
 * a fixture without one would be testing a shape that cannot occur.
 */
const panes: DetailPane[] = [
  {
    id: "stat__notes",
    title: "Vendor notes",
    tab: false,
    spec: paneSpec("vendor__stat__notes", "Vendor notes", "stat"),
  },
  {
    id: "notes",
    title: "Vendor notes",
    tab: false,
    spec: paneSpec("vendor__notes", "Vendor notes", "table"),
  },
];

const render = (rows: unknown[]): string => {
  const adapter = new InlineAdapter();
  adapter.register("api", "notes", () => rows);
  const registry = new AdapterRegistry().register(adapter).addConnection(connection);

  return renderToStaticMarkup(
    createElement(DashboardProvider, {
      dashboard,
      registry,
      now: 1_700_000_000_000,
      children: createElement(RecordView, { panes, row: { Id: 1 }, wide: true }),
    }),
  );
};

describe("record page stat tiles", () => {
  it("names the collection each number counts", () => {
    // Without this a vendor page leads with "18" and no word for what it is.
    const markup = render([{ Id: 1 }]);
    expect(markup).toContain("dash-record-page__stat-label");
    expect(markup).toContain("Vendor notes");
  });

  /*
   * The label is what makes the failing tiles legible too: on a real vendor
   * page two of them were a paragraph of apology with nothing saying which
   * collection they belonged to.
   */
  it("keeps the label when the collection could not be read", () => {
    const markup = renderToStaticMarkup(
      createElement(DashboardProvider, {
        dashboard,
        // No adapter registered for the op, so the pane cannot resolve.
        registry: new AdapterRegistry().addConnection(connection),
        now: 1_700_000_000_000,
        children: createElement(RecordView, { panes, row: { Id: 1 }, wide: true }),
      }),
    );
    expect(markup).toContain("dash-record-page__stat-label");
    expect(markup).toContain("Vendor notes");
  });
});
