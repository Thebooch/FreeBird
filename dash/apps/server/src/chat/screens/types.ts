import type { ActionDefinition, ComponentDefinition } from "@freebirdai/core";
import {
  LAYER_KEYS,
  LOCATION_KINDS,
  LOCATION_WORDS,
  WHEN_UNKNOWN,
  factPathSchema,
  ruleSetSchema,
  weeklyHoursSchema,
  type AgentInput,
  type AgentSpec,
  type AgentTool,
  type AppointmentType,
  type Principal,
  type SchedulingSettings,
} from "@freebirdai/dash-spec";
import { z } from "zod";
import type { SchedulingOverview, SchedulingService } from "../../scheduling/service.js";
import { SCREENS, actor, allowedTo, argsOf, blocked, changeRows, findBy, idFrom, landed, listed, screenComponent, shown, type ScreenAccess } from "./common.js";
import { hoursInWords, rulesInWords } from "./rules-words.js";
import { mergedSettings, settingsChanges, settingsInherit, settingsRows } from "./settings-words.js";

/**
 * Appointment types (`#/agent/calendar/types`): everything the type editor
 * sets, from the chat. Each change reads the type fresh, changes only what
 * was asked, and saves through `SchedulingService.putType`, as the editor
 * does. The setup snapshot is for the card's "before"; it is dropped after
 * every scheduling change (`ScreenAccess.changed`).
 */

export interface TypesDeps extends ScreenAccess {
  /** The setup as it was when this turn began: for knowledge and the cards. */
  readonly setup: SchedulingOverview;
  readonly scheduling: SchedulingService;
  readonly agents: {
    readonly roster: readonly AgentSpec[];
    update(principal: Principal, id: string, input: AgentInput): Promise<AgentSpec>;
  };
}

const SCREEN = SCREENS.types;
const MANAGE = "Your role here does not allow changing scheduling.";

/* ── what a type's fields are, for the chat ─────────────────────────── */

const strictRules = ruleSetSchema;

const typeFields = {
  name: z.string().trim().min(1).max(80).optional().describe("What people see it called."),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(60)
    .optional()
    .describe("The public link's address, /p/<workspace>/t/<slug>: lower-case letters, digits and dashes."),
  description: z.string().max(2000).optional().describe("What it is, shown on its booking page."),
  color: z.number().int().min(1).max(8).optional().describe("Its colour on the calendar, 1 to 8."),
  active: z.boolean().optional().describe("Whether it can be booked at all."),
  hostMembers: z.array(z.string().min(1)).min(1).max(100).optional().describe("Who hosts it: people from HOSTS, by name or id. Replaces a pool."),
  hostPool: z.string().min(1).optional().describe("A pool from POOLS that hosts it, by name or id. Replaces named hosts."),
  hours: weeklyHoursSchema.nullable().optional().describe("Narrow it to these hours each week ({ mon: [{ from: '09:00', to: '12:00' }], … }). null: each host's own hours."),
  offer: z.enum(["link", "conversation"]).optional().describe("How agents offer it: a link to pick a time from, or times proposed in the conversation."),
  linkOnRequest: z.boolean().optional().describe("In conversation, send a link when the person asks for one."),
  publicLink: z.boolean().optional().describe("A public link anyone can book it from."),
  whoCanBook: strictRules.optional().describe("Who can book it at all: rules over contact.* fields and request.* answers ({ all: [{ field, op, values }], any: [] }). Empty rules: anyone."),
  whenUnknown: z.enum(WHEN_UNKNOWN).optional().describe("When a who-can-book field has no value yet: exclude (ask first, offer nothing), include, or approval (let them book, pending approval)."),
  turnedAwayMessage: z.string().trim().max(300).optional().describe("What someone it does not take is told, e.g. 'For parties of 9 or more, please call us.'"),
  questions: z
    .array(z.object({ field: factPathSchema, required: z.boolean().default(false), ask: z.string().max(300).optional() }).strict())
    .max(20)
    .optional()
    .describe("Questions asked when booking: contact.* or request.* fields, each with how to ask. Replaces the list."),
  location: z.object({ kind: z.enum(LOCATION_KINDS), value: z.string().max(300).optional() }).strict().optional().describe("Where it happens: contact_address, fixed (value: the place), phone, video or ask."),
  maxActivePerContact: z.number().int().min(1).max(20).optional().describe("How many active bookings of it one contact may hold."),
  requireVerifiedContact: z.boolean().optional().describe("Public link only: the contact must be verified first."),
};

