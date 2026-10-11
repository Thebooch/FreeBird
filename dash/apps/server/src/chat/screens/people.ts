import type { ActionDefinition, ComponentDefinition } from "@freebirdai/core";
import { POOL_ASSIGN, POOL_ASSIGN_WORDS, weeklyHoursSchema, type Pool, type SchedulingProfile, type SchedulingSettings } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { SchedulingOverview, SchedulingService } from "../../scheduling/service.js";
import { SCREENS, allowedTo, argsOf, blocked, changeRows, findBy, idFrom, landed, listed, screenComponent, shown, type ScreenAccess } from "./common.js";
import { hoursInWords } from "./rules-words.js";
import { mergedSettings, settingsChanges, settingsInherit, settingsRows } from "./settings-words.js";

/**
 * People & pools (`#/agent/calendar/people`): whose time can be booked (each
 * host's profile: hours, zone, settings, how they answer approvals) and the
 * pools that share the work. Saved through `SchedulingService`, as the tab is.
 */

export interface PeopleDeps extends ScreenAccess {
  readonly setup: SchedulingOverview;
  readonly scheduling: SchedulingService;
}

const SCREEN = SCREENS.people;
const MANAGE = "Your role here does not allow changing scheduling.";

const hostFields = {
  displayName: z.string().trim().min(1).max(80).optional().describe("Their name as people booking see it."),
  email: z.string().email().optional().describe("Where approval requests and notices go."),
  bookable: z.boolean().optional().describe("Whether their time can be booked at all."),
  timezone: z.string().optional().describe("Their IANA time zone, like America/Chicago."),
  hours: weeklyHoursSchema.optional().describe("Their working hours each week ({ mon: [{ from: '09:00', to: '17:00' }], …, sat: [], sun: [] })."),
  outsideBlocks: z.enum(["open", "closed"]).optional().describe("Working hours no block covers: open to anyone, or closed (bookable only through blocks)."),
  approvalsNeedSignIn: z.boolean().optional().describe("Whether answering an approval request needs them signed in."),
  approvalsByEmail: z.boolean().optional().describe("Whether approval requests reach them by email."),
  color: z.number().int().min(1).max(8).optional().describe("Their colour on the calendar, 1 to 8."),
};

const hostChange = z.object({
  host: z.string().min(1).describe("Who: a person from HOSTS or MEMBERS by name, email or id; or a new team member's name with an email, for someone who answers through the approval page without signing in."),
  ...hostFields,
  ...settingsChanges("host").shape,
  inherit: settingsInherit("host"),
});
type HostChange = z.infer<typeof hostChange>;

const poolFields = {
  name: z.string().trim().min(1).max(80).optional().describe("The pool's name."),
  color: z.number().int().min(1).max(8).optional().describe("Its colour, 1 to 8."),
  timezone: z.string().optional().describe("Its IANA time zone."),
  members: z
    .array(z.object({ host: z.string().min(1), priority: z.number().int().min(1).max(100).optional(), active: z.boolean().optional() }).strict())
    .max(100)
    .optional()
    .describe("Who is in it: hosts by name or id, each with a priority (1 first) and whether they take bookings now. Replaces the list."),
  assign: z.enum(POOL_ASSIGN).optional().describe("Who gets each booking: round_robin (take turns), least_busy, priority, or customer_picks."),
  sticky: z.boolean().optional().describe("A returning contact gets their last host when that host is free."),
  leastBusyWindow: z.enum(["day", "week"]).optional().describe("With least_busy: busiest over the day or the week."),
};

const poolChange = z.object({ pool: z.string().min(1).describe("The pool, by name or id; a new name makes a new pool."), ...poolFields });
type PoolChange = z.infer<typeof poolChange>;

const findHost = (setup: SchedulingOverview, key: string): SchedulingProfile | null => findBy(setup.profiles, key, (one) => [one.member, one.displayName, one.email]);
const findMember = (setup: SchedulingOverview, key: string) => findBy(setup.members, key, (one) => [one.userId, one.email]);
const findPool = (setup: SchedulingOverview, key: string): Pool | null => findBy(setup.pools, key, (one) => [one.id, one.name]);

