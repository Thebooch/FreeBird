import { describe, expect, it } from "vitest";
import { workflowBookings } from "../bookings/row.js";
import { BookingService, bookingsAsBusy } from "../bookings/service.js";
import { MemoryBookingStore } from "../bookings/store.js";
import { ContactService } from "../contacts/service.js";
import { MemoryContactStore } from "../contacts/store.js";
import { SchedulingService } from "../scheduling/service.js";
import { MemorySchedulingStore } from "../scheduling/store.js";
import { BookingDispatcher } from "./booking-events.js";
import { BOOKING_RECIPES } from "./recipes.js";
import { WorkflowService } from "./service.js";
import { TemplateService } from "./templates.js";
import { T0, agentOf, fake, node, owner, workflowOf } from "./testing.js";

const CHICAGO = "America/Chicago";
const HOUR = 3_600_000;
/** Wednesday 7 October 2026, 9:00 and 10:00 in Chicago; T0 is Tuesday 7:00 there. */
const WED_9 = Date.parse("2026-10-07T14:00:00Z");
const WED_10 = WED_9 + HOUR;
const them = { kind: "contact" as const };
const sam = { kind: "member" as const, id: "sam" };

const setup = async (approval: "always" | "none" = "always") => {
  const f = fake({ sender: true });
  f.agents.set("maint", agentOf());
  const now = () => f.clock.now;
  let n = 0;
  const contacts = new ContactService({ store: new MemoryContactStore(), now, newId: () => `c${++n}` });
  const store = new MemoryBookingStore();
  const scheduling = new SchedulingService({
    store: new MemorySchedulingStore(),
    calendar: f.env.calendar,
    members: async () => [{ userId: "sam", email: "sam@acme.test", role: "owner" }],
    bookings: bookingsAsBusy(store),
    contacts,
    now,
  });
  const service = new BookingService({ store, scheduling, contacts, calendar: f.env.calendar, now, newId: () => `b${++n}` });
  const rows = workflowBookings({ service, contacts, scheduling, linkFor: async (booking) => `https://book.example/b/${booking.id}` });
  Object.assign(f.env, { bookings: () => rows });
  const dispatcher = new BookingDispatcher({ env: f.env, engine: f.engine, store, bookings: rows, contacts });
  await scheduling.putProfile("sam", { displayName: "Sam", bookable: true, timezone: CHICAGO });
  await scheduling.putType("visit", {
    name: "Visit",
    slug: "visit",
    hosts: { members: ["sam"] },
    settings: { length: "60m", slotStep: "60m", minNotice: "0m", approval, holdFor: "1d", suggestionHoldFor: "2d", cancelCutoff: "0m" },
  });
  const ana = await contacts.findOrCreate({ email: "ana@example.com", phone: "512-555-0142", name: "Ana Lopez", origin: "public_link" });
  await contacts.update(ana.id, { timezone: CHICAGO }, "sam");
  return { f, contacts, store, scheduling, service, rows, dispatcher, ana: ana.id };
};

const bookingTrigger = (events: string[], endWhenCancelled = true) => ({ kind: "booking", events, types: [], endWhenCancelled });