const typeChange = z.object({
  type: z.string().min(1).describe("The type to change, by name or id, from APPOINTMENT TYPES."),
  ...typeFields,
  ...settingsChanges("type").shape,
  inherit: settingsInherit("type"),
});
type TypeChange = z.infer<typeof typeChange>;

const typeCreate = z.object({
  ...typeFields,
  name: z.string().trim().min(1).max(80).describe("What people see it called."),
  ...settingsChanges("type").shape,
});
type TypeCreate = z.infer<typeof typeCreate>;

const SETTING_KEYS = LAYER_KEYS.type;

/* ── reading the setup ──────────────────────────────────────────────── */

const findType = (setup: SchedulingOverview, key: string): AppointmentType | null => findBy(setup.types, key, (one) => [one.id, one.name, one.slug]);

const hostName = (setup: SchedulingOverview, member: string): string => setup.profiles.find((one) => one.member === member)?.displayName ?? member;

const hostsInWords = (setup: SchedulingOverview, hosts: AppointmentType["hosts"]): string =>
  "members" in hosts ? hosts.members.map((one) => hostName(setup, one)).join(", ") : `the pool ${setup.pools.find((one) => one.id === hosts.pool)?.name ?? hosts.pool}`;

/** Names to member ids, or what was not found. */
const resolveHosts = (setup: SchedulingOverview, names: readonly string[]): { members: string[]; unknown: string[] } => {
  const members: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const found = findBy(setup.profiles, name, (one) => [one.member, one.displayName, one.email]);
    if (found) members.push(found.member);
    else unknown.push(name);
  }
  return { members, unknown };
};

/** A type's own fields, as the chat changes them, from what it holds. */
const typeOwn = (type: AppointmentType) => ({
  name: type.name,
  slug: type.slug,
  description: type.description,
  color: type.color,
  active: type.active,
  hours: type.hours ?? null,
  offer: type.offer,
  linkOnRequest: type.linkOnRequest,
  publicLink: type.publicLink,
  whoCanBook: type.eligibility.rules,
  whenUnknown: type.eligibility.whenUnknown,
  turnedAwayMessage: type.eligibility.message,
  questions: type.intake,
  location: type.location,
  maxActivePerContact: type.maxActivePerContact,
  requireVerifiedContact: type.requireVerifiedContact,
});

const FIELD_LABELS: Readonly<Record<keyof ReturnType<typeof typeOwn>, string>> = {
  name: "Name",
  slug: "Link address",
  description: "Description",
  color: "Colour",
  active: "Can be booked",
  hours: "Hours",
  offer: "Agents offer it",
  linkOnRequest: "Send a link when asked",
  publicLink: "Public link",
  whoCanBook: "Who can book",
  whenUnknown: "When a field is unknown",
  turnedAwayMessage: "Told when not taken",
  questions: "Questions",
  location: "Location",
  maxActivePerContact: "Active bookings per contact",
  requireVerifiedContact: "Verified contacts only",
};

const fieldWords = (key: keyof ReturnType<typeof typeOwn>) => (value: unknown): string => {
  if (key === "hours") return hoursInWords(value as AppointmentType["hours"]);
  if (key === "whoCanBook") return rulesInWords(value as AppointmentType["eligibility"]["rules"]);
  if (key === "offer") return value === "link" ? "A link to pick from" : "Times in the conversation";
  if (key === "whenUnknown") return value === "exclude" ? "Ask first, offer nothing" : value === "include" ? "Let them book" : "Let them book, pending approval";
  if (key === "location" && value && typeof value === "object") {
    const one = value as AppointmentType["location"];
    return `${LOCATION_WORDS[one.kind]}${one.value ? `: ${one.value}` : ""}`;
  }
  if (key === "questions") return (value as AppointmentType["intake"]).map((one) => `${one.ask ?? one.field}${one.required ? " (required)" : ""}`).join("; ") || "None";
  return shown(value);
};

