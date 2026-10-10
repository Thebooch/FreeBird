import { argumentNames, citationOf, createComponentRegistry, deriveActionPreview, runAction, transientOf, withoutTransient } from "@freebirdai/core";
import type { AgentSpec, Principal } from "@freebirdai/dash-spec";
import { describe, expect, it, vi } from "vitest";
import { BookingLinks } from "../../bookings/links.js";
import { DEFAULT_BRAND, notConnectedNotifier } from "../../bookings/notify.js";
import { BookingService, bookingsAsBusy } from "../../bookings/service.js";
import { MemoryBookingStore } from "../../bookings/store.js";
import { CalendarService } from "../../calendar/service.js";
import { MemoryCalendarStore } from "../../calendar/store.js";
import { ContactService } from "../../contacts/service.js";
import { MemoryContactStore } from "../../contacts/store.js";
import { MemoryPublicTokenStore } from "../../public/tokens.js";
import { SchedulingService } from "../../scheduling/service.js";
import { MemorySchedulingStore } from "../../scheduling/store.js";
import { agentOf } from "../../workflows/testing.js";
import { MemoryTaskStore } from "../../workflows/store.js";
import { buildChatRegistry } from "../registry.js";
import { SCREENS, buildScreens } from "./index.js";

const CHICAGO = "America/Chicago";
/** Monday 12 October 2026, 6:00 in Chicago. */
const START = Date.parse("2026-10-12T11:00:00Z");

const owner: Principal = { userId: "sam", workspaceId: "acme", role: "owner", kind: "member" };
const viewer: Principal = { userId: "vic", workspaceId: "acme", role: "viewer", kind: "member" };
const authOf = (principal: Principal) => ({ userId: principal.userId, extra: { principal } });

/** The services as the server builds them, in memory, with one host, two types and one contact. */
const world = async () => {
  let n = 0;
  const now = () => START;
  const calendarStore = new MemoryCalendarStore();
  const store = new MemoryBookingStore();
  const contacts = new ContactService({ store: new MemoryContactStore(), now, newId: () => `c${++n}` });
  const scheduling = new SchedulingService({
    store: new MemorySchedulingStore(),
    calendar: calendarStore,
    members: async () => [
      { userId: "sam", email: "sam@acme.test", role: "owner" },
      { userId: "vic", email: "vic@acme.test", role: "viewer" },
    ],
    bookings: bookingsAsBusy(store),
    factKinds: () => contacts.factKinds(),
    contacts,
    now,
  });
  const bookings = new BookingService({ store, scheduling, contacts, calendar: calendarStore, now, newId: () => `b${++n}` });
  await scheduling.putProfile("sam", { displayName: "Sam", bookable: true, timezone: CHICAGO });
  await scheduling.putType("showing", { name: "Showing", slug: "showing", hosts: { members: ["sam"] }, settings: { length: "30m", slotStep: "30m", minNotice: "0m" } });
  const ana = await contacts.findOrCreate({ email: "ana@example.com", name: "Ana Lopez", origin: "member" });
  const links = new BookingLinks({
    tokens: new MemoryPublicTokenStore(),
    bookings,
    scheduling,
    contacts,
    members: async () => [{ userId: "sam", email: "sam@acme.test", role: "owner" }],
    notifier: notConnectedNotifier,
    brand: async () => DEFAULT_BRAND,
    workspace: "acme",
    origin: "https://dash.example.com",
    now,
  });
  const agent: AgentSpec = { ...agentOf({ tools: [] }), id: "leasing", name: "Leasing" };
  const updateAgent = vi.fn(async (_principal: Principal, _id: string, input: unknown) => ({ ...agent, ...(input as object) }) as AgentSpec);
  const changed = vi.fn();
  const may = async (principal: Principal) => principal.role !== "viewer";
  const calendar = new CalendarService({ store: calendarStore, now, newId: () => `e${++n}` });
  const build = async () =>
    buildScreens({
      may,
      now,
      changed,
      calendar,
      scheduling,
      bookings,
      contacts,
      links,
      tasks: new MemoryTaskStore(),
      agents: { roster: [agent], update: updateAgent },
      setup: await scheduling.overview(),
      contactSetup: await contacts.setup(),
    });
  /** Run one action as `/actions/confirm` would, on screens built afresh (a new turn). */
  const run = async (componentId: string, actionId: string, args: Record<string, unknown>, principal: Principal = owner) => {
    const registry = createComponentRegistry();
    for (const screen of await build()) registry.register(screen);
    return runAction(registry, { componentId, actionId, args, auth: authOf(principal), sessionId: "s1", recordId: "r1" });
  };
  /** The card a proposal shows, before anything runs. */
  const card = async (componentId: string, actionId: string, args: Record<string, unknown>) => {
    const registry = createComponentRegistry();
    for (const screen of await build()) registry.register(screen);
    const def = registry.getAction(componentId, actionId)!;
    const resolved = def.preflight ? await def.preflight(args as never, { auth: authOf(owner), sessionId: "s1" }) : { ok: true as const };
    return deriveActionPreview(def, { ...args, ...(resolved.ok ? (resolved.resolvedArgs ?? {}) : {}) }, { componentId });
  };
  return { scheduling, contacts, bookings, calendar, links, build, run, card, changed, updateAgent, ana: ana.id };
};

