import {
  DEFAULT_SETTINGS,
  WEEKDAYS,
  durationMs,
  resolveSettings,
  type AppointmentType,
  type Block,
  type FieldRule,
  type PartialSettings,
  type Placement,
  type RuleSet,
  type SchedulingProfile,
  type SchedulingSettings,
  type SettingsLayer,
  type WeeklyHours,
} from "@freebirdai/dash-spec";

/**
 * The words and arithmetic the scheduling setup screens share, kept apart
 * from React so they can be tested on their own.
 */

/** An id for something new: its name in letters and dashes, and a short tail so two of the same name do not collide. */
export const newId = (name: string, prefix = ""): string => {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const tail = Math.random().toString(36).slice(2, 6);
  return `${prefix}${slug || "item"}-${tail}`;
};

/** A name as a web address part: "Home Inspection" → "home-inspection". */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "appointment";

/* ── durations ─────────────────────────────────────────────────────────── */

export const DURATION_UNITS = [
  { unit: "m", label: "minutes", ms: 60_000 },
  { unit: "h", label: "hours", ms: 3_600_000 },
  { unit: "d", label: "days", ms: 86_400_000 },
  { unit: "w", label: "weeks", ms: 7 * 86_400_000 },
] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number]["unit"];

/** A duration as a number and the largest unit it is a whole number of: "90m" → 90 minutes, "120m" → 2 hours. */
export const splitDuration = (value: string | undefined): { amount: number; unit: DurationUnit } => {
  const ms = durationMs(value) ?? 0;
  if (ms === 0) return { amount: 0, unit: "m" };
  for (const one of [...DURATION_UNITS].reverse()) if (ms % one.ms === 0) return { amount: ms / one.ms, unit: one.unit };
  return { amount: Math.round(ms / 60_000), unit: "m" };
};

/** "30 min", "2 h", "1 day", "2 weeks". */
export const durationWords = (value: string | undefined): string => {
  const { amount, unit } = splitDuration(value);
  if (amount === 0) return "none";
  if (unit === "m") return `${amount} min`;
  if (unit === "h") return `${amount} h`;
  if (unit === "d") return `${amount} ${amount === 1 ? "day" : "days"}`;
  return `${amount} ${amount === 1 ? "week" : "weeks"}`;
};

/* ── settings ──────────────────────────────────────────────────────────── */

export type SettingKind = "duration" | "number" | "step" | "approval" | "switch" | "fields" | "consolidate" | "rules";

export interface SettingMeta {
  readonly key: keyof SchedulingSettings;
  readonly label: string;
  readonly kind: SettingKind;
  readonly hint?: string;
  readonly min?: number;
  readonly max?: number;
}

export const SETTING_META: Readonly<Record<keyof SchedulingSettings, SettingMeta>> = {
  length: { key: "length", label: "Appointment length", kind: "duration" },
  buffer: { key: "buffer", label: "Buffer between appointments", kind: "duration", hint: "Free time kept between two appointments of one person." },
  slotStep: { key: "slotStep", label: "Start times every", kind: "step", hint: "Aligned to the hour." },
  capacity: { key: "capacity", label: "Appointments at the same time", kind: "number", min: 1, max: 50, hint: "Above one lets appointments stack." },
  stackOnlySame: { key: "stackOnlySame", label: "Stack only with the same", kind: "fields", hint: "With stacking on: a second appointment at the same time must share these fields." },
  minNotice: { key: "minNotice", label: "Minimum notice", kind: "duration", hint: "How far ahead a time must be to be offered." },
  horizon: { key: "horizon", label: "Bookable up to", kind: "duration", hint: "How far ahead people may book." },
  maxPerDay: { key: "maxPerDay", label: "Most appointments a day", kind: "number", min: 1, max: 200 },
  approval: { key: "approval", label: "Approval", kind: "approval" },
  approvalWhen: { key: "approvalWhen", label: "Needs approval when", kind: "rules" },
  holdFor: { key: "holdFor", label: "Hold a pending request for", kind: "duration", hint: "The longest a request keeps its time while it waits for approval." },
  suggestionHoldFor: { key: "suggestionHoldFor", label: "Hold a suggested time for", kind: "duration", hint: "How long a time a team member suggests stays held for the person." },
  cancelCutoff: { key: "cancelCutoff", label: "Cancel online until", kind: "duration", hint: "Closer than this to the start, the booking page says to get in touch." },
  rescheduleCutoff: { key: "rescheduleCutoff", label: "Reschedule online until", kind: "duration" },
  maxReschedules: { key: "maxReschedules", label: "Reschedules allowed", kind: "number", min: 0, max: 20 },
  consolidate: { key: "consolidate", label: "Consolidate", kind: "consolidate" },
  showHostName: { key: "showHostName", label: "Show who they are booked with", kind: "switch" },
};

