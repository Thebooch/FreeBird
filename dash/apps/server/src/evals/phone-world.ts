import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { AgentSpec, CallRecord, InboundText, Task, WorldPhone } from "@freebirdai/dash-spec";
import { CallService } from "../phone/call-service.js";
import { callId, transcriptText } from "../phone/calls.js";
import type { DeliveryUpdate } from "@freebirdai/dash-spec";
import { FAKE_PROVIDER_ID, FakeCarrier, type CallPlacer, type OpenPhoneProvider, type PhoneKeys, type RawRequest } from "@freebirdai/phone";
import { PhoneInbox, type InboxOutcome } from "../phone/inbox.js";
import { PhoneOutreach, type PhoneLine } from "../phone/outreach.js";
import { MemoryPhoneTextStore } from "../phone/texts.js";
import { MemoryPhoneUsageStore } from "../phone/usage.js";
import { receivePhoneWebhook, type PhoneEvent, type PhoneWebhookDeps } from "../phone/webhook.js";
import type { TaskStore } from "../workflows/store.js";

/**
 * A sandbox's phone lines, on the fake carrier: the same `PhoneOutreach`,
 * `PhoneInbox` and webhook code the server runs, over a carrier that leaves
 * nothing, with consent kept by number as a contact's would be.
 *
 * Texts go out through the line's adapter after the line's four checks; an
 * inbound text turn is a signed webhook from the carrier, verified and
 * parsed exactly as a real one, and STOP, HELP and START are answered by
 * Dash and start nothing; delivery updates the carrier owes come back the
 * same way after each runner pass, onto the task they were sent for.
 */

/**
 * The pretend account a sandbox's lines are on: the fake carrier by default,
 * or another provider's simulator (Telnyx's), so the same packs run through
 * that provider's own adapter, its own webhook shapes and signatures. What it
 * keeps is in `holder`'s maps and arrays, for snapshots.
 */
export interface SandboxCarrier {
  readonly provider: string;
  readonly open: OpenPhoneProvider;
  readonly keys: PhoneKeys;
  readonly sent: ReadonlyArray<{ readonly providerId: string; readonly from: string; readonly to: string; readonly body: string; readonly key: string; readonly at: string }>;
  readonly calls: ReadonlyArray<{ readonly providerId: string; readonly from: string; readonly to: string; readonly purpose: string; readonly key: string; readonly maxMinutes: number; readonly at: string }>;
  readonly placer: CallPlacer;
  readonly holder: object;
  failDelivery(to: string, errorCode?: string): void;
  inboundText(text: { readonly from: string; readonly to: string; readonly body: string }, url: string): RawRequest;
  stopReply(from: string, to: string, url: string): RawRequest;
  takeUpdates(): DeliveryUpdate[];
  statusRequest(update: DeliveryUpdate, url: string): RawRequest;
}

/** Makes a sandbox's carrier, given its clock and the world's line numbers. */
export type SandboxCarrierFactory = (deps: { readonly now: () => number; readonly numbers: readonly string[] }) => SandboxCarrier;

/** The fake carrier, as a sandbox's carrier. */
export const fakeSandboxCarrier: SandboxCarrierFactory = ({ now, numbers }) => {
  const carrier = new FakeCarrier({ now, accountName: "Sandbox carrier", numbers });
  return {
    provider: FAKE_PROVIDER_ID,
    open: carrier.open,
    keys: { secret: carrier.secret },
    sent: carrier.sent,
    calls: carrier.calls,
    placer: carrier.placer,
    holder: carrier,
    failDelivery: (to, code) => carrier.failDelivery(to, code),
    inboundText: (text, url) => carrier.inboundText(text, url),
    stopReply: (from, to, url) => carrier.stopReply(from, to, url),
    takeUpdates: () => carrier.takeUpdates(),
    statusRequest: (update, url) => carrier.statusRequest(update, url),
  };
};

/** Where the fake carrier calls: never reached, only signed over. */
const HOOK_ORIGIN = "https://sandbox.invalid";

