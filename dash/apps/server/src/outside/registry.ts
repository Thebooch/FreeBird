import { createComponentRegistry, type ActionDefinition, type ComponentRegistry } from "@freebirdai/core";
import { mailMessageSchema, type MailMessage, type ScreenRecord } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { BookingService } from "../bookings/service.js";
import type { ContactService } from "../contacts/service.js";
import type { InboundService } from "../inbound/service.js";
import type { SchedulingService } from "../scheduling/service.js";

/**
 * What outside agents may do with the business over MCP (Dash Evals,
 * phase 4): the same things a stranger may do on the public booking page,
 * and write to the team. Never the team's own tools.
 *
 * - See the services that can be booked by link.
 * - See open times for one, and ask for one: the request is held for the
 *   person to confirm, as on the public link, since anyone can type an email.
 * - Send a message: screened like an email, and a workflow it starts carries
 *   the mark, so nothing it says drives an outside step on Auto.
 *
 * Every call names the email it acts for, and goes through the requester
 * policy keyed to it. What it learns is only what the public pages show:
 * no one's bookings, no contact's details.
 */

/** Who is calling: the session's agent, as it says it is, and where it called from. */
export interface OutsideAuth {
  readonly session: string;
  /** The agent's own name for itself, if it gave one. Said, not proven: it raises no trust. */
  readonly agent?: string;
}

export interface OutsideDeps {
  readonly scheduling: SchedulingService;
  readonly bookings: BookingService;
  readonly contacts: ContactService;
  readonly inbound: InboundService;
  /** Starts the workspace's workflows for a message an outside agent sent, after the screen let it through. */
  readonly proceed: (message: MailMessage, text: string, screen: ScreenRecord) => Promise<void>;
  /** Whether outside agents may connect at all: off until the team turns it on. */
  readonly enabled: () => Promise<boolean>;
  readonly now: () => number;
  readonly newId: () => string;
}

const DAY = 86_400_000;
const email = z.string().trim().email().max(200).describe("The email of the person you act for. Replies and confirmations go there.");
const name = z.string().trim().min(1).max(120).describe("Their name.");

export class OutsideError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "OutsideError";
  }
}