describe("the calendar's and contacts' screens, as the chat's components", () => {
  it("registers every screen with its place in the app, and says what each action takes", async () => {
    const { build } = await world();
    const screens = await build();
    expect(screens.map((one) => one.id)).toEqual(Object.values(SCREENS).map((one) => one.id));
    for (const screen of screens) {
      expect(screen.domAnchor).toEqual({ selector: `[data-freebird-component="${screen.id}"]`, page: Object.values(SCREENS).find((one) => one.id === screen.id)!.page });
      for (const action of screen.actions ?? []) {
        if (action.requiresConfirmation === "none") continue;
        /* Every change asks first, says who may, and builds its own card. */
        expect(action.requiresConfirmation, action.id).toBe("preview");
        expect(action.authorize, action.id).toBeTypeOf("function");
        expect(action.preview, action.id).toBeTypeOf("function");
      }
    }
    expect(argumentNames(screens.find((one) => one.id === "calendar-types")!.actions!.find((one) => one.id === "update_type")!.schema)).toContain("approval");
  });

  it("sits beside the dashboard's own components, and a widget never takes a screen's id", async () => {
    const { build } = await world();
    const board = { id: "ops", title: "Ops", widgets: [{ id: "calendar", title: "Calendar", component: "table", source: { connection: "acme", op: "list" }, pipeline: [], roles: {} }], layout: { cells: [] } };
    const registry = buildChatRegistry({
      dashboard: board as never,
      reports: [],
      board: { getDashboard: () => board as never, getDashboardById: () => board as never, putDashboard: () => undefined, createDashboard: () => board as never, deleteDashboard: () => undefined },
      screens: await build(),
    });
    const ids = registry.list().map((one) => one.id);
    expect(ids).toContain("calendar");
    expect(ids).toContain("calendar--ops");
    expect(registry.get("calendar")?.title).toBe("Calendar");
  });
});