export class SandboxPhone {
  readonly carrier: SandboxCarrier;
  readonly usage = new MemoryPhoneUsageStore();
  readonly texts = new MemoryPhoneTextStore();
  /** Consent to texts by number: what an opt-in form or a booking page left, and what STOP and START did since. */
  readonly consent = new Map<string, "given" | "withdrawn">();
  readonly lines: readonly PhoneLine[];
  readonly outreach: PhoneOutreach;
  private readonly inbox: PhoneInbox;
  /** Set by the sandbox: a text that is conversation, on to the workflows. */
  arrived: (line: PhoneLine, text: InboundText) => Promise<void> = async () => undefined;
  /** Set by the sandbox: a call that ended, on to the workflows that listen for calls. */
  callEnded: (line: PhoneLine, call: CallRecord) => Promise<void> = async () => undefined;
  /** Calls, as transcripts: the same `CallService` the voice worker drives. */
  readonly calls: CallService;
  private readonly tasks: () => TaskStore;
  private readonly now: () => number;

  constructor(
    world: WorldPhone,
    deps: { readonly now: () => number; readonly agents: { get(id: string): Promise<AgentSpec | null> }; readonly tasks: () => TaskStore; readonly llm?: () => LlmAdapter | null; readonly newId?: () => string; readonly carrier?: SandboxCarrierFactory },
  ) {
    this.tasks = deps.tasks;
    this.now = deps.now;
    this.carrier = (deps.carrier ?? fakeSandboxCarrier)({ now: deps.now, numbers: world.lines.map((line) => line.number) });
    for (const failure of world.failures) this.carrier.failDelivery(failure.to, failure.errorCode);
    for (const one of world.consent) this.consent.set(one.number, one.status);
    this.lines = world.lines.map((line) => ({
      id: line.id,
      title: `Line ${line.number}`,
      phone: { provider: this.carrier.provider, number: line.number, owner: line.owner, text: { status: line.text }, voice: { status: line.voice }, calls: line.calls, ceilings: line.ceilings },
    }));
    this.outreach = new PhoneOutreach({
      lines: () => this.lines,
      providers: { [this.carrier.provider]: this.carrier.open },
      keysFor: () => this.carrier.keys,
      usage: this.usage,
      agents: deps.agents,
      calls: this.carrier.placer,
      consent: async (number) => {
        const status = this.consent.get(number);
        return status ? { status } : null;
      },
      texts: this.texts,
      tasks: { get: (id) => deps.tasks().get(id), put: (task: Task) => deps.tasks().put(task) },
      now: deps.now,
    });
    this.inbox = new PhoneInbox({
      texts: this.texts,
      outreach: this.outreach,
      consent: {
        withdraw: async (number) => void this.consent.set(number, "withdrawn"),
        /* START restores only consent a form or a booking page gave: here, any number that had some. */
        restore: async (number) => {
          if (!this.consent.has(number)) return false;
          this.consent.set(number, "given");
          return true;
        },
      },
      brand: async () => world.brand,
      arrived: async (line, text) => {
        await this.arrived(line, text);
        return {};
      },
    });
    let n = 0;
    this.calls = new CallService({
      lines: { get: (id) => this.lines.find((one) => one.id === id) ?? null },
      agents: deps.agents,
      llm: deps.llm ?? (() => null),
      /* A tool used live on a call: what a rule check reads, as a task. Nothing reaches a real account. */
      runTool: async (_agent, tool, args) => {
        await deps.tasks().put({ id: `call-tool-${deps.newId?.() ?? ++n}`, action: "call.tool", base: "call", title: `Used ${tool.label ?? tool.kind} on a call`, status: "done", body: { kind: "decision", reason: JSON.stringify(args).slice(0, 500) }, pending: { tool: tool.id, mode: tool.mode, during: "call", args }, links: {}, createdAt: new Date(deps.now()).toISOString() } as Task);
        return "Done.";
      },
      business: async () => world.brand,
      texts: this.texts,
      tasks: { get: (id) => deps.tasks().get(id), put: (task: Task) => deps.tasks().put(task) },
      arrived: async (line, call) => this.callEnded(line, call),
      outreach: { send: (message) => this.outreach.send(message) },
      now: deps.now,
      newId: () => deps.newId?.() ?? `c${++n}`,
    });
  }

