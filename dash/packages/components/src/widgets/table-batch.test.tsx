// @vitest-environment happy-dom
import { presentationSchema } from "@freebirdai/dash-spec";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetRenderProps } from "../types.js";
import { Table } from "./Table.jsx";

/**
 * A long table, drawn as it is read.
 *
 * Six hundred rows in a tile that shows a dozen made a board slow to open,
 * sort and search. An unpaged table draws a batch and adds the next as the
 * reader nears its end — and sorting and searching still act on every row,
 * drawn or not.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROWS = Array.from({ length: 250 }, (_, index) => ({ Name: `Unit ${String(index).padStart(3, "0")}` }));

const props = (overrides: Partial<WidgetRenderProps> = {}): WidgetRenderProps => ({
  rows: ROWS,
  columns: [{ name: "Name", valueType: "text" }],
  roles: { columns: ["Name"] },
  format: {},
  title: "Units",
  now: 1_700_000_000_000,
  ...overrides,
});

/** The callback each observer was made with, to say the end came into range. */
const observed: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mount = (overrides: Partial<WidgetRenderProps> = {}): void => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Table, props(overrides))));
};

const drawn = (): number => host!.querySelectorAll("tbody tr:not(.dash-table__more)").length;
const more = (): HTMLElement | null => host!.querySelector('[data-testid="table-more"]');

beforeEach(() => {
  observed.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        observed.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe("Table, batched", () => {
  it("draws the first batch and says how many there are", () => {
    mount();
    expect(drawn()).toBe(100);
    expect(more()?.textContent).toContain("Showing 100 of 250 rows");
  });

  it("adds the next batch when the end comes into range, and stops at the last row", () => {
    mount();
    act(() => observed.at(-1)!([{ isIntersecting: true }]));
    expect(drawn()).toBe(200);
    act(() => observed.at(-1)!([{ isIntersecting: true }]));
    expect(drawn()).toBe(250);
    expect(more()).toBeNull();
  });

  it("adds a batch from the button, for whoever gets there without scrolling", () => {
    mount();
    act(() => more()!.querySelector("button")!.click());
    expect(drawn()).toBe(200);
  });

  it("sorts every row, not only the ones drawn", () => {
    mount();
    act(() => host!.querySelector<HTMLButtonElement>('[data-testid="sort-Name"]')!.click());
    act(() => host!.querySelector<HTMLButtonElement>('[data-testid="sort-Name"]')!.click());
    // Descending: the last row of the endpoint, never drawn before, comes first.
    expect(host!.querySelector("tbody td")?.textContent).toBe("Unit 249");
  });

  it("draws every row where nothing can say when the end is near", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const html = renderToStaticMarkup(createElement(Table, props()));
    expect(html).toContain("Unit 249");
    expect(html).not.toContain("dash-table__more");
  });

  it("leaves a paged table to its pages", () => {
    mount({ presentation: presentationSchema.parse({ settings: { pageSize: 25 } }) });
    expect(drawn()).toBe(25);
    expect(more()).toBeNull();
  });
});