describe("appointment types from the chat", () => {
  it("shows a change as before → after, applies only that, and says where it landed", async () => {
    const { card, run, scheduling, changed } = await world();
    const preview = await card("calendar-types", "update_type", { type: "showing", approval: "always", length: "45m" });
    expect(preview.title).toBe('Change "Showing"');
    expect(preview.rows).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Length", value: "30m → 45m" }), expect.objectContaining({ label: "Needs approval", value: "Always" })]));

    const done = await run("calendar-types", "update_type", { type: "Showing", approval: "always", length: "45m" });
    expect(done.kind).toBe("executed");
    const type = await scheduling.findType("showing");
    expect(type?.settings).toMatchObject({ approval: "always", length: "45m", slotStep: "30m", minNotice: "0m" });
    expect(type?.name).toBe("Showing");
    expect(changed).toHaveBeenCalled();
    const cited = citationOf((done as { result: unknown }).result);
    expect(cited).toMatchObject({ title: "Showing", page: "#/agent/calendar/types", selector: '[data-freebird-component="calendar-types"] [data-freebird-item="showing"]' });
    expect(cited?.summary).toContain("Needs approval: Always");
  });

  it("sets who can book and what someone it does not take is told, and stops a setting to follow the workspace", async () => {
    const { run, scheduling } = await world();
    await run("calendar-types", "update_type", {
      type: "showing",
      whoCanBook: { all: [{ field: "request.partySize", op: "lte", values: [8] }], any: [] },
      turnedAwayMessage: "For 9 or more, please call us.",
      inherit: ["minNotice"],
    });
    const type = await scheduling.findType("showing");
    expect(type?.eligibility).toMatchObject({ rules: { all: [{ field: "request.partySize", op: "lte", values: [8] }] }, message: "For 9 or more, please call us." });
    expect(type?.settings.minNotice).toBeUndefined();
    expect(type?.settings.length).toBe("30m");
  });

  it("names what is not there instead of guessing, on the field to correct", async () => {
    const { run } = await world();
    const out = await run("calendar-types", "update_type", { type: "Shoing", approval: "always" });
    expect(out).toMatchObject({ kind: "blocked", blockers: [{ field: "type" }] });
    expect((out as { message: string }).message).toContain("Types: Showing");
  });

  it("makes a new type with its hosts, and lets an agent book it", async () => {
    const { run, scheduling, updateAgent } = await world();
    expect((await run("calendar-types", "create_type", { name: "Move-in walkthrough", hostMembers: ["Sam"], length: "60m" })).kind).toBe("executed");
    const made = await scheduling.findType("move-in-walkthrough");
    expect(made).toMatchObject({ name: "Move-in walkthrough", hosts: { members: ["sam"] }, settings: { length: "60m" } });

    expect((await run("calendar-types", "let_agent_book", { agent: "Leasing", types: ["Move-in walkthrough"], mode: "auto" })).kind).toBe("executed");
    const tools = (updateAgent.mock.calls[0]![2] as { tools: Array<{ kind: string; mode: string; schedule: { types: string[] } }> }).tools;
    expect(tools).toEqual([expect.objectContaining({ kind: "schedule_appointment", mode: "auto", schedule: expect.objectContaining({ types: ["move-in-walkthrough"] }) })]);
  });

  it("refuses someone whose role cannot change scheduling, before anything runs", async () => {
    const { run, scheduling } = await world();
    const out = await run("calendar-types", "update_type", { type: "showing", approval: "always" }, viewer);
    expect(out).toMatchObject({ kind: "unauthorized", status: 403 });
    expect((await scheduling.findType("showing"))?.settings.approval).toBeUndefined();
  });
});

