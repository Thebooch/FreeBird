// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { button, click, fakeServer, mount, settle, shown, type, unmountAll, type FakeServer } from "../testing/screen.js";
import type { ApprovalState } from "./api.js";
import { ApprovalPage } from "./ApprovalPage.jsx";

/**
 * A member's approval page, opened from an email with no sign-in.
 *
 * The link in the email says which answer the member leaned towards, and the
 * page must not take that as the answer: opening it sends nothing, and only a
 * button on the page does. These hold it to that, and to what each answer sends.
 */

const TOKEN = "Jb4zx75XimR3CDBX5EvkjfsLVuzGUkU1qthdv0j1fLI";
const ROOT = `/api/public/acme/approve/${TOKEN}`;

const start = new Date(Date.now() + 2 * 86_400_000);
start.setUTCHours(16, 0, 0, 0);
const end = new Date(start.getTime() + 3_600_000);
const open1 = { start: new Date(start.getTime() + 86_400_000).toISOString(), end: new Date(end.getTime() + 86_400_000).toISOString(), approval: false, recommended: false };
const open2 = { start: new Date(start.getTime() + 90_000_000).toISOString(), end: new Date(end.getTime() + 90_000_000).toISOString(), approval: false, recommended: false };

const approval = (over: Partial<ApprovalState> = {}): ApprovalState => ({
  workspace: { name: "Acme Homes", accent: "#2255aa" },
  member: { name: "Sam Lee", email: "sam@acme.test", timezone: "America/Chicago" },
  booking: {
    id: "bk-1",
    type: "Home inspection",
    description: "A walk through the property.",
    start: start.toISOString(),
    end: end.toISOString(),
    status: "pending",
    statusWords: "Waiting for an answer",
    where: "12 Oak St",
    contact: { name: "Ada Park", email: "ada@example.test", phone: "+15125550100" },
    notes: [{ label: "Pets", value: "Two dogs" }],
    facts: ["Current tenant"],
  },
  ask: { question: "Can you take this inspection?", allowSuggest: true, allowDeny: true, maxSuggestions: 2 },
  open: true,
  day: [],
  ...over,
});

const answered = (outcome: "approved" | "suggested" | "denied"): ApprovalState =>
  approval({ open: false, ask: null, decided: { outcome, by: "Sam Lee", at: new Date().toISOString() }, booking: { ...approval().booking, status: outcome === "approved" ? "confirmed" : outcome === "denied" ? "denied" : "suggested", statusWords: outcome } });

let server: FakeServer;
const open = async (routes: Parameters<typeof fakeServer>[0], choice: "approve" | "suggest" | "deny" | null = null) => {
  server = fakeServer(routes);
  const page = mount(createElement(ApprovalPage, { workspace: "acme", token: TOKEN, choice }));
  await settle();
  return page.container;
};
const posts = () => server.sent(`POST ${ROOT}`);
const selectedTab = (page: HTMLElement) => page.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim();

afterEach(() => {
  unmountAll();
  server?.restore();
});