  /**
   * A call to a line, as transcript: the persona's spoken turns, each
   * answered by the line's agent. The call is kept as a `call.conversation`
   * task (its opening line in `body.sent`, the transcript in `body.reply`),
   * which the call rule checks read.
   */
  async call(lineId: string | undefined, from: string, says: readonly string[], turn: string): Promise<CallRecord> {
    const line = this.line(lineId);
    const id = callId(line.id, turn);
    const { turn: opened } = await this.calls.start({ id, line: line.id, number: from, direction: "in" });
    for (const words of says) {
      const next = await this.calls.hear(id, words);
      if (next.end || next.transfer) break;
    }
    const call = await this.calls.end(id);
    await this.tasks().put({
      id: `task-${id}`,
      action: "call.conversation",
      base: "call",
      title: `Call from ${from}`,
      status: "done",
      body: { kind: "conversation", channel: "call", to: from, agent: call.agent ?? "", sent: opened.say, reply: transcriptText(call) },
      ...(call.agent ? { agent: call.agent } : {}),
      pending: { recording: call.recording, answeredBy: call.answeredBy, waiting: call.waiting, ...(call.transfer ? { transferredTo: call.transfer.to } : {}) },
      links: { conversation: `${line.id}:${from}` },
      createdAt: new Date(this.now()).toISOString(),
    } as Task);
    return call;
  }

  /** What the carrier, the lines' records and consent hold: for the sandbox's snapshots. */
  holders(): object[] {
    return [this.carrier.holder, this.usage, this.texts, { consent: this.consent }];
  }

  line(id: string | undefined): PhoneLine {
    const line = id === undefined ? this.lines[0] : this.lines.find((one) => one.id === id);
    if (!line) throw new Error(`This world has no phone line "${id}". Known: ${this.lines.map((one) => one.id).join(", ")}.`);
    return line;
  }

  hookUrl(line: string, event: PhoneEvent): string {
    return `${HOOK_ORIGIN}/api/public/sandbox/phone/${line}/${event}`;
  }

  private deps(on: Partial<Pick<PhoneWebhookDeps, "onText" | "onStatus">>): PhoneWebhookDeps {
    return {
      line: (id) => this.lines.find((one) => one.id === id) ?? null,
      providers: { [this.carrier.provider]: this.carrier.open },
      keysFor: () => this.carrier.keys,
      onText: on.onText ?? (async () => undefined),
      onStatus: on.onStatus ?? (async () => undefined),
    };
  }

  /** Someone texts a line: the carrier's signed webhook, through the same verify, parse and inbox as the server's route. */
  async receive(lineId: string | undefined, from: string, body: string, options: { readonly stop?: boolean } = {}): Promise<{ readonly line: PhoneLine; readonly outcome: InboxOutcome }> {
    const line = this.line(lineId);
    const url = this.hookUrl(line.id, "text");
    const raw = options.stop ? this.carrier.stopReply(from, line.phone.number!, url) : this.carrier.inboundText({ from, to: line.phone.number!, body }, url);
    let outcome: InboxOutcome | undefined;
    const answer = await receivePhoneWebhook(this.deps({ onText: async (_line, inbound) => void (outcome = await this.inbox.receive(line, inbound)) }), line.id, "text", raw);
    if (answer.status !== 200 || !outcome) throw new Error(`The fake carrier's text was refused: ${"error" in answer ? answer.error : "nothing arrived"}.`);
    return { line, outcome };
  }

  /** The delivery updates the carrier owes, through the webhook, onto each send, its kept text and its task. How many were applied. */
  async deliver(): Promise<number> {
    let applied = 0;
    for (const update of this.carrier.takeUpdates()) {
      let line: PhoneLine | undefined;
      for (const one of this.lines) if (await this.usage.byProvider(one.id, update.providerId)) line = one;
      if (!line) continue;
      const onStatus: PhoneWebhookDeps["onStatus"] = async (_line, parsed) => {
        if (await this.outreach.delivered(line.id, parsed)) applied++;
      };
      const answer = await receivePhoneWebhook(this.deps({ onStatus }), line.id, "status", this.carrier.statusRequest(update, this.hookUrl(line.id, "status")));
      if (answer.status !== 200) throw new Error(`The fake carrier's status update was refused: ${"error" in answer ? answer.error : ""}.`);
    }
    return applied;
  }
}
