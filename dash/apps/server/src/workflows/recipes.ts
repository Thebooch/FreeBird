import { workflowTemplateSchema, type WorkflowTemplate } from "@freebirdai/dash-spec";

/**
 * Booking recipes: whole workflows shipped as templates, with blanks for the
 * agent who speaks, the appointment types they apply to and the times.
 *
 * 1. Booking approval: the team approves, offers other times or denies, and
 *    the person is told each time; offered times they don't take are
 *    followed up; nobody answering cancels and says so.
 * 2. Confirmation and reminders: confirm, remind the day before and two
 *    hours before, then ask whether they showed.
 * 3. Denied, so offer other times: find open times and offer them.
 * 4. Follow up with people turned away: text them (or email them, with no
 *    phone) what to do instead, in the words the team gives, and tell the
 *    team.
 *
 * Every one is saved switched off, as any workflow from a template is.
 */

const AT = "2026-01-01T00:00:00.000Z";

const node = (id: string, action: string, settings: Record<string, unknown>, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id,
  action,
  settings,
  mode: action.startsWith("outreach.") ? "approve" : "auto",
  onFailure: "stop",
  reversible: true,
  position: { x, y },
  ...extra,
});

const edge = (from: string, outcome: string, to: string) => ({ id: `e-${from}-${outcome}-${to}`.slice(0, 64), from, outcome, to });

const AGENT_BLANK = { name: "agent", label: "The agent who tells them" };

const tell = (id: string, about: string, include: string, x: number, y: number) =>
  node(id, "outreach.inform", { agentId: "{{ blank.agent }}", about, channel: "preferred", includeLink: "auto", content: "agent", ...(include ? { include } : {}) }, x, y);