describe("the approval page", () => {
  it("shows who is asking and what for, to the member the link belongs to", async () => {
    const page = await open({ [`GET ${ROOT}`]: approval() });
    const text = shown(page);
    expect(text).toContain("Answering as Sam Lee (sam@acme.test)");
    expect(text).toContain("Ada Park");
    expect(text).toContain("ada@example.test");
    expect(text).toContain("Home inspection");
    expect(text).toContain("12 Oak St");
    expect(text).toContain("Two dogs");
    expect(text).toContain("Current tenant");
    expect(text).toContain("Can you take this inspection?");
  });

  it("decides nothing by being opened, whichever button in the email opened it", async () => {
    for (const choice of ["approve", "deny", "suggest"] as const) {
      const page = await open({ [`GET ${ROOT}`]: approval(), [`POST ${ROOT}/times`]: { host: { name: "Sam Lee", self: true }, slots: [] } }, choice);
      expect(selectedTab(page)).toBe({ approve: "Approve", deny: "Deny", suggest: "Suggest" }[choice]);
      expect(posts()).toHaveLength(0);
      unmountAll();
      server.restore();
    }
  });

  it("offers only the answers the step allows, and ignores an email's choice that is not one of them", async () => {
    const page = await open({ [`GET ${ROOT}`]: approval({ ask: { question: "Approve?", allowSuggest: false, allowDeny: false, maxSuggestions: 0 } }) }, "deny");
    expect([...page.querySelectorAll('[role="tab"]')].map((one) => one.textContent?.trim())).toEqual(["Approve"]);
    expect(selectedTab(page)).toBe("Approve");
    expect(posts()).toHaveLength(0);
  });

  it("approves with one request, carrying the note and never a reason", async () => {
    const page = await open({ [`GET ${ROOT}`]: approval(), [`POST ${ROOT}`]: answered("approved") });
    await type(page.querySelector<HTMLTextAreaElement>("#pub-message")!, "  See you then.  ");
    expect(page.querySelector("#pub-reason")).toBeNull();
    await click(button(page, "Approve request"));
    await settle();
    expect(posts().map((one) => one.body)).toEqual([{ answer: "approve", message: "See you then." }]);
    expect(shown(page)).toContain("Sam Lee approved it");
    expect(shown(page)).toContain("There's nothing more to do here.");
    /* Answered: nothing left to press that answers again. */
    expect(page.querySelector('[role="tab"]')).toBeNull();
  });

  it("denies with the reason kept for the team", async () => {
    const page = await open({ [`GET ${ROOT}`]: approval(), [`POST ${ROOT}`]: answered("denied") });
    await click(button(page, /^Deny$/));
    await type(page.querySelector<HTMLTextAreaElement>("#pub-message")!, "Sorry, we can't that day.");
    await type(page.querySelector<HTMLTextAreaElement>("#pub-reason")!, "Double booked");
    await click(button(page, "Deny request"));
    await settle();
    expect(posts().map((one) => one.body)).toEqual([{ answer: "deny", message: "Sorry, we can't that day.", reason: "Double booked" }]);
    expect(shown(page)).toContain("Sam Lee denied it");
  });

  it("will not offer other times until one is picked, then offers exactly those picked, up to the most allowed", async () => {
    const page = await open({
      [`GET ${ROOT}`]: approval(),
      [`POST ${ROOT}/times`]: { host: { name: "Sam Lee", self: true }, slots: [open1, open2, { ...open2, start: new Date(start.getTime() + 180_000_000).toISOString() }] },
      [`POST ${ROOT}`]: answered("suggested"),
    });
    await click(button(page, /^Suggest$/));
    await settle();
    expect(shown(page)).toContain("Pick up to 2 of your open times.");

    await click(button(page, "Offer times"));
    expect(shown(page)).toContain("Pick at least one time to offer.");
    expect(posts()).toHaveLength(0);

    const chips = [...page.querySelectorAll<HTMLButtonElement>(".pub-chip")];
    expect(chips).toHaveLength(3);
    await click(chips[0]!);
    await click(chips[1]!);
    /* Two is the most: the third cannot be added. */
    expect([...page.querySelectorAll<HTMLButtonElement>(".pub-chip")][2]!.disabled).toBe(true);

    await click(button(page, "Offer 2 times"));
    await settle();
    expect(posts().map((one) => one.body)).toEqual([{ answer: "suggest", times: [{ start: open1.start }, { start: open2.start }], allowOutside: false }]);
    expect(shown(page)).toContain("Sam Lee suggested other times");
  });

  it("shows where the request stands when somebody else answered first", async () => {
    const page = await open({ [`GET ${ROOT}`]: approval(), [`POST ${ROOT}`]: { status: 409, body: { error: "Somebody already answered this request." } } });
    server.on(`GET ${ROOT}`, approval({ open: false, ask: null, decided: { outcome: "approved", by: "Jo Kim", at: new Date().toISOString() } }));
    await click(button(page, "Approve request"));
    await settle();
    expect(posts()).toHaveLength(1);
    expect(shown(page)).toContain("Jo Kim approved it");
    expect(page.querySelector('[role="tab"]')).toBeNull();
  });

  it("offers nothing to answer once the request is closed, and says why", async () => {
    const page = await open({ [`GET ${ROOT}`]: approval({ open: false, ask: null, closed: "Ada withdrew this request yesterday.", booking: { ...approval().booking, status: "cancelled", statusWords: "Cancelled" } }) });
    expect(shown(page)).toContain("They withdrew the request");
    expect(shown(page)).toContain("Ada withdrew this request yesterday.");
    expect(page.querySelector("button")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("says the link cannot be opened, and shows nothing of the request", async () => {
    const page = await open({ [`GET ${ROOT}`]: { status: 404, body: { error: "This link was already used." } } });
    expect(shown(page)).toContain("This approval link can't be opened");
    expect(shown(page)).toContain("This link was already used.");
    expect(shown(page)).not.toContain("Ada Park");
  });
});
