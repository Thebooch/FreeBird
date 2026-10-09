import {
  WEEKDAYS,
  durationMs,
  minutesOf,
  resolveSettings,
  type AppointmentType,
  type Block,
  type Occurrence,
  type PartialSettings,
  type Placement,
  type ResolvedSettings,
  type SchedulingProfile,
  type WeeklyHours,
} from "@freebirdai/dash-spec";
import { expand } from "./recurrence.js";
import { evaluateRules, factString, type Facts, type Verdict } from "./rules.js";
import { addDays, instantOn, localDate, minuteOfDay, wallTime, weekdayOfDate } from "./zoned.js";

/**
 * Open times: the one place availability is decided.
 *
 * Pure, with an injected clock. For each host it lays the window out from
 * the profile's hours and the blocks placed on it (a one-off placement over a
 * repeating one over plain hours; closed over open), walks start times every
 * `slotStep` aligned to the clock, and keeps a start only if:
 *
 * - it is far enough ahead (`minNotice`) and not too far (`horizon`), and in
 *   the type's own hours when it has some;
 * - the block it falls in takes this type and these facts (a blank one
 *   becomes the first block it may become that takes them, unless a booking
 *   has already set it);
 * - the host is free: under `capacity`, stacking only as `stackOnlySame`
 *   allows, nothing else on the calendar, and a buffer from the neighbours —
 *   except, with back-to-back consolidation, a neighbour that shares the
 *   consolidation value;
 * - neither `maxPerDay` nor the block occurrence's `maxBookings` is reached.
 *
 * A slot carries which hosts are free then and on what terms, never anything
 * about anybody else's booking.
 */

/** What already fills a host's time. */
export interface Busy {
  readonly start: number;
  readonly end: number;
  /** A booking (it stacks, under capacity) or another calendar entry (it never does). */
  readonly kind: "booking" | "entry";
  /** The buffer the booking was made under, in ms. */
  readonly buffer?: number;
  /** For a booking: the facts it was made with, normalized, by path. */
  readonly values?: Readonly<Record<string, string>>;
  /** For a booking in a block: the placement occurrence it is in, and the block it came under. */
  readonly placement?: string;
  readonly occurrence?: string;
  readonly block?: string;
}

export interface HostInput {
  readonly profile: SchedulingProfile;
  /** The placements that apply to this host: its own, and its pools'. */
  readonly placements: readonly Placement[];
  readonly busy: readonly Busy[];
}

export interface FindSlotsInput {
  readonly now: number;
  readonly from: number;
  readonly to: number;
  readonly type: AppointmentType;
  /** The workspace's own defaults. */
  readonly workspace?: PartialSettings;
  readonly hosts: readonly HostInput[];
  readonly blocks: ReadonlyMap<string, Block>;
  readonly facts: Facts;
  /** "See all available times": ignore `show: only`. */
  readonly all?: boolean;
  readonly limit?: number;
}

/** One host free at a time, and on what terms. */
export interface HostOption {
  readonly host: string;
  readonly block?: string;
  readonly placement?: string;
  readonly occurrence?: string;
  readonly approval: boolean;
  readonly consolidated: boolean;
  readonly settings: ResolvedSettings;
}

export interface Slot {
  readonly start: number;
  readonly end: number;
  readonly options: readonly HostOption[];
  /** Every host free then needs a person's approval. */
  readonly approval: boolean;
  /** At least one host free then would group it with a matching appointment. */
  readonly consolidated: boolean;
}

export interface FindSlotsResult {
  readonly slots: readonly Slot[];
  /** Fields whose being unknown kept times out, or made them need approval: what to ask for. */
  readonly needs: readonly string[];
  /** Only consolidated times were kept (`show: only`). */
  readonly consolidatedOnly: boolean;
  /** Other open times exist beyond the consolidated ones shown. */
  readonly more: boolean;
  /** The type's "Who can book" rules don't take these facts: nothing is offered, whatever is open. */
  readonly notEligible?: boolean;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const ms = (value: string | undefined): number => durationMs(value) ?? 0;

/* ── laying out a host's time ──────────────────────────────────────────── */

export type Governing = { readonly kind: "hours" } | { readonly kind: "block"; readonly block: Block; readonly occurrence: Occurrence };

export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly governing: Governing;
}

const hoursIntervals = (hours: WeeklyHours, zone: string, fromDate: string, toDate: string): Array<{ start: number; end: number }> => {
  const out: Array<{ start: number; end: number }> = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const day = WEEKDAYS[(weekdayOfDate(date) + 6) % 7]!;
    for (const range of hours[day]) out.push({ start: instantOn(date, range.from, zone), end: instantOn(date, range.to, zone) });
  }
  return out;
};

