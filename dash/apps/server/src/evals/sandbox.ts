import { createHash } from "node:crypto";
import type { z } from "zod";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import { mailMessageSchema, normalizePhone, worldRefSchema, type SandboxSession, type SandboxStatus, type ScriptedReply, type Task, type Turn, type WorkflowSpec, type WorldRef } from "@freebirdai/dash-spec";
import type { WorkflowEvent } from "../workflows/env.js";
import { InboundService } from "../inbound/service.js";
import { MemoryInboundStore } from "../inbound/store.js";
import { WorkflowRunner } from "../workflows/runner.js";
import { startWorkflow } from "../workflows/start.js";
import { fake, owner, type Fake } from "../workflows/testing.js";
import { SandboxPhone } from "./phone-world.js";
import { worldSeed } from "./worlds.js";

/**
 * A sandbox session: the workflow engine as it runs in production, over
 * `fake()`'s stores, its own clock and a scripted model.
 *
 * It cannot reach the world. It is built with no real sender, no write
 * service and no connection secrets, and nothing turns them on: outside steps
 * record what they would have done. Inputs arrive only as turns, and the
 * clock and the model are the session's own, so playing the same turns
 * again gives the same tasks.
 */

type WorldRefInput = z.input<typeof worldRefSchema>;

export type SandboxEvent = { readonly kind: "step"; readonly data: WorkflowEvent } | { readonly kind: "task"; readonly data: Task };

export interface SandboxOptions {
  readonly id?: string;
  readonly world: WorldRef | WorldRefInput;
  /** Scripted mode: the model's replies, in order. Absent: no model is reachable. */
  readonly model?: readonly ScriptedReply[];
  /** Live mode: a real model in place of the scripted one. It spends; nothing else leaves the sandbox. */
  readonly llm?: LlmAdapter;
  /** Everything that happens, as it happens. */
  readonly onEvent?: (event: SandboxEvent) => void;
}

/** What a snapshot holds: every store's rows, the fake's own state, the clock and where the model is. */
interface Snapshot {
  readonly holders: ReadonlyArray<ReadonlyArray<readonly [string, unknown]>>;
  readonly scalars: { readonly now: number; readonly ids: number; readonly complete: boolean; readonly modelAt: number };
}

/** How many runner passes `runUntilWaiting` makes at most before it calls the sandbox settled. */
const MAX_PASSES = 20;

/** The session's start: the same as the workflow tests', so a scenario and a test read the same dates. */
export const SANDBOX_T0 = Date.parse("2026-10-06T12:00:00.000Z");

const shortHash = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 16);

/** A model that gives the scenario's replies in order, the last one again when they run out, and none when there are none. */
const scriptedModel = (replies: readonly ScriptedReply[], cursor: { at: number }): LlmAdapter => {
  const generate: LlmAdapter["generate"] = async (opts) => {
    const next = replies[Math.min(cursor.at++, replies.length - 1)];
    if (!next) return { text: "", toolCalls: [] };
    if ("text" in next) return { text: next.text, toolCalls: [] };
    const toolName = typeof opts.toolChoice === "object" ? opts.toolChoice.name : Object.keys(opts.tools ?? {})[0];
    return { text: "", toolCalls: [{ id: `call_${cursor.at}`, name: toolName ?? "answer", args: next.args }] };
  };
  return {
    defaultModel: "scripted",
    generate,
    stream: async function* (opts) {
      const result = await generate(opts);
      if (result.text) yield { textDelta: result.text };
      for (const call of result.toolCalls) yield { toolCall: call };
    },
  };
};

/** Own fields that hold rows: maps and arrays. Everything a memory store or the fake keeps lives in one. */
const rowsOf = (holder: object): Array<readonly [string, unknown]> =>
  Object.entries(holder)
    .filter(([, value]) => value instanceof Map || Array.isArray(value))
    .map(([key, value]) => [key, structuredClone(value)] as const);

/** Puts rows back into the same map or array, so every reference to it sees them. */
const putBack = (holder: object, rows: ReadonlyArray<readonly [string, unknown]>): void => {
  for (const [key, saved] of rows) {
    const target = (holder as Record<string, unknown>)[key];
    const copy = structuredClone(saved);
    if (target instanceof Map && copy instanceof Map) {
      target.clear();
      for (const [k, v] of copy) target.set(k, v);
    } else if (Array.isArray(target) && Array.isArray(copy)) {
      target.length = 0;
      target.push(...copy);
    }
  }
};

