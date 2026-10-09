import {
  appointmentTypeSchema,
  blockSchema,
  partialSettingsSchema,
  placementSchema,
  poolSchema,
  schedulingProfileSchema,
  type AppointmentType,
  type Block,
  type CalendarEvent,
  type Occurrence,
  type PartialSettings,
  type Placement,
  type Pool,
  type Principal,
  type Role,
  type SchedulingProfile,
} from "@freebirdai/dash-spec";
import type { ZodError, ZodTypeAny } from "zod";
import type { CalendarStore } from "../calendar/store.js";
import { expand } from "./recurrence.js";
import type { FactKind, Facts } from "./rules.js";
import { findSlots, placementClash, type Busy, type FindSlotsResult, type HostInput } from "./slots.js";
import type { SchedulingStore } from "./store.js";
import { addDays, localDate } from "./zoned.js";

/**
 * Scheduling's setup, in one place for the routes and the chat: each host's
 * profile, pools, appointment types, blocks and their placements, and the
 * workspace's defaults. Every save is checked against the rest, so nothing
 * can point at what is not there: a type's hosts have profiles, a blank
 * block becomes set blocks that exist, a placement does not overlap another
 * bookable one on the same host, and nothing in use is removed.
 */

export class SchedulingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SchedulingError";
  }
}

export interface WorkspaceMember {
  readonly userId: string;
  readonly email: string;
  readonly role: Role;
}

export interface SchedulingDeps {
  readonly store: SchedulingStore;
  readonly calendar: CalendarStore;
  /** Who is in the workspace. The open-source build has its one owner. */
  readonly members: () => Promise<readonly WorkspaceMember[]>;
  /** What fills a host's time besides calendar entries: their bookings. */
  readonly bookings?: (member: string, from: number, to: number) => Promise<readonly Busy[]>;
  /** Each contact field's kind, by path, for comparing values. */
  readonly factKinds?: () => Promise<ReadonlyMap<string, FactKind>>;
  /** A contact's facts, for previewing what one real contact would be offered. */
  readonly contacts?: { facts(id: string): Promise<Facts> };
  readonly now: () => number;
}

/** Narrowing a search: only some hosts, and their bookings read another way. */
export interface SlotOptions {
  readonly hosts?: readonly string[];
  readonly bookings?: SchedulingDeps["bookings"];
}

export interface SchedulingOverview {
  readonly defaults: PartialSettings;
  readonly profiles: readonly SchedulingProfile[];
  readonly pools: readonly Pool[];
  readonly types: readonly AppointmentType[];
  readonly blocks: readonly Block[];
  readonly placements: readonly Placement[];
  readonly members: readonly WorkspaceMember[];
}

/** One occurrence on one host, and what a blank one has been set to. */
export interface HostOccurrence extends Occurrence {
  readonly host: string;
  readonly kind: Block["kind"];
  readonly setTo?: string;
}

const DAY = 86_400_000;
const TEAM_ID = /^team-[a-z0-9-]{1,60}$/;

const problems = (error: ZodError): string =>
  error.issues.map((one) => (one.path.length > 0 ? `${one.path.join(".")}: ${one.message}` : one.message)).join("; ");

const parse = <S extends ZodTypeAny>(schema: S, value: unknown): ReturnType<S["parse"]> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new SchedulingError(problems(result.error));
  return result.data;
};

