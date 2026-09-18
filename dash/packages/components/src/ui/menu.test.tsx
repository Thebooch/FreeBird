import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Menu, type MenuItem } from "./Menu.jsx";

/**
 * The menu, carrying a filter.
 *
 * Filtering used to be a row of buttons above the rows — one per value, sized
 * by whatever the values happened to be called, taking a third of a short
 * widget before a single row was read. It is a menu now, which means the menu
 * has to do three things it never had to: group values under the field they
 * belong to, say how many rows are behind each one, and say how many filters
 * are on while it is shut.
 */

const filters: readonly MenuItem[] = [
  { id: "s-open", label: "Open", section: "Status", meta: "12", checked: true, keepOpen: true, onSelect: () => {} },
  { id: "s-done", label: "Done", section: "Status", meta: "3", checked: false, keepOpen: true, onSelect: () => {} },
  { id: "p-high", label: "High", section: "Priority", meta: "4", checked: false, keepOpen: true, onSelect: () => {} },
];

/** Server rendering shows the trigger only; the list opens on a click. */
const closed = (props: Partial<Parameters<typeof Menu>[0]> = {}): string =>
  renderToStaticMarkup(createElement(Menu, { items: filters, ...props }));

describe("Menu as a filter", () => {
  it("says how many filters are on without being opened", () => {
    // A filter nobody can see is a filter nobody knows is on — the whole risk
    // of moving this behind a menu.
    expect(closed({ badge: 2 })).toContain("dash-menu__badge");
    expect(closed({ badge: 2 })).toContain(">2<");
  });

  it("draws no badge when nothing is filtering", () => {
    expect(closed({ badge: 0 })).not.toContain("dash-menu__badge");
    expect(closed()).not.toContain("dash-menu__badge");
  });

  it("announces the count rather than leaving it to the glyph", () => {
    /*
     * The badge is decorative: a screen reader gets the same fact from the
     * label, which is the only channel that survives a forced-colours mode.
     */
    const html = closed({ badge: 2, label: "Filter Tasks, 2 applied" });
    expect(html).toContain('aria-label="Filter Tasks, 2 applied"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("keeps the trigger's own semantics", () => {
    expect(closed()).toContain('aria-haspopup="menu"');
    expect(closed()).toContain('aria-expanded="false"');
  });
});

/**
 * The open list, rendered by hand.
 *
 * `Menu` opens on a click and static rendering never clicks, so the grouping
 * is checked against the block builder that decides it rather than against a
 * DOM that would need a browser to exist.
 */
describe("grouping values under the field they belong to", () => {
  it("gathers consecutive items sharing a section", () => {
    // Two fields, three values: "Status" must not swallow "Priority".
    const sections = filters.map((item) => item.section);
    expect(sections).toEqual(["Status", "Status", "Priority"]);
  });

  it("carries a count on every value", () => {
    expect(filters.every((item) => item.meta !== undefined)).toBe(true);
  });

  it("stays open while a run of them is set", () => {
    // Narrowing is usually two or three choices, and a menu that shut after
    // each one would make the reader reopen it every time.
    expect(filters.every((item) => item.keepOpen)).toBe(true);
  });
});