export class Sandbox {
  private status: SandboxStatus = "running";
  private readonly snapshots = new Map<string, Snapshot>();

  private constructor(
    readonly id: string,
    readonly world: WorldRef,
    private readonly f: Fake,
    private readonly runner: WorkflowRunner,
    /** The scripted model's place: the model reads it, so a restore moves it too. */
    private readonly modelAt: { at: number },
    /** The inbound screen, over its own store: the same rules the server applies. */
    private readonly inbound: InboundService,
    private readonly inboundStore: MemoryInboundStore,
    private readonly onEvent: SandboxOptions["onEvent"],
    /** The world's phone lines on the fake carrier, when it has any. */
    private readonly phone: SandboxPhone | null,
  ) {}

  /** Emails the screen held, in order. */
  private readonly held: Array<{ turn: string; from: string; signals: string[] }> = [];

  /** Boots the world: its records, agents and workflows, then one runner pass so watched triggers take their baseline. */
  static async start(options: SandboxOptions): Promise<Sandbox> {
    const world = worldRefSchema.parse(options.world);
    const seed = worldSeed(world.provider, world.seed);
    const modelAt = { at: 0 };
    const model = options.llm ?? (options.model ? scriptedModel(options.model, modelAt) : undefined);
    /* Phone lines on the fake carrier: texts and calls go out through the same code as the server's. Bound to the fake below. */
    let bound: Fake | undefined;
    const phone = world.workspace.phone ? new SandboxPhone(world.workspace.phone, { now: () => bound?.clock.now ?? SANDBOX_T0, agents: { get: async (id) => bound?.agents.get(id) ?? null }, tasks: () => bound!.env.tasks, llm: () => model ?? null, newId: () => bound!.env.newId() }) : null;
    const f = fake({
      sender: true,
      now: SANDBOX_T0,
      ...(phone ? { phone: (message) => phone.outreach.send(message) } : {}),
      ...(model ? { llm: model } : {}),
      ...(options.onEvent ? { onEvent: (data: WorkflowEvent) => options.onEvent!({ kind: "step", data }) } : {}),
    });
    bound = f;
    /* Every task as it is written: the run's log is built from these. */
    const put = f.env.tasks.put.bind(f.env.tasks);
    f.env.tasks.put = async (task) => {
      await put(task);
      options.onEvent?.({ kind: "task", data: structuredClone(task) });
    };
    f.rows.push(...seed.records.map((row) => ({ ...row })), ...world.workspace.records.map((row) => ({ ...row })));
    for (const agent of [...seed.agents, ...world.workspace.agents]) f.agents.set(agent.id, agent);
    for (const workflow of world.workspace.workflows) await f.env.store.put(workflow);
    const runner = new WorkflowRunner({ ...f.starter });
    const inboundStore = new MemoryInboundStore();
    const screening = world.workspace.inbound;
    await inboundStore.putSettings(screening.settings);
    for (const rule of screening.rules) await inboundStore.putRule(rule);
    const inbound = new InboundService({ store: inboundStore, now: () => f.clock.now, newId: () => f.env.newId(), members: async () => screening.members.map((email) => ({ email })) });
    const sandbox = new Sandbox(options.id ?? `sandbox-${f.env.newId()}`, world, f, runner, modelAt, inbound, inboundStore, options.onEvent, phone);
    await runner.tick();
    return sandbox;
  }

  info(): SandboxSession {
    return { id: this.id, world: this.world, clock: this.f.clock.now, status: this.status };
  }

  get now(): number {
    return this.f.clock.now;
  }

  /** What the sandbox's outside steps would have done: messages sent and changes prepared and committed. Nothing left. */
  get intents() {
    return {
      sent: [...this.f.sent],
      prepared: [...this.f.prepared],
      committed: [...this.f.committed],
      posts: [...this.f.posts],
      held: [...this.held],
      ...(this.phone ? { phone: { texts: [...this.phone.carrier.sent], calls: [...this.phone.carrier.calls], consent: Object.fromEntries(this.phone.consent) } } : {}),
    };
  }

  /** Every task, oldest first. */
  async tasks(): Promise<Task[]> {
    return (await this.f.env.tasks.list({ limit: 1000 })).reverse();
  }