const body = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export class SchedulingService {
  constructor(private readonly deps: SchedulingDeps) {}

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  async overview(): Promise<SchedulingOverview> {
    const { store } = this.deps;
    const [defaults, profiles, pools, types, blocks, placements, members] = await Promise.all([
      store.get("defaults", "workspace"),
      store.list("profile"),
      store.list("pool"),
      store.list("type"),
      store.list("block"),
      store.list("placement"),
      this.deps.members(),
    ]);
    const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));
    return {
      defaults: defaults ?? {},
      profiles: [...profiles].sort((a, b) => a.displayName.localeCompare(b.displayName)),
      pools: byName(pools),
      types: byName(types),
      blocks: byName(blocks),
      placements: [...placements].sort((a, b) => a.start.localeCompare(b.start)),
      members,
    };
  }

  async setDefaults(input: unknown): Promise<PartialSettings> {
    return this.deps.store.put("defaults", parse(partialSettingsSchema, input));
  }

  /* ── hosts ─────────────────────────────────────────────────────────── */

  async putProfile(member: string, input: unknown): Promise<SchedulingProfile> {
    const known = (await this.deps.members()).find((one) => one.userId === member);
    if (!known && !TEAM_ID.test(member)) {
      throw new SchedulingError(`"${member}" is not in this workspace. Add a team member instead: they answer through the approval page without signing in.`, 404);
    }
    const held = await this.deps.store.get("profile", member);
    const given = body(input);
    const profile = parse(schedulingProfileSchema, {
      ...held,
      ...given,
      member,
      ...(!given["email"] && !held?.email && known?.email ? { email: known.email } : {}),
      revision: (held?.revision ?? 0) + 1,
      updatedAt: this.iso(),
    });
    if (!known && !profile.email) throw new SchedulingError("A team member who does not sign in needs an email, so approval requests can reach them.");
    return this.deps.store.put("profile", profile);
  }

  async removeProfile(member: string): Promise<{ removed: true; member: string }> {
    const { types, pools, placements } = await this.overview();
    const uses = [
      ...types.filter((one) => "members" in one.hosts && one.hosts.members.includes(member)).map((one) => `the type "${one.name}"`),
      ...pools.filter((one) => one.members.some((each) => each.member === member)).map((one) => `the pool "${one.name}"`),
      ...(placements.some((one) => one.target.kind === "member" && one.target.id === member) ? ["blocks placed on their calendar"] : []),
    ];
    if (uses.length > 0) throw new SchedulingError(`Still used by ${uses.join(", ")}. Take them out of those first.`, 409);
    await this.deps.store.delete("profile", member);
    return { removed: true, member };
  }

  /* ── pools ─────────────────────────────────────────────────────────── */

  async putPool(id: string, input: unknown): Promise<Pool> {
    const held = await this.deps.store.get("pool", id);
    const pool = parse(poolSchema, { ...held, ...body(input), id, createdAt: held?.createdAt ?? this.iso(), updatedAt: this.iso() });
    const profiles = new Set((await this.deps.store.list("profile")).map((one) => one.member));
    const missing = pool.members.filter((one) => !profiles.has(one.member)).map((one) => one.member);
    if (missing.length > 0) throw new SchedulingError(`Set up ${missing.join(", ")} under People first.`, 404);
    return this.deps.store.put("pool", pool);
  }

  async removePool(id: string): Promise<{ removed: true; id: string }> {
    const { types, placements } = await this.overview();
    const uses = [
      ...types.filter((one) => "pool" in one.hosts && one.hosts.pool === id).map((one) => `the type "${one.name}"`),
      ...(placements.some((one) => one.target.kind === "pool" && one.target.id === id) ? ["blocks placed on it"] : []),
    ];
    if (uses.length > 0) throw new SchedulingError(`Still used by ${uses.join(", ")}.`, 409);
    await this.deps.store.delete("pool", id);
    return { removed: true, id };
  }

  /* ── appointment types ─────────────────────────────────────────────── */

  async putType(id: string, input: unknown): Promise<AppointmentType> {
    const held = await this.deps.store.get("type", id);
    const type = parse(appointmentTypeSchema, { ...held, ...body(input), id, version: held ? held.version + 1 : 1, createdAt: held?.createdAt ?? this.iso(), updatedAt: this.iso() });
    const { profiles, pools, types } = await this.overview();
    if (types.some((one) => one.id !== id && one.slug === type.slug)) throw new SchedulingError(`Another type already uses the address "${type.slug}".`, 409);
    if ("members" in type.hosts) {
      const missing = type.hosts.members.filter((member) => !profiles.some((one) => one.member === member));
      if (missing.length > 0) throw new SchedulingError(`Set up ${missing.join(", ")} under People first.`, 404);
    } else if (!pools.some((one) => one.id === (type.hosts as { pool: string }).pool)) {
      throw new SchedulingError(`There is no pool "${(type.hosts as { pool: string }).pool}".`, 404);
    }
    return this.deps.store.put("type", type);
  }

  async removeType(id: string): Promise<{ removed: true; id: string }> {
    const blocks = await this.deps.store.list("block");
    const uses = blocks.filter((one) => one.types?.includes(id)).map((one) => `the block "${one.name}"`);
    if (uses.length > 0) throw new SchedulingError(`Still named by ${uses.join(", ")}.`, 409);
    await this.deps.store.delete("type", id);
    return { removed: true, id };
  }

  /* ── blocks ────────────────────────────────────────────────────────── */

  async putBlock(id: string, input: unknown): Promise<Block> {
    const held = await this.deps.store.get("block", id);
    const block = parse(blockSchema, { ...held, ...body(input), id, version: held ? held.version + 1 : 1, createdAt: held?.createdAt ?? this.iso(), updatedAt: this.iso() });
    const { blocks, types } = await this.overview();
    if (block.kind === "blank") {
      for (const into of block.becomes) {
        const target = blocks.find((one) => one.id === into);
        if (!target) throw new SchedulingError(`There is no block "${into}" for it to become.`, 404);
        if (target.kind !== "set") throw new SchedulingError(`A blank block becomes set blocks; "${target.name}" is ${target.kind}.`);
      }
    }
    if (block.kind !== "set" && blocks.some((one) => one.id !== id && one.kind === "blank" && one.becomes.includes(id))) {
      throw new SchedulingError("A blank block may become this one, so it has to stay a set block.", 409);
    }
    const unknownTypes = (block.types ?? []).filter((type) => !types.some((one) => one.id === type));
    if (unknownTypes.length > 0) throw new SchedulingError(`There is no type ${unknownTypes.map((one) => `"${one}"`).join(", ")}.`, 404);
    return this.deps.store.put("block", block);
  }

  async removeBlock(id: string): Promise<{ removed: true; id: string }> {
    const { blocks, placements } = await this.overview();
    const uses = [
      ...(placements.some((one) => one.block === id) ? ["its placements on the calendar"] : []),
      ...blocks.filter((one) => one.becomes.includes(id)).map((one) => `the blank block "${one.name}"`),
    ];
    if (uses.length > 0) throw new SchedulingError(`Still used by ${uses.join(", ")}. Remove those first.`, 409);
    await this.deps.store.delete("block", id);
    return { removed: true, id };
  }

  /* ── placements ────────────────────────────────────────────────────── */

  /** The hosts a placement's target stands for. */
  private async hostsOf(target: Placement["target"]): Promise<string[]> {
    if (target.kind === "member") return [target.id];
    return ((await this.deps.store.get("pool", target.id))?.members ?? []).map((one) => one.member);
  }

  /** Every placement that applies to any of these hosts: their own and their pools'. */
  private async placementsFor(hosts: readonly string[]): Promise<Placement[]> {
    const [placements, pools] = await Promise.all([this.deps.store.list("placement"), this.deps.store.list("pool")]);
    const poolIds = new Set(pools.filter((pool) => pool.members.some((one) => hosts.includes(one.member))).map((pool) => pool.id));
    return placements.filter((one) => (one.target.kind === "member" ? hosts.includes(one.target.id) : poolIds.has(one.target.id)));
  }

  async putPlacement(principal: Principal | null, id: string, input: unknown): Promise<Placement> {
    const held = await this.deps.store.get("placement", id);
    const placement = parse(placementSchema, {
      ...held,
      ...body(input),
      id,
      ...(held?.createdBy ? {} : principal ? { createdBy: principal.userId } : {}),
      createdAt: held?.createdAt ?? this.iso(),
      updatedAt: this.iso(),
    });
    const blocks = new Map((await this.deps.store.list("block")).map((one) => [one.id, one]));
    if (!blocks.has(placement.block)) throw new SchedulingError(`There is no block "${placement.block}".`, 404);
    if (placement.target.kind === "member" && !(await this.deps.store.get("profile", placement.target.id))) throw new SchedulingError(`Set up "${placement.target.id}" under People first.`, 404);
    if (placement.target.kind === "pool" && !(await this.deps.store.get("pool", placement.target.id))) throw new SchedulingError(`There is no pool "${placement.target.id}".`, 404);
    const clash = placementClash(placement, await this.placementsFor(await this.hostsOf(placement.target)), blocks, this.deps.now());
    if (clash) {
      const other = blocks.get(clash.with.block);
      throw new SchedulingError(`This overlaps "${other?.name ?? clash.with.block}" on ${clash.date}. Two blocks people can book cannot share a time; place a one-off block to make an exception.`, 409);
    }
    return this.deps.store.put("placement", placement);
  }

  async removePlacement(id: string): Promise<{ removed: true; id: string }> {
    await this.deps.store.delete("placement", id);
    return { removed: true, id };
  }

  /** "This one": skip one occurrence of a repeating placement. */
  async skipOccurrence(id: string, date: unknown): Promise<Placement> {
    const held = await this.deps.store.get("placement", id);
    if (!held) throw new SchedulingError(`There is no placement "${id}".`, 404);
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SchedulingError("Say which date: { date: \"2026-10-13\" }.");
    if (!held.repeat) {
      await this.deps.store.delete("placement", id);
      return held;
    }
    return this.deps.store.put("placement", { ...held, except: [...new Set([...held.except, date])].sort(), updatedAt: this.iso() });
  }

  /**
   * "This and later": the series ends the day before `date`, and a copy of it
   * starts on `date` under `newId`, ready to be changed on its own.
   */
  async splitAt(id: string, date: unknown, newId: unknown): Promise<{ readonly before: Placement; readonly after: Placement }> {
    const held = await this.deps.store.get("placement", id);
    if (!held?.repeat) throw new SchedulingError("Only a repeating placement can be split.", 400);
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= held.start.slice(0, 10)) throw new SchedulingError("Say a date after the first one.");
    if (typeof newId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(newId) || (await this.deps.store.get("placement", newId))) throw new SchedulingError("Give the new part an id not in use.");
    const span = (Date.parse(`${held.end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${held.start.slice(0, 10)}T00:00:00Z`)) / DAY;
    const before = await this.deps.store.put("placement", { ...held, repeat: { ...held.repeat, until: addDays(date, -1) }, updatedAt: this.iso() });
    const { count: _count, ...rest } = held.repeat;
    const after = await this.deps.store.put("placement", {
      ...held,
      id: newId,
      start: `${date}T${held.start.slice(11)}`,
      end: `${addDays(date, span)}T${held.end.slice(11)}`,
      repeat: rest,
      except: held.except.filter((one) => one >= date),
      createdAt: this.iso(),
      updatedAt: this.iso(),
    });
    return { before, after };
  }

  /* ── what is placed, and what is open ──────────────────────────────── */

  /** Each host's block occurrences in a range, with what a booking set each blank one to. */
  async occurrences(from: number, to: number): Promise<HostOccurrence[]> {
    const { profiles, blocks } = await this.overview();
    const byId = new Map(blocks.map((one) => [one.id, one]));
    const out: HostOccurrence[] = [];
    for (const profile of profiles) {
      const busy = (await this.deps.bookings?.(profile.member, from, to)) ?? [];
      for (const placement of await this.placementsFor([profile.member])) {
        const block = byId.get(placement.block);
        if (!block) continue;
        for (const occurrence of expand(placement, localDate(from - DAY, placement.timezone), localDate(to + DAY, placement.timezone))) {
          if (occurrence.end <= from || occurrence.start >= to) continue;
          const setTo = block.kind === "blank" ? busy.find((one) => one.placement === placement.id && one.occurrence === occurrence.date && one.block)?.block : undefined;
          out.push({ ...occurrence, host: profile.member, kind: block.kind, ...(setTo ? { setTo } : {}) });
        }
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /**
   * What fills a host's time: their own timed calendar entries, and their
   * bookings — read through `bookings` when given (a booking change reads
   * them inside its lock, leaving out the booking being changed).
   */
  async busyFor(member: string, from: number, to: number, bookings: SchedulingDeps["bookings"] = this.deps.bookings): Promise<Busy[]> {
    const entries: CalendarEvent[] = await this.deps.calendar.list({
      from: new Date(from - DAY).toISOString(),
      to: new Date(to + DAY).toISOString(),
      owners: [`member:${member}`],
      kinds: ["event"],
      statuses: ["open", "tentative"],
      limit: 5000,
    });
    const timed: Busy[] = entries
      .filter((one) => !one.allDay && one.end)
      .map((one) => ({ start: Date.parse(one.at), end: Date.parse(one.end!), kind: "entry" as const }))
      .filter((one) => Number.isFinite(one.start) && one.end > one.start);
    return [...timed, ...((await bookings?.(member, from - DAY, to + DAY)) ?? [])];
  }

  /** The hosts a type can be booked with, each with what applies to them and fills their time. */
  async hostsFor(type: AppointmentType, from: number, to: number, options: SlotOptions = {}): Promise<HostInput[]> {
    const { profiles, pools } = await this.overview();
    const members = "members" in type.hosts ? type.hosts.members : (pools.find((one) => one.id === (type.hosts as { pool: string }).pool)?.members.filter((one) => one.active).map((one) => one.member) ?? []);
    const hosts: HostInput[] = [];
    for (const member of members) {
      if (options.hosts && !options.hosts.includes(member)) continue;
      const profile = profiles.find((one) => one.member === member);
      if (!profile) continue;
      hosts.push({ profile, placements: await this.placementsFor([member]), busy: await this.busyFor(member, from, to, options.bookings ?? this.deps.bookings) });
    }
    return hosts;
  }

  /** One appointment type, by its id or its booking page address. */
  async findType(key: string): Promise<AppointmentType | null> {
    return (await this.deps.store.get("type", key)) ?? (await this.deps.store.list("type")).find((one) => one.slug === key) ?? null;
  }

  async findPool(id: string): Promise<Pool | null> {
    return this.deps.store.get("pool", id);
  }

  async findProfile(member: string): Promise<SchedulingProfile | null> {
    return this.deps.store.get("profile", member);
  }

  /** Open times for a type, for these facts. */
  async slots(type: AppointmentType, facts: Facts, range: { readonly from: number; readonly to: number; readonly all?: boolean; readonly limit?: number }, options: SlotOptions = {}): Promise<FindSlotsResult> {
    const { defaults, blocks } = await this.overview();
    return findSlots({
      now: this.deps.now(),
      from: range.from,
      to: range.to,
      type,
      workspace: defaults,
      hosts: await this.hostsFor(type, range.from, range.to, options),
      blocks: new Map(blocks.map((one) => [one.id, one])),
      facts,
      ...(range.all ? { all: true } : {}),
      ...(range.limit ? { limit: range.limit } : {}),
    });
  }

  /** What a person would be offered, from facts typed in to try a type out. Every value counts as trusted. */
  async preview(typeId: string, input: unknown): Promise<FindSlotsResult> {
    const type = await this.deps.store.get("type", typeId);
    if (!type) throw new SchedulingError(`There is no type "${typeId}".`, 404);
    const given = body(input);
    const from = typeof given["from"] === "string" && Number.isFinite(Date.parse(given["from"])) ? Date.parse(given["from"]) : this.deps.now();
    const to = typeof given["to"] === "string" && Number.isFinite(Date.parse(given["to"])) ? Date.parse(given["to"]) : from + 14 * DAY;
    const range = { from, to, all: given["all"] === true, limit: 300 };
    /* One real contact: what they hold, trusted only where it came from a record or a member. */
    if (typeof given["contactId"] === "string" && this.deps.contacts) {
      const facts = await this.deps.contacts.facts(given["contactId"]);
      return this.slots(type, { ...facts, scope: { ...facts.scope, request: body(given["request"]), type: { id: type.id, name: type.name } } }, range);
    }
    const scope = { contact: body(given["contact"]), request: body(given["request"]), type: { id: type.id, name: type.name } };
    const trusted = new Set<string>([...Object.keys(scope.contact).map((key) => `contact.${key}`), ...Object.keys(scope.request).map((key) => `request.${key}`)]);
    return this.slots(type, { scope, trusted, kinds: new Map<string, FactKind>([["contact.address", "address"], ...((await this.deps.factKinds?.()) ?? [])]) }, range);
  }
}
