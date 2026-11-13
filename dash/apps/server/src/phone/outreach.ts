import { normalizePhone, reachCovers, type AgentSpec, type DeliveryUpdate, type PhoneLineSpec, type Task, type TextBasis } from "@freebirdai/dash-spec";
import { RepeatSendError, type CallPlacer, type PhoneKeys, type PhoneProviders } from "@freebirdai/phone";
import type { OutreachSender } from "../workflows/env.js";
import type { PhoneTextStore } from "./texts.js";
import { utcDay, type PhoneSendRecord, type PhoneUsageStore } from "./usage.js";

/**
 * Texts and calls from a workspace's phone lines: `OutreachSender`'s `text`
 * and `call`, routed to the line's adapter. Email is not here and does not
 * change.
 *
 * Which line: the agent's own, else a team line its reach may act on
 * (`records.act` on the line's connection), as for mailboxes. Before a text
 * reaches a provider, in this order:
 *
 * 1. the line's registration is approved;
 * 2. the contact has not opted out (STOP, on any line);
 * 3. the contact has consent on record, or texted this line first in this
 *    conversation: someone who reaches out cold may be answered, but an agent
 *    or workflow starting a conversation needs consent on record;
 * 4. the line is under its daily ceiling (and the key was never sent: at
 *    most once).
 *
 * Each refusal is `not_sent` with a plain reason, which the task shows. A
 * text that goes says why it was allowed (`basis`), and is kept in the
 * line's conversation.
 */

export type OutreachMessage = Parameters<OutreachSender["send"]>[0];
export type OutreachResult = Awaited<ReturnType<OutreachSender["send"]>>;

/** A line as outreach needs it: a connection with `phone`. */
export interface PhoneLine {
  readonly id: string;
  readonly title: string;
  readonly phone: PhoneLineSpec;
}

/** The default when a workspace has no phone line at all. */
export const NO_LINES = "Texts and calls are not connected yet, so nothing was sent.";

