import { createHash } from "node:crypto";
import { composeResponsePrompt, durationMs, type Booking, type Contact, type Task } from "@freebirdai/dash-spec";
import { BookingError } from "../bookings/service.js";
import { offerOrder } from "../scheduling/slots.js";
import type { ActionContext, ActionExecutor, ActionResult } from "./actions.js";
import { notConnectedSender, type WorkflowBookings } from "./env.js";

/**
 * The steps that work with bookings: the Schedule steps, Approve a booking,
 * the two booking waits, and Tell them what was decided.
 *
 * Every change goes through `BookingService` as the workflow, so it is
 * checked and written the same way a person's change is. A step that may run
 * twice carries its attempt id (a hold's booking id is made from it), and a
 * decision already made is read from the booking rather than made again.
 */

const done = (outcome: string, task: Partial<Task>, outputs?: Record<string, unknown>): ActionResult => ({ kind: "done", outcome, task, ...(outputs ? { outputs } : {}) });
const failed = (error: string, task?: Partial<Task>): ActionResult => ({ kind: "failed", error, ...(task ? { task } : {}) });
const text = (value: unknown): string => (value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value));
const iso = (ms: number): string => new Date(ms).toISOString();
const shortHash = (value: string): string => createHash("sha1").update(value).digest("hex").slice(0, 16);

const NO_BOOKINGS = "Bookings aren't set up on this server, so this step can't run.";

/** The booking a step is about: its setting, else the booking that started the case. */
const bookingOf = async (ctx: ActionContext, bookings: WorkflowBookings): Promise<Booking | null> => {
  const id = text(ctx.settings["booking"]).trim() || text((ctx.case.data.row as Record<string, unknown>)["id"]).trim();
  if (!id) return null;
  try {
    return await bookings.service.get(id);
  } catch {
    return null;
  }
};

const by = (ctx: ActionContext) => ({ kind: "workflow" as const, id: ctx.workflow.id });