/**
 * A host's window as segments, each open under plain hours or under one
 * block's occurrence. Closed time, and time nobody opened, is simply absent.
 */
export const layOut = (host: HostInput, blocks: ReadonlyMap<string, Block>, from: number, to: number): Segment[] => {
  const zone = host.profile.timezone;
  const fromDate = localDate(from - DAY, zone);
  const toDate = localDate(to + DAY, zone);
  const hours = host.profile.outsideBlocks === "open" ? hoursIntervals(host.profile.hours, zone, fromDate, toDate) : [];
  const occurrences = host.placements.flatMap((placement) =>
    blocks.has(placement.block) ? expand(placement, localDate(from - DAY, placement.timezone), localDate(to + DAY, placement.timezone)) : [],
  );

  const cuts = new Set<number>();
  for (const one of [...hours, ...occurrences]) {
    if (one.end <= from || one.start >= to) continue;
    cuts.add(Math.max(one.start, from));
    cuts.add(Math.min(one.end, to));
  }
  const edges = [...cuts].sort((a, b) => a - b);

  const covering = (tier: Occurrence["tier"], a: number, b: number) => occurrences.filter((one) => one.tier === tier && one.start <= a && one.end >= b);
  const segments: Segment[] = [];
  for (let index = 0; index + 1 < edges.length; index++) {
    const a = edges[index]!;
    const b = edges[index + 1]!;
    let governing: Governing | null = null;
    for (const tier of ["once", "repeat"] as const) {
      const here = covering(tier, a, b);
      if (here.length === 0) continue;
      /* Closed beats bookable within a tier; between bookable ones, the first placed. */
      const closed = here.find((one) => blocks.get(one.block)!.kind === "closed");
      const chosen = closed ?? here[0]!;
      governing = blocks.get(chosen.block)!.kind === "closed" ? null : { kind: "block", block: blocks.get(chosen.block)!, occurrence: chosen };
      break;
    }
    if (governing === null && !occurrences.some((one) => one.start <= a && one.end >= b) && hours.some((one) => one.start <= a && one.end >= b)) governing = { kind: "hours" };
    if (!governing) continue;
    const last = segments.at(-1);
    const same =
      last &&
      last.end === a &&
      ((last.governing.kind === "hours" && governing.kind === "hours") ||
        (last.governing.kind === "block" && governing.kind === "block" && last.governing.occurrence.placement === governing.occurrence.placement && last.governing.occurrence.date === governing.occurrence.date));
    if (same) segments[segments.length - 1] = { ...last, end: b };
    else segments.push({ start: a, end: b, governing });
  }
  return segments;
};

/* ── checking a start ──────────────────────────────────────────────────── */

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean => a.start < b.end && b.start < a.end;

/** Whether a booking shares the candidate's values on every path given. */
const shares = (busy: Busy, paths: readonly string[], facts: Facts): boolean =>
  paths.length > 0 &&
  paths.every((path) => {
    const mine = factString(facts, path);
    return mine !== undefined && busy.values?.[path] === mine;
  });

/** Whether `[start, end)` lies inside one of a type's own ranges, on the host's clock. */
const inTypeHours = (hours: WeeklyHours, start: number, end: number, zone: string): boolean => {
  const date = localDate(start, zone);
  if (localDate(end - 1, zone) !== date) return false;
  const day = WEEKDAYS[(weekdayOfDate(date) + 6) % 7]!;
  const from = minuteOfDay(start, zone);
  const to = from + Math.round((end - start) / MINUTE);
  return hours[day].some((range) => minutesOf(range.from) <= from && to <= minutesOf(range.to));
};

interface Terms {
  readonly block?: Block;
  readonly approvalUnknown: boolean;
}

/**
 * The block a start in this segment comes under, for these facts: the
 * segment's own, what a booking already set a blank occurrence to, or the
 * first block a blank one may become that takes them. Null when none does.
 */
