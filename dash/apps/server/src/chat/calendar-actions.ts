import type { ActionContext, ActionDefinition } from "@freebirdai/core";
import { principalSchema, type AgentSpec, type CalendarEntryInput, type CalendarEvent, type Principal } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { CalendarListOptions } from "../calendar/store.js";

/**
 * The calendar from the chat: "what's on this week?" (`list_calendar`) and
 * "put the vendor walkthrough on Thursday at 10" (`add_calendar_entry`).
 *
 * Reading needs nothing beyond being in the workspace. Adding needs
 * `calendar.manage`, goes through `CalendarService` like the page does, and
 * is shown on a card first. The tool schemas are flat; times are ISO 8601,
 * with the person's own offset, because the chat cannot see their clock.
 */

export interface CalendarChatOps {
  readonly agents: readonly Pick<AgentSpec, "id" | "name" | "archived">[];
  readonly now: () => number;
  mayManage(principal: Principal): Promise<boolean>;
  list(options: CalendarListOptions): Promise<CalendarEvent[]>;
  create(principal: Principal, input: CalendarEntryInput): Promise<CalendarEvent>;
}

const DAY = 86_400_000;

export const listCalendarSchema = z.object({
  from: z.string().optional().describe("ISO date or date-time to start from. Default: now."),
  days: z.number().int().min(1).max(92).optional().describe("How many days ahead to read. Default 7."),
  ownerAgentId: z.string().optional().describe("Only one agent's entries: an id from AGENTS."),
  includeFinished: z.boolean().optional().describe("Also entries marked done or cancelled. Default false."),
});

export const addCalendarEntrySchema = z.object({
  title: z.string().trim().min(1).max(200),
  at: z.string().min(1).describe("When it starts: ISO 8601 with the person's offset, e.g. 2026-10-15T10:00:00-05:00, or a date (2026-10-15) for a whole day."),
  end: z.string().optional().describe("When it ends, the same way. Leave out for a deadline or a single moment."),
  deadline: z.boolean().optional().describe("True for something due at that moment rather than something that takes time."),
  ownerAgentId: z.string().optional().describe("Put it on an agent's calendar: an id from AGENTS. Default: the person's own."),
  notes: z.string().max(4000).optional(),
});

const principalOf = (ctx: ActionContext<unknown>): Principal | null => {
  const extra = (ctx.auth as { extra?: Record<string, unknown> } | null)?.extra;
  const parsed = principalSchema.safeParse(extra?.["principal"]);
  return parsed.success ? parsed.data : null;
};

const words = (event: CalendarEvent): string => {
  const when = event.allDay ? event.at : event.end ? `${event.at} to ${event.end}` : event.at;
  return `${event.title} (${event.kind}, ${when})`;
};

export const calendarActions = (ops: CalendarChatOps): ActionDefinition<any, unknown, unknown>[] => {
  const agentName = (id: string | undefined) => (id ? ops.agents.find((agent) => agent.id === id)?.name : undefined);

  const list: ActionDefinition<z.infer<typeof listCalendarSchema>, unknown, unknown> = {
    id: "list_calendar",
    description:
      "Read the calendar: events, deadlines and appointments from agents, workflows and people. Use it to answer \"what's on this week?\", " +
      "\"when is the next inspection?\" or \"what does the maintenance agent have tomorrow?\". Say times in the person's own time zone.",
    schema: listCalendarSchema,
    requiresConfirmation: "none",
    mcp: { expose: false },
    handler: async (args) => {
      const from = args.from && !Number.isNaN(Date.parse(args.from)) ? Date.parse(args.from) : ops.now();
      const to = from + (args.days ?? 7) * DAY;
      const entries = await ops.list({
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
          ...(one.owner ? { owner: one.owner.kind === "agent" ? (agentName(one.owner.id) ?? "a removed agent") : `member ${one.owner.id}` } : {}),
          ...(one.notes ? { notes: one.notes.slice(0, 300) } : {}),
          ...(one.workflow ? { fromWorkflow: one.workflow } : {}),
        })),
      };
    },
  };

  const add: ActionDefinition<z.infer<typeof addCalendarEntrySchema>, unknown, unknown> = {
    id: "add_calendar_entry",
    description:
      "Put an entry on the calendar: an event that takes time, or a deadline. Ask for the day and time if the person did not say, and confirm the time zone " +
      "when it is not clear. Shown to the person on a card before it is added.",
    schema: addCalendarEntrySchema,
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: async (args, ctx) => {
      const principal = principalOf(ctx);
      if (!principal) return { ok: false as const, reason: "Nobody is signed in.", status: 401 };
      if (!(await ops.mayManage(principal))) return { ok: false as const, reason: "Your role here does not allow changing the calendar.", status: 403 };
      if (args.ownerAgentId && !ops.agents.some((agent) => agent.id === args.ownerAgentId && !agent.archived)) {
        return { ok: false as const, reason: `"${args.ownerAgentId}" is not one of your agents.`, status: 404 };
      }
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
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Nobody is signed in.");
      const made = await ops.create(principal, {
        title: args.title,
        at: args.at,
        ...(args.end ? { end: args.end } : {}),
        kind: args.deadline ? "deadline" : "event",
        ...(args.ownerAgentId ? { owner: { kind: "agent", id: args.ownerAgentId } } : {}),
        ...(args.notes ? { notes: args.notes } : {}),
      });
      return { added: true, id: made.id, entry: words(made) };
    },
  };

  return [list, add];
};

/** What the chat is told about the calendar each turn. */
export const calendarKnowledge = (ops: CalendarChatOps): Array<{ text: string }> => [
  {
    text:
      `CALENDAR: it is now ${new Date(ops.now()).toISOString()} (UTC). list_calendar reads what agents, workflows, bookings and people have scheduled; ` +
      "add_calendar_entry puts an event or a deadline on it, the person's own or an agent's. Times go in as ISO 8601 with the person's offset. " +
      "Appointments change through their bookings, never by adding entries.",
  },
];
