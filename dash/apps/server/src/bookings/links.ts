import { BOOKING_STATUS_WORDS, LOCATION_WORDS, type Booking, type BookingEvent } from "@freebirdai/dash-spec";
import type { ContactService } from "../contacts/service.js";
import { mintToken, type PublicToken, type PublicTokenStore } from "../public/tokens.js";
import type { SchedulingService, WorkspaceMember } from "../scheduling/service.js";
import { APPROVAL_REMINDER, APPROVAL_REQUEST, BOOKING_CHANGED, DECISION_RECORDED, ownLink, render } from "../scheduling/templates/index.js";
import type { Brand, TeamNoticeKind, TeamNotifier } from "./notify.js";
import { whenWords } from "./row.js";
import type { BookingService } from "./service.js";

/**
 * The links people outside Dash use, and the notices that carry them.
 *
 * - A **booking link** is one contact's own page: their booking's status, or
 *   times to pick when they have none. A booking a workflow tells them about
 *   gets one, so `{{ link }}` always opens their page.
 * - An **approval link** is one member's, for one Approve a booking step:
 *   minted for each member asked, carried by their notice, spent when used
 *   and revoked when the step finishes.
 *
 * Only a token's hash is kept (`public/tokens.ts`), so a link can't be read
 * back: each is minted when it is handed out.
 */

const DAY = 86_400_000;
export const BOOKING_LINK_LIFETIME = 30 * DAY;

export interface BookingLinksDeps {
  readonly tokens: PublicTokenStore;
  readonly bookings: BookingService;
  readonly scheduling: SchedulingService;
  readonly contacts: ContactService;
  readonly members: () => Promise<readonly WorkspaceMember[]>;
  readonly notifier: TeamNotifier;
  readonly brand: () => Promise<Brand>;
  /** The workspace id public paths name. */
  readonly workspace: string;
  /** Where the pages are opened: the web app's origin. */
  readonly origin: string;
  readonly now: () => number;
}

export interface AskedMember {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly timezone: string;
}

/** The Approve a booking step an approval link answers: its task, and the try of the step. */
export interface ApprovalAsk {
  readonly id: string;
  readonly attempt?: string | undefined;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** "contact.address.postalCode" → "Postal code". */
const pathWords = (path: string): string => {
  const last = path.split(".").pop() ?? path;
  const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const dayKey = (at: number, zone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
};

const timeWords = (at: number | string, zone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(11, 16);
  }
};

/** "in 1 day and 3 hours", "in 40 minutes". */
export const remainingWords = (ms: number): string => {
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `in ${days} day${days === 1 ? "" : "s"}${rest ? ` and ${rest} hour${rest === 1 ? "" : "s"}` : ""}`;
};

export class BookingLinks {
  constructor(private readonly deps: BookingLinksDeps) {}

  private async brandVars(): Promise<{ brandName: string; accent: string }> {
    const brand = await this.deps.brand();
    return { brandName: brand.name, accent: brand.accent };
  }

  private page(kind: "book" | "approve", token: string, query = ""): string {
    return ownLink(`${this.deps.origin}/p/${encodeURIComponent(this.deps.workspace)}/${kind}/${token}${query}`, this.deps.origin);
  }

  /** The Dash calendar on a day, for the team's notices. */
  private calendarUrl(at: string): string {
    return `${this.deps.origin}/#/agent/calendar/${new Date(at).toISOString().slice(0, 10)}`;
  }

  /* ── booking links ───────────────────────────────────────────────────── */

  /** A new link to one contact's page, optionally for one type, host or record. */
  async contactLink(
    contact: string,
    options: { readonly type?: string; readonly host?: string; readonly subject?: PublicToken["subject"]; readonly booking?: string; readonly fromPublic?: boolean } = {},
  ): Promise<{ readonly url: string; readonly path: string; readonly token: PublicToken; readonly raw: string }> {
    await this.deps.contacts.require(contact);
    const minted = mintToken(
      {
        purpose: "booking_link",
        contact,
        ...(options.type ? { type: options.type } : {}),
        ...(options.host ? { host: options.host } : {}),
        ...(options.subject ? { subject: options.subject } : {}),
        ...(options.booking ? { booking: options.booking } : {}),
        ...(options.fromPublic ? { fromPublic: true } : {}),
        expiresAt: iso(this.deps.now() + BOOKING_LINK_LIFETIME),
      },
      this.deps.now(),
    );
    await this.deps.tokens.put(minted.record);
    return { url: this.page("book", minted.token), path: `/p/${encodeURIComponent(this.deps.workspace)}/book/${minted.token}`, token: minted.record, raw: minted.token };
  }