const termsFor = (segment: Segment, host: HostInput, input: FindSlotsInput, needs: Set<string>): Terms | null => {
  if (segment.governing.kind === "hours") return { approvalUnknown: false };
  const { block, occurrence } = segment.governing;
  const takes = (candidate: Block): Terms | null => {
    if (candidate.kind !== "set") return null;
    if (candidate.types && !candidate.types.includes(input.type.id)) return null;
    const result = evaluateRules(candidate.rules, input.facts, input.now);
    if (result.verdict === "eligible") return { block: candidate, approvalUnknown: false };
    if (result.verdict === "ineligible") return null;
    for (const path of [...result.missing, ...result.untrusted]) needs.add(path);
    if (candidate.whenUnknown === "include") return { block: candidate, approvalUnknown: false };
    if (candidate.whenUnknown === "approval") return { block: candidate, approvalUnknown: true };
    return null;
  };
  if (block.kind === "set") return takes(block);
  if (block.kind !== "blank") return null;
  /* A booking already in this occurrence set it: it is that block now. */
  const set = host.busy.find((one) => one.kind === "booking" && one.placement === occurrence.placement && one.occurrence === occurrence.date && one.block)?.block;
  if (set) {
    const into = input.blocks.get(set);
    return into ? takes(into) : null;
  }
  for (const id of block.becomes) {
    const into = input.blocks.get(id);
    const terms = into ? takes(into) : null;
    if (terms) return terms;
  }
  return null;
};

/* ── the search ────────────────────────────────────────────────────────── */

/**
 * Whether a type takes these facts at all ("Who can book"), before any time
 * is looked at. A field not known yet is asked for (`needs`), and then left
 * out, let in, or let in pending approval, as the type says.
 */
export const typeEligibility = (type: AppointmentType, facts: Facts, now: number): { readonly verdict: Verdict; readonly needs: readonly string[]; readonly approval: boolean } => {
  const eligibility = type.eligibility as AppointmentType["eligibility"] | undefined;
  const result = evaluateRules(eligibility?.rules, facts, now);
  if (result.verdict !== "unknown") return { verdict: result.verdict, needs: [], approval: false };
  const needs = [...result.missing, ...result.untrusted];
  const when = eligibility?.whenUnknown ?? "exclude";
  return { verdict: when === "exclude" ? "unknown" : "eligible", needs, approval: when === "approval" };
};