export const outsideRegistry = (deps: OutsideDeps): ComponentRegistry<unknown, OutsideAuth> => {
  const registry = createComponentRegistry<unknown, OutsideAuth>();

  /** Off, or a refusal from the requester policy, in its own words. */
  const open = async (): Promise<true | { ok: false; reason: string; status: number }> =>
    (await deps.enabled()) ? true : { ok: false, reason: "This business does not take requests from outside agents.", status: 403 };
  const gate = async (who: string, action: "start" | "book", counts: { bookingsToday?: number; openHolds?: number } = {}) => {
    const answer = await deps.inbound.gate({ email: who, action, ...counts });
    if (!answer.allowed) throw new OutsideError(answer.reason ?? "This can't be done here right now.", 429);
  };
  const bookable = async () => (await deps.scheduling.overview()).types.filter((type) => type.active && (type.publicLink || type.offer === "link"));
  const typeOf = async (key: string) => {
    const type = (await bookable()).find((one) => one.id === key || one.slug === key);
    if (!type) throw new OutsideError(`There is no service "${key}" that can be booked here. list_services shows them.`, 404);
    return type;
  };
  /** The person, as a contact anyone could have typed: never added to one that exists. */
  const person = async (who: string, called: string) => deps.contacts.findOrCreate({ email: who, name: called, origin: "public_link", unverified: true });

  const listServices: ActionDefinition<Record<string, never>, unknown, OutsideAuth> = {
    id: "list_services",
    description: "The services that can be booked, each with its id and what it is.",
    schema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    authorize: open,
    requiresConfirmation: "none",
    handler: async () => ({ services: (await bookable()).map((type) => ({ id: type.slug || type.id, name: type.name, description: type.description })) }),
  };

  const findTimes: ActionDefinition<{ service: string; email: string; name: string; from?: string; days?: number }, unknown, OutsideAuth> = {
    id: "find_times",
    description: "Open times for a service, for the person you act for. Times are ISO instants.",
    schema: z.object({ service: z.string().min(1).max(80), email, name, from: z.string().optional().describe("ISO date to start from. Default now."), days: z.number().int().min(1).max(31).optional() }),
    authorize: open,
    requiresConfirmation: "none",
    handler: async (args) => {
      await gate(args.email, "start");
      const type = await typeOf(args.service);
      const contact = await person(args.email, args.name);
      const from = Math.max(args.from ? Date.parse(args.from) || deps.now() : deps.now(), deps.now());
      const found = await deps.bookings.slotsFor(type.id, contact.id, { from, to: from + (args.days ?? 7) * DAY });
      return { service: type.name, times: found.slots.slice(0, 40).map((slot) => new Date(slot.start).toISOString()) };
    },
  };

  const requestTime: ActionDefinition<{ service: string; email: string; name: string; start: string; notes?: string }, unknown, OutsideAuth> = {
    id: "request_appointment",
    description: "Ask for one of the open times for the person you act for. It is held until they confirm from their email, and the business may still need to approve it.",
    schema: z.object({ service: z.string().min(1).max(80), email, name, start: z.string().describe("One of the times find_times gave."), notes: z.string().max(1000).optional() }),
    authorize: open,
    requiresConfirmation: "none",
    handler: async (args, ctx) => {
      const type = await typeOf(args.service);
      const contact = await person(args.email, args.name);
      const theirs = await deps.bookings.list({ contact: contact.id, limit: 200 });
      const dayAgo = new Date(deps.now() - DAY).toISOString();
      await gate(args.email, "book", { bookingsToday: theirs.filter((one) => one.createdAt >= dayAgo).length, openHolds: theirs.filter((one) => one.status === "pending").length });
      const start = Date.parse(args.start);
      if (!Number.isFinite(start)) throw new OutsideError("Pick one of the times find_times gave.");
      const made = await deps.bookings.request({
        type: type.id,
        contact: contact.id,
        start,
        answers: { ...(args.notes ? { notes: args.notes } : {}), ...(ctx.auth?.agent ? { via: `Outside agent: ${ctx.auth.agent}` } : {}) },
        origin: "public_link",
        by: { kind: "contact", id: contact.id },
        /* As on the public link: anyone can type an email, so the time is held only until they confirm. */
        holdFor: "4h",
      });
      return { requested: new Date(made.booking.start).toISOString(), status: made.outcome === "pending" ? "held until the person confirms, or the business approves" : "booked", service: type.name };
    },
  };

  const sendMessage: ActionDefinition<{ email: string; name: string; subject: string; text: string }, unknown, OutsideAuth> = {
    id: "send_message",
    description: "Write to the business for the person you act for: a question, a request. The team or its agents answer by email.",
    schema: z.object({ email, name, subject: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(8000) }),
    authorize: open,
    requiresConfirmation: "none",
    handler: async (args) => {
      const id = `mcp-${deps.newId()}`;
      const message = mailMessageSchema.parse({
        id,
        threadId: id,
        mailbox: "mcp",
        from: { address: args.email, name: args.name },
        subject: args.subject,
        snippet: args.text.slice(0, 1000),
        at: new Date(deps.now()).toISOString(),
      });
      const screen = await deps.inbound.screen(message, args.text);
      if (screen.status === "held") return { status: "received", note: "The team will read it before anything is done about it." };
      await deps.proceed(message, args.text, screen);
      return { status: "received" };
    },
  };

  registry.register({
    id: "business",
    title: "The business",
    description: "Book a service, or write to the team, for the person you act for.",
    grid: { minW: 12, minH: 4 },
    knowledge: [{ text: "Every request names the email of the person it is for. Requests are limited per person, and a business may block a sender." }],
    actions: [listServices, findTimes, requestTime, sendMessage] as never,
  });
  return registry;
};
