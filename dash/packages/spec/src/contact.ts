import { idSchema } from "@freebirdai/connect-spec";
import { z } from "zod";
import { principalSchema } from "./access.js";

/**
 * Contacts: the people who book, as Dash keeps them. The start of a CRM,
 * built only as far as scheduling needs, behind an interface the CRM keeps
 * (`ContactDirectory` on the server).
 *
 * - A contact is found by a normalized email or phone, never by a name, so
 *   one address is one contact.
 * - Its **fields** are facts block rules read (`contact.<key>`). Each field
 *   keeps where every value came from: copied from a matched API record,
 *   given by the person, or set by a member. A member's value beats a
 *   record's, and a record's beats what the person said; a rule that wants a
 *   trusted value ignores the person's.
 * - A contact is **linked** to an API record by the workspace's match rules,
 *   when exactly one record matches. Linking copies the mapped fields once;
 *   Refresh copies them again. Nothing syncs in the background, so a rule
 *   never changes under a booking without someone seeing why.
 */

export const CONTACT_ORIGINS = ["public_link", "agent", "member", "workflow"] as const;
export type ContactOrigin = (typeof CONTACT_ORIGINS)[number];

/** Where a field's value came from, weakest first. */
export const FIELD_SOURCES = ["person", "record", "member"] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

export const CONTACT_FIELD_KINDS = ["text", "choice", "address", "email", "phone", "number", "date", "boolean"] as const;
export type ContactFieldKind = (typeof CONTACT_FIELD_KINDS)[number];

export const CONTACT_CHANNELS = ["text", "email", "call"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** Keys a field may not take: they are the contact's own, at the same place in a rule's scope. */
export const RESERVED_FIELD_KEYS = ["id", "name", "email", "emails", "phone", "phones", "timezone", "stats", "tags"] as const;

export const contactFieldKeySchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/, "A field key is letters, digits and underscores, starting with a letter: serviceArea.")
  .refine((key) => !(RESERVED_FIELD_KEYS as readonly string[]).includes(key), "That key is the contact's own. Pick another.");

/* ── normalizing ───────────────────────────────────────────────────────── */

/** An email as one comparable form, or null when it is not one. */
export const normalizeEmail = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254 ? value : null;
};

/**
 * A phone number in E.164 ("+15125550142"), or null when it cannot be told
 * which number it is. A number written without a country is read in the
 * workspace's (`callingCode`, North America's "1" by default): ten digits
 * there, or a leading trunk 0 elsewhere.
 */
export const normalizePhone = (raw: unknown, callingCode = "1"): string | null => {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  const international = text.startsWith("+") || text.startsWith("00");
  let digits = text.replace(/\D/g, "");
  if (text.startsWith("00")) digits = digits.slice(2);
  const valid = (all: string) => (all.length >= 8 && all.length <= 15 && !all.startsWith("0") ? `+${all}` : null);
  if (international) return valid(digits);
  if (callingCode === "1") {
    if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1") && /^[2-9]/.test(digits.slice(1))) return `+${digits}`;
    return null;
  }
  if (digits.startsWith("0")) return valid(`${callingCode}${digits.slice(1)}`);
  return digits.startsWith(callingCode) ? valid(digits) : null;
};

/** The keys a contact is found by: "email:…" and "phone:…". */
export const contactKeys = (contact: { readonly emails: readonly string[]; readonly phones: readonly string[] }): string[] => [
  ...new Set([...contact.emails.map((email) => `email:${email}`), ...contact.phones.map((phone) => `phone:${phone}`)]),
];

/* ── values ────────────────────────────────────────────────────────────── */

export const addressValueSchema = z.object({
  line1: z.string().trim().max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(32).optional(),
  country: z.string().trim().max(80).optional(),
});
export type AddressValue = z.infer<typeof addressValueSchema>;

/** Where a copied value lives in its API record. */
export const fieldRefSchema = z.object({
  connection: idSchema,
  entity: z.string().min(1).max(120),
  recordId: z.string().min(1).max(200),
  field: z.string().min(1).max(200),
});
export type FieldRef = z.infer<typeof fieldRefSchema>;

export const contactFieldValueSchema = z.object({
  value: z.unknown(),
  /** From a record: where it was copied from. */
  ref: fieldRefSchema.optional(),
  /** From a member: who set it. */
  by: z.string().optional(),
  at: z.string(),
});
export type ContactFieldValue = z.infer<typeof contactFieldValueSchema>;

