import { inboundSettingsSchema, requesterKeys, type InboundSettings, type MailMessage, type Principal, type RequesterRule, type ScreenRecord, type ScreenSignal } from "@freebirdai/dash-spec";
import { screenEmail } from "./screen.js";
import type { InboundStore } from "./store.js";

/**
 * The inbound screen in the server: every new email is screened before a
 * model reads it or a workflow starts, and the result kept. A held email
 * waits in "Waiting for you" and Communications for a person: Release lets
 * it go on as if it had just arrived, Block sender drops it and holds the
 * sender's next ones, Trust sender releases it and lets what that sender
 * sends drive steps on Auto.
 */

export class InboundError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InboundError";
  }
}

export interface InboundDeps {
  readonly store: InboundStore;
  readonly now: () => number;
  readonly newId: () => string;
  /** The team: nobody outside may claim to be them. */
  readonly members?: () => Promise<readonly { readonly email: string }[]>;
  /**
   * Goes on with a message the screen let through or a person released:
   * extraction, highlights and workflows, marked with who asked and how far
   * they are trusted. Absent: nothing goes on (tests of the screen alone).
   */
  readonly proceed?: (message: MailMessage, screen: ScreenRecord) => Promise<void>;
  /** A held message, found again in what Communications keeps. Null once it is no longer kept. */
  readonly message?: (mailbox: string, id: string) => Promise<MailMessage | null>;
}

const DAY_MS = 86_400_000;

export class InboundService {
  constructor(private readonly deps: InboundDeps) {}

  settings(): Promise<InboundSettings> {
    return this.deps.store.settings();
  }

  async putSettings(input: unknown): Promise<InboundSettings> {
    const parsed = inboundSettingsSchema.safeParse(input);
    if (!parsed.success) throw new InboundError(parsed.error.issues.map((issue) => issue.message).join(" "), 400);
    await this.deps.store.putSettings(parsed.data);
    return parsed.data;
  }

  rules(): Promise<RequesterRule[]> {
    return this.deps.store.rules();
  }

  /**
   * Screens one email and keeps the result. Returns it; `status` is `held`
   * when it must wait for a person, `passed` when it may go on.
   */
  async screen(message: MailMessage, text: string, extra: { readonly contact?: string; readonly knownContact?: boolean; readonly channel?: "email" | "text" } = {}): Promise<ScreenRecord> {
    const address = message.from?.address ?? "";
    const at = new Date(this.deps.now()).toISOString();
    const keys = requesterKeys(address);
    const [settings, rules, members, today] = await Promise.all([
      this.deps.store.settings(),
      this.deps.store.rules(),
      this.deps.members?.() ?? Promise.resolve([]),
      this.deps.store.screens({ since: new Date(this.deps.now() - DAY_MS).toISOString(), limit: 1000 }),
    ]);
    /* What reached workflows today: from this sender, and from anyone at its domain. */
    const went = today.filter((one) => one.status === "passed" || one.status === "released");
    const sentToday = went.filter((one) => requesterKeys(one.from).address === keys.address).length;
    const domainSentToday = went.filter((one) => requesterKeys(one.from).domain === keys.domain).length;
    const result = screenEmail({
      from: { address, ...(message.from?.name ? { name: message.from.name } : {}) },
      subject: message.subject,
      text,
      hasAttachments: message.hasAttachments,
      ...(extra.knownContact ? { knownContact: true } : {}),
      rules: new Map(rules.map((rule) => [rule.key, rule])),
      sentToday,
      messagesPerDay: settings.limits.messagesPerDay,
      domainSentToday,
      domainMessagesPerDay: settings.limits.domainMessagesPerDay,
      members,
    });
    /* Observe-only holds nothing a rule found, but a sender a person blocked is always held. */
    const holds = result.requester.trust === "blocked" || (!settings.observeOnly && result.wouldHold);
    const record: ScreenRecord = {
      id: `screen-${this.deps.newId()}`,
      at,
      channel: extra.channel ?? "email",
      mailbox: message.mailbox,
      message: message.id,
      from: address,
      ...(extra.contact ? { contact: extra.contact } : {}),
      requester: result.requester,
      signals: result.signals,
      wouldHold: result.wouldHold,
      observeOnly: settings.observeOnly,
      status: holds ? "held" : "passed",
    };
    await this.deps.store.putScreen(record);
    return record;
  }

