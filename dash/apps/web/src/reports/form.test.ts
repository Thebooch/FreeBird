import type { DashboardSpec, Report } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { formOf, includesLine, inputOf, splitRecipients } from "./form.js";

/* Only what the form reads: the id, the title and the widgets' names. */
const board = {
  id: "props",
  title: "Properties",
  widgets: [
    { id: "units", title: "Vacant units", component: "table", roles: {} },
    { id: "vacant", title: "Vacancies", component: "stat", roles: {} },
  ],
} as unknown as DashboardSpec;

const saved: Report = {
  id: "r1",
  name: "Mine",
  enabled: true,
  schedule: { cron: "30 7 * * 1-5", timezone: "America/Chicago" },
  recipients: ["pat@acme.test"],
  optedOut: [],
  blocks: [
    { kind: "widget", dashboard: "props", widget: "vacant" },
    { kind: "tab", dashboard: "leasing" },
    { kind: "text", markdown: "Hello" },
  ],
  summary: "none",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("the Reports pop-up's form", () => {
  it("starts as a weekly report of the whole tab", () => {
    const form = formOf(board, undefined, "UTC");
    const result = inputOf({ ...form, recipients: "pat@acme.test" }, board);
    expect(result).toEqual({
      ok: true,
      input: {
        name: "Properties report",
        enabled: true,
        schedule: { cron: "0 8 * * 1", timezone: "UTC" },
        recipients: ["pat@acme.test"],
        blocks: [{ kind: "tab", dashboard: "props" }],
        summary: "auto",
      },
    });
  });

  it("edits only this tab's part of a report, and keeps the rest", () => {
    const form = formOf(board, saved);
    expect(form).toMatchObject({ include: "widgets", widgets: ["vacant"], every: "weekday", time: "07:30", summary: false });
    const result = inputOf({ ...form, widgets: ["units", "vacant"] }, board);
    expect(result.ok && result.input.blocks).toEqual([
      { kind: "widget", dashboard: "props", widget: "units" },
      { kind: "widget", dashboard: "props", widget: "vacant" },
      { kind: "tab", dashboard: "leasing" },
      { kind: "text", markdown: "Hello" },
    ]);
    expect(includesLine(saved, board)).toBe("Vacancies, and 2 more pieces");
  });

  it("keeps what each reader wants emphasized, only while summaries are on", () => {
    const form = { ...formOf(board, undefined, "UTC"), recipients: "pat@acme.test", include: "widgets" as const, widgets: ["vacant"], widgetEmphasis: { vacant: " Did vacancies go up? " } };
    const on = inputOf(form, board);
    expect(on.ok && on.input.blocks).toEqual([{ kind: "widget", dashboard: "props", widget: "vacant", emphasis: "Did vacancies go up?" }]);
    const off = inputOf({ ...form, summary: false }, board);
    expect(off.ok && off.input.blocks).toEqual([{ kind: "widget", dashboard: "props", widget: "vacant" }]);
    const tab = inputOf({ ...form, include: "tab", tabEmphasis: "Any leaks?" }, board);
    expect(tab.ok && tab.input.blocks).toEqual([{ kind: "tab", dashboard: "props", emphasis: "Any leaks?" }]);
    expect(formOf(board, { ...saved, blocks: [{ kind: "widget", dashboard: "props", widget: "vacant", emphasis: "Up?" }] }).widgetEmphasis).toEqual({ vacant: "Up?" });
  });

  it("says what is missing", () => {
    const form = formOf(board, undefined, "UTC");
    expect(inputOf(form, board)).toEqual({ ok: false, error: "Add at least one email address." });
    expect(inputOf({ ...form, recipients: "pat@acme.test, nope" }, board)).toEqual({ ok: false, error: '"nope" isn\'t an email address.' });
    expect(inputOf({ ...form, recipients: "pat@acme.test", include: "widgets" }, board)).toMatchObject({ ok: false });
  });

  it("reads addresses however they were typed", () => {
    expect(splitRecipients("Pat@Acme.test, lee@acme.test;\nlee@acme.test  sam@acme.test")).toEqual(["pat@acme.test", "lee@acme.test", "sam@acme.test"]);
  });
});
