import { idSchema } from "@freebirdai/connect-spec";
import { z } from "zod";
import { durationMs } from "./actions.js";
import { isTimeZone } from "./workflow.js";

/**
 * Scheduling: whose time can be booked, on what terms, and by whom.
 *
 * - A **host** is a person whose time is booked: a workspace member, or a
 *   team member added here with a name and an email who answers through the
 *   approval page without signing in. Each has a **profile**: hours, time
 *   zone and settings.
 * - A **pool** is a named group of hosts with an assignment rule.
 * - An **appointment type** is what is booked: its length, who hosts it,
 *   whether it needs approval, how agents offer it.
 * - A **block** is a reusable set of rules and settings, **placed** on a
 *   host's or pool's calendar for a time range, once or repeating. A *set*
 *   block takes only people its rules match; a *blank* block becomes, for
 *   each occurrence, the set block its first booking belongs to; a *closed*
 *   block is busy time.
 *
 * Settings are layered: workspace → host → type → block, the last one that
 * says something winning (`resolveSettings`). The buffer is set only for the
 * whole workspace or on a block.
 */

/* ── small shapes ──────────────────────────────────────────────────────── */

/** "30m", "2h", "3d", "1w". */
export const durationSchema = z.string().trim().refine((value) => (durationMs(value) ?? -1) >= 0, "Say how long, like 15m, 2h, 3d or 1w.");

/** "08:00" to "24:00". */
export const timeOfDaySchema = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "A time of day, like 08:00 or 17:30.");

/** Minutes after midnight of an `HH:MM`. */
export const minutesOf = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
};

export const hoursRangeSchema = z
  .object({ from: timeOfDaySchema, to: timeOfDaySchema })
  .refine((range) => minutesOf(range.from) < minutesOf(range.to), "Each range ends after it starts.");
export type HoursRange = z.infer<typeof hoursRangeSchema>;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** A weekday key for `Date#getDay()` (0 is Sunday). */
export const weekdayOf = (day: number): Weekday => WEEKDAYS[(day + 6) % 7]!;

const dayHours = z.array(hoursRangeSchema).max(8).default([]);
export const weeklyHoursSchema = z
  .object({ mon: dayHours, tue: dayHours, wed: dayHours, thu: dayHours, fri: dayHours, sat: dayHours, sun: dayHours })
  .refine(
    (week) =>
      WEEKDAYS.every((day) => {
        const ranges = [...week[day]].sort((a, b) => minutesOf(a.from) - minutesOf(b.from));
        return ranges.every((range, index) => index === 0 || minutesOf(range.from) >= minutesOf(ranges[index - 1]!.to));
      }),
    "A day's ranges cannot overlap.",
  );
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

const nine = [{ from: "09:00", to: "17:00" }];
export const DEFAULT_HOURS: WeeklyHours = { mon: nine, tue: nine, wed: nine, thu: nine, fri: nine, sat: [], sun: [] };

/** Local wall time, `YYYY-MM-DDTHH:MM`, read in a time zone given beside it. */
export const localDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, "A local date and time, like 2026-10-13T08:00.");
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date, like 2026-10-13.");

/* ── who may book: rules over facts ─────────────────────────────────────── */

export const FIELD_RULE_OPS = ["in", "not_in", "equals", "not_equals", "starts_with", "contains", "exists", "missing", "gte", "lte", "between"] as const;
export type FieldRuleOp = (typeof FIELD_RULE_OPS)[number];

export const FIELD_RULE_WORDS: Readonly<Record<FieldRuleOp, string>> = {
  in: "is one of",
  not_in: "is none of",
  equals: "is",
  not_equals: "is not",
  starts_with: "starts with",
  contains: "contains",
  exists: "is known",
  missing: "is not known",
  gte: "is at least",
  lte: "is at most",
  between: "is between",
};

