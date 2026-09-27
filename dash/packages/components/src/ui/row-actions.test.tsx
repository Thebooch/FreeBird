import type { Row } from "@freebirdai/dash-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RowAction, WidgetRenderProps } from "../types.js";
import { Board } from "../widgets/Board.jsx";
import { Calendar } from "../widgets/Calendar.jsx";
import { Cards } from "../widgets/Cards.jsx";
import { Feed } from "../widgets/Feed.jsx";
import { List } from "../widgets/List.jsx";
import { Table } from "../widgets/Table.jsx";
import { Timeline } from "../widgets/Timeline.jsx";
import { RowActions } from "./RowActions.jsx";

/**
 * A record can be changed from wherever it is shown, so every component that
 * draws rows draws the same small menu at each row's end — and only where the
 * host says that row's record can be changed.
 */

const ROWS: Row[] = [
  { Id: 1, Name: "Maple Court", Status: "Active", When: "2026-09-01T10:00:00Z" },
  { Id: 2, Name: "Birch Row", Status: "Inactive", When: "2026-09-02T10:00:00Z" },
];

const ACTIONS: RowAction[] = [
  { id: "change-update", label: "Edit", onSelect: () => {} },
  { id: "change-delete", label: "Delete", tone: "danger", onSelect: () => {} },
];

/** Only the first row's record can be changed. */
const onlyFirst = (row: Row): readonly RowAction[] => (row["Id"] === 1 ? ACTIONS : []);

const props = (extra: Partial<WidgetRenderProps> = {}): WidgetRenderProps => ({
  rows: ROWS,
  columns: [
    { name: "Id", valueType: "numeric" },
    { name: "Name", valueType: "text" },
    { name: "Status", valueType: "categorical" },
    { name: "When", valueType: "temporal" },
  ],
  roles: { title: "Name", status: "Status", time: "When", start: "When", group: "Status", columns: ["Name", "Status"] },
  format: {},
  title: "Properties",
  now: Date.parse("2026-09-15T00:00:00Z"),
  timeZone: "UTC",
  ...extra,
});

const count = (html: string, text: string): number => html.split(text).length - 1;

describe("a row's changes", () => {
  it("draws nothing without actions, or with none for the row", () => {
    expect(renderToStaticMarkup(createElement(RowActions, { row: ROWS[0]!, actions: undefined }))).toBe("");
    expect(renderToStaticMarkup(createElement(RowActions, { row: ROWS[1]!, actions: onlyFirst }))).toBe("");
  });

  it("names the record it changes", () => {
    const html = renderToStaticMarkup(createElement(RowActions, { row: ROWS[0]!, actions: onlyFirst, label: "Maple Court" }));
    expect(html).toContain('aria-label="Changes to Maple Court"');
    expect(html).toContain('data-testid="row-actions"');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it.each([
    ["Table", Table],
    ["List", List],
    ["Cards", Cards],
    ["Board", Board],
    ["Feed", Feed],
    ["Timeline", Timeline],
  ] as const)("is drawn by %s for exactly the rows that can be changed", (_name, Component) => {
    const without = renderToStaticMarkup(createElement(Component, props()));
    expect(without).not.toContain("row-actions");
    const html = renderToStaticMarkup(createElement(Component, props({ rowActions: onlyFirst })));
    expect(count(html, 'data-testid="row-actions"')).toBe(1);
    expect(html).toContain("Changes to Maple Court");
  });

  it("is drawn beside a calendar entry, never inside its button", () => {
    const html = renderToStaticMarkup(
      createElement(Calendar, props({ rowActions: onlyFirst, now: Date.parse("2026-09-01T12:00:00Z") })),
    );
    expect(count(html, 'data-testid="row-actions"')).toBe(1);
    expect(html).toContain("dash-calendar__entry-row");
    expect(html).not.toMatch(/<button[^>]*dash-calendar__entry"[^>]*>(?:(?!<\/button>).)*row-actions/s);
  });

  it("gives a table a column of its own, header and total rows included, so no bound column moves", () => {
    const html = renderToStaticMarkup(createElement(Table, props({ rowActions: onlyFirst })));
    expect(html).toContain('<th class="dash-table__actions" aria-label="Changes"></th>');
    expect(count(html, 'class="dash-table__actions"')).toBe(1 + ROWS.length);
  });
});