const HOST_LABELS = {
  displayName: "Name",
  email: "Email",
  bookable: "Can be booked",
  timezone: "Time zone",
  hours: "Hours",
  outsideBlocks: "Hours no block covers",
  approvalsNeedSignIn: "Approvals need sign-in",
  approvalsByEmail: "Approval requests by email",
  color: "Colour",
} as const;

const hostOwn = (profile: SchedulingProfile | null) =>
  profile
    ? {
        displayName: profile.displayName,
        email: profile.email,
        bookable: profile.bookable,
        timezone: profile.timezone,
        hours: profile.hours,
        outsideBlocks: profile.outsideBlocks,
        approvalsNeedSignIn: profile.approvals.requireSignIn,
        approvalsByEmail: profile.approvals.email,
        color: profile.color,
      }
    : null;

const hostPlan = (held: SchedulingProfile | null, args: Partial<HostChange>) => {
  const before = hostOwn(held);
  const rows = changeRows(
    (Object.keys(HOST_LABELS) as Array<keyof typeof HOST_LABELS>).map((key) => ({
      label: HOST_LABELS[key],
      before: before?.[key],
      after: (args as Record<string, unknown>)[key],
      isNew: !held,
      words: key === "hours" ? (value: unknown) => hoursInWords(value as SchedulingProfile["hours"]) : key === "outsideBlocks" ? (value: unknown) => (value === "closed" ? "Closed: blocks only" : "Open to anyone") : shown,
    })),
  );
  const changes = Object.fromEntries(Object.keys(settingsChanges("host").shape).map((key) => [key, (args as Record<string, unknown>)[key]])) as Partial<Record<keyof SchedulingSettings, unknown>>;
  const settings = mergedSettings(held?.settings, changes, args.inherit);
  return { rows: [...rows, ...settingsRows(held?.settings, settings)], settings };
};

const poolPlan = (setup: SchedulingOverview, held: Pool | null, args: Partial<PoolChange>) => {
  const memberWords = (value: unknown) =>
    ((value as Array<{ member?: string; host?: string; priority?: number; active?: boolean }>) ?? [])
      .map((one) => `${findHost(setup, one.member ?? one.host ?? "")?.displayName ?? one.member ?? one.host}${one.priority && one.priority !== 1 ? ` (priority ${one.priority})` : ""}${one.active === false ? " (paused)" : ""}`)
      .join(", ") || "Nobody";
  return changeRows([
    { label: "Name", before: held?.name, after: args.name, isNew: !held },
    { label: "Members", before: held?.members, after: args.members, words: memberWords, isNew: !held },
    { label: "Who gets each booking", before: held?.assign, after: args.assign, words: (value) => POOL_ASSIGN_WORDS[value as Pool["assign"]] ?? shown(value), isNew: !held },
    { label: "Returning contacts keep their host", before: held?.sticky, after: args.sticky, isNew: !held },
    { label: "Least busy over", before: held?.leastBusyWindow, after: args.leastBusyWindow, isNew: !held },
    { label: "Time zone", before: held?.timezone, after: args.timezone, isNew: !held },
    { label: "Colour", before: held?.color, after: args.color, isNew: !held },
  ]);
};