/** Paths a rule may read: `contact.*`, `contact.stats.*`, `request.*`, `type.*`. */
export const factPathSchema = z.string().trim().regex(/^(contact|request|type)(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/, "A field like contact.category or request.serviceAddress.");

export const fieldRuleSchema = z.object({
  field: factPathSchema,
  op: z.enum(FIELD_RULE_OPS),
  values: z.array(z.union([z.string().max(400), z.number()])).max(500).default([]),
  /** Only a value from a matched record or a member counts; what the person said counts as unknown here. */
  trusted: z.boolean().optional(),
});
export type FieldRule = z.infer<typeof fieldRuleSchema>;

export const ruleSetSchema = z.object({
  all: z.array(fieldRuleSchema).max(30).default([]),
  any: z.array(fieldRuleSchema).max(30).default([]),
  /** `@freebirdai/expr` over the same scope, for what the builder cannot say. */
  expression: z.string().trim().max(2000).optional(),
});
export type RuleSet = z.infer<typeof ruleSetSchema>;
export const EMPTY_RULES: RuleSet = { all: [], any: [] };

export const ruleSetIsEmpty = (rules: RuleSet | undefined): boolean => !rules || (rules.all.length === 0 && rules.any.length === 0 && !rules.expression?.trim());

/* ── consolidation ─────────────────────────────────────────────────────── */

/**
 * Times that group a new appointment with ones the host already has that
 * share a field's value.
 *
 * - `stack`: the same start time as a matching appointment (needs capacity above one).
 * - `back_to_back`: touching a matching appointment, with no buffer between the two.
 */
export const consolidationSchema = z.object({
  by: z.array(factPathSchema).min(1).max(5),
  mode: z.enum(["stack", "back_to_back"]),
  /** `only`: offer just those, with a way to see the rest. `first`: list them first. */
  show: z.enum(["only", "first"]).default("only"),
});
export type Consolidation = z.infer<typeof consolidationSchema>;

/* ── settings ──────────────────────────────────────────────────────────── */

export const APPROVAL_MODES = ["none", "always", "rules"] as const;

const settingsShape = {
  /** How long an appointment takes. Set on types; a block cannot change it. */
  length: durationSchema,
  /** Free time kept between two appointments of one host. Set for the whole workspace or on a block only. */
  buffer: durationSchema,
  /** Start times every…, aligned to the hour. */
  slotStep: durationSchema,
  /** Stacking: how many appointments one host may have at the same time. */
  capacity: z.number().int().min(1).max(50),
  /** With capacity above one: stack only with appointments that share these fields. */
  stackOnlySame: z.array(factPathSchema).max(5),
  minNotice: durationSchema,
  horizon: durationSchema,
  maxPerDay: z.number().int().min(1).max(200),
  approval: z.enum(APPROVAL_MODES),
  /** With `approval: "rules"`: approval is needed when these hold. */
  approvalWhen: ruleSetSchema,
  /** The longest a pending request holds its slot. */
  holdFor: durationSchema,
  /** How long a suggested time stays held for the person booking. */
  suggestionHoldFor: durationSchema,
  cancelCutoff: durationSchema,
  rescheduleCutoff: durationSchema,
  maxReschedules: z.number().int().min(0).max(20),
  consolidate: consolidationSchema,
  /** Whether the person booking sees who they are booked with. */
  showHostName: z.boolean(),
};

export const schedulingSettingsSchema = z.object(settingsShape);
export type SchedulingSettings = z.infer<typeof schedulingSettingsSchema>;
/** Any layer says only what it changes. `consolidate: null` switches consolidation off below it. */
export const partialSettingsSchema = z.object(settingsShape).partial().extend({ consolidate: consolidationSchema.nullable().optional(), maxPerDay: z.number().int().min(1).max(200).nullable().optional() });
export type PartialSettings = z.infer<typeof partialSettingsSchema>;

/** The settings with every layer resolved. `consolidate` and `maxPerDay` may be absent: off, and no limit. */
export type ResolvedSettings = Omit<SchedulingSettings, "consolidate" | "maxPerDay"> & { readonly consolidate?: Consolidation; readonly maxPerDay?: number };

export const DEFAULT_SETTINGS: ResolvedSettings = {
  length: "30m",
  buffer: "0m",
  slotStep: "15m",
  capacity: 1,
  stackOnlySame: [],
  minNotice: "2h",
  horizon: "30d",
  approval: "none",
  approvalWhen: EMPTY_RULES,
  holdFor: "2d",
  suggestionHoldFor: "2d",
  cancelCutoff: "24h",
  rescheduleCutoff: "24h",
  maxReschedules: 2,
  showHostName: true,
};

export const SETTINGS_LAYERS = ["default", "workspace", "host", "type", "block"] as const;
export type SettingsLayer = (typeof SETTINGS_LAYERS)[number];

/** What each layer may set. The buffer is the workspace's or a block's; length and horizon are never a block's. */
export const LAYER_KEYS: Readonly<Record<Exclude<SettingsLayer, "default">, readonly (keyof SchedulingSettings)[]>> = {
  workspace: Object.keys(settingsShape) as (keyof SchedulingSettings)[],
  host: ["length", "slotStep", "capacity", "minNotice", "horizon", "maxPerDay", "showHostName"],
  type: ["length", "slotStep", "capacity", "stackOnlySame", "minNotice", "horizon", "maxPerDay", "approval", "approvalWhen", "holdFor", "suggestionHoldFor", "cancelCutoff", "rescheduleCutoff", "maxReschedules", "consolidate", "showHostName"],
  block: ["buffer", "capacity", "stackOnlySame", "minNotice", "approval", "approvalWhen", "consolidate"],
};

/**
 * The settings for one booking, from its layers, the last layer that says
 * something winning, with the layer each value came from so a screen can say
 * "30m (from Inspection)". A layer's keys outside `LAYER_KEYS` are ignored.
 */
export const resolveSettings = (
  layers: ReadonlyArray<{ readonly layer: Exclude<SettingsLayer, "default">; readonly settings: PartialSettings | undefined }>,
): { readonly settings: ResolvedSettings; readonly from: Readonly<Record<keyof SchedulingSettings, SettingsLayer>> } => {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const from = Object.fromEntries(Object.keys(settingsShape).map((key) => [key, "default"])) as Record<keyof SchedulingSettings, SettingsLayer>;
  for (const { layer, settings } of layers) {
    if (!settings) continue;
    for (const key of LAYER_KEYS[layer]) {
      const value = (settings as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (value === null) delete out[key];
      else out[key] = value;
      from[key] = layer;
    }
  }
  return { settings: out as ResolvedSettings, from };
};

/* ── hosts and pools ───────────────────────────────────────────────────── */

export const schedulingProfileSchema = z.object({
  /** A workspace member's user id, or `team-…` for a team member who does not sign in. */
  member: z.string().min(1).max(120),
  displayName: z.string().trim().min(1).max(80),
  /** Where approval requests and notices go. */
  email: z.string().email().optional(),
  bookable: z.boolean().default(false),
  timezone: z.string().refine(isTimeZone, "Not a time zone this server knows."),
  hours: weeklyHoursSchema.default(DEFAULT_HOURS),
  /** Whether working hours no block covers are open to anyone, or bookable only through blocks. */
  outsideBlocks: z.enum(["open", "closed"]).default("open"),
  settings: partialSettingsSchema.default({}),
  approvals: z.object({ requireSignIn: z.boolean().default(false), email: z.boolean().default(true) }).default({}),
  /** 1–8: a series slot, the colour of their appointments. */
  color: z.number().int().min(1).max(8).optional(),
  revision: z.number().int().min(0).default(0),
  updatedAt: z.string(),
});
export type SchedulingProfile = z.infer<typeof schedulingProfileSchema>;

export const POOL_ASSIGN = ["round_robin", "least_busy", "priority", "customer_picks"] as const;
export const POOL_ASSIGN_WORDS: Readonly<Record<(typeof POOL_ASSIGN)[number], string>> = {
  round_robin: "Take turns",
  least_busy: "Whoever is least busy",
  priority: "In order of priority",
  customer_picks: "The person booking picks",
};

export const poolSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  color: z.number().int().min(1).max(8).default(1),
  timezone: z.string().refine(isTimeZone, "Not a time zone this server knows."),
  members: z.array(z.object({ member: z.string().min(1).max(120), priority: z.number().int().min(1).max(100).default(1), active: z.boolean().default(true) })).max(100).default([]),
  assign: z.enum(POOL_ASSIGN).default("round_robin"),
  /** A returning contact gets their last host when that host is free. */
  sticky: z.boolean().default(true),
  leastBusyWindow: z.enum(["day", "week"]).default("week"),
  /** Round robin: who was given the last one. Moved inside the claim that assigns. */
  cursor: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Pool = z.infer<typeof poolSchema>;

/* ── appointment types ─────────────────────────────────────────────────── */

export const LOCATION_KINDS = ["contact_address", "fixed", "phone", "video", "ask"] as const;
export const LOCATION_WORDS: Readonly<Record<(typeof LOCATION_KINDS)[number], string>> = {
  contact_address: "At the contact's address",
  fixed: "At a set place",
  phone: "By phone",
  video: "By video call",
  ask: "Asked when booking",
};

/** What a type does when a "Who can book" rule's field has no usable value yet. */
export const WHEN_UNKNOWN = ["exclude", "include", "approval"] as const;

/**
 * Who can book a type at all, before any time is looked at: rules over the
 * contact's fields and this booking's answers (`request.*`, from the type's
 * questions). "Party size is at most 8", "segment is one of members".
 */
export const typeEligibilitySchema = z.object({
  /** Empty: anyone. */
  rules: ruleSetSchema.default(EMPTY_RULES),
  /** A field not known yet: ask first and offer nothing, let them book, or let them book pending approval. */
  whenUnknown: z.enum(WHEN_UNKNOWN).default("exclude"),
  /** What someone it doesn't take is told: "For parties of 9 or more, please call us." */
  message: z.string().trim().max(300).default(""),
});
export type TypeEligibility = z.infer<typeof typeEligibilitySchema>;

export const appointmentTypeSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  /** The public link's address: `/p/<workspace>/t/<slug>`. */
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lower-case letters, digits and dashes.").max(60),
  description: z.string().max(2000).default(""),
  color: z.number().int().min(1).max(8).default(1),
  active: z.boolean().default(true),
  hosts: z.union([z.object({ members: z.array(z.string().min(1)).min(1).max(100) }), z.object({ pool: idSchema })]),
  settings: partialSettingsSchema.default({}),
  /** Narrows the hosts' hours: "only in the morning". */
  hours: weeklyHoursSchema.optional(),
  /** How an agent offers it: a link, or times proposed in conversation. */
  offer: z.enum(["link", "conversation"]).default("conversation"),
  /** In conversation, send a link when the person asks for one. */
  linkOnRequest: z.boolean().default(true),
  /** A public link anyone can book from. */
  publicLink: z.boolean().default(false),
  /** Who can book it at all. */
  eligibility: typeEligibilitySchema.default({}),
  /** Questions asked when booking: `contact.*` or `request.*` fields. */
  intake: z.array(z.object({ field: factPathSchema, required: z.boolean().default(false), ask: z.string().max(300).optional() })).max(20).default([]),
  location: z.object({ kind: z.enum(LOCATION_KINDS), value: z.string().max(300).optional() }).default({ kind: "ask" }),
  /** Active bookings one contact may hold of this type: a link with one shows its status. */
  maxActivePerContact: z.number().int().min(1).max(20).default(1),
  /** Public link only: the contact must be verified first (needs Comms). */
  requireVerifiedContact: z.boolean().default(false),
  version: z.number().int().min(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AppointmentType = z.infer<typeof appointmentTypeSchema>;

/* ── blocks and placements ─────────────────────────────────────────────── */

export const BLOCK_KINDS = ["set", "blank", "closed"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const BLOCK_KIND_WORDS: Readonly<Record<BlockKind, { readonly label: string; readonly does: string }>> = {
  set: { label: "Set", does: "Only people its rules match can book here." },
  blank: { label: "Blank", does: "Each time it comes round, its first booking turns it into the block that booking belongs to." },
  closed: { label: "Closed", does: "Busy: nobody books here." },
};

export const blockSettingsSchema = partialSettingsSchema.pick({ buffer: true, capacity: true, stackOnlySame: true, minNotice: true, approval: true, approvalWhen: true, consolidate: true });

export const blockSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(80),
    color: z.number().int().min(1).max(8).default(1),
    description: z.string().max(1000).default(""),
    kind: z.enum(BLOCK_KINDS).default("set"),
    /** Set only: who may book here. Empty: anyone. */
    rules: ruleSetSchema.default(EMPTY_RULES),
    /** Blank only: the set blocks it may become, first one first. */
    becomes: z.array(idSchema).max(20).default([]),
    /** Set only: what to do when a rule's field has no usable value. */
    whenUnknown: z.enum(WHEN_UNKNOWN).default("exclude"),
    /** The types bookable here. Absent: every type the host takes. */
    types: z.array(idSchema).max(50).optional(),
    settings: blockSettingsSchema.default({}),
    /** Per occurrence: "at most four installs in each Tuesday north block". */
    maxBookings: z.number().int().min(1).max(500).optional(),
    version: z.number().int().min(1).default(1),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .refine((block) => block.kind !== "blank" || block.becomes.length > 0, { message: "A blank block says which blocks it may become.", path: ["becomes"] });
export type Block = z.infer<typeof blockSchema>;

export const recurrenceSchema = z
  .object({
    every: z.enum(["day", "week", "month"]),
    interval: z.number().int().min(1).max(52).default(1),
    /** Week: 0 (Sunday) to 6. Absent: the first occurrence's weekday. */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    /** Month: the same date (the 15th), or the nth weekday (the 2nd Tuesday, the last Friday). */
    monthly: z.union([z.object({ by: z.literal("date") }), z.object({ by: z.literal("weekday"), nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]) })]).optional(),
    /** The last date it may fall on. */
    until: localDateSchema.optional(),
    /** How many times in all, skipped dates included. */
    count: z.number().int().min(1).max(1000).optional(),
  });
export type Recurrence = z.infer<typeof recurrenceSchema>;

export const placementTargetSchema = z.object({ kind: z.enum(["member", "pool"]), id: z.string().min(1).max(120) });
export type PlacementTarget = z.infer<typeof placementTargetSchema>;

export const placementSchema = z
  .object({
    id: idSchema,
    block: idSchema,
    /** A pool placement applies to each of its members. */
    target: placementTargetSchema,
    timezone: z.string().refine(isTimeZone, "Not a time zone this server knows."),
    /** Local wall time in `timezone`. */
    start: localDateTimeSchema,
    end: localDateTimeSchema,
    repeat: recurrenceSchema.optional(),
    /** Dates of occurrences skipped. */
    except: z.array(localDateSchema).max(1000).default([]),
    createdBy: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .refine((one) => one.end > one.start, { message: "A placement ends after it starts.", path: ["end"] });
export type Placement = z.infer<typeof placementSchema>;

/** One time a placement comes round: the local date it starts on, and its instants. */
export interface Occurrence {
  readonly placement: string;
  readonly block: string;
  /** The local date it starts on: the occurrence's name. */
  readonly date: string;
  readonly start: number;
  readonly end: number;
  /** One-off placements beat repeating ones where they overlap. */
  readonly tier: "once" | "repeat";
}

/** "Every week on Tue, Thu", "Every 2 months on the last Fri", "Once". */
export const describeRecurrence = (repeat: Recurrence | undefined, start?: string): string => {
  if (!repeat) return "Once";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const every = repeat.interval === 1 ? `Every ${repeat.every}` : `Every ${repeat.interval} ${repeat.every}s`;
  let on = "";
  if (repeat.every === "week") {
    const weekdays = repeat.weekdays && repeat.weekdays.length > 0 ? repeat.weekdays : start ? [new Date(`${start.slice(0, 10)}T12:00:00Z`).getUTCDay()] : [];
    on = weekdays.length > 0 ? ` on ${[...weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => days[day]).join(", ")}` : "";
  } else if (repeat.every === "month" && start) {
    const date = new Date(`${start.slice(0, 10)}T12:00:00Z`);
    if (repeat.monthly?.by === "weekday") {
      const nth = repeat.monthly.nth === -1 ? "last" : ["", "1st", "2nd", "3rd", "4th"][repeat.monthly.nth];
      on = ` on the ${nth} ${days[date.getUTCDay()]}`;
    } else on = ` on day ${date.getUTCDate()}`;
  }
  const end = repeat.until ? `, until ${repeat.until}` : repeat.count ? `, ${repeat.count} times` : "";
  return `${every}${on}${end}`;
};
