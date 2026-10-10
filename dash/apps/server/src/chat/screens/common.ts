import { revealSelector, withCitation, type ActionContext, type ActionPreflightResult, type ActionPreviewRow, type ComponentDefinition } from "@freebirdai/core";
import { DASH_SCREENS, principalSchema, type Permission, type Principal } from "@freebirdai/dash-spec";
import type { z } from "zod";

/**
 * The calendar's and the contacts' screens, as the chat knows them.
 *
 * Each screen is a guide component: its own actions (what a person can do on
 * it, the same services and permissions as the screen), a line of knowledge,
 * and where it is (`domAnchor`), so a citation chip or "take me there" lands
 * on it. Nothing here runs a change: a change is proposed on a card, the
 * person approves it, and the handler calls the service the screen calls.
 * What the chat did is then a line in the conversation with a chip to where
 * it is (`withCitation`), followed only if the person wants to.
 */

export interface Screen {
  readonly id: string;
  readonly title: string;
  /** The app's own address for it. */
  readonly page: string;
  readonly description: string;
}

export const SCREENS = {
  calendar: {
    id: DASH_SCREENS.calendar.id,
    title: "Calendar",
    page: DASH_SCREENS.calendar.page,
    description: "Everything on the calendar: events, deadlines and appointments from agents, workflows and people; and each member's own calendar feed for their phone.",
  },
  bookings: {
    id: DASH_SCREENS.bookings.id,
    title: "Bookings",
    page: DASH_SCREENS.bookings.page,
    description: "Appointments people booked or asked for: open times, booking for a contact, and every decision on a booking (confirm, deny, offer other times, move, reassign, cancel, mark how it went, links).",
  },
  types: {
    id: DASH_SCREENS.types.id,
    title: "Appointment types",
    page: DASH_SCREENS.types.page,
    description: "What people can book: length, hosts, approval, who can book (rules), questions, location, public link, how agents offer it, and its settings.",
  },
  blocks: {
    id: DASH_SCREENS.blocks.id,
    title: "Blocks",
    page: DASH_SCREENS.blocks.page,
    description: "Rules for who can book at which times (set, blank and closed blocks), and where they are placed on calendars, once or repeating.",
  },
  people: {
    id: DASH_SCREENS.people.id,
    title: "People & pools",
    page: DASH_SCREENS.people.page,
    description: "Whose time can be booked: each host's hours, time zone and settings, and pools that share the work.",
  },
  settings: {
    id: DASH_SCREENS.settings.id,
    title: "Scheduling settings",
    page: DASH_SCREENS.settings.page,
    description: "The defaults every booking starts from: buffer, notice, horizon, approval, holds, cancel and reschedule cut-offs.",
  },
  contacts: {
    id: DASH_SCREENS.contacts.id,
    title: "Contacts",
    page: DASH_SCREENS.contacts.page,
    description: "Everyone who has booked or been added: their details and fields, the records they match, and their personal booking links.",
  },
  contactFields: {
    id: DASH_SCREENS.contactFields.id,
    title: "Contact fields",
    page: DASH_SCREENS.contactFields.page,
    description: "The facts contacts hold, where each comes from, and the rules that match contacts to records.",
  },
} as const satisfies Record<string, Screen>;

/** A screen as a guide component: its anchor, its knowledge and its actions. */
export const screenComponent = (screen: Screen, knowledge: readonly string[], actions: ComponentDefinition["actions"]): ComponentDefinition => ({
  id: screen.id,
  title: screen.title,
  description: screen.description,
  grid: { minW: 12, minH: 4 },
  domAnchor: { selector: revealSelector({ component: screen.id }), page: screen.page },
  knowledge: knowledge.map((text) => ({ text })),
  actions: actions ?? [],
});

/**
 * A schema as an action's argument type. Guide types an action's schema with
 * one type in and out; a schema with defaults reads differently on each side,
 * and the handler always gets the parsed side.
 */
export const argsOf = <T>(schema: z.ZodTypeAny): z.ZodType<T> => schema as unknown as z.ZodType<T>;

