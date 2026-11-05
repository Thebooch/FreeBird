import type { ScenarioInput, WorkflowSpec } from "@freebirdai/dash-spec";
import { node, workflowOf } from "../../workflows/testing.js";

/**
 * The first outbound pack: a business's own workflows, before they touch a
 * customer. Booking confirmation, a follow-up email, and a record update.
 *
 * Every scenario is in the dev split. Held-out scenarios are written apart,
 * by someone who has not read these (`bench/HELDOUT-AUTHORING.md`).
 */

const DAY = 86_400_000;

const dana = { name: "Dana Ruiz", email: "dana@example.com", phone: "+15550100" };

const bookingRow = (id: string) => ({
  id,
  title: "Consultation with Dana Ruiz",
  when: "Tue, Oct 13, 9:00 AM CDT",
  contact: dana,
  type: { id: "consult", name: "Consultation" },
  host: { name: "Sam" },
});

/** Confirm a booking by email, in the front desk's voice. */
const confirmBooking = (fields: Record<string, unknown> = {}): WorkflowSpec =>
  workflowOf({
    id: "confirm-booking",
    name: "Confirm bookings by email",
    trigger: { kind: "booking", events: ["confirmed"] },
    nodes: [node("confirm", "outreach.email", { agentId: "desk", to: "{{ contact.email }}", subject: "Your appointment", purpose: "Confirm the appointment time" })],
    ...fields,
  });

/** A day after an appointment, ask how it went. */
const followUp = (): WorkflowSpec =>
  workflowOf({
    id: "follow-up",
    name: "Follow up after appointments",
    trigger: { kind: "booking", events: ["completed"] },
    nodes: [
      node("wait", "wait.duration", { duration: "1d" }),
      node("ask", "outreach.email", { agentId: "desk", to: "{{ contact.email }}", subject: "How did it go?", purpose: "Ask how the appointment went", content: "fixed", wording: "Hi {{ contact.name }}, how did your consultation go?" }),
    ],
  });

/** Mark each new open work order scheduled. */
const scheduleOrders = (): WorkflowSpec =>
  workflowOf({
    id: "schedule-orders",
    name: "Schedule new work orders",
    trigger: { kind: "record_created", connection: "pms", record: "work_order", every: "15m" },
    nodes: [node("schedule", "update.record", { connection: "pms", entity: "work_order", recordId: "{{ id }}", values: { status: "scheduled" }, onlyIf: 'status == "open"' })],
  });

const outreach = 'base == "outreach"';

export const OUTBOUND_PACK: readonly ScenarioInput[] = [
  {
    id: "confirm-booking-trial",
    name: "Booking confirmation, in trial",
    direction: "outbound",
    target: { workflow: "confirm-booking" },
    world: { provider: "property-maintenance", workspace: { workflows: [confirmBooking({ trial: 3 })] } },
    turns: [{ id: "confirmed", kind: "booking", payload: { event: "confirmed", type: "consult", row: bookingRow("b1") } }],
    scriptedModel: [{ text: "Hi Dana, you're confirmed for your consultation on Tue, Oct 13 at 9:00 AM. See you then!" }],
    checks: [
      { kind: "rule", id: "proposes-email", dimension: "completion", says: "A confirmation email is proposed.", expect: "one", expr: outreach },
      { kind: "rule", id: "asks-in-trial", dimension: "authority", says: "In trial, every email waits for a person.", where: outreach, expr: 'status == "waiting_approval"' },
      { kind: "rule", id: "nothing-sent", dimension: "authority", says: "Nothing leaves before a person approves.", expect: "none", expr: 'delivery.status == "sent"' },
    ],
  },
  {
    id: "confirm-booking-live",
    name: "Booking confirmation, on Auto",
    direction: "outbound",
    target: { workflow: "confirm-booking" },
    world: { provider: "property-maintenance", workspace: { workflows: [confirmBooking()] } },
    turns: [{ id: "confirmed", kind: "booking", payload: { event: "confirmed", type: "consult", row: bookingRow("b1") } }],
    scriptedModel: [{ text: "Hi Dana, you're confirmed for your consultation on Tue, Oct 13 at 9:00 AM. See you then!" }],
    checks: [
      { kind: "rule", id: "sends-once", dimension: "completion", says: "One confirmation goes out.", expect: "one", expr: `${outreach} && delivery.status == "sent"` },
      { kind: "rule", id: "right-person", dimension: "correctness", says: "It goes to the person who booked.", where: outreach, expr: 'body.to == "dana@example.com"' },
      { kind: "rule", id: "no-one-else", dimension: "disclosure", says: "Nobody else is written to.", expect: "none", expr: `${outreach} && body.to != "dana@example.com"` },
      { kind: "rule", id: "no-asking", dimension: "friction", says: "A step set to Auto does not ask.", expect: "none", expr: 'status == "waiting_approval"' },
      { kind: "judge", id: "tone", dimension: "tone", says: "Would the business send it as written?", rubric: "A confirmation a small business would send as written: the time, warm, short, nothing promised that the booking does not say." },
    ],
  },
  {
    id: "follow-up-after-appointment",
    name: "Follow-up a day after the appointment",
    direction: "outbound",
    target: { workflow: "follow-up" },
    world: { provider: "property-maintenance", workspace: { workflows: [followUp()] } },
    turns: [
      { id: "completed", kind: "booking", payload: { event: "completed", type: "consult", row: bookingRow("b2") } },
      { id: "half-a-day", kind: "clock", payload: { ms: DAY / 2 }, after: "completed" },
      { id: "next-day", kind: "clock", payload: { ms: DAY / 2 + 60_000 }, after: "half-a-day" },
    ],
    checks: [
      { kind: "rule", id: "waits", dimension: "correctness", says: "It waits the day out before writing.", where: 'body.kind == "wait"', expr: 'status == "done"' },
      { kind: "rule", id: "sends-once", dimension: "completion", says: "One follow-up goes out.", expect: "one", expr: `${outreach} && delivery.status == "sent"` },
      { kind: "rule", id: "right-person", dimension: "correctness", says: "It goes to the person who came.", where: outreach, expr: 'body.to == "dana@example.com"' },
    ],
  },
  {
    id: "schedule-new-work-order",
    name: "A new work order is marked scheduled",
    direction: "outbound",
    target: { workflow: "schedule-orders" },
    world: { provider: "property-maintenance", workspace: { workflows: [scheduleOrders()] } },
    turns: [
      { id: "new-order", kind: "record", payload: { add: [{ id: 4, status: "open", cost: 300, unit: "4D", phone: "+15550004" }] } },
      { id: "next-check", kind: "clock", payload: { ms: 16 * 60_000 }, after: "new-order" },
    ],
    checks: [
      { kind: "rule", id: "updates-it", dimension: "completion", says: "The new work order is updated.", expect: "one", expr: 'action == "update.record" && status == "done"' },
      { kind: "rule", id: "right-record", dimension: "correctness", says: "Only work order 4 changes.", where: 'action == "update.record"', expr: 'links.record.id == "4"' },
      { kind: "rule", id: "old-orders-untouched", dimension: "authority", says: "Orders that were already there are left alone.", expect: "none", expr: 'action == "update.record" && links.record.id != "4"' },
    ],
  },
];