  /** The contact's page for one booking: what `{{ link }}` opens. */
  async bookingLink(booking: Booking): Promise<string> {
    return (await this.contactLink(booking.contact, { type: booking.type.id, booking: booking.id, ...(booking.subject ? { subject: booking.subject } : {}) })).url;
  }

  /** Withdraw a link: it stops opening at once. */
  async revoke(id: string, contact: string): Promise<PublicToken | null> {
    const token = (await this.deps.tokens.list({ contact })).find((one) => one.id === id);
    if (!token) return null;
    if (token.revokedAt) return token;
    const revoked = { ...token, revokedAt: iso(this.deps.now()) };
    await this.deps.tokens.put(revoked);
    return revoked;
  }

  /** A contact's links, newest first, without anything that opens them. */
  async linksOf(contact: string): Promise<PublicToken[]> {
    return (await this.deps.tokens.list({ contact })).filter((one) => one.purpose === "booking_link").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /* ── approval links ──────────────────────────────────────────────────── */

  private async member(id: string, fallbackZone: string): Promise<AskedMember | null> {
    const one = (await this.deps.members()).find((member) => member.userId === id);
    if (!one) return null;
    const profile = await this.deps.scheduling.findProfile(id);
    return { id, email: one.email, name: profile?.displayName || one.email.split("@")[0] || id, timezone: profile?.timezone ?? fallbackZone };
  }

  /**
   * Who is asked to approve a booking: the member the step named, else the
   * pool's active members, else the host. Only people still in the workspace.
   */
  async askedMembers(booking: Booking, assignee?: string): Promise<AskedMember[]> {
    let ids: string[];
    if (assignee) ids = [assignee];
    else if (booking.pool) {
      const pool = await this.deps.scheduling.findPool(booking.pool);
      ids = pool ? pool.members.filter((one) => one.active).map((one) => one.member) : [booking.host];
      if (ids.length === 0) ids = [booking.host];
    } else ids = [booking.host];
    const out: AskedMember[] = [];
    for (const id of new Set(ids)) {
      const member = await this.member(id, booking.timezone);
      if (member) out.push(member);
    }
    return out;
  }

  /** A link that lets one member answer one Approve a booking step. */
  async approvalLink(task: ApprovalAsk, booking: Booking, member: string, deadline: string, choice?: "approve" | "suggest" | "deny"): Promise<string> {
    const minted = mintToken(
      {
        purpose: "approval",
        member,
        task: task.id,
        ...(task.attempt ? { attempt: task.attempt } : {}),
        booking: booking.id,
        contact: booking.contact,
        expiresAt: deadline,
      },
      this.deps.now(),
    );
    await this.deps.tokens.put(minted.record);
    return this.page("approve", minted.token, choice ? `?choice=${choice}` : "");
  }

  /** Three links, one per button, all opening the page: the choice only preselects a panel. */
  private async buttonsFor(task: ApprovalAsk, booking: Booking, member: string, deadline: string) {
    const url = await this.approvalLink(task, booking, member, deadline);
    return { approveUrl: `${url}?choice=approve`, suggestUrl: `${url}?choice=suggest`, denyUrl: `${url}?choice=deny` };
  }

  private async notify(kind: TeamNoticeKind, member: AskedMember, rendered: { subject: string; html: string; text: string }, key: string) {
    try {
      return await this.deps.notifier.notify({ kind, member: { id: member.id, email: member.email, name: member.name }, ...rendered, key });
    } catch (error) {
      return { status: "not_sent" as const, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async summary(booking: Booking) {
    const contact = await this.deps.contacts.get(booking.contact);
    const contactName = contact?.name || contact?.emails[0] || contact?.phones[0] || "Someone";
    const said = typeof booking.answers["where"] === "string" ? (booking.answers["where"] as string) : "";
    const where = !booking.location
      ? "Not set"
      : booking.location.kind === "ask"
        ? said || "Not given yet"
        : `${LOCATION_WORDS[booking.location.kind]}${booking.location.value ? `: ${booking.location.value}` : ""}`;
    return {
      contact,
      contactName,
      contactDetails: [contact?.emails[0], contact?.phones[0]].filter(Boolean).join(" · ") || "No email or phone yet",
      whereText: where,
    };
  }

  /** The member's own bookings on the day of the asked-for time, in their zone, this one marked. */
  async dayAround(memberId: string, timezone: string, booking: Booking): Promise<Array<{ readonly start: string; readonly end: string; readonly label: string; readonly status: string; readonly current: boolean }>> {
    const start = Date.parse(booking.start);
    const day = dayKey(start, timezone);
    const theirs = await this.deps.bookings.list({ host: memberId, from: start - DAY, to: start + DAY, statuses: ["pending", "confirmed", "suggested"] });
    const mine = theirs.some((one) => one.id === booking.id) ? theirs : [...theirs, booking];
    return mine
      .filter((one) => dayKey(Date.parse(one.start), timezone) === day)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((one) => ({ start: one.start, end: one.end, label: one.type.name, status: BOOKING_STATUS_WORDS[one.status], current: one.id === booking.id }));
  }

  private async dayOf(member: AskedMember, booking: Booking): Promise<string> {
    const lines = (await this.dayAround(member.id, member.timezone, booking)).map(
      (one) => `${timeWords(one.start, member.timezone)} – ${timeWords(one.end, member.timezone)}  ${one.label}${one.current ? " (this request)" : ` (${one.status.toLowerCase()})`}`,
    );
    return lines.length > 1 ? lines.join("\n") : "Nothing else booked that day.";
  }

  /** What the booking's rules read about the person, and the block it came under: why it was offered, for the team only. */
  async factLines(booking: Booking): Promise<string[]> {
    const lines = Object.entries(booking.values)
      .filter(([path]) => path.startsWith("contact.") || path.startsWith("request."))
      .slice(0, 12)
      .map(([path, value]) => `${pathWords(path)}: ${value}`);
    if (booking.block) {
      const block = (await this.deps.scheduling.overview()).blocks.find((one) => one.id === booking.block);
      if (block) lines.unshift(`Under the ${block.name} block`);
    }
    return lines;
  }

  private async factsOf(booking: Booking): Promise<string> {
    const lines = await this.factLines(booking);
    return lines.length > 0 ? lines.join("\n") : "No facts were needed for this type.";
  }

  /** A member as the approval page names them: "Answering as Sam (sam@…)". */
  async memberOf(id: string, fallbackZone: string): Promise<AskedMember | null> {
    return this.member(id, fallbackZone);
  }

  /**
   * Asks each member who may answer, once per step: a link each, handed to
   * the notifier. A step that runs again finds its links already minted and
   * asks nobody twice.
   */
  async askTeam(input: { readonly task: ApprovalAsk; readonly booking: Booking; readonly deadline: string; readonly assignee?: string }): Promise<{ readonly asked: number; readonly notSent: number }> {
    const { task, booking, deadline } = input;
    const held = (await this.deps.tokens.list({ task: task.id })).filter((one) => one.purpose === "approval" && (one.attempt ?? "") === (task.attempt ?? ""));
    if (held.length > 0) return { asked: 0, notSent: 0 };
    const members = await this.askedMembers(booking, input.assignee);
    const { contactName, contactDetails, whereText } = await this.summary(booking);
    const notes = Object.entries(booking.answers)
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([key, value]) => `${pathWords(key)}: ${String(value)}`)
      .join("; ");
    let notSent = 0;
    for (const member of members) {
      const urls = await this.buttonsFor(task, booking, member.id, deadline);
      const rendered = render(APPROVAL_REQUEST, {
        ...(await this.brandVars()),
        memberName: member.name,
        contactName,
        contactDetails,
        typeName: booking.type.name,
        when: whenWords(booking.start, member.timezone),
        whereText,
        notes: notes || "None",
        facts: await this.factsOf(booking),
        day: await this.dayOf(member, booking),
        holdText: booking.holdUntil ? `The time is held until ${whenWords(booking.holdUntil, member.timezone)}.` : "The time is held while you decide.",
        ...urls,
      });
      const sent = await this.notify("approval_request", member, rendered, `approval:${task.id}:${task.attempt ?? ""}:${member.id}`);
      if (sent.status === "not_sent") notSent++;
    }
    return { asked: members.length, notSent };
  }

  /** The one reminder: fresh links, since the first ones can't be read back. */
  async remindTeam(input: { readonly task: ApprovalAsk; readonly booking: Booking; readonly deadline: string; readonly assignee?: string }): Promise<void> {
    const { task, booking, deadline } = input;
    const { contactName, whereText } = await this.summary(booking);
    const left = Date.parse(booking.holdUntil ?? deadline) - this.deps.now();
    for (const member of await this.askedMembers(booking, input.assignee)) {
      const urls = await this.buttonsFor(task, booking, member.id, deadline);
      const rendered = render(APPROVAL_REMINDER, {
        ...(await this.brandVars()),
        memberName: member.name,
        contactName,
        typeName: booking.type.name,
        when: whenWords(booking.start, member.timezone),
        whereText,
        remaining: `The hold runs out ${remainingWords(left)}.`,
        ...urls,
      });
      await this.notify("approval_reminder", member, rendered, `approval-reminder:${task.id}:${task.attempt ?? ""}:${member.id}`);
    }
  }

  /**
   * The step finished: every link it handed out stops answering (it still
   * shows what was decided), and each member asked hears the outcome, so
   * nobody answers twice.
   */
  async closeAsks(task: ApprovalAsk, booking: Booking, outcome: string): Promise<void> {
    const now = iso(this.deps.now());
    const asked = (await this.deps.tokens.list({ task: task.id })).filter((one) => one.purpose === "approval");
    for (const one of asked) if (!one.revokedAt) await this.deps.tokens.put({ ...one, revokedAt: now });
    const members = [...new Set(asked.map((one) => one.member).filter((one): one is string => Boolean(one)))];
    if (members.length === 0) return;
    const { contactName } = await this.summary(booking);
    const answeredBy = booking.decision?.by;
    const byName = answeredBy ? ((await this.member(answeredBy, booking.timezone))?.name ?? "Someone on the team") : "";
    for (const id of members) {
      const member = await this.member(id, booking.timezone);
      if (!member) continue;
      const you = answeredBy === id;
      const who = you ? "You" : byName || "Someone on the team";
      const [headline, detail] =
        outcome === "approved"
          ? [`${who} approved ${booking.type.name} for ${contactName}`, you ? "It's confirmed, and they'll be told." : `${byName} answered first, so there's nothing for you to do.`]
          : outcome === "suggested"
            ? [`${who} suggested other times to ${contactName}`, you ? "They'll be told, and can pick one of the times." : `${byName} answered first, so there's nothing for you to do.`]
            : outcome === "denied"
              ? [`${who} denied ${booking.type.name} for ${contactName}`, you ? "They'll be told." : `${byName} answered first, so there's nothing for you to do.`]
              : outcome === "withdrawn"
                ? [`${contactName} withdrew the request`, "They cancelled or changed it before anyone answered, so there's nothing to do."]
                : [`Nobody answered ${contactName}'s request in time`, "The hold ran out before anyone answered."];
      const view = mintToken({ purpose: "approval", member: id, task: task.id, booking: booking.id, contact: booking.contact, expiresAt: iso(this.deps.now() + BOOKING_LINK_LIFETIME), revokedAt: now }, this.deps.now());
      await this.deps.tokens.put(view.record);
      const rendered = render(DECISION_RECORDED, {
        ...(await this.brandVars()),
        memberName: member.name,
        headline,
        detail,
        contactName,
        typeName: booking.type.name,
        when: whenWords(booking.start, member.timezone),
        viewUrl: this.page("approve", view.token),
      });
      await this.notify("decision_recorded", member, rendered, `decision:${task.id}:${task.attempt ?? ""}:${id}`);
    }
  }

  /** The host hears of a change to their booking they didn't make themselves. */
  async bookingChanged(event: BookingEvent, booking: Booking): Promise<void> {
    if (!["confirmed", "cancelled", "rescheduled", "suggestion_accepted"].includes(event.kind)) return;
    if (event.kind === "confirmed" && event.payload["previous"] === "suggested") return;
    const by = event.payload["by"] as { kind?: string; id?: string } | undefined;
    if (by?.kind === "member" && by.id === booking.host) return;
    const host = await this.member(booking.host, booking.timezone);
    if (!host) return;
    const { contactName, whereText } = await this.summary(booking);
    const when = whenWords(booking.start, host.timezone);
    const words: Record<string, [string, string]> = {
      confirmed: [`Confirmed: ${booking.type.name} with ${contactName}`, `${booking.type.name} with ${contactName} is confirmed for ${when}.`],
      cancelled: [`Cancelled: ${booking.type.name} with ${contactName}`, `${booking.type.name} with ${contactName} on ${when} was cancelled. The time is free again.`],
      rescheduled: [`Moved: ${booking.type.name} with ${contactName}`, `${booking.type.name} with ${contactName} is now ${when}.`],
      suggestion_accepted: [`${contactName} took a suggested time`, `${contactName} picked ${when} for ${booking.type.name}. It's confirmed.`],
    };
    const [headline, detail] = words[event.kind]!;
    const rendered = render(BOOKING_CHANGED, {
      ...(await this.brandVars()),
      hostName: host.name,
      headline,
      detail,
      contactName,
      typeName: booking.type.name,
      when,
      whereText,
      statusText: BOOKING_STATUS_WORDS[booking.status],
      viewUrl: this.calendarUrl(booking.start),
    });
    await this.notify("booking_changed", host, rendered, `changed:${event.id}`);
  }
}