  /** One turn, then the engine runs until everything waits. */
  async step(turn: Turn): Promise<SandboxSession> {
    if (this.status === "ended") throw new Error("This sandbox has ended.");
    this.status = "running";
    const { engine } = this.f;
    const payload = turn.payload;
    switch (turn.kind) {
      case "message": {
        if (payload["channel"] === "text") {
          await this.textArrives(turn);
          break;
        }
        if (payload["channel"] === "call") {
          await this.callArrives(turn);
          break;
        }
        const mailbox = typeof payload["mailbox"] === "string" ? payload["mailbox"] : "inbox";
        const from = typeof payload["from"] === "string" ? { address: payload["from"], name: typeof payload["name"] === "string" ? payload["name"] : "" } : payload["from"];
        /* Screened first, as the server screens every email (`inbound/`): a held one starts nothing. */
        const address = String((from as { address?: unknown } | undefined)?.address ?? "");
        const screen = await this.inbound.screen(
          mailMessageSchema.parse({ id: turn.id, threadId: turn.id, mailbox, from: { address, name: (from as { name?: string } | undefined)?.name ?? "" }, subject: String(payload["subject"] ?? ""), snippet: String(payload["text"] ?? "").slice(0, 1000), at: new Date(this.f.clock.now).toISOString(), hasAttachments: payload["attachments"] === true }),
          String(payload["text"] ?? ""),
          { knownContact: payload["known"] === true },
        );
        if (screen.status === "held") {
          this.held.push({ turn: turn.id, from: address, signals: screen.signals.map((one) => one.detail) });
          this.onEvent?.({ kind: "step", data: { type: "inbound.held", workflow: "", reason: `Held for a person: ${screen.signals.map((one) => one.detail).join("; ") || "the sender is blocked"}.` } as unknown as WorkflowEvent });
          break;
        }
        const row: Record<string, unknown> = {
          mailbox,
          id: turn.id,
          threadId: turn.id,
          from,
          subject: payload["subject"] ?? "",
          snippet: payload["text"] ?? "",
          text: payload["text"] ?? "",
          channel: "email",
          ...(payload["contact"] ? { contact: payload["contact"] } : {}),
          inbound: { screen: screen.id, requester: screen.requester.key, trust: screen.requester.trust, signals: screen.signals.map((one) => one.kind) },
        };
        for (const workflow of await this.listening("message_received")) {
          if (workflow.trigger.kind !== "message_received" || (workflow.trigger.mailboxes.length > 0 && !workflow.trigger.mailboxes.includes(mailbox))) continue;
          const id = `mr-${shortHash(`${workflow.id}:${mailbox}:${turn.id}`)}`;
          await engine.create(workflow, { id, row, rowKey: `${mailbox}:${turn.id}`, start: { kind: "message", message: `${mailbox}:${turn.id}` } });
          await engine.advance(id);
        }
        break;
      }
      case "booking": {
        const event = String(payload["event"] ?? "");
        const type = typeof payload["type"] === "string" ? payload["type"] : "";
        const row = (payload["row"] as Record<string, unknown> | undefined) ?? {};
        for (const workflow of await this.listening("booking")) {
          if (workflow.trigger.kind !== "booking") continue;
          if (!(workflow.trigger.events as readonly string[]).includes(event) || (workflow.trigger.types.length > 0 && !workflow.trigger.types.includes(type))) continue;
          const id = `bk-${shortHash(`${workflow.id}:${turn.id}`)}`;
          await engine.create(workflow, { id, row, rowKey: String(row["id"] ?? turn.id), start: { kind: "booking", bookingEvent: turn.id } });
          await engine.advance(id);
        }
        break;
      }
      case "record": {
        const add = Array.isArray(payload["add"]) ? (payload["add"] as Record<string, unknown>[]) : [];
        this.f.rows.push(...add.map((row) => ({ ...row })));
        const update = Array.isArray(payload["update"]) ? (payload["update"] as Array<{ id: unknown; values: Record<string, unknown> }>) : [];
        for (const one of update) {
          const row = this.f.rows.find((candidate) => String(candidate["id"]) === String(one.id));
          if (row) Object.assign(row, one.values);
        }
        break;
      }
      case "start": {
        const inputs = (payload["inputs"] as Record<string, unknown> | undefined) ?? {};
        const named = typeof payload["workflow"] === "string" ? payload["workflow"] : undefined;
        const started = [...(await this.listening("manual")), ...(await this.listening("agent"))].filter((one) => named === undefined || one.id === named);
        for (const workflow of started) {
          const agentId = workflow.trigger.kind === "agent" ? (typeof payload["agent"] === "string" ? payload["agent"] : [...this.f.agents.keys()][0]) : undefined;
          await startWorkflow(this.f.starter, workflow, agentId ? { kind: "agent", agentId } : { kind: "manual" }, { inputs, actor: owner });
        }
        break;
      }
      case "clock": {
        const ms = Number(payload["ms"] ?? 0);
        if (!Number.isFinite(ms) || ms < 0) throw new Error(`A clock turn moves time forward: "${String(payload["ms"])}" is not a number of milliseconds.`);
        this.f.clock.now += ms;
        break;
      }
    }
    return this.runUntilWaiting();
  }