/** One field's values, one per place it came from. */
export const contactFieldSchema = z.object({
  person: contactFieldValueSchema.optional(),
  record: contactFieldValueSchema.optional(),
  member: contactFieldValueSchema.optional(),
});
export type ContactField = z.infer<typeof contactFieldSchema>;

/**
 * The value a field has, and where it came from: a member's, else a
 * record's, else the person's. `trusted` leaves out what the person said.
 */
export const fieldValueOf = (
  field: ContactField | undefined,
  options: { readonly trusted?: boolean } = {},
): { readonly value: unknown; readonly from: FieldSource } | undefined => {
  if (!field) return undefined;
  for (const from of ["member", "record", "person"] as const) {
    if (from === "person" && options.trusted) return undefined;
    const one = field[from];
    if (one && one.value !== undefined && one.value !== null && one.value !== "") return { value: one.value, from };
  }
  return undefined;
};

/* ── the contact ───────────────────────────────────────────────────────── */

export const contactLinkSchema = z.object({
  connection: idSchema,
  entity: z.string().min(1).max(120),
  recordId: z.string().min(1).max(200),
  /** What the record is called, when it says. */
  label: z.string().max(200).optional(),
  /** The contact's keys it matched on: ["email"]. Empty when a member linked it by hand. */
  matchedOn: z.array(z.string()).default([]),
  syncedAt: z.string(),
  by: z.enum(["match", "member"]),
});
export type ContactLink = z.infer<typeof contactLinkSchema>;

export const MATCH_OUTCOMES = ["linked", "none", "ambiguous", "unavailable"] as const;
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

export const contactStatsSchema = z.object({
  bookings: z.number().int().nonnegative().default(0),
  cancellations: z.number().int().nonnegative().default(0),
  noShows: z.number().int().nonnegative().default(0),
  lastBookedAt: z.string().optional(),
  firstContactAt: z.string(),
});
export type ContactStats = z.infer<typeof contactStatsSchema>;

