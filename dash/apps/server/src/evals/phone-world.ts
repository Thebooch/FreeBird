import type { AgentSpec, InboundText, Task, WorldPhone } from "@freebirdai/dash-spec";
import { FAKE_PROVIDER_ID, FakeCarrier } from "@freebirdai/phone";
import { PhoneOutreach, type PhoneLine } from "../phone/outreach.js";
import { MemoryPhoneUsageStore } from "../phone/usage.js";
import { receivePhoneWebhook, type PhoneEvent, type PhoneWebhookDeps } from "../phone/webhook.js";
import type { TaskStore } from "../workflows/store.js";

/**
 * A sandbox's phone lines, on the fake carrier: the same `PhoneOutreach`
 * and webhook code the server runs, over a carrier that leaves nothing.
 *
 * Texts go out through the line's adapter after the line's checks and
 * ceilings; an inbound text turn is a signed webhook from the carrier,
 * verified and parsed exactly as a real one; delivery updates the carrier
 * owes come back the same way after each runner pass, onto the send's
 * record and its task's delivery.
 */

/** Where the fake carrier calls: never reached, only signed over. */
const HOOK_ORIGIN = "https://sandbox.invalid";

export class SandboxPhone {
  readonly carrier: FakeCarrier;
  readonly usage = new MemoryPhoneUsageStore();
  readonly lines: readonly PhoneLine[];
  readonly outreach: PhoneOutreach;

  constructor(world: WorldPhone, deps: { readonly now: () => number; readonly agents: { get(id: string): Promise<AgentSpec | null> } }) {
    this.carrier = new FakeCarrier({ now: deps.now, accountName: "Sandbox carrier" });
    for (const failure of world.failures) this.carrier.failDelivery(failure.to, failure.errorCode);
    this.lines = world.lines.map((line) => ({
      id: line.id,
      title: `Line ${line.number}`,
      phone: { provider: FAKE_PROVIDER_ID, number: line.number, owner: line.owner, text: { status: line.text }, voice: { status: line.voice }, ceilings: line.ceilings },
    }));
    this.outreach = new PhoneOutreach({
      lines: () => this.lines,
      providers: { [FAKE_PROVIDER_ID]: this.carrier.open },
      keysFor: () => ({ secret: this.carrier.secret }),
      usage: this.usage,
      agents: deps.agents,
      calls: this.carrier.placer,
      now: deps.now,
    });
  }

  /** What the carrier and the line's records hold: for the sandbox's snapshots. */
  holders(): object[] {
    return [this.carrier, this.usage];
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
      providers: { [FAKE_PROVIDER_ID]: this.carrier.open },
      keysFor: () => ({ secret: this.carrier.secret }),
      onText: on.onText ?? (async () => undefined),
      onStatus: on.onStatus ?? (async () => undefined),
    };
  }

  /** Someone texts a line: the carrier's signed webhook, through the same verify and parse as the server's route. */
  async receive(lineId: string | undefined, from: string, body: string, options: { readonly stop?: boolean } = {}): Promise<{ readonly line: PhoneLine; readonly text: InboundText }> {
    const line = this.line(lineId);
    const url = this.hookUrl(line.id, "text");
    const raw = options.stop ? this.carrier.stopReply(from, line.phone.number!, url) : this.carrier.inboundText({ from, to: line.phone.number!, body }, url);
    let text: InboundText | undefined;
    const answer = await receivePhoneWebhook(this.deps({ onText: async (_line, inbound) => void (text = inbound) }), line.id, "text", raw);
    if (answer.status !== 200 || !text) throw new Error(`The fake carrier's text was refused: ${"error" in answer ? answer.error : "nothing arrived"}.`);
    return { line, text };
  }

  /** The delivery updates the carrier owes, through the webhook, onto each send and its task. How many were applied. */
  async deliver(tasks: TaskStore): Promise<number> {
    let applied = 0;
    for (const update of this.carrier.takeUpdates()) {
      let line: PhoneLine | undefined;
      for (const one of this.lines) if (await this.usage.byProvider(one.id, update.providerId)) line = one;
      if (!line) continue;
      const onStatus: PhoneWebhookDeps["onStatus"] = async (_line, parsed) => {
        const record = await this.outreach.delivered(line.id, parsed);
        if (!record) return;
        applied++;
        const task = (await tasks.list({ limit: 1000 })).find((one: Task) => one.delivery?.key === record.key);
        if (task?.delivery) await tasks.put({ ...task, delivery: { ...task.delivery, status: parsed.status, ...(parsed.errorCode ? { detail: `The carrier could not deliver it (error ${parsed.errorCode}).` } : {}) } });
      };
      const answer = await receivePhoneWebhook(this.deps({ onStatus }), line.id, "status", this.carrier.statusRequest(update, this.hookUrl(line.id, "status")));
      if (answer.status !== 200) throw new Error(`The fake carrier's status update was refused: ${"error" in answer ? answer.error : ""}.`);
    }
    return applied;
  }
}
