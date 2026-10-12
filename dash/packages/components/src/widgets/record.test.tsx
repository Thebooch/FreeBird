// @vitest-environment happy-dom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { WidgetRenderProps } from "../types.js";
import { Record, splitFields } from "./Record.jsx";

/**
 * A record: key fields first, the rest behind "All fields".
 *
 * A Buildium lease sends forty-odd fields, and showing every one at equal
 * weight made the three a person came for — who, how much, until when — the
 * hardest to find.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEASE = {
  Tenant: "Ada Park",
  Rent: 1200,
  Status: "Active",
  MoveOut: null,
  RenewalOfferStatus: "NotSet",
  Id: 41,
  CreatedDateTime: "2026-01-02T10:00:00Z",
};

const props = (overrides: Partial<WidgetRenderProps> = {}): WidgetRenderProps => ({
  rows: [LEASE],
  columns: [
    { name: "Tenant", valueType: "text" },
    { name: "Rent", valueType: "numeric", semantic: "currency" },
    { name: "Status", valueType: "categorical", semantic: "status_enum" },
    { name: "MoveOut", valueType: "temporal", semantic: "timestamp" },
    { name: "RenewalOfferStatus", valueType: "categorical", semantic: "status_enum" },
    { name: "Id", valueType: "numeric", semantic: "identifier" },
    { name: "CreatedDateTime", valueType: "temporal", semantic: "timestamp" },
  ],
  roles: { fields: ["Tenant", "Rent", "Status", "MoveOut"] },
  format: {
    Rent: { semantic: "currency" },
    Status: { semantic: "status_enum" },
    MoveOut: { semantic: "timestamp" },
    RenewalOfferStatus: { semantic: "status_enum" },
  },
  title: "Lease",
  now: 1_700_000_000_000,
  detailFields: ["RenewalOfferStatus", "Id", "CreatedDateTime"],
  ...overrides,
});

describe("Record, split", () => {
  it("shows the key fields and hides the empty ones there", () => {
    const html = renderToStaticMarkup(createElement(Record, props()));
    expect(html).toContain("Ada Park");
    expect(html).toContain("$1,200.00");
    // An empty key field says nothing, so it is not drawn among them.
    expect(html).not.toContain(">Move out<");
  });

  it("puts the rest behind one closed disclosure, counted", () => {
    const html = renderToStaticMarkup(createElement(Record, props()));
    expect(html).toContain("All fields (3)");
    expect(html).not.toMatch(/<details[^>]*open/);
    // Closed means not rendered: nothing behind it is in the page yet.
    expect(html).not.toContain("dash-record__api");
  });

  it("shows every field, as before, on a short record that names no split", () => {
    const html = renderToStaticMarkup(createElement(Record, props({ detailFields: undefined })));
    expect(html).not.toContain("All fields");
    expect(html).toContain("Move out");
  });

  it("picks the key fields itself on a long record that names none", () => {
    const names = Array.from({ length: 20 }, (_, index) => `Field${index}`);
    const split = splitFields(
      {
        columns: [
          ...names.map((name) => ({ name, valueType: "text" as const })),
          { name: "VendorId", valueType: "numeric" as const },
        ],
      },
      [...names, "VendorId"],
      undefined,
    );
    expect(split.keys.length).toBeLessThanOrEqual(10);
    expect(split.keys).not.toContain("VendorId");
    expect(split.more).toContain("VendorId");
    expect(split.keys.length + split.more.length).toBe(21);
  });
});

describe("Record, All fields open", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  const open = async (overrides: Partial<WidgetRenderProps> = {}): Promise<HTMLElement> => {
    host = document.createElement("div");
    host.className = "dash-root";
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(Record, props(overrides))));
    const details = host.querySelector<HTMLDetailsElement>("[data-testid=record-all-fields]")!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    return host;
  };

  it("lists the rest compactly, empties as Not set, each with its API name", async () => {
    const page = await open();
    const all = page.querySelector("[data-testid=record-all-fields]")!;
    expect(all.textContent).toContain("Not set");
    expect(all.querySelectorAll(".dash-record__api").length).toBe(3);
    expect(all.textContent).toContain("RenewalOfferStatus");
  });

  it("offers an edit beside each field once open, and a move to the key fields", async () => {
    const moved: [string, string][] = [];
    const edited: string[] = [];
    const page = await open({
      onEditField: (column) => edited.push(column),
      onMoveField: (column, to) => moved.push([column, to]),
    });
    page.querySelector<HTMLButtonElement>("[data-testid=record-field-edit-Id]")!.click();
    expect(edited).toEqual(["Id"]);

    await act(async () => page.querySelector<HTMLButtonElement>("[data-testid=record-field-menu-Id]")!.click());
    const item = [...page.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemcheckbox]")].find(
      (one) => one.textContent?.includes("Move to key fields"),
    );
    expect(item).toBeDefined();
    await act(async () => item!.click());
    expect(moved).toEqual([["Id", "key"]]);
  });
});
