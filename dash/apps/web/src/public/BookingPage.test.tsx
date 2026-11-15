// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { button, click, fakeServer, mount, oneWith, settle, shown, submit, type, unmountAll, type FakeServer } from "../testing/screen.js";
import type { LinkState, PublicBooking, PublicType } from "./api.js";
import { BookingPage } from "./BookingPage.jsx";

/**
 * A person's own booking page, opened by somebody who is not signed in.
 *
 * These open the page against a stand-in for the public API and do what a
 * person does: pick what to book, pick a time, confirm, cancel. They hold the
 * page to what it sends, since each of those requests changes a real booking.
 */

const TOKEN = "Jb4zx75XimR3CDBX5EvkjfsLVuzGUkU1qthdv0j1fLI";
const ROOT = `/api/public/acme/book/${TOKEN}`;

const inspection: PublicType = {
  id: "type-inspection",
  slug: "home-inspection",
  name: "Home inspection",
  description: "A walk through the property.",
  minutes: 60,
  location: { kind: "address", words: "At the property" },
  approval: false,
  showHostName: false,
  hosts: [],
};
const call: PublicType = { ...inspection, id: "type-call", slug: "intro-call", name: "Intro call", minutes: 30, location: { kind: "phone", words: "By phone" } };

/** Three days out at 15:00 UTC, so it is a future day whatever month the test runs in. */
const slotStart = (() => {
  const at = new Date(Date.now() + 3 * 86_400_000);
  at.setUTCHours(15, 0, 0, 0);
  return at;
})();
const slot = { start: slotStart.toISOString(), end: new Date(slotStart.getTime() + 3_600_000).toISOString(), approval: false, recommended: false };

const booking = (over: Partial<PublicBooking> = {}): PublicBooking => ({
  id: "bk-1",
  status: "confirmed",
  statusWords: "Confirmed",
  type: "Home inspection",
  start: slot.start,
  end: slot.end,
  timezone: "America/Chicago",
  where: "12 Oak St",
  canCancel: true,
  canReschedule: true,
  insideCutoff: false,
  ...over,
});

const link = (over: Partial<LinkState> = {}): LinkState => ({
  workspace: { name: "Acme Homes", accent: "#2255aa" },
  contact: { name: "Ada Park", timezone: "America/Chicago" },
  type: null,
  types: [inspection, call],
  booking: null,
  canBook: true,
  ...over,
});

let server: FakeServer;
const open = async (routes: Parameters<typeof fakeServer>[0]) => {
  server = fakeServer(routes);
  const page = mount(createElement(BookingPage, { workspace: "acme", token: TOKEN }));
  await settle();
  return page.container;
};

afterEach(() => {
  unmountAll();
  server?.restore();
});