export const contactSchema = z.object({
  id: z.string().min(1),
  name: z.string().max(160).default(""),
  /** Normalized (`normalizeEmail`). */
  emails: z.array(z.string()).max(10).default([]),
  /** E.164 (`normalizePhone`). */
  phones: z.array(z.string()).max(10).default([]),
  timezone: z.string().optional(),
  fields: z.record(contactFieldSchema).default({}),
  links: z.array(contactLinkSchema).max(20).default([]),
  /** The last try at matching, and what came of it. */
  lastMatch: z
    .object({
      outcome: z.enum(MATCH_OUTCOMES),
      /** Why, in a sentence: "Two records in Billing have this email." */
      detail: z.string().optional(),
      /** For `ambiguous`: the records a member picks from. */
      candidates: z
        .array(z.object({ connection: idSchema, entity: z.string(), recordId: z.string(), label: z.string().optional() }))
        .max(20)
        .optional(),
      at: z.string(),
    })
    .optional(),
  preferences: z
    .object({
      channel: z.enum(CONTACT_CHANNELS).optional(),
      optOut: z.array(z.enum(CONTACT_CHANNELS)).default([]),
    })
    .default({ optOut: [] }),
  preferredHost: z.string().optional(),
  stats: contactStatsSchema,
  /** What Comms has confirmed, once it can. */
  verified: z.object({ email: z.string().optional(), phone: z.string().optional() }).default({}),
  origin: z.enum(CONTACT_ORIGINS),
  revision: z.number().int().positive().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Contact = z.infer<typeof contactSchema>;

/** What a member changes on a contact. A field set to null loses the member's value. */
export const contactInputSchema = z.object({
  name: z.string().trim().max(160).optional(),
  emails: z.array(z.string()).max(10).optional(),
  phones: z.array(z.string()).max(10).optional(),
  timezone: z.string().nullable().optional(),
  preferredHost: z.string().nullable().optional(),
  preferences: z.object({ channel: z.enum(CONTACT_CHANNELS).nullable().optional(), optOut: z.array(z.enum(CONTACT_CHANNELS)).optional() }).optional(),
  fields: z.record(z.unknown()).optional(),
  /** The revision the change was made against; a newer one refuses it. */
  revision: z.number().int().positive().optional(),
});
export type ContactInput = z.infer<typeof contactInputSchema>;

/* ── how contacts get their fields ─────────────────────────────────────── */

export const contactFieldSourceSchema = z.object({
  connection: idSchema,
  entity: z.string().min(1).max(120),
  /** A path in the record: "type", "address.zip". */
  field: z.string().trim().min(1).max(200),
  /** The API's values to ours: { "A": "existing" }. Values not here copy as they are. */
  map: z.record(z.string()).optional(),
});
export type ContactFieldSource = z.infer<typeof contactFieldSourceSchema>;

const fieldDefShape = z.object({
  key: contactFieldKeySchema,
  label: z.string().trim().min(1, "Give the field a name.").max(80),
  kind: z.enum(CONTACT_FIELD_KINDS).default("text"),
  choices: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  /** Whether the person may be asked for it. Off for anything they could answer to their own advantage. */
  askable: z.boolean().default(false),
  /** How to ask: "What's the address of the visit?" */
  ask: z.string().trim().max(200).optional(),
  /** Whether rules on it count only a record's or a member's value by default. */
  trust: z.enum(["any", "record"]).default("any"),
  sources: z.array(contactFieldSourceSchema).max(10).default([]),
  order: z.number().int().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const contactFieldDefSchema = fieldDefShape.refine((def) => def.kind !== "choice" || (def.choices?.length ?? 0) > 0, {
  message: "A choice field needs its choices.",
  path: ["choices"],
});
export type ContactFieldDef = z.infer<typeof contactFieldDefSchema>;

export const contactFieldDefInputSchema = fieldDefShape.omit({ key: true, createdAt: true, updatedAt: true });
export type ContactFieldDefInput = z.input<typeof contactFieldDefInputSchema>;

/**
 * How a contact is matched to a record: which of the contact's keys equals
 * which field of the record. Matching reads as the person who saved the
 * rule, so it can never read what they could not.
 */
const matchRuleShape = z.object({
  id: z.string().min(1).max(80),
  connection: idSchema,
  entity: z.string().min(1).max(120),
  on: z
    .array(
      z.object({
        /** "email", "phone", or a field key. */
        contact: z.string().trim().min(1).max(60),
        /** A path in the record. */
        record: z.string().trim().min(1).max(200),
      }),
    )
    .min(1, "Say what to match on.")
    .max(3),
  savedBy: principalSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const contactMatchRuleSchema = matchRuleShape;
export type ContactMatchRule = z.infer<typeof contactMatchRuleSchema>;

export const contactMatchRuleInputSchema = matchRuleShape.omit({ id: true, savedBy: true, createdAt: true, updatedAt: true });
export type ContactMatchRuleInput = z.input<typeof contactMatchRuleInputSchema>;

/* ── checking a value against its field ────────────────────────────────── */

/**
 * A value made right for its field, or why it can't be: an email lower-cased,
 * a phone in E.164, a number from "12", a choice spelled as the field spells
 * it. A record's value goes through the same check when it is copied.
 */
export const fieldValueFor = (
  def: Pick<ContactFieldDef, "kind" | "choices" | "label">,
  raw: unknown,
  callingCode?: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: string } => {
  const bad = (problem: string) => ({ ok: false as const, problem: `${def.label}: ${problem}` });
  switch (def.kind) {
    case "email": {
      const value = normalizeEmail(raw);
      return value ? { ok: true, value } : bad("not an email address.");
    }
    case "phone": {
      const value = normalizePhone(raw, callingCode);
      return value ? { ok: true, value } : bad("not a phone number with its area code.");
    }
    case "number": {
      const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      return Number.isFinite(value) ? { ok: true, value } : bad("not a number.");
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const text = String(raw).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(text)) return { ok: true, value: true };
      if (["false", "no", "n", "0"].includes(text)) return { ok: true, value: false };
      return bad("not yes or no.");
    }
    case "date": {
      const text = typeof raw === "string" ? raw.trim().slice(0, 10) : "";
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00Z`)) ? { ok: true, value: text } : bad("not a date (YYYY-MM-DD).");
    }
    case "address": {
      if (typeof raw === "string") return raw.trim() ? { ok: true, value: raw.trim() } : bad("empty.");
      const parsed = addressValueSchema.safeParse(raw);
      return parsed.success && parsed.data.line1 ? { ok: true, value: parsed.data } : bad("not an address.");
    }
    case "choice": {
      const text = String(raw ?? "").trim();
      const choice = def.choices?.find((one) => one.toLowerCase() === text.toLowerCase());
      return choice ? { ok: true, value: choice } : bad(`"${text}" is not one of its choices.`);
    }
    default: {
      if (raw === null || raw === undefined) return bad("empty.");
      const value = typeof raw === "object" ? JSON.stringify(raw) : String(raw).trim();
      return value.length <= 2000 ? { ok: true, value } : bad("too long.");
    }
  }
};
