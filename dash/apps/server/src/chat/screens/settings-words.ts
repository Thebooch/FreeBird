import {
  APPROVAL_MODES,
  LAYER_KEYS,
  consolidationSchema,
  durationMs,
  durationSchema,
  factPathSchema,
  ruleSetSchema,
  type PartialSettings,
  type SchedulingSettings,
} from "@freebirdai/dash-spec";
import { z } from "zod";
import { shown } from "./common.js";
import { rulesInWords } from "./rules-words.js";

/**
 * Scheduling's settings in words, for the chat's schemas and its cards: what
 * each one is (the model reads this to pick it), what it is called on the
 * screen, and how its value reads. Settings are layered workspace → host →
 * type → block, and each layer may set only some of them (`LAYER_KEYS`).
 */

type SettingKey = keyof SchedulingSettings;

export const SETTING_LABELS: Readonly<Record<SettingKey, string>> = {
  length: "Length",
  buffer: "Buffer between appointments",
  slotStep: "Start times every",
  capacity: "At the same time",
  stackOnlySame: "Stack only when the same",
  minNotice: "Minimum notice",
  horizon: "Bookable up to",
  maxPerDay: "Most per day",
  approval: "Needs approval",
  approvalWhen: "Approval when",
  holdFor: "Hold a request for",
  suggestionHoldFor: "Hold offered times for",
  cancelCutoff: "Cancel up to",
  rescheduleCutoff: "Reschedule up to",
  maxReschedules: "Most reschedules",
  consolidate: "Group with matching appointments",
  showHostName: "Show who they meet",
};

const duration = (what: string) => durationSchema.optional().describe(`${what} Like 15m, 2h, 3d or 1w.`);

const SETTING_SCHEMAS = {
  length: duration("How long an appointment takes."),
  buffer: duration("Free time kept between two appointments of one host."),
  slotStep: duration("Start times every…, aligned to the hour."),
  capacity: z.number().int().min(1).max(50).optional().describe("How many appointments one host may have at the same time (stacking). 1 means one at a time."),
  stackOnlySame: z.array(factPathSchema).max(5).optional().describe("With capacity above one: stack only appointments that share these fields, like contact.serviceArea."),
  minNotice: duration("The least notice a booking needs."),
  horizon: duration("How far ahead people may book."),
  maxPerDay: z.number().int().min(1).max(200).nullable().optional().describe("The most appointments a host takes in a day. null: no limit."),
  approval: z.enum(APPROVAL_MODES).optional().describe("Whether a booking needs a person's approval: none (books outright), always, or rules (when approvalWhen holds)."),
  approvalWhen: ruleSetSchema.optional().describe("With approval 'rules': approval is needed when these rules over contact.* and request.* fields hold."),
  holdFor: duration("The longest a pending request holds its time."),
  suggestionHoldFor: duration("How long other times offered to someone stay held for them."),
  cancelCutoff: duration("Up to how long before the start someone may cancel themselves."),
  rescheduleCutoff: duration("Up to how long before the start someone may reschedule themselves."),
  maxReschedules: z.number().int().min(0).max(20).optional().describe("How many times one booking may be rescheduled by the person."),
  consolidate: consolidationSchema.nullable().optional().describe("Offer times next to or at the same time as the host's appointments that share these fields first (or only). null: off."),
  showHostName: z.boolean().optional().describe("Whether the person booking sees who they will meet."),
} satisfies Record<SettingKey, z.ZodTypeAny>;

/** The settings one layer may change, each optional and described. Typed as all of them; the layer's own are present. */
export const settingsChanges = (layer: keyof typeof LAYER_KEYS) =>
  z
    .object(Object.fromEntries(LAYER_KEYS[layer].map((key) => [key, SETTING_SCHEMAS[key]])) as unknown as typeof SETTING_SCHEMAS)
    .partial()
    .describe("Settings to set at this level. Leave out what stays as it is.");

/** Settings to stop setting at this level, so they follow the level above. */
export const settingsInherit = (layer: keyof typeof LAYER_KEYS) =>
  z
    .array(z.enum(LAYER_KEYS[layer] as unknown as [SettingKey, ...SettingKey[]]))
    .max(20)
    .optional()
    .describe("Settings to stop setting here, so they follow the level above (the host's or the workspace's).");

const APPROVAL_WORDS: Readonly<Record<(typeof APPROVAL_MODES)[number], string>> = { none: "Not needed", always: "Always", rules: "When its rules say" };

/** One setting's value as it reads on the screen. */
const DURATION_KEYS: ReadonlySet<SettingKey> = new Set(["length", "buffer", "slotStep", "minNotice", "horizon", "holdFor", "suggestionHoldFor", "cancelCutoff", "rescheduleCutoff"]);

/** "30 min", "2 h", "1 day", "2 weeks": a duration as the screens write it. */
export const durationWords = (value: string): string => {
  const ms = durationMs(value);
  if (ms === null) return value;
  if (ms === 0) return "None";
  const units = [
    { ms: 604_800_000, one: "week", many: "weeks" },
    { ms: 86_400_000, one: "day", many: "days" },
    { ms: 3_600_000, one: "h", many: "h" },
  ];
  for (const unit of units) if (ms % unit.ms === 0) return `${ms / unit.ms} ${ms === unit.ms ? unit.one : unit.many}`;
  return `${Math.round(ms / 60_000)} min`;
};

export const settingWords = (key: SettingKey) => (value: unknown): string => {
  if (value === null) return key === "maxPerDay" ? "No limit" : "Off";
  if (DURATION_KEYS.has(key) && typeof value === "string") return durationWords(value);
  if (key === "approval" && typeof value === "string") return APPROVAL_WORDS[value as (typeof APPROVAL_MODES)[number]] ?? value;
  if (key === "approvalWhen") return rulesInWords(value as z.infer<typeof ruleSetSchema>);
  if (key === "consolidate" && value && typeof value === "object") {
    const one = value as z.infer<typeof consolidationSchema>;
    return `${one.mode === "stack" ? "At the same time as" : "Next to"} appointments with the same ${one.by.join(", ")}${one.show === "only" ? ", only those" : ", those first"}`;
  }
  return shown(value);
};

/**
 * What a layer's settings become: changes over what it holds, minus what it
 * stops setting. `null` is kept where a setting means "off" by it.
 */
export const mergedSettings = (held: PartialSettings | undefined, changes: Partial<Record<SettingKey, unknown>> | undefined, inherit: readonly SettingKey[] | undefined): PartialSettings => {
  const out: Record<string, unknown> = { ...(held ?? {}) };
  for (const [key, value] of Object.entries(changes ?? {})) if (value !== undefined) out[key] = value;
  for (const key of inherit ?? []) delete out[key];
  return out as PartialSettings;
};

/** Card rows for a layer's settings: each one set or stopped. */
export const settingsRows = (held: PartialSettings | undefined, next: PartialSettings) => {
  const keys = new Set([...Object.keys(held ?? {}), ...Object.keys(next)]) as Set<SettingKey>;
  return [...keys]
    .filter((key) => JSON.stringify((held as Record<string, unknown> | undefined)?.[key] ?? null) !== JSON.stringify((next as Record<string, unknown>)[key] ?? null))
    .map((key) => {
      const before = (held as Record<string, unknown> | undefined)?.[key];
      const after = (next as Record<string, unknown>)[key];
      const words = settingWords(key);
      const value = after === undefined ? `${before === undefined ? "—" : words(before)} → follows the level above` : before === undefined ? words(after) : `${words(before)} → ${words(after)}`;
      return { label: SETTING_LABELS[key], value, multiline: value.length > 60 };
    });
};