  /**
   * A request on a booking page, from the email it is made with: a blocked
   * sender is refused always; past a limit it is refused once holding is on,
   * and only counted while the screen watches. A trusted one is never
   * limited. Kept like a screened email, so the summary counts it too.
   */
  async gate(input: {
    readonly email: string;
    readonly action: "start" | "book" | "cancel";
    readonly bookingsToday?: number;
    readonly openHolds?: number;
    readonly cancellationsThisWeek?: number;
  }): Promise<{ readonly allowed: boolean; readonly reason?: string; readonly record: ScreenRecord }> {
    const keys = requesterKeys(input.email);
    const [settings, rules] = await Promise.all([this.deps.store.settings(), this.deps.store.rules()]);
    const rule = rules.find((one) => one.key === keys.address) ?? rules.find((one) => one.key === keys.domain);
    const trust = rule?.trust ?? "unknown";
    const signals: ScreenSignal[] = [];
    if (trust === "blocked") signals.push({ kind: "blocked", detail: "the sender is blocked", hold: true });
    if (trust !== "trusted" && trust !== "blocked") {
      const { limits } = settings;
      if (input.action === "book" && (input.bookingsToday ?? 0) >= limits.bookingsPerDay) signals.push({ kind: "over_limit", detail: `${input.bookingsToday} booking requests today, over the limit of ${limits.bookingsPerDay}`, hold: true });
      if (input.action === "book" && (input.openHolds ?? 0) >= limits.openHolds) signals.push({ kind: "over_limit", detail: `${input.openHolds} bookings already waiting on the team, the most one person may have`, hold: true });
      if (input.action === "cancel" && (input.cancellationsThisWeek ?? 0) >= limits.cancellationsPerWeek) signals.push({ kind: "over_limit", detail: `${input.cancellationsThisWeek} cancellations this week, over the limit of ${limits.cancellationsPerWeek}`, hold: true });
    }
    const wouldHold = signals.some((one) => one.hold);
    const refused = trust === "blocked" || (!settings.observeOnly && wouldHold);
    const record: ScreenRecord = {
      id: `screen-${this.deps.newId()}`,
      at: new Date(this.deps.now()).toISOString(),
      channel: "booking",
      mailbox: "booking",
      message: input.action,
      from: input.email.trim().toLowerCase(),
      requester: { key: rule?.key ?? keys.address, trust },
      signals,
      wouldHold,
      observeOnly: settings.observeOnly,
      status: refused ? "dropped" : "passed",
    };
    /* Only what is worth counting is kept: a refusal, or what a rule would have refused. */
    if (wouldHold || refused) await this.deps.store.putScreen(record);
    const reason = trust === "blocked" ? "This booking page isn't taking requests from this address. Contact the business directly." : refused ? `This can't be done here right now: ${signals.find((one) => one.hold)?.detail ?? "a limit was reached"}. Contact the business directly.` : undefined;
    return { allowed: !refused, ...(reason ? { reason } : {}), record };
  }

  /** Held messages, newest first; or every screened one, for the observe-only period's numbers. */
  list(filter: { readonly status?: ScreenRecord["status"]; readonly limit?: number } = {}): Promise<ScreenRecord[]> {
    return this.deps.store.screens({ ...(filter.status ? { status: filter.status } : {}), ...(filter.limit ? { limit: filter.limit } : {}) });
  }

  /** What observe-only has seen: how many were screened, and how many a rule would have held. */
  async summary(days = 7): Promise<{ readonly screened: number; readonly wouldHold: number; readonly held: number; readonly bySignal: Record<string, number> }> {
    const since = new Date(this.deps.now() - days * DAY_MS).toISOString();
    const all = await this.deps.store.screens({ since, limit: 1000 });
    const bySignal: Record<string, number> = {};
    for (const one of all) for (const signal of new Set(one.signals.map((each) => each.kind))) bySignal[signal] = (bySignal[signal] ?? 0) + 1;
    return { screened: all.length, wouldHold: all.filter((one) => one.wouldHold).length, held: all.filter((one) => one.status === "held").length, bySignal };
  }

  /** A person's word on a flag raised while the screen only watched. */
  async review(principal: Principal, id: string, verdict: "good_catch" | "fine"): Promise<ScreenRecord> {
    const record = await this.screenOf(id);
    if (!record.wouldHold) throw new InboundError("The screen raised no flag on this email.", 409);
    const reviewed: ScreenRecord = { ...record, review: { verdict, by: principal.userId, at: new Date(this.deps.now()).toISOString() } };
    await this.deps.store.putScreen(reviewed);
    return reviewed;
  }

  /** Flags raised while watching that nobody has looked at yet, newest first. */
  async toReview(limit = 50): Promise<ScreenRecord[]> {
    return (await this.deps.store.screens({ status: "passed", limit: 1000 })).filter((one) => one.wouldHold && !one.review && one.channel === "email").slice(0, limit);
  }

