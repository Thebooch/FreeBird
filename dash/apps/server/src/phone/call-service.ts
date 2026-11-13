import type { AgentSpec, CallRecord, Principal, Task } from "@freebirdai/dash-spec";
import { CallSession, answeringAgent, followUpTask, transcriptText, type CallDeps, type CallTurn } from "./calls.js";
import type { OutreachSender } from "../workflows/env.js";
import type { PhoneLine } from "./outreach.js";
import type { PhoneTextStore } from "./texts.js";

/**
 * The calls on a workspace's lines: sessions the voice worker (or a
 * sandbox) drives, each kept when it ends as a conversation in
 * Communications (`kind: "call"`, its transcript the body), and handed to
 * `message_received` workflows that listen for calls, with the transcript.
 *
 * Approve-mode actions an agent promised on a call wait as tasks in
 * "Waiting for you" (`call.follow_up`). Approving one runs it and texts the
 * caller a confirmation; they called the line first, so the text may go
 * without separate consent, after the line's other checks.
 */

export interface CallServiceDeps extends Omit<CallDeps, "defer"> {
  readonly lines: { get(id: string): PhoneLine | null };
  readonly agentList?: () => Promise<AgentSpec[]>;
  readonly texts: PhoneTextStore;
  readonly tasks: { get(id: string): Promise<Task | null>; put(task: Task): Promise<void> };
  /** Finds or makes the caller's contact. */
  readonly contact?: (number: string) => Promise<{ readonly id: string } | null>;
  /** A finished call, on to the workflows that listen for calls. */
  readonly arrived?: (line: PhoneLine, call: CallRecord, contact: string | undefined) => Promise<void>;
  /** Sends the confirmation text after an approval. */
  readonly outreach?: OutreachSender;
  readonly newId: () => string;
}

export class CallError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class CallService {
  private readonly sessions = new Map<string, CallSession>();

  constructor(private readonly deps: CallServiceDeps) {}

  private callDeps(): CallDeps {
    return {
      ...this.deps,
      defer: async (request) => {
        const task = followUpTask(request, `call-task-${this.deps.newId()}`, new Date(this.deps.now()).toISOString());
        await this.deps.tasks.put(task);
        return task.id;
      },
    };
  }

  /** A call begins: who answers, and the first words. */
  async start(input: { readonly id: string; readonly line: string; readonly number: string; readonly direction: "in" | "out"; readonly purpose?: string; readonly agent?: string }): Promise<{ readonly id: string; readonly turn: CallTurn }> {
    const line = this.deps.lines.get(input.line);
    if (!line) throw new CallError(`There is no phone line "${input.line}".`, 404);
    const held = this.sessions.get(input.id);
    if (held) return { id: held.id, turn: { say: held.openingLine } };
    const answeredBy = input.direction === "out" ? "agent" : line.phone.calls.answer;
    const agent = input.agent ? await this.deps.agents.get(input.agent) : await answeringAgent(line, { get: (id) => this.deps.agents.get(id), ...(this.deps.agentList ? { list: this.deps.agentList } : {}) });
    const session = new CallSession(this.callDeps(), input.id, line, input.number, input.direction, answeredBy, answeredBy === "agent" ? agent : null, input.purpose ?? "");
    this.sessions.set(input.id, session);
    return { id: input.id, turn: await session.open() };
  }

  async hear(id: string, text: string): Promise<CallTurn> {
    const session = this.sessions.get(id);
    if (!session) throw new CallError("That call has ended.", 404);
    return session.hear(text);
  }

  /** The call ended: kept with the conversation, the caller's contact found, and workflows told. */
  async end(id: string): Promise<CallRecord> {
    const session = this.sessions.get(id);
    if (!session) throw new CallError("That call has ended.", 404);
    this.sessions.delete(id);
    const call = session.finish();
    const contact = await this.deps.contact?.(call.number).catch(() => null);
    await this.deps.texts.add({
      line: call.line,
      id: call.id,
      number: call.number,
      direction: call.direction,
      kind: "call",
      body: transcriptText(call).slice(0, 10_000),
      at: call.startedAt,
      ...(call.agent ? { agent: call.agent } : {}),
      ...(contact ? { contact: contact.id } : {}),
    });
    await this.deps.arrived?.(session.line, call, contact?.id);
    return call;
  }

  live(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * A person approved what an agent promised on a call: the tool runs now,
   * as the agent, and the caller is texted a confirmation.
   */
  async approveFollowUp(principal: Principal, task: Task): Promise<Task> {
    const pending = task.pending ?? {};
    const line = this.deps.lines.get(String(pending["line"] ?? ""));
    const agent = task.agent ? await this.deps.agents.get(task.agent) : null;
    const tool = agent?.tools.find((one) => one.id === pending["tool"]);
    const caller = String(pending["caller"] ?? "");
    const at = new Date(this.deps.now()).toISOString();
    if (!line || !agent || !tool) {
      const failed: Task = { ...task, status: "failed", error: "The line, the agent or its tool is gone.", approvedBy: principal.userId, finishedAt: at };
      await this.deps.tasks.put(failed);
      return failed;
    }
    let result: string;
    try {
      result = await this.deps.runTool(agent, tool, (pending["args"] ?? {}) as Record<string, unknown>, caller);
    } catch (error) {
      const failed: Task = { ...task, status: "failed", error: error instanceof Error ? error.message : String(error), approvedBy: principal.userId, finishedAt: at };
      await this.deps.tasks.put(failed);
      return failed;
    }
    const business = await this.deps.business();
    const text = `${business}: ${String(pending["promise"] ?? "what you asked for on the phone")} is confirmed.`.replace(/:\s+(\w)/, (_all, first: string) => `: ${first.toUpperCase()}`);
    const sent = this.deps.outreach
      ? await this.deps.outreach.send({ channel: "text", to: caller, text, agent: { id: agent.id, name: agent.name }, key: `call-confirm-${task.id}`, task: task.id, actor: principal })
      : { status: "not_sent" as const, detail: "Texts are not set up on this server." };
    const done: Task = {
      ...task,
      status: "done",
      approvedBy: principal.userId,
      finishedAt: at,
      body: { kind: "decision", outcome: "approved", reason: result.slice(0, 1000) },
      delivery: { status: sent.status, ...(sent.detail ? { detail: sent.detail } : {}), key: `call-confirm-${task.id}`, ...(sent.basis ? { basis: sent.basis } : {}) },
    };
    await this.deps.tasks.put(done);
    return done;
  }
}