export const findSlots = (input: FindSlotsInput): FindSlotsResult => {
  const needs = new Set<string>();
  const who = typeEligibility(input.type, input.facts, input.now);
  for (const path of who.needs) needs.add(path);
  if (who.verdict !== "eligible") return { slots: [], needs: [...needs].sort(), consolidatedOnly: false, more: false, ...(who.verdict === "ineligible" ? { notEligible: true } : {}) };
  const byStart = new Map<number, HostOption[]>();
  const typeLevel = resolveSettings([
    { layer: "workspace", settings: input.workspace },
    { layer: "type", settings: input.type.settings },
  ]).settings;

  for (const host of input.hosts) {
    if (!host.profile.bookable) continue;
    const zone = host.profile.timezone;
    const base = [
      { layer: "workspace" as const, settings: input.workspace },
      { layer: "host" as const, settings: host.profile.settings },
      { layer: "type" as const, settings: input.type.settings },
    ];
    const hostLevel = resolveSettings(base).settings;
    const step = Math.max(ms(hostLevel.slotStep), 5 * MINUTE);
    const stepMinutes = Math.round(step / MINUTE);
    const length = ms(hostLevel.length);
    if (length <= 0) continue;
    const horizonEnd = input.now + ms(hostLevel.horizon);
    const from = Math.max(input.from, input.now);
    const to = Math.min(input.to, horizonEnd + length);
    if (to <= from) continue;
    const bookings = host.busy.filter((one) => one.kind === "booking");
    const entries = host.busy.filter((one) => one.kind === "entry");
    const perDay = new Map<string, number>();
    for (const booking of bookings) {
      const date = localDate(booking.start, zone);
      perDay.set(date, (perDay.get(date) ?? 0) + 1);
    }

    for (const segment of layOut(host, input.blocks, from, to)) {
      const terms = termsFor(segment, host, input, needs);
      if (!terms) continue;
      const { settings } = resolveSettings([...base, { layer: "block", settings: terms.block?.settings }]);
      const buffer = ms(settings.buffer);
      const consolidate = settings.consolidate;
      const consolidateValues = consolidate ? consolidate.by.map((path) => factString(input.facts, path)) : [];
      const canConsolidate = consolidate !== undefined && consolidateValues.every((value) => value !== undefined);
      let approvalRules = false;
      if (settings.approval === "rules") {
        const result = evaluateRules(settings.approvalWhen, input.facts, input.now);
        if (result.verdict === "unknown") for (const path of [...result.missing, ...result.untrusted]) needs.add(path);
        approvalRules = result.verdict !== "ineligible";
      }
      const approval = settings.approval === "always" || approvalRules || terms.approvalUnknown || who.approval;
      const occurrence = segment.governing.kind === "block" ? segment.governing.occurrence : undefined;
      const inOccurrence = occurrence ? bookings.filter((one) => one.placement === occurrence.placement && one.occurrence === occurrence.date).length : 0;
      if (terms.block?.maxBookings !== undefined && inOccurrence >= terms.block.maxBookings) continue;

      /* Start times on the clock (every 15 minutes from the hour) when the step divides an hour; else from the segment's start. */
      let start = Math.ceil(segment.start / MINUTE) * MINUTE;
      if (60 % stepMinutes === 0) start += ((stepMinutes - (wallTime(start, zone).minute % stepMinutes)) % stepMinutes) * MINUTE;
      for (; start + length <= segment.end; start += step) {
        if (start < from || start >= input.to) continue;
        if (start < input.now + ms(settings.minNotice) || start > horizonEnd) continue;
        const end = start + length;
        const slot = { start, end };
        if (input.type.hours && !inTypeHours(input.type.hours, start, end, zone)) continue;
        if (entries.some((one) => overlaps(one, slot))) continue;
        const stacked = bookings.filter((one) => overlaps(one, slot));
        if (stacked.length + 1 > settings.capacity) continue;
        if (stacked.length > 0 && settings.stackOnlySame.length > 0 && !stacked.every((one) => shares(one, settings.stackOnlySame, input.facts))) continue;
        const tooClose = host.busy.some((one) => {
          if (overlaps(one, slot)) return false;
          const gap = start >= one.end ? start - one.end : one.start - end;
          const needed = Math.max(buffer, one.kind === "booking" ? (one.buffer ?? 0) : 0);
          if (gap >= needed) return false;
          return !(consolidate?.mode === "back_to_back" && one.kind === "booking" && shares(one, consolidate.by, input.facts));
        });
        if (tooClose) continue;
        if (settings.maxPerDay !== undefined && (perDay.get(localDate(start, zone)) ?? 0) >= settings.maxPerDay) continue;
        const consolidated =
          canConsolidate &&
          bookings.some((one) =>
            !shares(one, consolidate!.by, input.facts) ? false : consolidate!.mode === "stack" ? one.start === start : one.end === start || one.start === end,
          );
        const option: HostOption = {
          host: host.profile.member,
          ...(terms.block ? { block: terms.block.id } : {}),
          ...(occurrence ? { placement: occurrence.placement, occurrence: occurrence.date } : {}),
          approval,
          consolidated,
          settings,
        };
        byStart.set(start, [...(byStart.get(start) ?? []), option]);
      }
    }
  }

  let slots: Slot[] = [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, options]) => ({
      start,
      end: start + ms(options[0]!.settings.length),
      options,
      approval: options.every((one) => one.approval),
      consolidated: options.some((one) => one.consolidated),
    }));
  let consolidatedOnly = false;
  let more = false;
  if (!input.all && typeLevel.consolidate?.show === "only" && slots.some((one) => one.consolidated)) {
    more = slots.some((one) => !one.consolidated);
    slots = slots.filter((one) => one.consolidated);
    consolidatedOnly = true;
  }
  return { slots: slots.slice(0, input.limit ?? 500), needs: [...needs].sort(), consolidatedOnly, more };
};

/** The order an agent offers times in: consolidated first, then earliest. */
export const offerOrder = (slots: readonly Slot[]): Slot[] => [...slots].sort((a, b) => Number(b.consolidated) - Number(a.consolidated) || a.start - b.start);

/* ── placements that may not overlap ───────────────────────────────────── */

/**
 * The first clash a placement would make with others on the same host: two
 * bookable placements (set or blank) of the same tier that overlap, over the
 * next `days`. Closed placements never clash; a one-off over a repeating one
 * is how an exception is made.
 */
export const placementClash = (
  candidate: Placement,
  others: readonly Placement[],
  blocks: ReadonlyMap<string, Block>,
  now: number,
  days = 366,
): { readonly with: Placement; readonly date: string } | null => {
  const bookable = (placement: Placement) => {
    const block = blocks.get(placement.block);
    return block !== undefined && block.kind !== "closed";
  };
  if (!bookable(candidate)) return null;
  const tierOf = (placement: Placement) => (placement.repeat ? "repeat" : "once");
  const from = localDate(now - DAY, candidate.timezone);
  const to = addDays(from, days);
  const mine = expand(candidate, from, to);
  for (const other of others) {
    if (other.id === candidate.id || !bookable(other) || tierOf(other) !== tierOf(candidate)) continue;
    const theirs = expand(other, localDate(now - DAY, other.timezone), addDays(localDate(now - DAY, other.timezone), days));
    for (const a of mine) {
      const hit = theirs.find((b) => overlaps(a, b));
      if (hit) return { with: other, date: a.date };
    }
  }
  return null;
};
