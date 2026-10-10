import { withTransient, type ActionDefinition, type ComponentDefinition } from "@freebirdai/core";
import type { AgentSpec, CalendarEntryInput, CalendarEvent } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { BookingLinks } from "../../bookings/links.js";
import type { CalendarService } from "../../calendar/service.js";
import { SCREENS, actor, allowedTo, blocked, changeRows, landed, screenComponent, type ScreenAccess } from "./common.js";

/**
 * The calendar (`#/agent/calendar`): what is on it, adding, changing,
 * finishing and removing entries, and a member's own calendar feed for their
 * phone. Entries go through `CalendarService`, as the entry sheet does;
 * appointments change only through their bookings (the Bookings screen).
 */

export interface CalendarDeps extends ScreenAccess {
  readonly calendar: CalendarService;
  readonly links: BookingLinks;
  readonly agents: readonly Pick<AgentSpec, "id" | "name" | "archived">[];
}

const SCREEN = SCREENS.calendar;
const MANAGE = "Your role here does not allow changing the calendar.";
const DAY = 86_400_000;

const entryWords = (event: Pick<CalendarEvent, "title" | "kind" | "at" | "end" | "allDay">): string =>
  `${event.title} (${event.kind}, ${event.allDay ? event.at : event.end ? `${event.at} to ${event.end}` : event.at})`;

const at = (what: string) => z.string().min(1).describe(`${what}: ISO 8601 with the person's offset, e.g. 2026-10-15T10:00:00-05:00, or a date (2026-10-15) for a whole day.`);