/** The card's rows for a change to a type, and the type as the change leaves it. */
const typeChangePlan = (setup: SchedulingOverview, held: AppointmentType, args: Partial<TypeChange>) => {
  const before = typeOwn(held);
  const fieldRows = changeRows(
    (Object.keys(FIELD_LABELS) as Array<keyof typeof FIELD_LABELS>).map((key) => ({ label: FIELD_LABELS[key], before: before[key], after: (args as Record<string, unknown>)[key], words: fieldWords(key) })),
  );
  const named = args.hostMembers ? resolveHosts(setup, args.hostMembers) : null;
  const pool = args.hostPool ? findBy(setup.pools, args.hostPool, (one) => [one.id, one.name]) : null;
  const hosts: AppointmentType["hosts"] | undefined = named && named.members.length > 0 ? { members: named.members } : pool ? { pool: pool.id } : undefined;
  const hostRows = hosts && JSON.stringify(hosts) !== JSON.stringify(held.hosts) ? [{ label: "Hosts", value: `${hostsInWords(setup, held.hosts)} → ${hostsInWords(setup, hosts)}` }] : [];
  const changes = Object.fromEntries(SETTING_KEYS.map((key) => [key, (args as Record<string, unknown>)[key]])) as Partial<Record<keyof SchedulingSettings, unknown>>;
  const settings = mergedSettings(held.settings, changes, args.inherit);
  return { rows: [...fieldRows, ...hostRows, ...settingsRows(held.settings, settings)], hosts, settings, unknownHosts: named?.unknown ?? [], unknownPool: args.hostPool && !pool ? args.hostPool : null };
};

/** What the service is given for a change: the type's own fields as it stores them. */
const typeInput = (held: AppointmentType | null, args: Partial<TypeChange> & Partial<TypeCreate>, plan: { hosts?: AppointmentType["hosts"]; settings: AppointmentType["settings"] }) => {
  const input: Record<string, unknown> = {};
  for (const key of ["name", "slug", "description", "color", "active", "offer", "linkOnRequest", "publicLink", "maxActivePerContact", "requireVerifiedContact", "location"] as const) {
    if (args[key] !== undefined) input[key] = args[key];
  }
  if (args.hours !== undefined) input["hours"] = args.hours ?? undefined;
  if (args.questions !== undefined) input["intake"] = args.questions;
  if (args.whoCanBook !== undefined || args.whenUnknown !== undefined || args.turnedAwayMessage !== undefined) {
    input["eligibility"] = {
      ...(held?.eligibility ?? {}),
      ...(args.whoCanBook !== undefined ? { rules: args.whoCanBook } : {}),
      ...(args.whenUnknown !== undefined ? { whenUnknown: args.whenUnknown } : {}),
      ...(args.turnedAwayMessage !== undefined ? { message: args.turnedAwayMessage } : {}),
    };
  }
  if (plan.hosts) input["hosts"] = plan.hosts;
  input["settings"] = plan.settings;
  return input;
};

/* ── the screen ─────────────────────────────────────────────────────── */