/** A time from a setting: an instant, or a slot (`{{ steps.find.first }}`) with a start. */
const instantOf = (value: unknown): number | null => {
  if (value && typeof value === "object" && "start" in (value as Record<string, unknown>)) return instantOf((value as Record<string, unknown>)["start"]);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = text(value).trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      return instantOf(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
};

/** Times from a setting: a list of slots or instants, as a list or as its text. */
const timesOf = (value: unknown): number[] => {
  let list: unknown = value;
  if (typeof value === "string") {
    const raw = value.trim();
    if (raw.startsWith("[")) {
      try {
        list = JSON.parse(raw);
      } catch {
        list = raw.split(",");
      }
    } else list = raw.split(",");
  }
  const all = Array.isArray(list) ? list : [list];
  return all.map(instantOf).filter((one): one is number => one !== null);
};

/** "-1d", "+2h", "15m" (after) → milliseconds. */
const offsetOf = (value: unknown): number | null => {
  const match = /^\s*([+-])?\s*(\d+)\s*(m|h|d|w)\s*$/.exec(text(value));
  if (!match) return null;
  const amount = durationMs(`${match[2]}${match[3]}`) ?? 0;
  return match[1] === "-" ? -amount : amount;
};

/** What a decided booking says, for Approve a booking's outcome and outputs. Null while still pending. */
const decided = async (booking: Booking, bookings: WorkflowBookings): Promise<{ outcome: string; outputs: Record<string, unknown> } | null> => {
  /* `reason` is the team's own note: later steps may use it, and Tell them never passes it on. */
  const base = { booking: booking.id, by: booking.decision?.by ?? "", message: booking.decision?.message ?? "", reason: booking.decision?.reason ?? "" };
  switch (booking.status) {
    case "pending":
      return null;
    case "confirmed":
    case "completed":
    case "no_show":
      return { outcome: "approved", outputs: { ...base, answer: "approved" } };
    case "suggested":
      return {
        outcome: "suggested",
        outputs: {
          ...base,
          answer: "suggested",
          suggestions: await Promise.all((booking.suggestions ?? []).map(async (one) => ({ start: one.start, end: one.end, when: await bookings.when(one.start, booking.contact) }))),
        },
      };
    case "denied":
      return { outcome: "denied", outputs: { ...base, answer: "denied" } };
    case "expired":
      /* Nobody answered before the hold ran out. */
      return { outcome: "timed_out", outputs: { ...base, answer: "timed_out" } };
    default:
      return { outcome: "withdrawn", outputs: { ...base, answer: "withdrawn" } };
  }
};

const ANSWER_WORDS: Readonly<Record<string, string>> = { approved: "Approved.", suggested: "Other times offered.", denied: "Denied.", withdrawn: "Withdrawn before anyone answered.", timed_out: "Nobody answered in time." };

/* ── Approve a booking ─────────────────────────────────────────────────── */

/**
 * Waits on the booking. The team answers on the booking itself — from
 * Waiting for you, the calendar, or the approval page — and the booking's
 * outbox wakes this step, which reads what was decided; any other change
 * leaves it waiting. A booking cancelled before anyone answered is
 * `withdrawn`; one whose hold ran out, `timed_out`.
 */
const askBooking: ActionExecutor = async (ctx) => {
  const bookings = ctx.env.bookings?.();
  if (!bookings) return failed(NO_BOOKINGS);
  const booking = await bookingOf(ctx, bookings);
  if (!booking) return failed("There is no booking to approve: set which one.");
  const question = text(ctx.settings["question"]).trim() || `Approve ${booking.type.name}, ${await bookings.when(booking.start, booking.contact)}?`;
  const assignee = text(ctx.settings["assignee"]).trim();
  const body = {
    kind: "booking" as const,
    booking: booking.id,
    question,
    allowSuggest: ctx.settings["allowSuggest"] !== false,
    allowDeny: ctx.settings["allowDeny"] !== false,
    ...(assignee ? { assignee } : {}),
  };
  const settled = await decided(booking, bookings);
  if (settled) {
    return done(
      settled.outcome,
      { status: "done", title: `${question} ${ANSWER_WORDS[settled.outcome] ?? ""}`.trim(), body: { ...body, answer: settled.outcome }, ...(settled.outputs["by"] ? { approvedBy: text(settled.outputs["by"]) } : {}) },
      settled.outputs,
    );
  }
  if (ctx.resume?.kind === "timeout") return done("timed_out", { status: "timed_out", title: `No answer: ${question}`, body });
  const timeout = durationMs(ctx.settings["timeout"]);
  const deadline = timeout ? iso(Date.parse(ctx.task.createdAt) + timeout) : (booking.holdUntil ?? iso(ctx.env.now() + 2 * 86_400_000));
  return { kind: "wait", wait: { kind: "ask", key: `booking:${booking.id}`, deadline }, task: { status: "waiting", title: question, body } };
};

/* ── waits ─────────────────────────────────────────────────────────────── */

const WAIT_OUTCOMES: Readonly<Record<string, string>> = {
  suggestion_accepted: "accepted",
  suggestion_declined: "declined",
  rescheduled: "rescheduled",
  reschedule_requested: "rescheduled",
  requested: "rescheduled",
  cancelled: "cancelled",
};

/** Waits for the person booking to act. Other things happening to the booking leave it waiting. */
const waitBooking: ActionExecutor = async (ctx) => {
  const bookings = ctx.env.bookings?.();
  if (!bookings) return failed(NO_BOOKINGS);
  const booking = await bookingOf(ctx, bookings);
  if (!booking) return failed("There is no booking to wait on: set which one.");
  const forWhat = `${booking.type.name}: the person booking`;
  if (ctx.resume?.kind === "timeout") return done("timed_out", { status: "timed_out", title: `They didn't answer: ${forWhat}`, body: { kind: "wait", forWhat, ended: "timed_out" } });
  if (ctx.resume?.kind === "event") {
    const event = text(ctx.resume.payload?.["event"]);
    const outcome = WAIT_OUTCOMES[event];
    if (outcome) return done(outcome, { status: "done", title: `They ${outcome}: ${forWhat}`, body: { kind: "wait", forWhat, ended: "happened" } }, { event: ctx.resume.payload ?? {} });
  }
  if (!ctx.resume && booking.status === "cancelled") return done("cancelled", { status: "done", title: `Already cancelled: ${forWhat}`, body: { kind: "wait", forWhat, ended: "happened" } }, { event: { event: "cancelled" } });
  const timeout = durationMs(ctx.settings["timeout"]) ?? durationMs("2d")!;
  const deadline = iso(Date.parse(ctx.task.createdAt) + timeout);
  return { kind: "wait", wait: { kind: "booking", key: `booking:${booking.id}`, deadline }, task: { status: "waiting", title: `Waiting for them: ${forWhat}`, body: { kind: "wait", forWhat, deadline } } };
};

/**
 * Waits until a time set from the appointment. It listens to the booking
 * too: a move moves the time it waits for, a cancellation ends it.
 */
const waitAppointment: ActionExecutor = async (ctx) => {
  const bookings = ctx.env.bookings?.();
  if (!bookings) return failed(NO_BOOKINGS);
  const booking = await bookingOf(ctx, bookings);
  if (!booking) return failed("There is no booking to wait on: set which one.");
  const offset = offsetOf(ctx.settings["offset"]);
  if (offset === null) return failed(`"${text(ctx.settings["offset"])}" isn't a time before or after: write -1d, -2h or +15m.`);
  const forWhat = `${text(ctx.settings["offset"]).trim()} from ${booking.type.name}`;
  if (["cancelled", "denied", "expired"].includes(booking.status)) {
    return done("cancelled", { status: "done", title: `${booking.type.name} was ${booking.status}`, body: { kind: "wait", forWhat, ended: "happened" } });
  }
  const target = Date.parse(booking.start) + offset;
  if (target <= ctx.env.now()) return done("next", { status: "done", title: `Reached ${forWhat}`, body: { kind: "wait", forWhat, ended: "timed_out" } });
  return { kind: "wait", wait: { kind: "appointment", key: `booking:${booking.id}`, deadline: iso(target) }, task: { status: "waiting", title: `Waiting until ${forWhat}`, body: { kind: "wait", forWhat, deadline: iso(target) } } };
};

/* ── schedule ──────────────────────────────────────────────────────────── */

const findTimes: ActionExecutor = async (ctx) => {
  const bookings = ctx.env.bookings?.();
  if (!bookings) return failed(NO_BOOKINGS);
  const type = text(ctx.settings["type"]).trim();
  const contact = text(ctx.settings["contact"]).trim();
  if (!type || !contact) return failed("Say the appointment type and the contact.");
  const from = instantOf(ctx.settings["from"]) ?? ctx.env.now();
  const within = durationMs(ctx.settings["within"]) ?? durationMs("14d")!;
  const limit = Math.min(Math.max(Number(ctx.settings["limit"]) || 3, 1), 20);
  let result: Awaited<ReturnType<WorkflowBookings["service"]["slotsFor"]>>;
  try {
    result = await bookings.service.slotsFor(type, contact, { from, to: from + within });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  const slots = await Promise.all(
    offerOrder(result.slots)
      .slice(0, limit)
      .map(async (slot) => ({ start: iso(slot.start), end: iso(slot.end), when: await bookings.when(slot.start, contact), consolidated: slot.consolidated, approval: slot.approval })),
  );
  const outcome = slots.length > 0 ? "found" : result.needs.length > 0 ? "needs_info" : "none";
  return done(
    outcome,
    { status: "done", title: slots.length > 0 ? `Found ${slots.length} open time${slots.length === 1 ? "" : "s"}` : "No open times", body: { kind: "notice", text: slots.map((one) => one.when).join("; ") || (result.needs.length > 0 ? `Needs: ${result.needs.join(", ")}` : "Nothing open in that window.") } },
    { slots, first: slots[0] ?? null, count: slots.length, needs: result.needs },
  );
};

const holdTime: ActionExecutor = async (ctx) => {
  const bookings = ctx.env.bookings?.();
  if (!bookings) return failed(NO_BOOKINGS);
  const type = text(ctx.settings["type"]).trim();
  const contact = text(ctx.settings["contact"]).trim();
  const at = instantOf(ctx.settings["at"]);
  if (!type || !contact || at === null) return failed("Say the appointment type, the contact and the time.");
  const approval = ctx.settings["approval"] === "always" || ctx.settings["approval"] === "skip" ? (ctx.settings["approval"] as "always" | "skip") : "type";
  const host = text(ctx.settings["host"]).trim();
  const holdFor = text(ctx.settings["holdFor"]).trim();
  try {
    const { booking, outcome } = await bookings.service.request({
      type,
      contact,
      start: at,
      ...(host ? { host } : {}),
      ...(holdFor ? { holdFor } : {}),
      approval,
      origin: "workflow",
      by: by(ctx),
      id: `bk-${shortHash(ctx.attempt.id)}`,
    });
    const when = await bookings.when(booking.start, booking.contact);
    return done(
      outcome,
      { status: "done", title: `${outcome === "pending" ? "Held" : "Booked"}: ${booking.type.name}, ${when}`, body: { kind: "created", what: `${booking.type.name}, ${when}`, id: booking.id }, reversal: { available: false, reason: "Cancel the booking instead." } },
      { booking: booking.id, when, status: booking.status },
    );
  } catch (error) {
    if (error instanceof BookingError && error.status === 409) {
      return done("taken", { status: "done", title: "That time was taken", body: { kind: "notice", text: error.message } }, { slots: (error.slots ?? []).map((slot) => ({ start: iso(slot.start), end: iso(slot.end) })) });
    }
    return failed(error instanceof Error ? error.message : String(error));
  }
};

/** One booking change by the workflow: `ok` on success, `refused` when the booking's state or the time doesn't allow it. */
const change =
  (
    label: string,
    ok: string,
    refused: string,
    run: (bookings: WorkflowBookings, booking: Booking, ctx: ActionContext) => Promise<{ booking: Booking; outputs?: Record<string, unknown> }>,
  ): ActionExecutor =>
  async (ctx) => {
    const bookings = ctx.env.bookings?.();
    if (!bookings) return failed(NO_BOOKINGS);
    const booking = await bookingOf(ctx, bookings);
    if (!booking) return done(refused, { status: "done", title: `${label}: there is no such booking`, body: { kind: "notice", text: "The booking is gone." } });
    try {
      const after = await run(bookings, booking, ctx);
      return done(ok, { status: "done", title: `${label}: ${after.booking.type.name}, ${await bookings.when(after.booking.start, after.booking.contact)}`, body: { kind: "notice", text: `Now ${after.booking.status.replace("_", "-")}.` } }, { booking: after.booking.id, ...(after.outputs ?? {}) });
    } catch (error) {
      if (error instanceof BookingError && (error.status === 409 || error.status === 404)) return done(refused, { status: "done", title: `${label}: not done`, body: { kind: "notice", text: error.message } });
      return failed(error instanceof Error ? error.message : String(error));
    }
  };

const confirmBooking = change("Confirmed", "next", "gone", async (bookings, booking, ctx) => ({ booking: await bookings.service.confirm(booking.id, by(ctx)) }));

const suggestTimes = change("Offered other times", "next", "taken", async (bookings, booking, ctx) => {
  const times = timesOf(ctx.settings["times"]);
  if (times.length === 0) throw new BookingError("No times to offer.", 409);
  const message = text(ctx.settings["message"]).trim();
  const after = await bookings.service.suggest(booking.id, by(ctx), times.slice(0, 10).map((start) => ({ start })), message ? { message } : {});
  return { booking: after, outputs: { suggestions: await Promise.all((after.suggestions ?? []).map(async (one) => ({ start: one.start, end: one.end, when: await bookings.when(one.start, after.contact) }))) } };
});

const cancelBooking = change("Cancelled", "next", "gone", async (bookings, booking, ctx) => {
  const reason = text(ctx.settings["reason"]).trim();
  return { booking: await bookings.service.cancel(booking.id, by(ctx), reason ? { reason } : {}) };
});

const moveBooking = change("Moved", "next", "taken", async (bookings, booking, ctx) => {
  const to = instantOf(ctx.settings["to"]);
  if (to === null) throw new BookingError("Say the time to move it to.", 409);
  return { booking: await bookings.service.move(booking.id, by(ctx), { start: to }, { approval: "skip" }) };
});

const assignBooking = change("Given to another host", "next", "none_free", async (bookings, booking, ctx) => {
  const after = await bookings.service.assign(booking.id, by(ctx), text(ctx.settings["to"]).trim() || undefined);
  return { booking: after, outputs: { host: after.host } };
});

const markBooking = change("Marked", "next", "next", async (bookings, booking, ctx) => ({
  booking: await bookings.service.mark(booking.id, by(ctx), ctx.settings["as"] === "no_show" ? "no_show" : "completed"),
}));

/* ── Tell them what was decided ────────────────────────────────────────── */

type Channel = "text" | "call" | "email";

/** The way to reach them: the one asked for, else their preferred, never one they opted out of. */
const channelFor = (contact: Contact, asked: unknown): Channel | null => {
  const reachable = (channel: Channel) => !contact.preferences.optOut.includes(channel) && (channel === "email" ? contact.emails.length > 0 : contact.phones.length > 0);
  if (asked === "text" || asked === "email" || asked === "call") return reachable(asked) ? asked : null;
  const order: Channel[] = [contact.preferences.channel ?? (contact.phones.length > 0 ? "text" : "email"), "text", "email", "call"];
  return order.find(reachable) ?? null;
};

/**
 * What the message must say: the decision, the times in their zone, the
 * team's message for them (never the team-only reason), the host's name only
 * when the type shows it, and the link when they have something to pick.
 */
const decisionFacts = async (ctx: ActionContext, bookings: WorkflowBookings, booking: Booking) => {
  const aboutId = text(ctx.settings["about"]).trim();
  const about = aboutId ? (ctx.case.data.steps[aboutId] as Record<string, unknown> | undefined) : undefined;
  const aboutTask = about && typeof about["task"] === "string" ? await ctx.env.tasks.get(about["task"]) : null;
  const outcome = aboutTask?.outcome ?? booking.status;
  const row = await bookings.row(booking);
  const when = text(row["when"]);
  const suggestions = (row["suggestions"] as Array<{ when: string }> | undefined) ?? [];
  const pick = booking.status === "suggested" || booking.status === "denied" || booking.status === "expired";
  const includeLink = ctx.settings["includeLink"] === "always" || (ctx.settings["includeLink"] !== "never" && pick);
  const link = includeLink ? text(row["link"]) : "";
  const times = booking.status === "suggested" ? suggestions.map((one) => one.when) : ["confirmed", "pending"].includes(booking.status) ? [when] : [];
  return {
    facts: {
      decision: outcome,
      status: booking.status,
      appointment: { type: booking.type.name, when, location: booking.location ?? null },
      ...(booking.status === "suggested" ? { timesOffered: suggestions.map((one) => one.when) } : {}),
      ...(booking.decision?.message ? { messageFromTheTeam: booking.decision.message } : {}),
      ...(booking.settings.showHostName ? { with: (row["host"] as { name?: string } | undefined)?.name ?? "" } : {}),
      ...(link ? { link } : {}),
      ...(about ? { aboutTheStep: Object.fromEntries(Object.entries(about).filter(([key]) => !["task", "reason"].includes(key))) } : {}),
    },
    times,
    link,
  };
};

const STATUS_SENTENCES: Readonly<Record<string, (when: string) => string>> = {
  confirmed: (when) => `Your appointment is confirmed for ${when}.`,
  pending: (when) => `We have your request for ${when}. The team will confirm it shortly.`,
  suggested: () => "That time isn't available, but we can offer other times.",
  denied: () => "We aren't able to book that appointment.",
  cancelled: () => "Your appointment has been cancelled.",
  expired: () => "We couldn't confirm your appointment in time.",
  completed: () => "Thanks for your visit.",
  no_show: () => "We missed you at your appointment.",
};

const inform: ActionExecutor = async (ctx) => {
  const { env, settings: s, workflow, node, agent } = ctx;
  const bookings = env.bookings?.();
  if (!bookings) return failed(NO_BOOKINGS);
  if (!agent) return failed("The message comes from an agent: choose which.");
  const aboutId = text(s["about"]).trim();
  const about = aboutId ? (ctx.case.data.steps[aboutId] as Record<string, unknown> | undefined) : undefined;
  const bookingId = text(about?.["booking"]).trim() || text((ctx.case.data.row as Record<string, unknown>)["id"]).trim();
  let booking: Booking;
  try {
    booking = await bookings.service.get(bookingId);
  } catch {
    return failed("There is no booking to tell them about.");
  }
  const contact = await bookings.contact(booking.contact);
  if (!contact) return failed("The booking's contact is gone.");
  const channel = channelFor(contact, s["channel"]);
  if (!channel) return done("next", { status: "skipped", title: "Nobody to tell: no way to reach them that they haven't opted out of." });
  const to = text(s["to"]).trim() || (channel === "email" ? (contact.emails[0] ?? "") : (contact.phones[0] ?? ""));
  if (!to) return done("next", { status: "skipped", title: `Nobody to ${channel}: no address.` });

  const { facts, times, link } = await decisionFacts(ctx, bookings, booking);
  const include = text(s["include"]).trim();
  let wording = s["content"] === "fixed" ? text(s["wording"]).trim() : "";
  let modelUsed: string | undefined;
  if (!wording) {
    const llm = env.llm?.("outreach", node.model) ?? null;
    if (llm) {
      const shared = (await env.agents.shared?.()) ?? null;
      const system =
        composeResponsePrompt({ agent, shared, channel, now: new Date(env.now()) }) +
        "\n\n## This message\nTell the person what was decided about their appointment, plainly and kindly. Use only the facts given; state every time exactly as written. Write only the message itself." +
        (include ? `\n\n## Also include (instructions from the business)\n${include}` : "") +
        (workflow.guardrails.trim() ? `\n\n## Guardrails for this workflow\n${workflow.guardrails.trim()}` : "");
      const write = async () =>
        llm.generate({ maxOutputTokens: 500, messages: [{ role: "system", content: system }, { role: "user", content: `The facts, as data:\n"""\n${JSON.stringify(facts).slice(0, 4000)}\n"""` }] });
      try {
        const result = env.withBudget ? await env.withBudget(write) : await write();
        wording = result.text.trim();
        modelUsed = result.model;
      } catch (error) {
        return failed(`${agent.name} could not write the message: ${error instanceof Error ? error.message : String(error)}`, undefined);
      }
    }
    if (!wording) wording = [(STATUS_SENTENCES[booking.status] ?? (() => ""))(times[0] ?? ""), booking.decision?.message ?? "", include].filter(Boolean).join(" ");
  }
  /* Whatever wrote it, the times and the link it was meant to state are in it. */
  const missingTimes = times.filter((one) => !wording.includes(one));
  if (missingTimes.length > 0) wording += booking.status === "suggested" ? `\n\nTimes we can offer: ${missingTimes.join("; ")}.` : `\n\nWhen: ${missingTimes.join("; ")}.`;
  if (link && !wording.includes(link)) wording += `\n\nSee or change your booking: ${link}`;

  const key = ctx.attempt.id;
  const sender = env.outreach ?? notConnectedSender;
  let sent: Awaited<ReturnType<typeof sender.send>>;
  try {
    sent = await sender.send({ channel, to, ...(channel === "email" ? { subject: `Your ${booking.type.name}` } : {}), text: wording, agent: { id: agent.id, name: agent.name }, key });
  } catch (error) {
    return { kind: "failed", error: `Could not hand the message over to be sent: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
  }
  const conversation = sent.conversation ?? ctx.task.id;
  return done(
    "next",
    {
      status: "done",
      title: `Told ${contact.name || to}: ${booking.type.name} ${booking.status.replace("_", "-")}`,
      agent: agent.id,
      body: { kind: "conversation", channel, to, agent: agent.id, sent: wording, conversation },
      links: { conversation },
      delivery: { status: sent.status, ...(sent.detail ? { detail: sent.detail } : {}), key },
      reversal: { available: false, reason: "A message cannot be unsent. Send a correction instead." },
      model: { task: "outreach", ...(modelUsed ? { model: modelUsed } : {}) },
    },
    { conversation, message: wording },
  );
};

export const SCHEDULE_EXECUTORS: Readonly<Record<string, ActionExecutor>> = {
  "ask.booking": askBooking,
  "wait.booking": waitBooking,
  "wait.appointment": waitAppointment,
  "schedule.find": findTimes,
  "schedule.hold": holdTime,
  "schedule.confirm": confirmBooking,
  "schedule.suggest": suggestTimes,
  "schedule.cancel": cancelBooking,
  "schedule.move": moveBooking,
  "schedule.assign": assignBooking,
  "schedule.mark": markBooking,
  "outreach.inform": inform,
};