  /**
   * A text to one of the world's lines: the fake carrier's signed webhook,
   * verified and parsed like a real one, then as `message_received`
   * workflows listening for texts on that line see it. Nobody who texts is
   * trusted, so its values carry the inbound mark.
   */
  private async textArrives(turn: Turn): Promise<void> {
    const phone = this.phone;
    if (!phone) throw new Error('A text turn needs phone lines: give the world "workspace.phone".');
    const payload = turn.payload;
    const from = normalizePhone(payload["from"]);
    if (!from) throw new Error(`A text turn comes from a phone number: "${String(payload["from"])}" is not one.`);
    const name = typeof payload["name"] === "string" ? payload["name"] : "";
    /* Conversation (not STOP, HELP or START): screened like an email, then as `message_received` workflows listening for texts see it. */
    phone.arrived = async (line, text) => {
      const screen = await this.inbound.screen(
        mailMessageSchema.parse({ id: text.providerId, threadId: `${line.id}:${from}`, mailbox: line.id, from: { address: from, name }, subject: "", snippet: text.body.slice(0, 1000), at: text.at }),
        text.body,
        { knownContact: payload["known"] === true, channel: "text" },
      );
      if (screen.status === "held") {
        this.held.push({ turn: turn.id, from, signals: screen.signals.map((one) => one.detail) });
        return;
      }
      const row: Record<string, unknown> = {
        mailbox: line.id,
        line: line.id,
        id: text.providerId,
        threadId: `${line.id}:${from}`,
        from: { address: from, name },
        to: text.to,
        subject: "",
        snippet: text.body.slice(0, 1000),
        text: text.body,
        channel: "text",
        ...(payload["contact"] ? { contact: payload["contact"] } : {}),
        inbound: { screen: screen.id, requester: screen.requester.key, trust: screen.requester.trust, signals: screen.signals.map((one) => one.kind) },
      };
      for (const workflow of await this.listening("message_received")) {
        if (workflow.trigger.kind !== "message_received" || !workflow.trigger.channels.includes("text")) continue;
        if (workflow.trigger.mailboxes.length > 0 && !workflow.trigger.mailboxes.includes(line.id)) continue;
        const id = `mr-${shortHash(`${workflow.id}:${line.id}:${text.providerId}`)}`;
        await this.f.engine.create(workflow, { id, row, rowKey: `${line.id}:${text.providerId}`, start: { kind: "message", message: `${line.id}:${text.providerId}` } });
        await this.f.engine.advance(id);
      }
    };
    await phone.receive(typeof payload["line"] === "string" ? payload["line"] : undefined, from, String(payload["text"] ?? ""), { stop: payload["stop"] === true });
  }