describe("the rest of scheduling's setup from the chat", () => {
  it("changes a host's hours and settings, a pool, the defaults, and places a repeating block", async () => {
    const { run, scheduling } = await world();
    expect((await run("calendar-people", "set_up_host", { host: "Sam", hours: { mon: [{ from: "08:00", to: "12:00" }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }, maxPerDay: 4 })).kind).toBe("executed");
    expect((await scheduling.findProfile("sam"))).toMatchObject({ hours: { mon: [{ from: "08:00", to: "12:00" }] }, settings: { maxPerDay: 4 } });

    expect((await run("calendar-people", "set_up_pool", { pool: "Leasing team", timezone: CHICAGO, members: [{ host: "Sam" }], assign: "least_busy" })).kind).toBe("executed");
    expect(await scheduling.findPool("leasing-team")).toMatchObject({ name: "Leasing team", assign: "least_busy", members: [{ member: "sam", priority: 1, active: true }] });

    expect((await run("calendar-settings", "change_scheduling_defaults", { buffer: "15m", horizon: "60d" })).kind).toBe("executed");
    expect((await scheduling.overview()).defaults).toMatchObject({ buffer: "15m", horizon: "60d" });

    expect((await run("calendar-blocks", "set_up_block", { block: "Mornings", kind: "set", types: ["Showing"], maxBookings: 3 })).kind).toBe("executed");
    const placed = await run("calendar-blocks", "place_block", { block: "Mornings", on: "Sam", start: "2026-10-13T08:00", end: "2026-10-13T12:00", repeat: { every: "week", weekdays: ["tue", "thu"] } });
    expect(placed.kind).toBe("executed");
    const [placement] = (await scheduling.overview()).placements;
    expect(placement).toMatchObject({ block: "mornings", target: { kind: "member", id: "sam" }, timezone: CHICAGO, repeat: { every: "week", weekdays: [2, 4] } });
    expect((await run("calendar-blocks", "skip_occurrence", { placement: placement!.id, date: "2026-10-15" })).kind).toBe("executed");
    expect((await scheduling.overview()).placements[0]!.except).toEqual(["2026-10-15"]);
  });
});

describe("bookings from the chat", () => {
  it("finds a time, books it for a contact, and confirms, moves and cancels through the service", async () => {
    const { run, bookings, ana } = await world();
    const found = await run("calendar-bookings", "find_times", { type: "Showing", contact: "Ana" });
    const first = ((found as { result: { slots: Array<{ start: string }> } }).result.slots)[0]!;
    const booked = await run("calendar-bookings", "book_for_contact", { type: "Showing", contact: "ana@example.com", start: first.start, needsApproval: true });
    expect(booked.kind).toBe("executed");
    const [made] = await bookings.list({ contact: ana });
    expect(made).toMatchObject({ status: "pending", host: "sam" });

    expect((await run("calendar-bookings", "confirm_booking", { booking: made!.id })).kind).toBe("executed");
    expect((await bookings.get(made!.id)).status).toBe("confirmed");
    const later = ((found as { result: { slots: Array<{ start: string }> } }).result.slots)[2]!;
    expect((await run("calendar-bookings", "move_booking", { booking: made!.id, start: later.start })).kind).toBe("executed");
    expect((await bookings.get(made!.id)).start).toBe(later.start);
    expect((await run("calendar-bookings", "cancel_booking", { booking: made!.id, reason: "They called" })).kind).toBe("executed");
    expect((await bookings.get(made!.id)).status).toBe("cancelled");
  });

  it("names the booking on its card from what it is now", async () => {
    const { run, card, bookings, ana } = await world();
    const found = await run("calendar-bookings", "find_times", { type: "showing", contact: ana });
    await run("calendar-bookings", "book_for_contact", { type: "showing", contact: ana, start: (found as { result: { slots: Array<{ start: string }> } }).result.slots[0]!.start });
    const [made] = await bookings.list({ contact: ana });
    const preview = await card("calendar-bookings", "cancel_booking", { booking: made!.id });
    expect(preview.rows[0]).toMatchObject({ label: "Booking", value: expect.stringContaining("Ana Lopez · Showing with Sam") });
  });
});

describe("links that are keys", () => {
  it("are shown once to the person who approved, and kept nowhere in the conversation", async () => {
    const { run, ana } = await world();
    const made = await run("contacts", "make_contact_link", { contact: "Ana Lopez", type: "Showing" });
    expect(made.kind).toBe("executed");
    const result = (made as { result: unknown }).result;
    expect(transientOf(result)?.link).toMatch(/^https:\/\/dash\.example\.com\/p\/acme\/book\//);
    const kept = JSON.stringify(withoutTransient(result));
    expect(kept).not.toContain("/p/acme/book/");
    expect(citationOf(result)?.summary).not.toContain("http");
    expect(citationOf(result)?.selector).toContain(`[data-freebird-item="${ana}"]`);
  });
});

describe("contacts and the calendar from the chat", () => {
  it("adds and changes a contact, and adds, changes and finishes a calendar entry", async () => {
    const { run, contacts, calendar } = await world();
    expect((await run("contacts", "add_contact", { name: "Bo Chen", phones: ["512 555 0142"] })).kind).toBe("executed");
    const bo = (await contacts.list({ search: "Bo" })).contacts[0]!;
    expect(bo.phones).toEqual(["+15125550142"]);
    expect((await run("contacts", "update_contact", { contact: "Bo Chen", emails: ["bo@example.com"], channel: "text" })).kind).toBe("executed");
    expect(await contacts.get(bo.id)).toMatchObject({ emails: ["bo@example.com"], preferences: { channel: "text" } });

    const added = await run("calendar", "add_calendar_entry", { title: "Vendor walkthrough", at: "2026-10-15T10:00:00-05:00", end: "2026-10-15T11:00:00-05:00" });
    const id = (added as { result: { id: string } }).result.id;
    expect((await run("calendar", "change_calendar_entry", { entry: id, title: "Vendor walkthrough (roof)" })).kind).toBe("executed");
    expect((await run("calendar", "finish_calendar_entry", { entry: id, status: "done" })).kind).toBe("executed");
    expect(await calendar.get(id)).toMatchObject({ title: "Vendor walkthrough (roof)", status: "done" });
  });
});