export const calendarScreen = (deps: CalendarDeps): ComponentDefinition => {
  const { calendar } = deps;
  const manage = allowedTo(deps, "calendar.manage", MANAGE);
  const agentName = (id: string | undefined) => (id ? deps.agents.find((agent) => agent.id === id)?.name : undefined);
  const ownerWords = (event: CalendarEvent) => (event.owner ? (event.owner.kind === "agent" ? (agentName(event.owner.id) ?? "a removed agent") : `member ${event.owner.id}`) : "nobody in particular");

  /** An entry by id, with what it is now for the card, or why it cannot be changed here. */
  const resolveEntry = async (id: string) => {
    try {
      const held = await calendar.get(id);
      if (held.kind === "appointment") return blocked("entry", "That is an appointment: change it through its booking (the Bookings screen's actions).");
      return { ok: true as const, resolvedArgs: { current: entryWords(held) } };
    } catch {
      return blocked("entry", `There is no calendar entry "${id}". list_calendar shows them with their ids.`);
    }
  };

  const list: ActionDefinition<{ from?: string; days?: number; ownerAgentId?: string; includeFinished?: boolean }, unknown, unknown> = {
    id: "list_calendar",
    description:
      "Read the calendar: events, deadlines and appointments from agents, workflows and people. Use it to answer \"what's on this week?\", " +
      "\"when is the next inspection?\" or \"what does the maintenance agent have tomorrow?\". Say times in the person's own time zone.",
    schema: z.object({
      from: z.string().optional().describe("ISO date or date-time to start from. Default: now."),
      days: z.number().int().min(1).max(92).optional().describe("How many days ahead to read. Default 7."),
      ownerAgentId: z.string().optional().describe("Only one agent's entries: an id from AGENTS."),
      includeFinished: z.boolean().optional().describe("Also entries marked done or cancelled. Default false."),
    }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    handler: async (args) => {
      const from = args.from && !Number.isNaN(Date.parse(args.from)) ? Date.parse(args.from) : deps.now();
      const to = from + (args.days ?? 7) * DAY;
      const entries = await calendar.list({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        ...(args.ownerAgentId ? { owners: [`agent:${args.ownerAgentId}`] } : {}),
        ...(args.includeFinished ? {} : { statuses: ["open", "tentative"] }),
        limit: 200,
      });
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        count: entries.length,
        entries: entries.map((one) => ({
          id: one.id,
          title: one.title,
          kind: one.kind,
          status: one.status,
          at: one.at,
          ...(one.end ? { end: one.end } : {}),
          allDay: one.allDay,
          ...(one.owner ? { owner: ownerWords(one) } : {}),
          ...(one.notes ? { notes: one.notes.slice(0, 300) } : {}),
          ...(one.workflow ? { fromWorkflow: one.workflow } : {}),
          ...(one.booking ? { booking: one.booking } : {}),
        })),
      };
    },
  };

  const add: ActionDefinition<{ title: string; at: string; end?: string; deadline?: boolean; ownerAgentId?: string; notes?: string }, unknown, unknown> = {
    id: "add_calendar_entry",
    description:
      "Put an entry on the calendar: an event that takes time, or a deadline. Ask for the day and time if the person did not say, and confirm the time zone when it is not clear. Shown on a card first.",
    schema: z.object({
      title: z.string().trim().min(1).max(200),
      at: at("When it starts"),
      end: z.string().optional().describe("When it ends, the same way. Leave out for a deadline or a single moment."),
      deadline: z.boolean().optional().describe("True for something due at that moment rather than something that takes time."),
      ownerAgentId: z.string().optional().describe("Put it on an agent's calendar: an id from AGENTS. Default: the person's own."),
      notes: z.string().max(4000).optional(),
    }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: async (args, ctx) => {
      const allowed = await manage(args, ctx);
      if (allowed !== true) return allowed;
      if (args.ownerAgentId && !deps.agents.some((agent) => agent.id === args.ownerAgentId && !agent.archived)) return { ok: false as const, reason: `"${args.ownerAgentId}" is not one of your agents.`, status: 404 };
      return true;
    },
    preview: (args) => ({
      title: `Add "${args.title}" to the calendar`,
      summary: args.deadline ? "A deadline." : "An event.",
      rows: [
        { label: "When", value: args.end ? `${args.at} to ${args.end}` : args.at },
        { label: "Calendar", value: agentName(args.ownerAgentId) ?? "Yours" },
        ...(args.notes ? [{ label: "Notes", value: args.notes }] : []),
      ],
    }),
    handler: async (args, ctx) => {
      const input: CalendarEntryInput = {
        title: args.title,
        at: args.at,
        ...(args.end ? { end: args.end } : {}),
        kind: args.deadline ? "deadline" : "event",
        ...(args.ownerAgentId ? { owner: { kind: "agent", id: args.ownerAgentId } } : {}),
        ...(args.notes ? { notes: args.notes } : {}),
      };
      const made = await calendar.create(actor(ctx), input);
      deps.changed();
      return landed({ added: true, id: made.id, entry: entryWords(made) }, SCREEN, { title: made.title, item: made.id, summary: `Added ${entryWords(made)} to the calendar.` });
    },
  };

  const change: ActionDefinition<{ entry: string; title?: string; at?: string; end?: string; deadline?: boolean; ownerAgentId?: string; notes?: string; current?: string }, unknown, unknown> = {
    id: "change_calendar_entry",
    description: "Change a calendar entry: its title, time, end, kind, calendar or notes. An empty end or notes clears it. A workflow's entry is pinned by the change, so the workflow leaves it as set. Shown on a card first.",
    schema: z.object({
      entry: z.string().min(1).describe("The entry's id, from list_calendar."),
      title: z.string().trim().min(1).max(200).optional(),
      at: at("When it starts").optional(),
      end: z.string().optional().describe("When it ends, the same way. Empty: no end."),
      deadline: z.boolean().optional().describe("True: a deadline; false: an event."),
      ownerAgentId: z.string().optional().describe("Move it to an agent's calendar: an id from AGENTS."),
      notes: z.string().max(4000).optional().describe("Its notes. Empty: none."),
      current: z.string().optional().describe("Filled in by the system with the entry as it is now; leave it out."),
    }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => resolveEntry(args.entry),
    preview: (args) => ({
      title: "Change a calendar entry",
      summary: args.current ?? "",
      rows: changeRows([
        { label: "Title", after: args.title, isNew: true },
        { label: "Starts", after: args.at, isNew: true },
        { label: "Ends", after: args.end === "" ? "No end" : args.end, isNew: true },
        { label: "Kind", after: args.deadline === undefined ? undefined : args.deadline ? "Deadline" : "Event", isNew: true },
        { label: "Calendar", after: args.ownerAgentId ? (agentName(args.ownerAgentId) ?? args.ownerAgentId) : undefined, isNew: true },
        { label: "Notes", after: args.notes === "" ? "None" : args.notes, isNew: true },
      ]),
    }),
    handler: async (args, ctx) => {
      const body: Record<string, unknown> = {};
      for (const key of ["title", "at", "end", "notes"] as const) if (args[key] !== undefined) body[key] = args[key];
      if (args.deadline !== undefined) body["kind"] = args.deadline ? "deadline" : "event";
      if (args.ownerAgentId) body["owner"] = { kind: "agent", id: args.ownerAgentId };
      const saved = await calendar.update(actor(ctx), args.entry, body);
      deps.changed();
      return landed({ updated: true, id: saved.id }, SCREEN, { title: saved.title, item: saved.id, summary: `Changed it: ${entryWords(saved)}.` });
    },
  };

  const finish: ActionDefinition<{ entry: string; status: "done" | "cancelled" | "open"; current?: string }, unknown, unknown> = {
    id: "finish_calendar_entry",
    description: "Mark a calendar entry done or cancelled, or open again. Shown on a card first.",
    schema: z.object({
      entry: z.string().min(1).describe("The entry's id, from list_calendar."),
      status: z.enum(["done", "cancelled", "open"]),
      current: z.string().optional().describe("Filled in by the system; leave it out."),
    }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => resolveEntry(args.entry),
    preview: (args) => ({ title: args.status === "open" ? "Open this entry again" : `Mark this entry ${args.status}`, summary: "", rows: args.current ? [{ label: "Entry", value: args.current }] : [] }),
    handler: async (args, ctx) => {
      const saved = await calendar.setStatus(actor(ctx), args.entry, args.status);
      deps.changed();
      return landed({ id: saved.id, status: saved.status }, SCREEN, { title: saved.title, item: saved.id, summary: `${saved.title} is ${saved.status === "open" ? "open again" : saved.status}.` });
    },
  };

  const remove: ActionDefinition<{ entry: string; current?: string }, unknown, unknown> = {
    id: "remove_calendar_entry",
    description: "Remove a calendar entry a person added. A workflow's entry is cancelled instead, so what the workflow did stays on record. Shown on a card first.",
    schema: z.object({ entry: z.string().min(1).describe("The entry's id, from list_calendar."), current: z.string().optional().describe("Filled in by the system; leave it out.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => resolveEntry(args.entry),
    preview: (args) => ({ title: "Remove this calendar entry", summary: "It cannot be brought back.", rows: args.current ? [{ label: "Entry", value: args.current }] : [] }),
    handler: async (args, ctx) => {
      await calendar.remove(actor(ctx), args.entry);
      deps.changed();
      return landed({ removed: true, id: args.entry }, SCREEN, { title: "Calendar", summary: `Removed ${args.current ?? "the entry"}.` });
    },
  };

  const feed: ActionDefinition<Record<string, never>, unknown, unknown> = {
    id: "calendar_feed",
    description: "Whether the person has a calendar feed for their phone (their own entries and appointments, read-only), and since when.",
    schema: z.object({}),
    requiresConfirmation: "none",
    mcp: { expose: false },
    handler: async (_args, ctx) => {
      const held = await deps.links.feedOf(actor(ctx).userId);
      return held ? { feed: true, since: held.createdAt, expires: held.expiresAt } : { feed: false };
    },
  };

  const makeFeed: ActionDefinition<Record<string, never>, unknown, unknown> = {
    id: "make_calendar_feed",
    description: "Make the person a calendar feed link for their phone's calendar app (read-only: their own entries and appointments). A new link stops the old one. Shown on a card first.",
    schema: z.object({}),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: allowedTo(deps, null, ""),
    preview: () => ({ title: "Make your calendar feed link", summary: "Add it to your phone's calendar app. A link you had before stops working.", rows: [] }),
    handler: async (_args, ctx) => {
      const made = await deps.links.feedLink(actor(ctx).userId);
      return withTransient(landed({ made: true }, SCREEN, { title: "Subscribe", item: "feed", summary: "Made your calendar feed link. It is shown once, to copy into your phone's calendar app; a link you had before stops working." }), { calendar: made.webcal, web: made.url });
    },
  };

  const stopFeed: ActionDefinition<Record<string, never>, unknown, unknown> = {
    id: "stop_calendar_feed",
    description: "Stop the person's calendar feed link: their phone's calendar stops updating. Shown on a card first.",
    schema: z.object({}),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: allowedTo(deps, null, ""),
    preview: () => ({ title: "Stop your calendar feed", summary: "The link stops working; a new one can be made any time.", rows: [] }),
    handler: async (_args, ctx) => {
      await deps.links.stopFeed(actor(ctx).userId);
      return landed({ stopped: true }, SCREEN, { title: "Subscribe", item: "feed", summary: "Stopped your calendar feed." });
    },
  };

  return screenComponent(
    SCREEN,
    [
      `CALENDAR: it is now ${new Date(deps.now()).toISOString()} (UTC). Times go in as ISO 8601 with the person's offset. Appointments change through their bookings, never as entries.`,
    ],
    [list, add, change, finish, remove, feed, makeFeed, stopFeed],
  );
};