describe("the booking page", () => {
  it("asks what to book when the link does not say, and reads nothing else until one is picked", async () => {
    const page = await open({ [`GET ${ROOT}`]: link(), [`POST ${ROOT}/times`]: { slots: [slot], questions: [], consolidatedOnly: false, more: false } });
    expect(shown(page)).toContain("Hi Ada, what would you like to book?");
    expect(shown(page)).toContain("Home inspection");
    expect(shown(page)).toContain("30 min · By phone");
    expect(server.calls.map((one) => `${one.method} ${one.url}`)).toEqual([`GET ${ROOT}`]);

    await click(button(page, "Intro call"));
    await settle();
    const asked = server.sent(`POST ${ROOT}/times`);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]!.body).toMatchObject({ type: "type-call", all: false, request: {} });
    expect(oneWith(page, "h1", "Intro call")).toBeTruthy();
  });

  it("books the time picked: one request, with the type, the time and the note", async () => {
    const page = await open({
      [`GET ${ROOT}`]: link({ type: inspection, types: [inspection] }),
      [`POST ${ROOT}/times`]: { slots: [slot], questions: [], consolidatedOnly: false, more: false },
      [`POST ${ROOT}/request`]: link({ type: inspection, booking: booking() }),
    });
    /* The first open day is picked for them; its one time is offered. */
    const times = [...page.querySelectorAll<HTMLButtonElement>(".pub-time")];
    expect(times).toHaveLength(1);
    expect(server.sent(`POST ${ROOT}/request`)).toHaveLength(0);

    await click(times[0]!);
    expect(shown(page)).toContain("Book this time");
    await type(page.querySelector<HTMLTextAreaElement>("#pub-notes")!, "  Gate code 4411  ");
    await submit(page.querySelector<HTMLFormElement>("form.pub-form")!);
    await settle();

    const sent = server.sent(`POST ${ROOT}/request`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ type: "type-inspection", start: slot.start, notes: "Gate code 4411", request: {} });
    expect((sent[0]!.body as { timezone?: string }).timezone).toBeTruthy();
    expect(shown(page)).toContain("You're booked");
    expect(shown(page)).toContain("12 Oak St");
  });

  it("says a time was just taken and offers what is left, instead of booking", async () => {
    const page = await open({
      [`GET ${ROOT}`]: link({ type: inspection, types: [inspection] }),
      [`POST ${ROOT}/times`]: { slots: [slot], questions: [], consolidatedOnly: false, more: false },
      [`POST ${ROOT}/request`]: { status: 409, body: { error: "That time was just taken." } },
    });
    await click(page.querySelector<HTMLButtonElement>(".pub-time")!);
    await submit(page.querySelector<HTMLFormElement>("form.pub-form")!);
    await settle();
    expect(shown(page)).toContain("That time was just taken. Here's what's still open.");
    expect(shown(page)).not.toContain("You're booked");
    /* Back on the times, read again. */
    expect(server.sent(`POST ${ROOT}/times`).length).toBeGreaterThan(1);
    expect(page.querySelector(".pub-time")).not.toBeNull();
  });

  it("says so, and offers no times, when the type does not take this person", async () => {
    const page = await open({
      [`GET ${ROOT}`]: link({ type: inspection, types: [inspection] }),
      [`POST ${ROOT}/times`]: { slots: [], questions: [], consolidatedOnly: false, more: false, notEligible: "Inspections are for current tenants. Please call the office." },
    });
    expect(shown(page)).toContain("This can't be booked online");
    expect(shown(page)).toContain("Inspections are for current tenants. Please call the office.");
    expect(page.querySelector(".pub-time")).toBeNull();
    expect(page.querySelector(".pub-cal__grid")).toBeNull();
  });

  it("shows a booking that exists, and cancels it only after the person confirms", async () => {
    const page = await open({
      [`GET ${ROOT}`]: link({ type: inspection, booking: booking() }),
      [`POST ${ROOT}/cancel`]: link({ type: inspection, booking: booking({ status: "cancelled", statusWords: "Cancelled", canCancel: false, canReschedule: false }) }),
    });
    expect(shown(page)).toContain("You're booked");
    expect(shown(page)).toContain("Add to calendar");

    await click(button(page, /^Cancel$/));
    expect(shown(page)).toContain("Cancel this booking?");
    expect(server.sent(`POST ${ROOT}/cancel`)).toHaveLength(0);

    /* Changing their mind sends nothing. */
    await click(button(page, "Keep it"));
    expect(server.sent(`POST ${ROOT}/cancel`)).toHaveLength(0);
    expect(shown(page)).not.toContain("Cancel this booking?");

    await click(button(page, /^Cancel$/));
    await click(button(page, "Yes, cancel"));
    await settle();
    expect(server.sent(`POST ${ROOT}/cancel`).map((one) => one.body)).toEqual([{ booking: "bk-1" }]);
    expect(shown(page)).toContain("This booking was cancelled, and its time was released.");
    expect(shown(page)).toContain("Book again");
  });

  it("offers no changes online close to the appointment", async () => {
    const page = await open({ [`GET ${ROOT}`]: link({ type: inspection, booking: booking({ insideCutoff: true, canCancel: false, canReschedule: false }) }) });
    expect(shown(page)).toContain("Changes can't be made online this close to the appointment.");
    expect([...page.querySelectorAll("button")].map((one) => one.textContent)).toEqual([]);
  });

  it("accepts a suggested time with that suggestion's id, and turns them all down only on a yes", async () => {
    const suggested = booking({
      status: "suggested",
      statusWords: "New times suggested",
      message: "Could you do the afternoon?",
      suggestions: [
        { id: "s-1", start: slot.start, end: slot.end, holdUntil: slot.start },
        { id: "s-2", start: slot.end, end: new Date(slotStart.getTime() + 7_200_000).toISOString(), holdUntil: slot.start, host: "Sam" },
      ],
    });
    const page = await open({
      [`GET ${ROOT}`]: link({ type: inspection, booking: suggested }),
      [`POST ${ROOT}/accept`]: link({ type: inspection, booking: booking() }),
      [`POST ${ROOT}/decline`]: link({ type: inspection, booking: booking({ status: "cancelled" }) }),
    });
    expect(shown(page)).toContain("New times suggested");
    expect(shown(page)).toContain("Could you do the afternoon?");
    expect(shown(page)).toContain("With Sam");

    await click(button(page, "None of these work"));
    expect(shown(page)).toContain("Turn down these times?");
    expect(server.sent(`POST ${ROOT}/decline`)).toHaveLength(0);
    await click(button(page, "Keep it"));

    const accept = [...page.querySelectorAll<HTMLButtonElement>("button")].filter((one) => one.textContent?.trim() === "Accept");
    expect(accept).toHaveLength(2);
    await click(accept[1]!);
    await settle();
    expect(server.sent(`POST ${ROOT}/accept`).map((one) => one.body)).toEqual([{ booking: "bk-1", suggestion: "s-2" }]);
    expect(server.sent(`POST ${ROOT}/decline`)).toHaveLength(0);
    expect(shown(page)).toContain("You're booked");
  });

  it("says the link cannot be opened, in the server's words, and shows nothing of a booking", async () => {
    const page = await open({ [`GET ${ROOT}`]: { status: 404, body: { error: "This link has expired." } } });
    expect(shown(page)).toContain("This link can't be opened");
    expect(shown(page)).toContain("This link has expired.");
    expect(page.querySelector("button")).toBeNull();
  });

  it("asks people to wait when the server says too many requests", async () => {
    const page = await open({ [`GET ${ROOT}`]: { status: 429, body: { error: "rate limited" } } });
    expect(shown(page)).toContain("Too many requests. Wait a minute, then try again.");
  });
});