export const typesScreen = (deps: TypesDeps): ComponentDefinition => {
  const { setup, scheduling } = deps;
  const manage = allowedTo(deps, "calendar.manage", MANAGE);

  const list: ActionDefinition<{ type?: string }, unknown, unknown> = {
    id: "list_types",
    description: "Read the appointment types: every setting of one (by name or id), or a summary of all.",
    schema: z.object({ type: z.string().optional().describe("One type, by name or id. Leave out for all of them.") }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    handler: async (args) => {
      const { types, profiles, pools } = await scheduling.overview();
      const now = { ...setup, types, profiles, pools };
      if (args.type) {
        const one = findType(now, args.type);
        if (!one) return { error: `There is no type "${args.type}". Types: ${listed(types.map((each) => each.name))}.` };
        return { type: one, hosts: hostsInWords(now, one.hosts), hours: hoursInWords(one.hours), whoCanBook: rulesInWords(one.eligibility.rules) };
      }
      return {
        types: types.map((one) => ({
          id: one.id,
          name: one.name,
          active: one.active,
          hosts: hostsInWords(now, one.hosts),
          length: one.settings.length ?? "workspace default",
          approval: one.settings.approval ?? "workspace default",
          whoCanBook: rulesInWords(one.eligibility.rules),
          publicLink: one.publicLink,
          offer: one.offer,
        })),
      };
    },
  };

  const tryOut: ActionDefinition<{ type: string; contact?: string; facts?: Record<string, unknown>; answers?: Record<string, unknown>; from?: string; days?: number }, unknown, unknown> = {
    id: "try_type",
    description: "See what a type would offer someone: open times, or why it does not take them. For a contact (id) or for facts typed in.",
    schema: z.object({
      type: z.string().min(1).describe("The type, by name or id."),
      contact: z.string().optional().describe("A contact's id, to use what they hold."),
      facts: z.record(z.unknown()).optional().describe("Or contact fields to try, like { category: 'member' }."),
      answers: z.record(z.unknown()).optional().describe("Answers to the type's request.* questions, like { partySize: 9 }."),
      from: z.string().optional().describe("ISO date or date-time to start from. Default: now."),
      days: z.number().int().min(1).max(31).optional().describe("How many days to look at. Default 14."),
    }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: manage,
    handler: async (args) => {
      const type = findType({ ...setup, types: (await scheduling.overview()).types }, args.type);
      if (!type) return { error: `There is no type "${args.type}".` };
      const from = args.from && Number.isFinite(Date.parse(args.from)) ? Date.parse(args.from) : deps.now();
      const to = from + (args.days ?? 14) * 86_400_000;
      const result = await scheduling.preview(type.id, {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        ...(args.contact ? { contactId: args.contact } : { contact: args.facts ?? {} }),
        request: args.answers ?? {},
      });
      return { type: type.name, ...result, slots: result.slots.slice(0, 40) };
    },
  };

  const create: ActionDefinition<TypeCreate, unknown, unknown> = {
    id: "create_type",
    description: "Make a new appointment type: its name and hosts, and any of its settings. Shown on a card first.",
    schema: argsOf<TypeCreate>(typeCreate),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      if (!args.hostMembers && !args.hostPool) return blocked("hostMembers", `Say who hosts it: people (${listed(setup.profiles.map((one) => one.displayName))}) or a pool (${listed(setup.pools.map((one) => one.name))}).`);
      const plan = typeChangePlan(setup, newType(args.name), args);
      if (plan.unknownHosts.length > 0) return blocked("hostMembers", `${plan.unknownHosts.join(", ")} ${plan.unknownHosts.length === 1 ? "is" : "are"} not set up under People. People: ${listed(setup.profiles.map((one) => one.displayName))}.`);
      if (plan.unknownPool) return blocked("hostPool", `There is no pool "${plan.unknownPool}". Pools: ${listed(setup.pools.map((one) => one.name))}.`);
      return { ok: true };
    },
    preview: (args) => {
      const plan = typeChangePlan(setup, newType(args.name ?? "New type"), args);
      return {
        title: `Make the appointment type "${args.name ?? "…"}"`,
        summary: "A new type people can book. It is active unless you say otherwise.",
        rows: [{ label: "Hosts", value: plan.hosts ? hostsInWords(setup, plan.hosts) : "—" }, ...plan.rows.filter((row) => row.label !== "Name" && row.label !== "Hosts")],
      };
    },
    handler: async (args) => {
      const { types } = await scheduling.overview();
      const id = idFrom(args.name, new Set(types.map((one) => one.id)));
      const slug = args.slug ?? idFrom(args.name, new Set(types.map((one) => one.slug)));
      const fresh = await scheduling.overview();
      const plan = typeChangePlan({ ...setup, ...fresh }, newType(args.name), args);
      const made = await scheduling.putType(id, { ...typeInput(null, args, plan), slug });
      deps.changed();
      return landed({ created: true, id: made.id, name: made.name }, SCREEN, { title: made.name, item: made.id, summary: `Made the appointment type "${made.name}".` });
    },
  };

  const change: ActionDefinition<TypeChange, unknown, unknown> = {
    id: "update_type",
    description:
      "Change an appointment type: any of its own fields (name, hosts, hours, who can book, questions, location, public link, how agents offer it) and any of its settings (length, approval, notice, holds, cut-offs, stacking…). Only what is given changes. Shown on a card first.",
    schema: argsOf<TypeChange>(typeChange),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const held = findType(setup, args.type);
      if (!held) return blocked("type", `There is no type "${args.type}". Types: ${listed(setup.types.map((one) => one.name))}.`);
      const plan = typeChangePlan(setup, held, args);
      if (plan.unknownHosts.length > 0) return blocked("hostMembers", `${plan.unknownHosts.join(", ")} ${plan.unknownHosts.length === 1 ? "is" : "are"} not set up under People.`);
      if (plan.unknownPool) return blocked("hostPool", `There is no pool "${plan.unknownPool}". Pools: ${listed(setup.pools.map((one) => one.name))}.`);
      return { ok: true, resolvedArgs: { type: held.id } };
    },
    preview: (args) => {
      const held = findType(setup, args.type);
      if (!held) return { title: `Change "${args.type}"`, summary: "That type was not found.", rows: [] };
      const plan = typeChangePlan(setup, held, args);
      return { title: `Change "${held.name}"`, summary: plan.rows.length > 0 ? "Only these change." : "Nothing would change.", rows: plan.rows };
    },
    handler: async (args) => {
      const fresh = await scheduling.overview();
      const now = { ...setup, ...fresh };
      const held = findType(now, args.type);
      if (!held) throw new Error(`There is no type "${args.type}" any more.`);
      const plan = typeChangePlan(now, held, args);
      const saved = await scheduling.putType(held.id, typeInput(held, args, plan));
      deps.changed();
      const said = plan.rows.map((row) => `${row.label}: ${row.value}`).join("; ");
      return landed({ updated: true, id: saved.id }, SCREEN, { title: saved.name, item: saved.id, summary: `Changed "${saved.name}". ${said}`.slice(0, 400) });
    },
  };

  const remove: ActionDefinition<{ type: string }, unknown, unknown> = {
    id: "remove_type",
    description: "Remove an appointment type. Refused while a block still names it. Its bookings stay. Shown on a card first.",
    schema: z.object({ type: z.string().min(1).describe("The type, by name or id.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const held = findType(setup, args.type);
      return held ? { ok: true, resolvedArgs: { type: held.id } } : blocked("type", `There is no type "${args.type}". Types: ${listed(setup.types.map((one) => one.name))}.`);
    },
    preview: (args) => {
      const held = findType(setup, args.type);
      return { title: `Remove "${held?.name ?? args.type}"`, summary: "It can no longer be booked. Bookings already made stay.", rows: held ? [{ label: "Hosts", value: hostsInWords(setup, held.hosts) }] : [] };
    },
    handler: async (args) => {
      const held = findType({ ...setup, types: (await scheduling.overview()).types }, args.type);
      if (!held) throw new Error(`There is no type "${args.type}" any more.`);
      await scheduling.removeType(held.id);
      deps.changed();
      return landed({ removed: true, id: held.id }, SCREEN, { title: "Appointment types", summary: `Removed the appointment type "${held.name}".` });
    },
  };

  const agentBooks: ActionDefinition<{ agent: string; on?: boolean; types?: string[]; offer?: Record<string, "link" | "conversation">; mode?: "auto" | "approve" | "deny"; whenToUse?: string; denyReply?: string }, unknown, unknown> = {
    id: "let_agent_book",
    description:
      "Let an agent book appointments in its conversations (or stop it): which types it may book, how it offers each, and whether each booking needs a person's approval. Shown on a card first.",
    schema: z.object({
      agent: z.string().min(1).describe("The agent, by name or id."),
      on: z.boolean().optional().describe("Whether it books at all. Default true."),
      types: z.array(z.string().min(1)).max(50).optional().describe("The types it may book, by name or id. Empty: every active type."),
      offer: z.record(z.enum(["link", "conversation"])).optional().describe("Per type (name or id): offer a link or times in the conversation, where it differs from the type's own."),
      mode: z.enum(["auto", "approve", "deny"]).optional().describe("auto: books by itself; approve: a person approves each; deny: never, and answers with denyReply."),
      whenToUse: z.string().max(1000).optional().describe("When it should book, in plain words."),
      denyReply: z.string().max(1000).optional().describe("With mode deny: what it says instead."),
    }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: allowedTo(deps, "agents.manage", "Your role here does not allow changing agents."),
    preflight: async (args) => {
      const agent = findBy(deps.agents.roster.filter((one) => !one.archived), args.agent, (one) => [one.id, one.name]);
      if (!agent) return blocked("agent", `There is no agent "${args.agent}". Agents: ${listed(deps.agents.roster.filter((one) => !one.archived).map((one) => one.name))}.`);
      const unknown = (args.types ?? []).filter((one) => !findType(setup, one));
      if (unknown.length > 0) return blocked("types", `There is no type ${unknown.map((one) => `"${one}"`).join(", ")}. Types: ${listed(setup.types.map((one) => one.name))}.`);
      return { ok: true, resolvedArgs: { agent: agent.id } };
    },
    preview: (args) => {
      const agent = findBy(deps.agents.roster, args.agent, (one) => [one.id, one.name]);
      const held = agent?.tools.find((one) => one.kind === "schedule_appointment");
      const typeNames = (ids: readonly string[]) => (ids.length === 0 ? "Every active type" : ids.map((one) => findType(setup, one)?.name ?? one).join(", "));
      const modeWords = (mode: unknown) => (mode === "auto" ? "Books by itself" : mode === "approve" ? "A person approves each" : mode === "deny" ? "Never" : "—");
      return {
        title: `${args.on === false ? "Stop" : "Let"} ${agent?.name ?? args.agent} book appointments`,
        summary: "In its conversations, with the times the calendar has open.",
        rows: changeRows([
          { label: "Books appointments", before: held ? held.enabled : false, after: args.on ?? true },
          ...(args.types !== undefined ? [{ label: "Types", before: held?.schedule?.types, after: args.types, words: (value: unknown) => typeNames((value as string[] | undefined) ?? []) }] : []),
          ...(args.mode !== undefined ? [{ label: "Each booking", before: held?.mode, after: args.mode, words: modeWords }] : []),
          ...(args.offer !== undefined ? [{ label: "Offers", after: Object.entries(args.offer).map(([type, how]) => `${findType(setup, type)?.name ?? type}: ${how === "link" ? "a link" : "times in the conversation"}`).join("; "), isNew: true }] : []),
          ...(args.whenToUse !== undefined ? [{ label: "When", before: held?.whenToUse, after: args.whenToUse }] : []),
          ...(args.denyReply !== undefined ? [{ label: "Says instead", before: held?.denyReply, after: args.denyReply }] : []),
        ]),
      };
    },
    handler: async (args, ctx) => {
      const agent = findBy(deps.agents.roster, args.agent, (one) => [one.id, one.name]);
      if (!agent) throw new Error(`There is no agent "${args.agent}".`);
      const { types } = await scheduling.overview();
      const idOf = (key: string) => findBy(types, key, (one) => [one.id, one.name, one.slug])?.id ?? key;
      const held = agent.tools.find((one) => one.kind === "schedule_appointment");
      const tool: AgentTool = {
        ...(held ?? { id: "schedule-appointment", kind: "schedule_appointment", enabled: true, mode: "approve", scope: {}, description: "", whenToUse: "", denyReply: "" }),
        enabled: args.on ?? true,
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.whenToUse !== undefined ? { whenToUse: args.whenToUse } : {}),
        ...(args.denyReply !== undefined ? { denyReply: args.denyReply } : {}),
        schedule: {
          types: args.types !== undefined ? args.types.map(idOf) : (held?.schedule?.types ?? []),
          offer: args.offer !== undefined ? Object.fromEntries(Object.entries(args.offer).map(([type, how]) => [idOf(type), how])) : (held?.schedule?.offer ?? {}),
        },
      } as AgentTool;
      const tools = held ? agent.tools.map((one) => (one === held ? tool : one)) : [...agent.tools, tool];
      await deps.agents.update(actor(ctx), agent.id, { tools } as AgentInput);
      deps.changed();
      return { updated: true, agent: agent.name, books: tool.enabled };
    },
  };

  const typeLines = setup.types.map(
    (one) =>
      `${one.name} (id ${one.id}${one.active ? "" : ", off"}; ${hostsInWords(setup, one.hosts)}; ${one.settings.length ?? "default length"}; approval ${one.settings.approval ?? "default"}${one.eligibility.rules.all.length + one.eligibility.rules.any.length > 0 ? "; has who-can-book rules" : ""})`,
  );
  return screenComponent(
    SCREEN,
    [
      `APPOINTMENT TYPES: ${typeLines.length > 0 ? typeLines.join("; ") : "none yet"}. HOSTS: ${listed(setup.profiles.map((one) => `${one.displayName} (${one.member})`), 30)}. POOLS: ${listed(setup.pools.map((one) => `${one.name} (${one.id})`), 30)}.`,
      "What happens to someone a type turns away, besides its message, is a workflow: use_workflow_template with recipe-turned-away and types: [the type's id]. Booking workflows (a booking trigger) take types too.",
    ],
    [list, tryOut, create, change, remove, agentBooks],
  );
};

/** A type that does not exist yet, to measure a new one's rows against. */
const newType = (name: string): AppointmentType =>
  ({
    id: "",
    name,
    slug: "",
    description: "",
    color: 1,
    active: true,
    hosts: { members: [] },
    settings: {},
    offer: "conversation",
    linkOnRequest: true,
    publicLink: false,
    eligibility: { rules: { all: [], any: [] }, whenUnknown: "exclude", message: "" },
    intake: [],
    location: { kind: "ask" },
    maxActivePerContact: 1,
    requireVerifiedContact: false,
    version: 1,
    createdAt: "",
    updatedAt: "",
  }) as AppointmentType;