export const APPROVAL_WORDS: Readonly<Record<SchedulingSettings["approval"], string>> = {
  none: "Not needed",
  always: "Always",
  rules: "When conditions hold",
};

export const LAYER_WORDS: Readonly<Record<SettingsLayer, string>> = {
  default: "the default",
  workspace: "workspace settings",
  host: "their profile",
  type: "the appointment type",
  block: "the block",
};

/** What a setting is below one layer: the value the layers under it give, and which layer gave it. */
export const inherited = (
  below: ReadonlyArray<{ readonly layer: Exclude<SettingsLayer, "default">; readonly settings: PartialSettings | undefined }>,
): ReturnType<typeof resolveSettings> => resolveSettings(below);

/** A setting's value in words, for "Default: 30 min (workspace settings)". */
export const settingWords = (key: keyof SchedulingSettings, value: unknown): string => {
  if (value === undefined || value === null) return key === "consolidate" ? "Off" : key === "maxPerDay" ? "No limit" : "—";
  const meta = SETTING_META[key];
  if (meta.kind === "duration" || meta.kind === "step") return durationWords(value as string);
  if (meta.kind === "approval") return APPROVAL_WORDS[value as SchedulingSettings["approval"]];
  if (meta.kind === "switch") return value ? "Yes" : "No";
  if (meta.kind === "fields") return (value as string[]).length > 0 ? (value as string[]).join(", ") : "Anyone";
  if (meta.kind === "consolidate") {
    const consolidate = value as SchedulingSettings["consolidate"];
    return `${consolidate.mode === "stack" ? "Stacked" : "Back to back"} by ${consolidate.by.join(", ")}`;
  }
  if (meta.kind === "rules") return ruleSummary(value as RuleSet) || "Always";
  return String(value);
};

export { DEFAULT_SETTINGS };

/* ── hours ─────────────────────────────────────────────────────────────── */

export const DAY_LABELS: Readonly<Record<(typeof WEEKDAYS)[number], string>> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** "Mon–Fri 09:00–17:00 · Sat 10:00–14:00", "No hours". */
export const hoursSummary = (hours: WeeklyHours): string => {
  const key = (day: (typeof WEEKDAYS)[number]) => hours[day].map((range) => `${range.from}–${range.to}`).join(", ");
  const groups: Array<{ days: Array<(typeof WEEKDAYS)[number]>; text: string }> = [];
  for (const day of WEEKDAYS) {
    const text = key(day);
    if (!text) continue;
    const last = groups.at(-1);
    const previous = WEEKDAYS[WEEKDAYS.indexOf(day) - 1];
    if (last && last.text === text && previous && last.days.at(-1) === previous) last.days.push(day);
    else groups.push({ days: [day], text });
  }
  if (groups.length === 0) return "No hours";
  return groups
    .map((group) => `${DAY_LABELS[group.days[0]!]}${group.days.length > 1 ? `–${DAY_LABELS[group.days.at(-1)!]}` : ""} ${group.text}`)
    .join(" · ");
};

/* ── rules ─────────────────────────────────────────────────────────────── */

/** Fields a rule can read, with words, offered in the builder. Contact fields set up later join these. */
export const FACT_SUGGESTIONS: ReadonlyArray<{ readonly path: string; readonly label: string }> = [
  { path: "contact.category", label: "Contact: category" },
  { path: "contact.address", label: "Contact: address" },
  { path: "contact.address.postalCode", label: "Contact: postal code" },
  { path: "contact.address.city", label: "Contact: city" },
  { path: "contact.tags", label: "Contact: tags" },
  { path: "contact.stats.bookings", label: "Contact: bookings so far" },
  { path: "contact.stats.noShows", label: "Contact: no-shows" },
  { path: "contact.stats.cancellations", label: "Contact: cancellations" },
  { path: "request.serviceAddress", label: "This booking: service address" },
];

const ROOT_WORDS: Readonly<Record<string, string>> = { contact: "Contact", request: "This booking", type: "Appointment type" };

/** A field nobody named, in words: `contact.serviceArea` → "Contact: service area". */
const pathWords = (path: string): string => {
  const [root = "", ...rest] = path.split(".");
  const head = ROOT_WORDS[root];
  if (!head || rest.length === 0) return path;
  return `${head}: ${rest.map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase()).join(" ")}`;
};

/** A contact field the workspace has set up, as rule and grouping editors offer it. */
export interface FieldOption {
  readonly path: string;
  readonly label: string;
  /** Rules on it count only a record's or a member's value by default. */
  readonly trust?: "any" | "record";
  readonly choices?: readonly string[];
}

export const factLabel = (path: string, extra: ReadonlyArray<{ path: string; label: string }> = []): string =>
  [...extra, ...FACT_SUGGESTIONS].find((one) => one.path === path)?.label ?? pathWords(path);

