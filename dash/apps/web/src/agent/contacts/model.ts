import type { Contact, ContactField, ContactFieldDef, ContactFieldSource, FieldSource, MatchOutcome } from "@freebirdai/dash-spec";
import type { BadgeTone } from "@freebirdai/dash-components";
import type { ContactSource } from "../../api.js";

/**
 * Words and small sums for the Contacts section: what to call a contact,
 * how to show a phone number, where a value came from, and what became of
 * the last try at matching.
 */

export const contactTitle = (contact: Pick<Contact, "name" | "emails" | "phones">): string =>
  contact.name.trim() || contact.emails[0] || (contact.phones[0] ? formatPhone(contact.phones[0]) : "") || "Unnamed contact";

export const initials = (contact: Pick<Contact, "name" | "emails" | "phones">): string => {
  const words = contact.name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words.at(-1)![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (contact.emails[0]?.[0] ?? "#").toUpperCase();
};

/** One of the eight series colours, the same for a contact every time. */
export const contactColor = (id: string): number => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % 8) + 1;
};

/** "+15125550142" → "(512) 555-0142"; other countries as "+44 20 7946 0958"-ish groups. */
export const formatPhone = (e164: string): string => {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (us) return `(${us[1]}) ${us[2]}-${us[3]}`;
  const digits = e164.replace(/^\+/, "");
  return `+${digits.slice(0, 2)} ${digits.slice(2).replace(/(\d{3,4})(?=\d{3,})/g, "$1 ")}`.trim();
};

export const MATCH_WORDS: Readonly<Record<MatchOutcome, string>> = {
  linked: "Linked",
  none: "No record matched",
  ambiguous: "Several records match",
  unavailable: "Couldn't check",
};

export const MATCH_TONES: Readonly<Record<MatchOutcome, BadgeTone>> = {
  linked: "accent",
  none: "neutral",
  ambiguous: "warn",
  unavailable: "danger",
};

export const FROM_WORDS: Readonly<Record<FieldSource, string>> = {
  record: "From a record",
  person: "They told us",
  member: "Set by your team",
};

/** A value as a person reads it. */
export const valueWords = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    const one = value as Record<string, unknown>;
    if (typeof one["line1"] === "string") {
      const place = [one["city"], one["region"]].filter((part) => typeof part === "string" && part).join(", ");
      return [one["line1"], one["line2"], [place, one["postalCode"]].filter(Boolean).join(" ")].filter((part) => typeof part === "string" && part).join(", ");
    }
    return JSON.stringify(value);
  }
  return String(value);
};

/** Each value a field holds, strongest first, with where it came from. */
export const fieldValues = (field: ContactField | undefined): Array<{ readonly from: FieldSource; readonly value: unknown; readonly at: string; readonly by?: string; readonly ref?: { connection: string; entity: string; recordId: string; field: string } }> =>
  (["member", "record", "person"] as const).flatMap((from) => {
    const one = field?.[from];
    return one ? [{ from, value: one.value, at: one.at, ...(one.by ? { by: one.by } : {}), ...(one.ref ? { ref: one.ref } : {}) }] : [];
  });

/** "serviceArea" from "Service area". */
export const keyOfLabel = (label: string): string => {
  const words = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const key = words.map((word, index) => (index === 0 ? word.toLowerCase() : `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}`)).join("");
  return /^[a-zA-Z]/.test(key) ? key.slice(0, 60) : `field${key}`.slice(0, 60);
};

/** "Billing · Client · Type", from what the sources list knows. */
export const sourceWords = (source: Pick<ContactFieldSource, "connection" | "entity" | "field">, sources: readonly ContactSource[] = []): string => {
  const connection = sources.find((one) => one.connection === source.connection);
  const entity = connection?.entities.find((one) => one.entity === source.entity);
  const field = entity?.fields.find((one) => one.path === source.field);
  return [connection?.title ?? source.connection, entity?.name ?? source.entity, field?.label ?? source.field].join(" · ");
};

/** "Billing · Client", for a link or a rule. */
export const recordTypeWords = (connection: string, entity: string, sources: readonly ContactSource[] = []): string => {
  const known = sources.find((one) => one.connection === connection);
  return `${known?.title ?? connection} · ${known?.entities.find((one) => one.entity === entity)?.name ?? entity}`;
};

export const KIND_WORDS: Readonly<Record<ContactFieldDef["kind"], string>> = {
  text: "Text",
  choice: "Choice",
  address: "Address",
  email: "Email",
  phone: "Phone",
  number: "Number",
  date: "Date",
  boolean: "Yes or no",
};

/** "just now", "5 min ago", "3 h ago", "yesterday", "Oct 4". */
export const relativeTime = (iso: string, now = Date.now()): string => {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "yesterday";
  const date = new Date(at);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
};