/** What every screen's actions are given: who may do what, the clock, and a way to say something changed. */
export interface ScreenAccess {
  may(principal: Principal, permission: Permission): Promise<boolean>;
  readonly now: () => number;
  /** Something the chat knows about changed: drop the cached registry so the next turn reads afresh. */
  changed(): void;
}

export const principalOf = (ctx: ActionContext<unknown>): Principal | null => {
  const extra = (ctx.auth as { extra?: Record<string, unknown> } | null)?.extra;
  const parsed = principalSchema.safeParse(extra?.["principal"]);
  return parsed.success ? parsed.data : null;
};

/** The principal a handler acts as. `authorize` has already asked; this is the handler's own check. */
export const actor = (ctx: ActionContext<unknown>): Principal => {
  const principal = principalOf(ctx);
  if (!principal) throw new Error("Nobody is signed in.");
  return principal;
};

/** `authorize` for an action: signed in, and holding the permission the screen asks for. */
export const allowedTo =
  (access: ScreenAccess, permission: Permission | null, refusal: string) =>
  async (_args: unknown, ctx: ActionContext<unknown>): Promise<true | { ok: false; reason: string; status: number }> => {
    const principal = principalOf(ctx);
    if (!principal) return { ok: false, reason: "Nobody is signed in.", status: 401 };
    if (permission && !(await access.may(principal, permission))) return { ok: false, reason: refusal, status: 403 };
    return true;
  };

/** A preflight that cannot go on: what is wrong, on the field the model can correct. */
export const blocked = (field: string, message: string): ActionPreflightResult => ({ ok: false, message, blockers: [{ code: "not_found", field, message }] });

/** One of several things by id or by name, as a person says it ("showing", "Showing"). */
export const findBy = <T>(items: readonly T[], key: string, names: (item: T) => ReadonlyArray<string | undefined>): T | null => {
  const wanted = key.trim().toLowerCase();
  if (!wanted) return null;
  return items.find((item) => names(item).some((name) => name !== undefined && name.toLowerCase() === wanted)) ?? null;
};

/** "Showing, Inspection and 3 more": what there is, when something asked for is not. */
export const listed = (names: readonly string[], max = 12): string =>
  names.length === 0 ? "none yet" : names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;

/* ── words for values ───────────────────────────────────────────────── */

/** A value as a person reads it on a card. */
export const shown = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return value.length === 0 ? "None" : value.map(shown).join(", ");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, one]) => one !== undefined);
    return entries.length === 0 ? "—" : entries.map(([key, one]) => `${key}: ${shown(one)}`).join("; ");
  }
  return String(value);
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A card's rows for a change: each field it sets, as "before → after", or
 * only the new value where there is no before (a new thing, or nothing read).
 * Fields it leaves alone are not shown.
 */
export const changeRows = (
  fields: ReadonlyArray<{ readonly label: string; readonly before?: unknown; readonly after: unknown; readonly isNew?: boolean; readonly words?: (value: unknown) => string }>,
): ActionPreviewRow[] =>
  fields
    .filter((field) => field.after !== undefined && (field.isNew || !same(field.before, field.after)))
    .map((field) => {
      const words = field.words ?? shown;
      const after = words(field.after);
      const value = field.isNew || field.before === undefined ? after : `${words(field.before)} → ${after}`;
      return { label: field.label, value, multiline: value.length > 60 };
    });

/* ── where a change landed ──────────────────────────────────────────── */

/** A result carrying a chip to where its change is: the screen, the one thing on it, the one setting. */
export const landed = <T extends object>(
  result: T,
  screen: Screen,
  where: { readonly title: string; readonly summary: string; readonly item?: string; readonly field?: string },
) =>
  withCitation(result, {
    title: where.title,
    summary: where.summary,
    page: screen.page,
    selector: revealSelector({ component: screen.id, ...(where.item ? { item: where.item } : {}), ...(where.field ? { field: where.field } : {}) }),
  });

/** A short id from a name, for something new the person did not give an id: "Morning walk-ins" → "morning-walk-ins". */
export const idFrom = (name: string, taken: ReadonlySet<string>): string => {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
};
