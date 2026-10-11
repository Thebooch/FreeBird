import type { ActionDefinition, ComponentDefinition } from "@freebirdai/core";
import {
  BLOCK_KINDS,
  BLOCK_KIND_WORDS,
  WHEN_UNKNOWN,
  WEEKDAYS,
  describeRecurrence,
  localDateSchema,
  localDateTimeSchema,
  ruleSetSchema,
  type Block,
  type Placement,
  type Recurrence,
  type SchedulingSettings,
} from "@freebirdai/dash-spec";
import { z } from "zod";
import type { SchedulingOverview, SchedulingService } from "../../scheduling/service.js";
import { SCREENS, actor, allowedTo, argsOf, blocked, changeRows, findBy, idFrom, landed, listed, screenComponent, shown, type ScreenAccess } from "./common.js";
import { rulesInWords } from "./rules-words.js";
import { mergedSettings, settingsChanges, settingsInherit, settingsRows } from "./settings-words.js";

/**
 * Blocks (`#/agent/calendar/blocks`): rules for who can book at which times,
 * and where each is placed on a host's or a pool's calendar, once or
 * repeating. A *set* block takes only people its rules match, a *blank* one
 * becomes, each time, the set block its first booking belongs to, and a
 * *closed* one is busy time. Saved through `SchedulingService`, which refuses
 * two bookable blocks on one host at one time.
 */

export interface BlocksDeps extends ScreenAccess {
  readonly setup: SchedulingOverview;
  readonly scheduling: SchedulingService;
}

const SCREEN = SCREENS.blocks;
const MANAGE = "Your role here does not allow changing scheduling.";

const blockFields = {
  name: z.string().trim().min(1).max(80).optional().describe("The block's name, like 'North side installs'."),
  kind: z.enum(BLOCK_KINDS).optional().describe("set: only people its rules match book here; blank: becomes, each time, the set block its first booking belongs to; closed: busy, nobody books."),
  description: z.string().max(1000).optional(),
  color: z.number().int().min(1).max(8).optional().describe("Its colour, 1 to 8."),
  rules: ruleSetSchema.optional().describe("Set blocks: who may book here, rules over contact.* and request.* fields. Empty: anyone."),
  whenUnknown: z.enum(WHEN_UNKNOWN).optional().describe("Set blocks: when a rule's field has no value: exclude, include, or approval."),
  becomes: z.array(z.string().min(1)).max(20).optional().describe("Blank blocks: the set blocks it may become, by name or id, first one first."),
  types: z.array(z.string().min(1)).max(50).nullable().optional().describe("The appointment types bookable here, by name or id. null: every type the host takes."),
  maxBookings: z.number().int().min(1).max(500).nullable().optional().describe("The most bookings in each time it comes round. null: no limit."),
};

const blockChange = z.object({
  block: z.string().min(1).describe("The block, by name or id; a new name makes a new block."),
  ...blockFields,
  ...settingsChanges("block").shape,
  inherit: settingsInherit("block"),
});
type BlockChange = z.infer<typeof blockChange>;

const repeatSchema = z
  .object({
    every: z.enum(["day", "week", "month"]),
    interval: z.number().int().min(1).max(52).optional().describe("Every how many days, weeks or months. Default 1."),
    weekdays: z.array(z.enum(WEEKDAYS)).max(7).optional().describe("Weekly: which days, like ['tue', 'thu']. Default: the first one's day."),
    monthlyBy: z.enum(["date", "weekday"]).optional().describe("Monthly: the same date, or the same weekday of the month."),
    nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]).optional().describe("Monthly by weekday: which one, 1 to 4, or -1 for the last."),
    until: localDateSchema.optional().describe("The last date it may fall on."),
    count: z.number().int().min(1).max(1000).optional().describe("How many times in all."),
  })
  .strict();

const placementFields = {
  on: z.string().min(1).optional().describe("Whose calendar: a host or a pool, by name or id. A pool's placement applies to each of its members."),
  start: localDateTimeSchema.optional().describe("When the first one starts, as wall time in its zone: 2026-10-13T08:00."),
  end: localDateTimeSchema.optional().describe("When the first one ends, the same way."),
  timezone: z.string().optional().describe("Its IANA time zone. Default: the host's or the pool's."),
  repeat: repeatSchema.nullable().optional().describe("How it repeats. null or left out: once."),
};