export interface PhoneOutreachDeps {
  readonly lines: () => readonly PhoneLine[];
  readonly providers: PhoneProviders;
  /** The line's keys, read from the vault for this one use. */
  readonly keysFor: (line: PhoneLine) => PhoneKeys;
  readonly usage: PhoneUsageStore;
  readonly agents: { get(id: string): Promise<AgentSpec | null> };
  /** Places calls: the voice worker. Absent: calls are not placed. */
  readonly calls?: CallPlacer;
  /** Consent to texts on record for a number (the contact's `textConsent`), or null when there is none. */
  readonly consent: (number: string) => Promise<{ readonly status: "given" | "withdrawn" } | null>;
  /** The lines' conversations: who wrote first, and where a sent text is kept. */
  readonly texts: PhoneTextStore;
  /** Where a provider's delivery update is written onto the task a text was sent for. Absent: tasks are left as they were. */
  readonly tasks?: { get(id: string): Promise<Task | null>; put(task: Task): Promise<void> };
  readonly now: () => number;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class PhoneOutreach {
  constructor(private readonly deps: PhoneOutreachDeps) {}

  /** Whether the workspace has any line at all. */
  hasLines(): boolean {
    return this.deps.lines().length > 0;
  }

  /** The line an agent texts and calls from, or why it has none. */
  async lineFor(agentId: string): Promise<{ readonly line: PhoneLine } | { readonly refused: string }> {
    const agent = await this.deps.agents.get(agentId);
    if (!agent || agent.archived) return { refused: "The agent this comes from no longer exists, so nothing was sent." };
    const lines = this.deps.lines().filter((one) => one.phone.number);
    const own = lines.filter((one) => one.phone.owner.kind === "agent" && one.phone.owner.id === agent.id);
    const team = lines.filter((one) => one.phone.owner.kind === "team");
    const allowed = team.filter((one) => reachCovers(agent.reach, "records.act", { connection: one.id }));
    const byTitle = (a: PhoneLine, b: PhoneLine) => a.title.localeCompare(b.title);
    const line = own.sort(byTitle)[0] ?? allowed.sort(byTitle)[0];
    if (line) return { line };
    if (team.length > 0) return { refused: `${agent.name} texts and calls from its own line. Let it use ${team[0]!.phone.number} on its page first. Nothing was sent.` };
    return { refused: `${agent.name} has no phone line to use, so nothing was sent.` };
  }

  async send(m: OutreachMessage): Promise<OutreachResult> {
    if (m.channel === "email") throw new Error("Email is sent through Comms, not a phone line.");
    if (!this.hasLines()) return { status: "not_sent", detail: NO_LINES };
    const to = normalizePhone(m.to);
    if (!to) return { status: "not_sent", detail: `"${m.to}" is not a phone number, so nothing was sent.` };
    const chosen = await this.lineFor(m.agent.id);
    if ("refused" in chosen) return { status: "not_sent", detail: chosen.refused };
    const { line } = chosen;
    const open = this.deps.providers[line.phone.provider];
    if (!open) return { status: "not_sent", detail: `This line's provider (${line.phone.provider}) is not set up on this server, so nothing was sent.` };
    return m.channel === "text" ? this.text(line, open, to, m) : this.call(line, open, to, m);
  }

  /** Why a text to this number may go from this line now, or why not: checks 2 and 3 of the four. */
  async mayText(line: PhoneLine, to: string): Promise<{ readonly basis: TextBasis } | { readonly refused: string }> {
    const consent = await this.deps.consent(to);
    if (consent?.status === "withdrawn") return { refused: "They replied STOP, so they get no more texts. Nothing was sent." };
    if (consent?.status === "given") return { basis: "on_record" };
    const thread = await this.deps.texts.threadOf(line.id, to);
    if (thread?.startedBy === "them") return { basis: "texted_first" };
    return { refused: "They have not agreed to texts: there is no consent on record, and they have not texted this line. Nothing was sent." };
  }

  private async text(line: PhoneLine, open: PhoneProviders[string], to: string, m: OutreachMessage): Promise<OutreachResult> {
    /* 1. Registration. */
    if (line.phone.text.status === "none") return { status: "not_sent", detail: "This line carries calls only: its provider has no texts. Nothing was sent." };
    if (line.phone.text.status !== "approved") return { status: "not_sent", detail: "Texting starts when this line's registration is approved. Nothing was sent." };
    /* 2 and 3. Not opted out; consent on record, or they texted first. */
    const may = await this.mayText(line, to);
    if ("refused" in may) return { status: "not_sent", detail: may.refused };
    const keys = this.deps.keysFor(line);
    const adapter = open(keys).text;
    if (!adapter) return { status: "not_sent", detail: "This line's provider does not send texts, so nothing was sent." };
    const conversation = `${line.id}:${to}`;
    /* 4. The daily ceiling, claimed with the key so it is sent at most once. */
    const ceiling = line.phone.ceilings.textsPerDay;
    const claim = await this.deps.usage.claim({ line: line.id, key: m.key, kind: "text", day: utcDay(this.deps.now()), to, at: new Date(this.deps.now()).toISOString(), ...(m.task ? { task: m.task } : {}) }, ceiling);
    if (!claim.claimed) {
      if ("existing" in claim) return earlier(claim.existing, conversation);
      return { status: "not_sent", detail: `This line has sent its ${ceiling} texts for today, its daily limit, so nothing was sent.` };
    }
    try {
      const sent = await adapter.send({ from: line.phone.number!, to, body: m.text, key: m.key });
      await this.deps.usage.settle(line.id, m.key, { providerId: sent.providerId, status: sent.status });
      await this.deps.texts.add({ line: line.id, id: sent.providerId, number: to, direction: "out", body: m.text, at: new Date(this.deps.now()).toISOString(), status: sent.status, agent: m.agent.id });
      return { status: sent.status, conversation, basis: may.basis };
    } catch (error) {
      if (error instanceof RepeatSendError) {
        await this.deps.usage.settle(line.id, m.key, { providerId: error.providerId, status: "queued" });
        return { status: "queued", detail: "The provider already had this message; it was not sent twice.", conversation };
      }
      /* It may or may not have reached the provider: the key stays claimed, so it is never sent twice. */
      await this.deps.usage.settle(line.id, m.key, { status: "failed", detail: message(error) });
      return { status: "failed", detail: `The provider did not take the text: ${message(error)}` };
    }
  }

  private async call(line: PhoneLine, open: PhoneProviders[string], to: string, m: OutreachMessage): Promise<OutreachResult> {
    if (line.phone.voice.status !== "ready") return { status: "not_sent", detail: "Calls start when this line's calls are connected. Nobody was called." };
    if (open({}).capabilities.voice === "none") return { status: "not_sent", detail: "This line's provider does not carry calls, so nobody was called." };
    const placer = this.deps.calls;
    if (!placer) return { status: "not_sent", detail: "Calls are placed by the voice worker, which is not set up on this server yet. Nobody was called." };
    const day = utcDay(this.deps.now());
    const ceiling = line.phone.ceilings.callMinutesPerDay;
    const used = await this.deps.usage.used(line.id, day, "call");
    const claim = await this.deps.usage.claim({ line: line.id, key: m.key, kind: "call", day, to, at: new Date(this.deps.now()).toISOString() }, ceiling);
    const conversation = `${line.id}:${to}`;
    if (!claim.claimed) {
      if ("existing" in claim) return earlier(claim.existing, conversation);
      return { status: "not_sent", detail: `This line has used its ${ceiling} call minutes for today, its daily limit, so nobody was called.` };
    }
    try {
      const placed = await placer.place({ from: line.phone.number!, to, purpose: m.text, key: m.key, maxMinutes: Math.max(1, ceiling - used) });
      await this.deps.usage.settle(line.id, m.key, { providerId: placed.providerId, status: placed.status });
      return { status: placed.status, conversation };
    } catch (error) {
      await this.deps.usage.settle(line.id, m.key, { status: "failed", detail: message(error) });
      return { status: "failed", detail: `The call could not be placed: ${message(error)}` };
    }
  }

  /**
   * Dash's own answer to STOP, HELP or START: past the consent checks (it is
   * what they asked for), at most once per key, and counted on the line.
   */
  async keywordReply(line: PhoneLine, to: string, body: string, keyword: "stop" | "help" | "start", key: string): Promise<OutreachResult> {
    const open = this.deps.providers[line.phone.provider];
    const adapter = open?.(this.deps.keysFor(line)).text;
    if (!adapter || !line.phone.number) return { status: "not_sent", detail: "This line cannot send texts." };
    const claim = await this.deps.usage.claim({ line: line.id, key, kind: "text", day: utcDay(this.deps.now()), to, at: new Date(this.deps.now()).toISOString() }, Number.MAX_SAFE_INTEGER);
    if (!claim.claimed) return "existing" in claim ? earlier(claim.existing, `${line.id}:${to}`) : { status: "not_sent" };
    try {
      const sent = await adapter.send({ from: line.phone.number, to, body, key });
      await this.deps.usage.settle(line.id, key, { providerId: sent.providerId, status: sent.status });
      await this.deps.texts.add({ line: line.id, id: sent.providerId, number: to, direction: "out", body, at: new Date(this.deps.now()).toISOString(), status: sent.status, keyword });
      return { status: sent.status, basis: "keyword_reply" };
    } catch (error) {
      if (error instanceof RepeatSendError) return { status: "queued", basis: "keyword_reply" };
      await this.deps.usage.settle(line.id, key, { status: "failed", detail: message(error) });
      return { status: "failed", detail: message(error) };
    }
  }

  /**
   * A provider's delivery update (or a call's end), onto the send it is
   * about, the kept text, and the task it was sent for. Null when no send of
   * this line has that id.
   */
  async delivered(lineId: string, update: DeliveryUpdate): Promise<PhoneSendRecord | null> {
    const record = await this.deps.usage.byProvider(lineId, update.providerId);
    if (!record) return null;
    const settled = await this.deps.usage.settle(lineId, record.key, { status: update.status, ...(update.errorCode ? { errorCode: update.errorCode } : {}), ...(update.minutes !== undefined ? { minutes: update.minutes } : {}) });
    if (record.kind === "text") await this.deps.texts.update(lineId, update.providerId, { status: update.status });
    const task = record.task && this.deps.tasks ? await this.deps.tasks.get(record.task) : null;
    if (task?.delivery && this.deps.tasks) {
      await this.deps.tasks.put({ ...task, delivery: { ...task.delivery, status: update.status, ...(update.errorCode ? { detail: `The carrier could not deliver it (error ${update.errorCode}).` } : {}) } });
    }
    return settled;
  }
}

/** A key already sent: what became of it, never a second send. */
const earlier = (record: PhoneSendRecord, conversation: string): OutreachResult =>
  record.providerId
    ? { status: record.status === "not_sent" ? "queued" : record.status, detail: "Already sent once with this key; not sent again.", conversation }
    : { status: "failed", detail: `An earlier try did not finish${record.detail ? ` (${record.detail})` : ""}; it is not sent again.` };

/**
 * The server's `OutreachSender`: text and call through the lines, email
 * through `email`. With no line at all, texts and calls stay "not connected
 * yet", as before.
 */
export const routedOutreach = (phone: PhoneOutreach | null, email: OutreachSender["send"]): OutreachSender => ({
  send: async (m) => {
    if (m.channel === "email") return email(m);
    if (!phone) return { status: "not_sent", detail: NO_LINES };
    return phone.send(m);
  },
});