describe("a booking's workflows", () => {
  it("opens the approval workflow once per event, wakes it when the team answers on the booking, and tells the person", async () => {
    const { f, service, dispatcher, ana } = await setup();
    await f.env.store.put(
      workflowOf({
        id: "approval",
        trial: 0,
        trigger: bookingTrigger(["requested"]),
        nodes: [node("approve", "ask.booking"), node("told", "outreach.inform", { agentId: "maint", about: "approve" }), node("told-no", "outreach.inform", { agentId: "maint", about: "approve" })],
        edges: [
          { id: "e1", from: "trigger", outcome: "next", to: "approve" },
          { id: "e2", from: "approve", outcome: "approved", to: "told" },
          { id: "e3", from: "approve", outcome: "denied", to: "told-no" },
        ],
      }),
    );
    const { booking } = await service.request({ type: "visit", contact: ana, start: WED_9, origin: "public_link", by: them });
    expect(booking.status).toBe("pending");
    await dispatcher.deliver();
    await dispatcher.deliver();

    const [one, ...more] = await f.env.cases.list({ workflow: "approval" });
    expect(more).toEqual([]);
    expect(one).toMatchObject({ status: "waiting", rowKey: booking.id, start: { kind: "booking" } });
    expect(one!.data.row).toMatchObject({ id: booking.id, when: "Wed, Oct 7, 9:00 AM CDT", contact: { name: "Ana Lopez", phone: "+15125550142" }, type: { name: "Visit" }, host: { name: "Sam" } });
    const [asking] = await f.env.tasks.list({ case: one!.id });
    expect(asking).toMatchObject({ status: "waiting", body: { kind: "booking", booking: booking.id, question: expect.stringContaining("Approve") } });

    /* Someone approves on the calendar: the outbox wakes the step, which reads the answer and goes on. */
    await service.confirm(booking.id, sam, { message: "See you then" });
    await dispatcher.deliver();
    const after = (await f.env.cases.get(one!.id))!;
    expect(after.status).toBe("done");
    expect(after.data.steps["approve"]).toMatchObject({ answer: "approved", by: "sam", message: "See you then" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ channel: "text", to: "+15125550142" });
    expect(f.sent[0]!.text).toContain("Wed, Oct 7, 9:00 AM CDT");
    expect(f.sent[0]!.text).not.toContain("https://book.example");
  });

  it("offers other times and hears the person take one, telling them the time and never the team's note", async () => {
    const { f, service, dispatcher, ana } = await setup();
    await f.env.store.put(
      workflowOf({
        id: "approval",
        trial: 0,
        trigger: bookingTrigger(["requested"]),
        nodes: [node("approve", "ask.booking"), node("offered", "outreach.inform", { agentId: "maint", about: "approve" }), node("pick", "wait.booking", { timeout: "2d" }), node("took", "outreach.inform", { agentId: "maint", about: "pick" })],
        edges: [
          { id: "e1", from: "trigger", outcome: "next", to: "approve" },
          { id: "e2", from: "approve", outcome: "suggested", to: "offered" },
          { id: "e3", from: "offered", outcome: "next", to: "pick" },
          { id: "e4", from: "pick", outcome: "accepted", to: "took" },
        ],
      }),
    );
    const { booking } = await service.request({ type: "visit", contact: ana, start: WED_9, origin: "public_link", by: them });
    await dispatcher.deliver();
    await service.suggest(booking.id, sam, [{ start: WED_10 }], { message: "Mornings are full.", reason: "Van in the shop" });
    await dispatcher.deliver();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text).toContain("Wed, Oct 7, 10:00 AM CDT");
    expect(f.sent[0]!.text).toContain(`https://book.example/b/${booking.id}`);
    expect(f.sent[0]!.text).not.toContain("Van in the shop");
    const [one] = await f.env.cases.list({ workflow: "approval" });
    expect(one!.status).toBe("waiting");
    expect(one!.waiting).toMatchObject({ key: `booking:${booking.id}` });

    await service.acceptSuggestion(booking.id, "s1", them);
    await dispatcher.deliver();
    expect((await f.env.cases.get(one!.id))!.status).toBe("done");
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.text).toContain("Wed, Oct 7, 10:00 AM CDT");
  });

  it("ends the approval as withdrawn when they cancel first, or stops the case when the workflow is set to", async () => {
    const { f, service, dispatcher, ana } = await setup();
    const flow = (id: string, endWhenCancelled: boolean) =>
      workflowOf({ id, trial: 0, trigger: bookingTrigger(["requested"], endWhenCancelled), nodes: [node("approve", "ask.booking")], edges: [{ id: "e1", from: "trigger", outcome: "next", to: "approve" }] });
    await f.env.store.put(flow("keeps-going", false));
    await f.env.store.put(flow("stops", true));
    const { booking } = await service.request({ type: "visit", contact: ana, start: WED_9, origin: "public_link", by: them });
    await dispatcher.deliver();
    await service.cancel(booking.id, them);
    await dispatcher.deliver();

    const [going] = await f.env.cases.list({ workflow: "keeps-going" });
    const [stopped] = await f.env.cases.list({ workflow: "stops" });
    expect(going!.status).toBe("done");
    expect(going!.data.steps["approve"]).toMatchObject({ answer: "withdrawn" });
    expect(stopped!.status).toBe("cancelled");
  });

  it("waits until a day before the appointment, following a move, and ends on a cancellation", async () => {
    const { f, service, dispatcher, ana } = await setup("none");
    await f.env.store.put(
      workflowOf({
        id: "reminders",
        trial: 0,
        trigger: bookingTrigger(["confirmed"], false),
        nodes: [node("day-before", "wait.appointment", { offset: "-1d" }), node("remind", "outreach.inform", { agentId: "maint", include: "Remind them it is tomorrow." })],
        edges: [
          { id: "e1", from: "trigger", outcome: "next", to: "day-before" },
          { id: "e2", from: "day-before", outcome: "next", to: "remind" },
        ],
      }),
    );
    const friday = Date.parse("2026-10-09T14:00:00Z");
    const { booking } = await service.request({ type: "visit", contact: ana, start: friday, origin: "public_link", by: them });
    expect(booking.status).toBe("confirmed");
    await dispatcher.deliver();
    const [one] = await f.env.cases.list({ workflow: "reminders" });
    expect(one!.waiting?.deadline).toBe(new Date(friday - 24 * HOUR).toISOString());

    /* Moved to Monday: the wait moves with it. */
    const monday = Date.parse("2026-10-12T14:00:00Z");
    await service.move(booking.id, sam, { start: monday });
    await dispatcher.deliver();
    expect((await f.env.cases.get(one!.id))!.waiting?.deadline).toBe(new Date(monday - 24 * HOUR).toISOString());

    f.clock.now = monday - 24 * HOUR + 1;
    await f.engine.timeouts();
    expect((await f.env.cases.get(one!.id))!.status).toBe("done");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text).toContain("Mon, Oct 12, 9:00 AM CDT");
  });

  it("finds open times and holds one from any workflow, once per attempt", async () => {
    const { f, service, ana } = await setup("none");
    await f.env.store.put(
      workflowOf({
        id: "book-it",
        trial: 0,
        trigger: { kind: "manual" },
        nodes: [
          node("find", "schedule.find", { type: "visit", contact: ana, limit: 2 }),
          node("hold", "schedule.hold", { type: "visit", contact: ana, at: "{{ steps.find.first.start }}" }),
        ],
        edges: [
          { id: "e1", from: "trigger", outcome: "next", to: "find" },
          { id: "e2", from: "find", outcome: "found", to: "hold" },
        ],
      }),
    );
    const workflow = (await f.env.store.get("book-it"))!;
    const opened = await f.engine.open(workflow, { start: { kind: "manual" } });
    expect(opened.status).toBe("done");
    expect(opened.data.steps["find"]).toMatchObject({ count: 2 });
    const held = opened.data.steps["hold"] as { booking: string; status: string };
    expect(held.status).toBe("confirmed");
    expect((await service.get(held.booking)).start).toBe((opened.data.steps["find"] as { first: { start: string } }).first.start);
    expect(T0).toBeLessThan(Date.parse((await service.get(held.booking)).start));
  });
});