  /**
   * Whether the screen has earned holding: what it has seen, how often people
   * said a flag was wrong, and what is still missing. Dash suggests the
   * switch; a person makes it.
   */
  async readiness(): Promise<{
    readonly observeOnly: boolean;
    readonly screened: number;
    readonly days: number;
    readonly flagged: number;
    readonly reviewed: number;
    readonly fine: number;
    readonly falseFlags: number | null;
    readonly needed: InboundSettings["holdWhen"];
    readonly blockers: readonly string[];
    readonly ready: boolean;
  }> {
    const settings = await this.deps.store.settings();
    const all = (await this.deps.store.screens({ limit: 1000 })).filter((one) => one.channel === "email");
    const first = all.at(-1)?.at;
    const days = first ? Math.floor((this.deps.now() - Date.parse(first)) / DAY_MS) : 0;
    const flagged = all.filter((one) => one.wouldHold && one.requester.trust !== "blocked");
    const reviewed = flagged.filter((one) => one.review);
    const fine = reviewed.filter((one) => one.review!.verdict === "fine").length;
    const falseFlags = reviewed.length > 0 ? fine / reviewed.length : null;
    const needed = settings.holdWhen;
    const blockers: string[] = [];
    if (all.length < needed.minScreened) blockers.push(`${all.length} of ${needed.minScreened} emails screened.`);
    if (days < needed.minDays) blockers.push(`${days} of ${needed.minDays} days watched.`);
    if (flagged.length > reviewed.length) blockers.push(`${flagged.length - reviewed.length} flagged email${flagged.length - reviewed.length === 1 ? "" : "s"} still need a look.`);
    if (falseFlags !== null && falseFlags > needed.maxFalseFlags) blockers.push(`${Math.round(falseFlags * 100)}% of flags were marked fine, more than ${Math.round(needed.maxFalseFlags * 100)}%.`);
    return { observeOnly: settings.observeOnly, screened: all.length, days, flagged: flagged.length, reviewed: reviewed.length, fine, falseFlags, needed, blockers, ready: settings.observeOnly && blockers.length === 0 };
  }

  /** Lets a held message go on, as if it had just arrived. */
  async release(principal: Principal, id: string): Promise<ScreenRecord> {
    const record = await this.held(id);
    const message = await this.deps.message?.(record.mailbox, record.message);
    if (this.deps.message && !message) throw new InboundError("That email is no longer kept in Communications, so it cannot go on from here. Open it there.", 410);
    const released: ScreenRecord = { ...record, status: "released", decidedBy: principal.userId, decidedAt: new Date(this.deps.now()).toISOString() };
    await this.deps.store.putScreen(released);
    if (message) await this.deps.proceed?.(message, released);
    return released;
  }

  /** Blocks whoever sent it (their address, or their whole domain) and drops the message. */
  async block(principal: Principal, id: string, scope: "address" | "domain" = "address"): Promise<ScreenRecord> {
    const record = await this.screenOf(id);
    await this.setRule(principal, requesterKeys(record.from)[scope], "blocked");
    if (record.status !== "held") return record;
    const dropped: ScreenRecord = { ...record, status: "dropped", decidedBy: principal.userId, decidedAt: new Date(this.deps.now()).toISOString() };
    await this.deps.store.putScreen(dropped);
    return dropped;
  }

  /** Trusts whoever sent it, and releases the message if it was held. */
  async trust(principal: Principal, id: string, scope: "address" | "domain" = "address"): Promise<ScreenRecord> {
    const record = await this.screenOf(id);
    await this.setRule(principal, requesterKeys(record.from)[scope], "trusted");
    if (record.status !== "held") return record;
    return this.release(principal, id);
  }

  async setRule(principal: Principal, key: string, trust: RequesterRule["trust"], note?: string): Promise<RequesterRule> {
    const rule: RequesterRule = { key, trust, by: principal.userId, at: new Date(this.deps.now()).toISOString(), ...(note ? { note } : {}) };
    try {
      await this.deps.store.putRule(rule);
    } catch (error) {
      throw new InboundError(error instanceof Error ? error.message : String(error), 400);
    }
    return rule;
  }

  removeRule(key: string): Promise<void> {
    return this.deps.store.deleteRule(key);
  }

  private async screenOf(id: string): Promise<ScreenRecord> {
    const record = await this.deps.store.screen(id);
    if (!record) throw new InboundError("There is no such screened email.", 404);
    return record;
  }

  private async held(id: string): Promise<ScreenRecord> {
    const record = await this.screenOf(id);
    if (record.status !== "held") throw new InboundError(`This email was already ${record.status}.`, 409);
    return record;
  }
}