const placeBlock = z.object({ block: z.string().min(1).describe("The block to place, by name or id."), ...placementFields, on: placementFields.on.unwrap(), start: placementFields.start.unwrap(), end: placementFields.end.unwrap() });
type PlaceBlock = z.infer<typeof placeBlock>;
const placementChange = z.object({ placement: z.string().min(1).describe("The placement's id, from list_blocks."), block: z.string().min(1).optional().describe("Another block to put there instead."), ...placementFields });
type PlacementChange = z.infer<typeof placementChange>;

const findBlock = (setup: SchedulingOverview, key: string): Block | null => findBy(setup.blocks, key, (one) => [one.id, one.name]);
const findPlacement = (setup: SchedulingOverview, id: string): Placement | null => setup.placements.find((one) => one.id === id) ?? null;
const findType = (setup: SchedulingOverview, key: string) => findBy(setup.types, key, (one) => [one.id, one.name, one.slug]);

/** A host or a pool, by name or id. */
const targetOf = (setup: SchedulingOverview, key: string): { target: Placement["target"]; name: string; timezone: string } | null => {
  const host = findBy(setup.profiles, key, (one) => [one.member, one.displayName, one.email]);
  if (host) return { target: { kind: "member", id: host.member }, name: host.displayName, timezone: host.timezone };
  const pool = findBy(setup.pools, key, (one) => [one.id, one.name]);
  return pool ? { target: { kind: "pool", id: pool.id }, name: pool.name, timezone: pool.timezone } : null;
};
const targetName = (setup: SchedulingOverview, target: Placement["target"]): string =>
  target.kind === "member" ? (setup.profiles.find((one) => one.member === target.id)?.displayName ?? target.id) : (setup.pools.find((one) => one.id === target.id)?.name ?? target.id);

const recurrenceOf = (repeat: z.infer<typeof repeatSchema> | null | undefined): Recurrence | undefined =>
  repeat
    ? {
        every: repeat.every,
        interval: repeat.interval ?? 1,
        ...(repeat.weekdays ? { weekdays: repeat.weekdays.map((day) => (WEEKDAYS.indexOf(day) + 1) % 7) } : {}),
        ...(repeat.every === "month" ? { monthly: repeat.monthlyBy === "weekday" ? { by: "weekday" as const, nth: repeat.nth ?? 1 } : { by: "date" as const } } : {}),
        ...(repeat.until ? { until: repeat.until } : {}),
        ...(repeat.count ? { count: repeat.count } : {}),
      }
    : undefined;

const placementWords = (setup: SchedulingOverview, one: Pick<Placement, "block" | "target" | "start" | "end" | "timezone" | "repeat">) =>
  `${findBlock(setup, one.block)?.name ?? one.block} on ${targetName(setup, one.target)}: ${one.start.replace("T", " ")}–${one.end.slice(11)} (${one.timezone}), ${describeRecurrence(one.repeat, one.start).toLowerCase()}`;

const BLOCK_LABELS = { name: "Name", kind: "Kind", description: "Description", color: "Colour", rules: "Who can book here", whenUnknown: "When a field is unknown", becomes: "May become", types: "Types bookable here", maxBookings: "Most bookings each time" } as const;

const blockPlan = (setup: SchedulingOverview, held: Block | null, args: Partial<BlockChange>) => {
  const names = (ids: unknown) => ((ids as string[] | null | undefined) ?? null) === null ? "Every type the host takes" : (ids as string[]).map((one) => findType(setup, one)?.name ?? findBlock(setup, one)?.name ?? one).join(", ");
  const rows = changeRows(
    (Object.keys(BLOCK_LABELS) as Array<keyof typeof BLOCK_LABELS>).map((key) => ({
      label: BLOCK_LABELS[key],
      before: held ? (key === "types" ? (held.types ?? null) : key === "maxBookings" ? (held.maxBookings ?? null) : held[key]) : undefined,
      after: (args as Record<string, unknown>)[key],
      isNew: !held,
      words:
        key === "kind"
          ? (value: unknown) => BLOCK_KIND_WORDS[value as Block["kind"]]?.label ?? shown(value)
          : key === "rules"
            ? (value: unknown) => rulesInWords(value as Block["rules"])
            : key === "types" || key === "becomes"
              ? names
              : key === "maxBookings"
                ? (value: unknown) => (value === null ? "No limit" : shown(value))
                : shown,
    })),
  );
  const changes = Object.fromEntries(Object.keys(settingsChanges("block").shape).map((key) => [key, (args as Record<string, unknown>)[key]])) as Partial<Record<keyof SchedulingSettings, unknown>>;
  const settings = mergedSettings(held?.settings, changes, args.inherit);
  return { rows: [...rows, ...settingsRows(held?.settings, settings)], settings };
};