export const peopleScreen = (deps: PeopleDeps): ComponentDefinition => {
  const { setup, scheduling } = deps;
  const manage = allowedTo(deps, "calendar.manage", MANAGE);

  const list: ActionDefinition<Record<string, never>, unknown, unknown> = {
    id: "list_people",
    description: "Read whose time can be booked (each host's hours, zone and settings), the pools, and the workspace's members not set up yet.",
    schema: z.object({}),
    requiresConfirmation: "none",
    mcp: { expose: false },
    handler: async () => {
      const now = await scheduling.overview();
      return {
        hosts: now.profiles.map((one) => ({ id: one.member, name: one.displayName, email: one.email, bookable: one.bookable, timezone: one.timezone, hours: hoursInWords(one.hours), outsideBlocks: one.outsideBlocks, settings: one.settings })),
        pools: now.pools.map((one) => ({ id: one.id, name: one.name, assign: one.assign, members: one.members.map((each) => ({ host: findHost(now, each.member)?.displayName ?? each.member, priority: each.priority, active: each.active })) })),
        notSetUp: now.members.filter((one) => !now.profiles.some((profile) => profile.member === one.userId)).map((one) => ({ id: one.userId, email: one.email, role: one.role })),
      };
    },
  };

  const setHost: ActionDefinition<HostChange, unknown, unknown> = {
    id: "set_up_host",
    description:
      "Set up or change a host whose time can be booked: hours, time zone, whether they can be booked, how approvals reach them, and their own settings (length, notice, horizon, stacking, most per day). Adds a team member who does not sign in when given a new name and an email. Shown on a card first.",
    schema: argsOf<HostChange>(hostChange),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const held = findHost(setup, args.host);
      if (held) return { ok: true, resolvedArgs: { host: held.member } };
      const member = findMember(setup, args.host);
      if (member) return { ok: true, resolvedArgs: { host: member.userId } };
      if (!args.email) return blocked("email", `"${args.host}" is not a member of this workspace. To add them as a team member who answers through the approval page, give their email too.`);
      if (!args.timezone) return blocked("timezone", `Say ${args.host}'s time zone, like America/Chicago.`);
      return { ok: true };
    },
    preview: (args) => {
      const held = findHost(setup, args.host);
      const member = held ? null : findMember(setup, args.host);
      const plan = hostPlan(held, { ...(member && !args.displayName ? { displayName: member.email.split("@")[0] } : {}), ...args });
      return {
        title: held ? `Change ${held.displayName}'s scheduling` : member ? `Set up ${member.email} for booking` : `Add ${args.displayName ?? args.host} as a team member`,
        summary: held ? "Only these change." : member ? "Their time can be booked once they are bookable." : "They answer approval requests through the page, without signing in.",
        rows: plan.rows,
      };
    },
    handler: async (args) => {
      const now = await scheduling.overview();
      const held = findHost(now, args.host);
      const member = held ? null : findMember(now, args.host);
      const id = held?.member ?? member?.userId ?? `team-${idFrom(args.displayName ?? args.host, new Set(now.profiles.map((one) => one.member.replace(/^team-/, ""))))}`.slice(0, 66);
      const plan = hostPlan(held, args);
      const input: Record<string, unknown> = { settings: plan.settings };
      for (const key of ["displayName", "email", "bookable", "timezone", "hours", "outsideBlocks", "color"] as const) if (args[key] !== undefined) input[key] = args[key];
      if (!held && input["displayName"] === undefined) input["displayName"] = member?.email.split("@")[0] ?? args.host;
      if (args.approvalsNeedSignIn !== undefined || args.approvalsByEmail !== undefined) {
        input["approvals"] = { ...(held?.approvals ?? {}), ...(args.approvalsNeedSignIn !== undefined ? { requireSignIn: args.approvalsNeedSignIn } : {}), ...(args.approvalsByEmail !== undefined ? { email: args.approvalsByEmail } : {}) };
      }
      const saved = await scheduling.putProfile(id, input);
      deps.changed();
      return landed({ saved: true, id: saved.member }, SCREEN, { title: saved.displayName, item: saved.member, summary: `${held ? "Changed" : "Set up"} ${saved.displayName}'s scheduling.` });
    },
  };

  const removeHost: ActionDefinition<{ host: string }, unknown, unknown> = {
    id: "remove_host",
    description: "Stop someone's time being bookable here: removes their scheduling profile. Refused while a type, a pool or a placed block uses them. Shown on a card first.",
    schema: z.object({ host: z.string().min(1).describe("The host, by name, email or id.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const held = findHost(setup, args.host);
      return held ? { ok: true, resolvedArgs: { host: held.member } } : blocked("host", `"${args.host}" is not set up. Hosts: ${listed(setup.profiles.map((one) => one.displayName))}.`);
    },
    preview: (args) => ({ title: `Remove ${findHost(setup, args.host)?.displayName ?? args.host} from scheduling`, summary: "Their time can no longer be booked. Bookings already made stay.", rows: [] }),
    handler: async (args) => {
      const held = findHost(await scheduling.overview(), args.host);
      if (!held) throw new Error(`"${args.host}" is not set up any more.`);
      await scheduling.removeProfile(held.member);
      deps.changed();
      return landed({ removed: true, id: held.member }, SCREEN, { title: "People & pools", summary: `${held.displayName}'s time is no longer bookable.` });
    },
  };

  const setPool: ActionDefinition<PoolChange, unknown, unknown> = {
    id: "set_up_pool",
    description: "Make or change a pool of hosts that share bookings: its members and their priority, and who gets each booking. Shown on a card first.",
    schema: argsOf<PoolChange>(poolChange),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const unknown = (args.members ?? []).filter((one) => !findHost(setup, one.host)).map((one) => one.host);
      if (unknown.length > 0) return blocked("members", `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not set up under People. Hosts: ${listed(setup.profiles.map((one) => one.displayName))}.`);
      const held = findPool(setup, args.pool);
      if (!held && !args.timezone) return blocked("timezone", "Say the new pool's time zone, like America/Chicago.");
      return held ? { ok: true, resolvedArgs: { pool: held.id } } : { ok: true };
    },
    preview: (args) => {
      const held = findPool(setup, args.pool);
      return {
        title: held ? `Change the pool "${held.name}"` : `Make the pool "${args.name ?? args.pool}"`,
        summary: held ? "Only these change." : "Types can then be hosted by it.",
        rows: poolPlan(setup, held, { ...(held ? {} : { name: args.name ?? args.pool }), ...args, ...(args.members ? { members: args.members } : {}) }),
      };
    },
    handler: async (args) => {
      const now = await scheduling.overview();
      const held = findPool(now, args.pool);
      const id = held?.id ?? idFrom(args.name ?? args.pool, new Set(now.pools.map((one) => one.id)));
      const input: Record<string, unknown> = {};
      for (const key of ["color", "timezone", "assign", "sticky", "leastBusyWindow"] as const) if (args[key] !== undefined) input[key] = args[key];
      if (args.name !== undefined || !held) input["name"] = args.name ?? args.pool;
      if (args.members) input["members"] = args.members.map((one) => ({ member: findHost(now, one.host)?.member ?? one.host, priority: one.priority ?? 1, active: one.active ?? true }));
      const saved = await scheduling.putPool(id, input);
      deps.changed();
      return landed({ saved: true, id: saved.id }, SCREEN, { title: saved.name, item: `pool-${saved.id}`, summary: `${held ? "Changed" : "Made"} the pool "${saved.name}".` });
    },
  };

  const removePool: ActionDefinition<{ pool: string }, unknown, unknown> = {
    id: "remove_pool",
    description: "Remove a pool. Refused while a type or a placed block uses it. Shown on a card first.",
    schema: z.object({ pool: z.string().min(1).describe("The pool, by name or id.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const held = findPool(setup, args.pool);
      return held ? { ok: true, resolvedArgs: { pool: held.id } } : blocked("pool", `There is no pool "${args.pool}". Pools: ${listed(setup.pools.map((one) => one.name))}.`);
    },
    preview: (args) => ({ title: `Remove the pool "${findPool(setup, args.pool)?.name ?? args.pool}"`, summary: "Its hosts stay set up.", rows: [] }),
    handler: async (args) => {
      const held = findPool(await scheduling.overview(), args.pool);
      if (!held) throw new Error(`There is no pool "${args.pool}" any more.`);
      await scheduling.removePool(held.id);
      deps.changed();
      return landed({ removed: true, id: held.id }, SCREEN, { title: "People & pools", summary: `Removed the pool "${held.name}".` });
    },
  };

  return screenComponent(
    SCREEN,
    [
      `HOSTS: ${listed(setup.profiles.map((one) => `${one.displayName} (${one.member}${one.bookable ? "" : ", not bookable"}, ${one.timezone})`), 30)}. MEMBERS not set up: ${listed(setup.members.filter((one) => !setup.profiles.some((profile) => profile.member === one.userId)).map((one) => one.email), 20)}. POOLS: ${listed(setup.pools.map((one) => `${one.name} (${one.id}, ${POOL_ASSIGN_WORDS[one.assign].toLowerCase()})`), 20)}.`,
    ],
    [list, setHost, removeHost, setPool, removePool],
  );
};