  /**
   * A call to one of the world's lines, as words: `{ channel: "call", from,
   * says: [...], line? }`. Calls in sandboxes are transcripts, not audio. A
   * call that ends starts the `message_received` workflows listening for
   * calls, with the transcript and the inbound mark.
   */
  private async callArrives(turn: Turn): Promise<void> {
    const phone = this.phone;
    if (!phone) throw new Error('A call turn needs phone lines: give the world "workspace.phone".');
    const payload = turn.payload;
    const from = normalizePhone(payload["from"]);
    if (!from) throw new Error(`A call turn comes from a phone number: "${String(payload["from"])}" is not one.`);
    const says = Array.isArray(payload["says"]) ? payload["says"].map(String) : [];
    phone.callEnded = async (line, call) => {
      const row: Record<string, unknown> = {
        mailbox: line.id,
        line: line.id,
        id: call.id,
        threadId: `${line.id}:${from}`,
        from: { address: from, name: "" },
        subject: call.summary ?? "",
        snippet: (call.summary ?? "").slice(0, 1000),
        text: call.transcript.map((one) => `${one.who}: ${one.text}`).join("\n"),
        channel: "call",
        inbound: { requester: `address:${from}`, trust: "unknown", signals: [] },
      };
      for (const workflow of await this.listening("message_received")) {
        if (workflow.trigger.kind !== "message_received" || !workflow.trigger.channels.includes("call")) continue;
        if (workflow.trigger.mailboxes.length > 0 && !workflow.trigger.mailboxes.includes(line.id)) continue;
        const id = `mr-${shortHash(`${workflow.id}:${line.id}:${call.id}`)}`;
        await this.f.engine.create(workflow, { id, row, rowKey: `${line.id}:${call.id}`, start: { kind: "message", message: `${line.id}:${call.id}` } });
        await this.f.engine.advance(id);
      }
    };
    await phone.call(typeof payload["line"] === "string" ? payload["line"] : undefined, from, says, turn.id);
  }

  /** Runner passes until nothing more happens: due triggers, time-outs, signals, watched records, and the carrier's delivery updates. */
  async runUntilWaiting(): Promise<SandboxSession> {
    let before = await this.fingerprint();
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      await this.runner.tick();
      await this.phone?.deliver();
      const after = await this.fingerprint();
      if (after === before) break;
      before = after;
    }
    this.status = (await this.waiting()) ? "waiting" : "running";
    return this.info();
  }

  /** Saves every store, the clock and the model's place, between turns. */
  snapshot(): string {
    const id = `snap-${this.snapshots.size + 1}`;
    this.snapshots.set(id, {
      holders: this.holders().map(rowsOf),
      scalars: { now: this.f.clock.now, ids: this.f.ids, complete: this.f.complete, modelAt: this.modelAt.at },
    });
    return id;
  }

  /** Puts the sandbox back as a snapshot found it. It is paused until the next turn. */
  restore(snapshotId: string): SandboxSession {
    const saved = this.snapshots.get(snapshotId);
    if (!saved) throw new Error(`This sandbox has no snapshot "${snapshotId}".`);
    if (this.status === "ended") throw new Error("This sandbox has ended.");
    this.holders().forEach((holder, index) => putBack(holder, saved.holders[index] ?? []));
    this.f.clock.now = saved.scalars.now;
    this.f.ids = saved.scalars.ids;
    this.f.complete = saved.scalars.complete;
    this.modelAt.at = saved.scalars.modelAt;
    this.status = "paused";
    return this.info();
  }

  stop(): SandboxSession {
    this.status = "ended";
    return this.info();
  }

  /** Everything that keeps rows: the stores, the runner's own times, and the fake's records and intents. */
  private holders(): object[] {
    const { env } = this.f;
    return [env.store, env.cases, env.tasks, env.calendar, env.templates, env.signals, this.runner, this.f, this.inboundStore, { held: this.held }, ...(this.phone?.holders() ?? [])];
  }

  private async listening(kind: WorkflowSpec["trigger"]["kind"]): Promise<WorkflowSpec[]> {
    return (await this.f.env.store.list()).filter((one) => one.trigger.kind === kind && one.enabled && !one.parked);
  }

  private async waiting(): Promise<boolean> {
    const { env } = this.f;
    return (await env.cases.list({ status: "waiting", limit: 1 })).length > 0 || (await env.tasks.list({ status: "waiting_approval", limit: 1 })).length > 0;
  }

  /** What changed between passes: every task's and case's state, and the clock. */
  private async fingerprint(): Promise<string> {
    const { env } = this.f;
    const tasks = (await env.tasks.list({ limit: 1000 })).map((one) => `${one.id}:${one.status}`);
    const cases = (await env.cases.list({ limit: 1000 })).map((one) => `${one.id}:${one.revision}`);
    return [...tasks, ...cases, String(this.f.sent.length), String(this.f.committed.length)].join("|");
  }
}