const RECIPES: unknown[] = [
  {
    id: "recipe-booking-approval",
    kind: "workflow",
    name: "Booking approval",
    description: "The team approves each request, offers other times, or denies it, and the person hears what was decided.",
    blanks: [AGENT_BLANK, { name: "follow", label: "How long to wait for them to pick an offered time", default: "2d" }],
    nodes: [
      node("approve", "ask.booking", { booking: "{{ id }}" }, 0, 0),
      tell("approved", "approve", "", -320, 160),
      tell("offered", "approve", "Include the link {{ link }} so they can pick one of the times.", 0, 160),
      node("their_pick", "wait.booking", { booking: "{{ id }}", timeout: "{{ blank.follow }}" }, 0, 320),
      tell("took_it", "their_pick", "", -240, 480),
      node("find", "schedule.find", { type: "{{ type.id }}", contact: "{{ contact.id }}", within: "14d", limit: 3 }, 80, 480),
      node("offer_more", "schedule.suggest", { booking: "{{ id }}", times: "{{ steps.find.slots }}" }, 80, 640),
      tell("offered_more", "offer_more", "", 80, 800),
      node("give_up", "schedule.cancel", { booking: "{{ id }}", reason: "They didn't pick an offered time." }, 400, 480),
      tell("gave_up", "give_up", "Say we couldn't hold the times any longer, and include the link {{ link }} to pick a new one.", 400, 640),
      tell("denied", "approve", "Include the link {{ link }} so they can pick another time.", 320, 160),
      node("nobody", "schedule.cancel", { booking: "{{ id }}", reason: "Nobody approved it in time." }, 640, 160),
      tell("nobody_told", "nobody", "Say we couldn't confirm in time, and include the link {{ link }} to pick a new time.", 640, 320),
    ],
    edges: [
      edge("trigger", "next", "approve"),
      edge("approve", "approved", "approved"),
      edge("approve", "suggested", "offered"),
      edge("offered", "next", "their_pick"),
      edge("their_pick", "accepted", "took_it"),
      edge("their_pick", "declined", "find"),
      edge("find", "found", "offer_more"),
      edge("offer_more", "next", "offered_more"),
      edge("their_pick", "timed_out", "give_up"),
      edge("give_up", "next", "gave_up"),
      edge("approve", "denied", "denied"),
      edge("approve", "timed_out", "nobody"),
      edge("nobody", "next", "nobody_told"),
    ],
    entry: "approve",
    workflow: { name: "Booking approval", description: "Approve, offer other times or deny each request, and tell the person.", trigger: { kind: "booking", events: ["requested"], types: [], endWhenCancelled: true }, once: "per-row", guardrails: "" },
  },
  {
    id: "recipe-booking-reminders",
    kind: "workflow",
    name: "Confirmation and reminders",
    description: "Confirm the booking, remind them the day before and two hours before, then ask the team whether they showed.",
    blanks: [AGENT_BLANK],
    nodes: [
      tell("confirm", "", "", 0, 0),
      node("day_before", "wait.appointment", { booking: "{{ id }}", offset: "-1d" }, 0, 160),
      tell("remind_day", "", "Remind them it is tomorrow.", 0, 320),
      node("hours_before", "wait.appointment", { booking: "{{ id }}", offset: "-2h" }, 0, 480),
      tell("remind_soon", "", "Remind them it is in two hours.", 0, 640),
      node("after", "wait.appointment", { booking: "{{ id }}", offset: "+15m" }, 0, 800),
      node("showed", "ask.choose", { question: "Did {{ contact.name }} show for {{ type.name }}, {{ when }}?", options: ["completed", "no_show"], timeout: "3d" }, 0, 960),
      node("mark_done", "schedule.mark", { booking: "{{ id }}", as: "completed" }, -200, 1120),
      node("mark_missed", "schedule.mark", { booking: "{{ id }}", as: "no_show" }, 200, 1120),
    ],
    edges: [
      edge("trigger", "next", "confirm"),
      edge("confirm", "next", "day_before"),
      edge("day_before", "next", "remind_day"),
      edge("remind_day", "next", "hours_before"),
      edge("hours_before", "next", "remind_soon"),
      edge("remind_soon", "next", "after"),
      edge("after", "next", "showed"),
      edge("showed", "completed", "mark_done"),
      edge("showed", "no_show", "mark_missed"),
    ],
    entry: "confirm",
    workflow: { name: "Confirmation and reminders", description: "Confirm, remind, and record whether they showed.", trigger: { kind: "booking", events: ["confirmed"], types: [], endWhenCancelled: true }, once: "per-row", guardrails: "" },
  },
  {
    id: "recipe-booking-denied",
    kind: "workflow",
    name: "Denied, so offer other times",
    description: "When a request is denied, find the next open times and offer them, or send the link when none are open.",
    blanks: [AGENT_BLANK],
    nodes: [
      node("find", "schedule.find", { type: "{{ type.id }}", contact: "{{ contact.id }}", within: "14d", limit: 3 }, 0, 0),
      node("offer", "schedule.suggest", { booking: "{{ id }}", times: "{{ steps.find.slots }}" }, -200, 160),
      tell("offered", "offer", "", -200, 320),
      tell("none", "", "Say nothing is open soon, and include the link {{ link }} to pick a time later.", 200, 160),
    ],
    edges: [edge("trigger", "next", "find"), edge("find", "found", "offer"), edge("offer", "next", "offered"), edge("find", "none", "none"), edge("find", "needs_info", "none")],
    entry: "find",
    workflow: { name: "Denied, so offer other times", description: "Offer the next open times after a denial.", trigger: { kind: "booking", events: ["denied"], types: [], endWhenCancelled: true }, once: "per-row", guardrails: "" },
  },
  {
    id: "recipe-turned-away",
    kind: "workflow",
    name: "Follow up with people turned away",
    description: "When a type's Who can book rules turn someone away, text them (or email them) what to do instead, and tell the team.",
    blanks: [
      AGENT_BLANK,
      { name: "say", label: "What to tell them", default: "Let them know this can't be booked online, and that they can call us to arrange it." },
    ],
    nodes: [
      node("has_phone", "branch.if", { condition: 'contact.phone != ""' }, 0, 0),
      node("text_them", "outreach.text", { agentId: "{{ blank.agent }}", to: "{{ contact.phone }}", purpose: "{{ blank.say }}", content: "agent" }, -200, 160),
      node("email_them", "outreach.email", { agentId: "{{ blank.agent }}", to: "{{ contact.email }}", subject: "About your {{ type.name }} request", purpose: "{{ blank.say }}", content: "agent" }, 200, 160),
      node(
        "tell_team",
        "notify.team",
        { title: "{{ contact.name }} was turned away from {{ type.name }}", text: "They asked on {{ viaWords }}, {{ when }}.\n{{ answersText }}\nThey were told: {{ reason }}", to: "everyone" },
        0,
        320,
      ),
    ],
    edges: [
      edge("trigger", "next", "has_phone"),
      edge("has_phone", "yes", "text_them"),
      edge("has_phone", "no", "email_them"),
      edge("text_them", "next", "tell_team"),
      edge("text_them", "failed", "tell_team"),
      edge("email_them", "next", "tell_team"),
      edge("email_them", "failed", "tell_team"),
    ],
    entry: "has_phone",
    workflow: {
      name: "Follow up with people turned away",
      description: "Tell people a type turned away what to do instead, and tell the team.",
      trigger: { kind: "booking", events: ["turned_away"], types: [], endWhenCancelled: false },
      once: "per-row",
      guardrails: "",
    },
  },
];

export const BOOKING_RECIPES: readonly WorkflowTemplate[] = RECIPES.map((one) => workflowTemplateSchema.parse({ version: 1, createdAt: AT, updatedAt: AT, builtIn: true, ...(one as object) }));