export const blocksScreen = (deps: BlocksDeps): ComponentDefinition => {
  const { setup, scheduling } = deps;
  const manage = allowedTo(deps, "calendar.manage", MANAGE);

  const list: ActionDefinition<Record<string, never>, unknown, unknown> = {
    id: "list_blocks",
    description: "Read the blocks (their kind, rules, types and settings) and every placement of them on calendars, with ids.",
    schema: z.object({}),
    requiresConfirmation: "none",
    mcp: { expose: false },
    handler: async () => {
      const now = { ...setup, ...(await scheduling.overview()) };
      return {
        blocks: now.blocks.map((one) => ({ id: one.id, name: one.name, kind: one.kind, rules: rulesInWords(one.rules), types: one.types ?? "every type", becomes: one.becomes, maxBookings: one.maxBookings, settings: one.settings })),
        placements: now.placements.map((one) => ({ id: one.id, block: one.block, on: targetName(now, one.target), what: placementWords(now, one), skipped: one.except })),
      };
    },
  };

  const setBlock: ActionDefinition<BlockChange, unknown, unknown> = {
    id: "set_up_block",
    description: "Make or change a block: its kind, who can book in it (rules), which types, the most bookings each time, and its settings (buffer, capacity, notice, approval, grouping). Shown on a card first.",
    schema: argsOf<BlockChange>(blockChange),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const unknownTypes = (args.types ?? []).filter((one) => !findType(setup, one));
      if (unknownTypes.length > 0) return blocked("types", `There is no type ${unknownTypes.map((one) => `"${one}"`).join(", ")}. Types: ${listed(setup.types.map((one) => one.name))}.`);
      const unknownBlocks = (args.becomes ?? []).filter((one) => !findBlock(setup, one));
      if (unknownBlocks.length > 0) return blocked("becomes", `There is no block ${unknownBlocks.map((one) => `"${one}"`).join(", ")}. Blocks: ${listed(setup.blocks.map((one) => one.name))}.`);
      const held = findBlock(setup, args.block);
      return held ? { ok: true, resolvedArgs: { block: held.id } } : { ok: true };
    },
    preview: (args) => {
      const held = findBlock(setup, args.block);
      return {
        title: held ? `Change the block "${held.name}"` : `Make the block "${args.name ?? args.block}"`,
        summary: held ? "Only these change." : "Place it on a calendar for it to apply.",
        rows: blockPlan(setup, held, { ...(held ? {} : { name: args.name ?? args.block, kind: args.kind ?? "set" }), ...args }).rows,
      };
    },
    handler: async (args) => {
      const now = { ...setup, ...(await scheduling.overview()) };
      const held = findBlock(now, args.block);
      const id = held?.id ?? idFrom(args.name ?? args.block, new Set(now.blocks.map((one) => one.id)));
      const plan = blockPlan(now, held, args);
      const input: Record<string, unknown> = { settings: plan.settings };
      for (const key of ["kind", "description", "color", "rules", "whenUnknown"] as const) if (args[key] !== undefined) input[key] = args[key];
      if (args.name !== undefined || !held) input["name"] = args.name ?? args.block;
      if (args.becomes !== undefined) input["becomes"] = args.becomes.map((one) => findBlock(now, one)?.id ?? one);
      if (args.types !== undefined) input["types"] = args.types === null ? undefined : args.types.map((one) => findType(now, one)?.id ?? one);
      if (args.maxBookings !== undefined) input["maxBookings"] = args.maxBookings ?? undefined;
      const saved = await scheduling.putBlock(id, input);
      deps.changed();
      return landed({ saved: true, id: saved.id }, SCREEN, { title: saved.name, item: saved.id, summary: `${held ? "Changed" : "Made"} the block "${saved.name}".` });
    },
  };

  const removeBlock: ActionDefinition<{ block: string }, unknown, unknown> = {
    id: "remove_block",
    description: "Remove a block. Refused while it is placed or a blank block may become it. Shown on a card first.",
    schema: z.object({ block: z.string().min(1).describe("The block, by name or id.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const held = findBlock(setup, args.block);
      return held ? { ok: true, resolvedArgs: { block: held.id } } : blocked("block", `There is no block "${args.block}". Blocks: ${listed(setup.blocks.map((one) => one.name))}.`);
    },
    preview: (args) => ({ title: `Remove the block "${findBlock(setup, args.block)?.name ?? args.block}"`, summary: "Its rules stop applying.", rows: [] }),
    handler: async (args) => {
      const held = findBlock({ ...setup, ...(await scheduling.overview()) }, args.block);
      if (!held) throw new Error(`There is no block "${args.block}" any more.`);
      await scheduling.removeBlock(held.id);
      deps.changed();
      return landed({ removed: true, id: held.id }, SCREEN, { title: "Blocks", summary: `Removed the block "${held.name}".` });
    },
  };

  const place: ActionDefinition<PlaceBlock, unknown, unknown> = {
    id: "place_block",
    description: "Put a block on a host's or a pool's calendar for a time, once or repeating (every week on Tue and Thu, the last Friday of each month…). Shown on a card first.",
    schema: argsOf<PlaceBlock>(placeBlock),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const block = findBlock(setup, args.block);
      if (!block) return blocked("block", `There is no block "${args.block}". Blocks: ${listed(setup.blocks.map((one) => one.name))}.`);
      const target = targetOf(setup, args.on);
      if (!target) return blocked("on", `"${args.on}" is neither a host nor a pool. Hosts: ${listed(setup.profiles.map((one) => one.displayName))}. Pools: ${listed(setup.pools.map((one) => one.name))}.`);
      return { ok: true, resolvedArgs: { block: block.id } };
    },
    preview: (args) => {
      const target = targetOf(setup, args.on);
      const placed = { block: findBlock(setup, args.block)?.id ?? args.block, target: target?.target ?? { kind: "member" as const, id: args.on }, start: args.start, end: args.end, timezone: args.timezone ?? target?.timezone ?? "UTC", repeat: recurrenceOf(args.repeat) };
      return { title: `Place "${findBlock(setup, args.block)?.name ?? args.block}" on ${target?.name ?? args.on}'s calendar`, summary: "Two blocks people can book cannot share a time on one host.", rows: [{ label: "When", value: placementWords(setup, placed) }] };
    },
    handler: async (args, ctx) => {
      const now = { ...setup, ...(await scheduling.overview()) };
      const block = findBlock(now, args.block);
      const target = targetOf(now, args.on);
      if (!block || !target) throw new Error("That block or calendar is not there any more.");
      const id = idFrom(`${block.id}-${args.start.slice(0, 10)}`, new Set(now.placements.map((one) => one.id)));
      const repeat = recurrenceOf(args.repeat);
      const saved = await scheduling.putPlacement(actor(ctx), id, { block: block.id, target: target.target, timezone: args.timezone ?? target.timezone, start: args.start, end: args.end, ...(repeat ? { repeat } : {}) });
      deps.changed();
      return landed({ placed: true, id: saved.id }, SCREEN, { title: block.name, item: block.id, summary: `Placed "${block.name}": ${placementWords(now, saved)}.` });
    },
  };

  const changePlacement: ActionDefinition<PlacementChange, unknown, unknown> = {
    id: "change_placement",
    description: "Change where or when a placed block is: its calendar, times, zone or how it repeats, for every time it comes round. To change only later ones, split it first. Shown on a card first.",
    schema: argsOf<PlacementChange>(placementChange),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      if (!findPlacement(setup, args.placement)) return blocked("placement", `There is no placement "${args.placement}". list_blocks shows them with their ids.`);
      if (args.on && !targetOf(setup, args.on)) return blocked("on", `"${args.on}" is neither a host nor a pool.`);
      if (args.block && !findBlock(setup, args.block)) return blocked("block", `There is no block "${args.block}".`);
      return { ok: true };
    },
    preview: (args) => {
      const held = findPlacement(setup, args.placement);
      if (!held) return { title: "Change a placement", summary: "That placement was not found.", rows: [] };
      const next = { ...held, ...(args.block ? { block: findBlock(setup, args.block)?.id ?? args.block } : {}), ...(args.on ? { target: targetOf(setup, args.on)?.target ?? held.target } : {}), ...(args.start ? { start: args.start } : {}), ...(args.end ? { end: args.end } : {}), ...(args.timezone ? { timezone: args.timezone } : {}), ...(args.repeat !== undefined ? { repeat: recurrenceOf(args.repeat) } : {}) };
      return { title: `Change a placement of "${findBlock(setup, held.block)?.name ?? held.block}"`, summary: "Every time it comes round, past skips kept.", rows: [{ label: "When", value: `${placementWords(setup, held)} → ${placementWords(setup, next)}`, multiline: true }] };
    },
    handler: async (args, ctx) => {
      const now = { ...setup, ...(await scheduling.overview()) };
      const held = findPlacement(now, args.placement);
      if (!held) throw new Error(`There is no placement "${args.placement}" any more.`);
      const input: Record<string, unknown> = {};
      if (args.block) input["block"] = findBlock(now, args.block)?.id ?? args.block;
      if (args.on) input["target"] = targetOf(now, args.on)?.target ?? held.target;
      for (const key of ["start", "end", "timezone"] as const) if (args[key] !== undefined) input[key] = args[key];
      if (args.repeat !== undefined) input["repeat"] = recurrenceOf(args.repeat);
      const saved = await scheduling.putPlacement(actor(ctx), held.id, input);
      deps.changed();
      return landed({ saved: true, id: saved.id }, SCREEN, { title: findBlock(now, saved.block)?.name ?? "Blocks", item: saved.block, summary: `Changed a placement: ${placementWords(now, saved)}.` });
    },
  };

  const removePlacement: ActionDefinition<{ placement: string }, unknown, unknown> = {
    id: "remove_placement",
    description: "Take a placed block off the calendar, every time it comes round. Shown on a card first.",
    schema: z.object({ placement: z.string().min(1).describe("The placement's id, from list_blocks.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => (findPlacement(setup, args.placement) ? { ok: true } : blocked("placement", `There is no placement "${args.placement}".`)),
    preview: (args) => {
      const held = findPlacement(setup, args.placement);
      return { title: "Take a block off the calendar", summary: "Bookings already made stay.", rows: held ? [{ label: "Placement", value: placementWords(setup, held) }] : [] };
    },
    handler: async (args) => {
      const now = { ...setup, ...(await scheduling.overview()) };
      const held = findPlacement(now, args.placement);
      await scheduling.removePlacement(args.placement);
      deps.changed();
      return landed({ removed: true, id: args.placement }, SCREEN, { title: "Blocks", summary: held ? `Took ${placementWords(now, held)} off the calendar.` : "Took the placement off the calendar." });
    },
  };

  const skip: ActionDefinition<{ placement: string; date: string }, unknown, unknown> = {
    id: "skip_occurrence",
    description: "Skip one time a repeating block comes round (\"not this Tuesday\"). A one-off placement is removed. Shown on a card first.",
    schema: z.object({ placement: z.string().min(1).describe("The placement's id, from list_blocks."), date: localDateSchema.describe("The date of the one to skip, like 2026-10-13.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => (findPlacement(setup, args.placement) ? { ok: true } : blocked("placement", `There is no placement "${args.placement}".`)),
    preview: (args) => {
      const held = findPlacement(setup, args.placement);
      return { title: `Skip ${args.date}`, summary: held?.repeat ? "Only that one; the rest stay." : "It only comes round once, so it is removed.", rows: held ? [{ label: "Placement", value: placementWords(setup, held) }] : [] };
    },
    handler: async (args) => {
      const saved = await scheduling.skipOccurrence(args.placement, args.date);
      deps.changed();
      return landed({ skipped: args.date, id: saved.id }, SCREEN, { title: findBlock(setup, saved.block)?.name ?? "Blocks", item: saved.block, summary: `Skipped ${args.date}.` });
    },
  };

  const split: ActionDefinition<{ placement: string; date: string }, unknown, unknown> = {
    id: "split_placement",
    description: "Split a repeating placement at a date (\"this and later\"): it ends the day before, and a copy starts on that date, which change_placement can then change on its own. Shown on a card first.",
    schema: z.object({ placement: z.string().min(1).describe("The placement's id, from list_blocks."), date: localDateSchema.describe("The first date of the later part.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => (findPlacement(setup, args.placement)?.repeat ? { ok: true } : blocked("placement", "Only a repeating placement can be split; list_blocks shows which repeat.")),
    preview: (args) => ({ title: `Split from ${args.date}`, summary: "The earlier part ends the day before; the later part can then be changed on its own.", rows: [] }),
    handler: async (args) => {
      const now = await scheduling.overview();
      const newId = idFrom(`${args.placement}-from-${args.date}`, new Set(now.placements.map((one) => one.id)));
      const { after } = await scheduling.splitAt(args.placement, args.date, newId);
      deps.changed();
      return landed({ split: true, laterPart: after.id }, SCREEN, { title: findBlock(setup, after.block)?.name ?? "Blocks", item: after.block, summary: `Split it at ${args.date}; the later part is "${after.id}".` });
    },
  };

  return screenComponent(
    SCREEN,
    [
      `BLOCKS: ${listed(setup.blocks.map((one) => `${one.name} (${one.id}, ${one.kind})`), 30)}. PLACED: ${listed(setup.placements.map((one) => `${one.id}: ${placementWords(setup, one)}`), 20)}.`,
    ],
    [list, setBlock, removeBlock, place, changePlacement, removePlacement, skip, split],
  );
};