const OP_WORDS: Readonly<Record<FieldRule["op"], string>> = {
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
export { OP_WORDS };

/** A rule in a line: "postal code starts with 787 or 786". */
export const ruleWords = (rule: FieldRule, extra: ReadonlyArray<{ path: string; label: string }> = []): string => {
  const field = factLabel(rule.field, extra).replace(/^Contact: |^This booking: /, "");
  if (rule.op === "exists" || rule.op === "missing") return `${field} ${OP_WORDS[rule.op]}`;
  const values = rule.values.map(String);
  const list = rule.op === "between" ? values.slice(0, 2).join(" and ") : values.length > 3 ? `${values.slice(0, 3).join(", ")} +${values.length - 3}` : values.join(rule.op === "in" || rule.op === "starts_with" ? " or " : ", ");
  return `${field} ${OP_WORDS[rule.op]} ${list}`;
};

/** A rule set in a line, or empty when it has no rules. */
export const ruleSummary = (rules: RuleSet | undefined, extra: ReadonlyArray<{ path: string; label: string }> = []): string => {
  if (!rules) return "";
  const parts = [
    ...rules.all.map((rule) => ruleWords(rule, extra)),
    ...(rules.any.length > 0 ? [rules.any.length === 1 ? ruleWords(rules.any[0]!, extra) : `one of: ${rules.any.map((rule) => ruleWords(rule, extra)).join("; ")}`] : []),
    ...(rules.expression?.trim() ? [rules.expression.trim()] : []),
  ];
  return parts.join(" and ");
};

/* ── what a thing is, in a line ────────────────────────────────────────── */

export const typeHostsWords = (type: AppointmentType, profiles: readonly SchedulingProfile[], pools: ReadonlyArray<{ id: string; name: string }>): string =>
  "members" in type.hosts
    ? type.hosts.members.map((member) => profiles.find((one) => one.member === member)?.displayName ?? member).join(", ")
    : `Pool: ${pools.find((one) => one.id === (type.hosts as { pool: string }).pool)?.name ?? "removed"}`;

export const blockSummary = (block: Block, blocks: readonly Block[]): string => {
  if (block.kind === "closed") return "Busy: nobody books here";
  if (block.kind === "blank") return `Becomes ${block.becomes.map((id) => blocks.find((one) => one.id === id)?.name ?? id).join(" or ")}`;
  return ruleSummary(block.rules) || "Anyone can book";
};

const pad = (n: number): string => String(n).padStart(2, "0");
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue 08:00–12:00, every week" or "Wed 14 Oct, 08:00–12:00". */
/** Days of the week, Monday first, with a run of three or more as a range: "Mon–Fri", "Mon, Wed, Fri". */
const dayRun = (days: readonly number[]): string => {
  const order = [...new Set(days)].map((day) => (day + 6) % 7).sort((a, b) => a - b);
  const name = (index: number) => DAY_NAMES[(index + 1) % 7];
  const consecutive = order.every((index, at) => at === 0 || index === order[at - 1]! + 1);
  if (order.length >= 3 && consecutive) return `${name(order[0]!)}–${name(order.at(-1)!)}`;
  return order.map(name).join(", ");
};

export const placementWords = (placement: Placement): string => {
  const date = new Date(`${placement.start.slice(0, 10)}T12:00:00Z`);
  const time = `${placement.start.slice(11)}–${placement.end.slice(11)}`;
  if (!placement.repeat) return `${DAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${date.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" })}, ${time}`;
  const { repeat } = placement;
  const every = repeat.interval === 1 ? `every ${repeat.every}` : `every ${repeat.interval} ${repeat.every}s`;
  let on = "";
  if (repeat.every === "week") on = dayRun(repeat.weekdays && repeat.weekdays.length > 0 ? repeat.weekdays : [date.getUTCDay()]);
  else if (repeat.every === "month") on = repeat.monthly?.by === "weekday" ? `${repeat.monthly.nth === -1 ? "last" : ["", "1st", "2nd", "3rd", "4th"][repeat.monthly.nth]} ${DAY_NAMES[date.getUTCDay()]}` : `day ${date.getUTCDate()}`;
  const until = repeat.until ? `, until ${repeat.until}` : repeat.count ? `, ${repeat.count} times` : "";
  const skipped = placement.except.length > 0 ? `, ${placement.except.length} skipped` : "";
  return `${on ? `${on} ` : ""}${time}, ${every}${until}${skipped}`;
};

/** Today's date in a zone, `YYYY-MM-DD`. */
export const todayIn = (zone: string, now = Date.now()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  return parts;
};

/** The browser's own zone, or UTC. */
export const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** A sorted list of zones to choose from: what the runtime knows, or a short list. */
export const timeZones = (): string[] => {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.("timeZone");
    if (all && all.length > 0) return all.includes("UTC") ? all : ["UTC", ...all];
  } catch {
    /* Older runtime. */
  }
  return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"];
};

export const hourOptions = (): string[] => {
  const out: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 30) out.push(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
  return out;
};