describe("checking booking workflows", () => {
  it("asks which booking a step means when the workflow isn't started by one, and checks the trigger's types", async () => {
    const { f, scheduling } = await setup();
    const service = new WorkflowService({
      store: f.env.store,
      policy: { can: () => ({ ok: true }) },
      agents: { list: async () => [agentOf()] },
      hasConnection: () => true,
      appointmentTypes: async () => (await scheduling.overview()).types.map((one) => one.id),
    });
    const manual = await service.problems(owner, workflowOf({ trigger: { kind: "manual" }, nodes: [node("approve", "ask.booking")] }));
    expect(manual).toEqual([expect.objectContaining({ step: "approve", field: "booking", incomplete: true })]);
    const unknown = await service.problems(owner, workflowOf({ trigger: bookingTrigger(["requested"]), nodes: [] }));
    expect(unknown).toEqual([]);
    const ghost = await service.problems(owner, workflowOf({ trigger: { ...bookingTrigger(["requested"]), types: ["ghost"] }, nodes: [] }));
    expect(ghost).toEqual([expect.objectContaining({ field: "trigger", message: 'There is no appointment type "ghost".' })]);
  });

  it("ships recipes that make sound workflows once the agent is filled in", async () => {
    const { f } = await setup();
    const templates = new TemplateService({ templates: f.env.templates, workflows: f.env.store, newId: () => "x", builtIn: BOOKING_RECIPES });
    const service = new WorkflowService({ store: f.env.store, policy: { can: () => ({ ok: true }) }, agents: { list: async () => [agentOf()] }, hasConnection: () => true });
    expect((await templates.list()).map((one) => one.id)).toEqual(["recipe-booking-approval", "recipe-booking-reminders", "recipe-booking-denied"]);
    for (const recipe of BOOKING_RECIPES) {
      const { input } = await templates.workflowFrom(recipe.id, { agent: "maint" });
      const problems = await service.problems(owner, workflowOf({ ...input, enabled: false }));
      expect({ recipe: recipe.id, problems }).toEqual({ recipe: recipe.id, problems: [] });
    }
    await expect(templates.remove("recipe-booking-approval")).rejects.toThrow(/comes with Dash/);
  });
});
