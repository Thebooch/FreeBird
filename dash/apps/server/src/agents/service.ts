import {
  AGENT_TOOL_INFO,
  agentInputSchema,
  agentSchema,
  dedupeReach,
  reachCovers,
  sharedAgentKnowledgeSchema,
  type AgentInput,
  type AgentKnowledge,
  type AgentReach,
  type AgentSpec,
  type AgentTool,
  type Principal,
  type ReachProblem,
  type SharedAgentKnowledge,
} from "@freebirdai/dash-spec";
import type { Policy } from "../identity/policy.js";
import type { AgentStore } from "./store.js";

/**
 * Making, changing and retiring agents, in one place for the routes and the
 * assistant's actions to share — two paths would eventually disagree about
 * what an agent may be given.
 *
 * The rules that matter:
 * - **Nobody grants more than they hold.** A person never writes into an
 *   agent a reach they lack themselves, so an agent is never a way around
 *   one's own permissions. What it changes is still limited to the person who
 *   approves the change, so it never exceeds a human either.
 * - **A tool is only as wide as the reach.** A record tool that may act (auto
 *   or approve) needs the reach to cover its permission where it applies; one
 *   set to deny needs nothing, because it never acts.
 * - **Context is read within reach.** A context rule may only read an endpoint
 *   on a connection the agent may read.
 */

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problems: readonly ReachProblem[] = [],
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface AgentServiceDeps {
  readonly store: AgentStore;
  readonly policy: Policy;
  /** Whether a connection exists in this workspace. */
  readonly hasConnection: (id: string) => boolean;
  /** Whether a connection has a read endpoint with this id. Absent: any id on a known connection. */
  readonly hasOp?: (connection: string, op: string) => boolean;
  /** Whether anything else points at this agent; a referenced agent is archived, never removed. */
  readonly isReferenced?: (id: string) => Promise<boolean>;
  readonly now?: () => Date;
}

/** An id from a name, on the same slug rule boards use, with an `agent` fallback. */
const allocateAgentId = (name: string, taken: ReadonlySet<string>): string => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent";
  let id = base;
  for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
  return id;
};

const issues = (error: { issues: Array<{ path: Array<string | number>; message: string }> }, root: string): string =>
  error.issues.map((issue) => `${issue.path.join(".") || root}: ${issue.message}`).join("; ");

export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  async list(options: { includeArchived?: boolean } = {}): Promise<AgentSpec[]> {
    const all = await this.deps.store.list();
    return options.includeArchived ? all : all.filter((one) => !one.archived);
  }

  get(id: string): Promise<AgentSpec | null> {
    return this.deps.store.get(id);
  }

  /** What is wrong with a reach, if anything: an unknown connection, or a grant the saver does not hold. */
  async problems(principal: Principal, reach: readonly AgentReach[]): Promise<ReachProblem[]> {
    const out: ReachProblem[] = [];
    for (const one of reach) {
      if (one.scope.connection && !this.deps.hasConnection(one.scope.connection)) {
        out.push({ reach: one, reason: "unknown-connection", message: `"${one.scope.connection}" is not one of this workspace's connections.` });
        continue;
      }
      const held = await this.deps.policy.can(principal, one.permission, one.scope);
      if (!held.ok) {
        out.push({
          reach: one,
          reason: "beyond-you",
          message: `You cannot give an agent ${one.permission}${one.scope.connection ? ` on ${one.scope.connection}` : ""}: you do not hold it yourself.`,
        });
      }
    }
    return out;
  }

  /** Tools that would act beyond the reach, or on what is not there. */
  toolProblems(tools: readonly AgentTool[], reach: readonly AgentReach[]): ReachProblem[] {
    const out: ReachProblem[] = [];
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.id)) out.push({ item: tool.id, reason: "invalid", message: `Two tools are called "${tool.id}".` });
      seen.add(tool.id);
      const info = AGENT_TOOL_INFO[tool.kind];
      if (tool.scope.connection && !this.deps.hasConnection(tool.scope.connection)) {
        out.push({ item: tool.id, reason: "unknown-connection", message: `"${tool.scope.connection}" is not one of this workspace's connections.` });
        continue;
      }
      if (tool.kind === "highlight" && (!tool.label?.trim() || !tool.description.trim())) {
        out.push({ item: tool.id, reason: "invalid", message: "A highlight needs a title and a description of what to watch for." });
      }
      if (tool.kind === "run_workflow" && !tool.workflow) {
        out.push({ item: tool.id, reason: "invalid", message: "A workflow tool needs to say which workflow it starts." });
      }
      if (!tool.enabled || tool.mode === "deny" || !info.permission) continue;
      if (!reachCovers(reach, info.permission, tool.scope)) {
        out.push({
          item: tool.id,
          reason: "tool-beyond-reach",
          message: `"${tool.label || info.label}" needs ${info.permission}${tool.scope.connection ? ` on ${tool.scope.connection}` : ""} in what the agent may touch. Add it there, or set the tool to deny.`,
        });
      }
    }
    return out;
  }

  /** Context rules that read an endpoint that is not there, or that the agent may not read. */
  contextProblems(knowledge: Pick<AgentKnowledge, "context">, reach: readonly AgentReach[] | null): ReachProblem[] {
    const out: ReachProblem[] = [];
    for (const rule of knowledge.context) {
      for (const source of rule.sources) {
        if (!this.deps.hasConnection(source.connection)) {
          out.push({ item: rule.id, reason: "unknown-connection", message: `"${source.connection}" is not one of this workspace's connections.` });
        } else if (this.deps.hasOp && !this.deps.hasOp(source.connection, source.op)) {
          out.push({ item: rule.id, reason: "unknown-endpoint", message: `"${source.op}" is not an endpoint on ${source.connection}.` });
        } else if (
          reach !== null &&
          !reach.some((one) => one.permission === "records.read" && (one.scope.connection === undefined || one.scope.connection === source.connection))
        ) {
          out.push({
            item: rule.id,
            reason: "context-beyond-reach",
            message: `"${rule.trigger}" reads ${source.connection}, which this agent may not read. Give it read access there first.`,
          });
        }
      }
    }
    return out;
  }

  private async checked(principal: Principal, input: unknown, held: AgentSpec | null) {
    const parsedInput = agentInputSchema.safeParse(input);
    if (!parsedInput.success) throw new AgentError(issues(parsedInput.error, "agent"), 400);
    const given = parsedInput.data;
    /* What was not sent stays as it was: a rename does not wipe the tools. */
    const reach = dedupeReach(given.reach ?? held?.reach ?? []);
    const tools = given.tools ?? held?.tools ?? [];
    const knowledge = given.knowledge ?? held?.knowledge ?? { notes: "", context: [] };

    const reachProblems = await this.problems(principal, reach);
    if (reachProblems.length > 0) {
      const unknown = reachProblems.some((one) => one.reason === "unknown-connection");
      throw new AgentError(reachProblems.map((one) => one.message).join(" "), unknown ? 400 : 403, reachProblems);
    }
    const rest = [...this.toolProblems(tools, reach), ...this.contextProblems(knowledge, reach)];
    if (rest.length > 0) throw new AgentError(rest.map((one) => one.message).join(" "), 400, rest);

    return {
      name: given.name,
      color: given.color,
      role: given.role ?? held?.role ?? "",
      instructions: given.instructions ?? held?.instructions ?? "",
      personality: given.personality ?? held?.personality ?? "",
      knowledge,
      tools,
      reach,
      model: given.model ?? held?.model,
    };
  }

  async create(principal: Principal, input: AgentInput): Promise<AgentSpec> {
    const valid = await this.checked(principal, input, null);
    const taken = new Set((await this.deps.store.list()).map((one) => one.id));
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const { model, ...fields } = valid;
    const agent = agentSchema.parse({
      ...fields,
      ...(model ? { model } : {}),
      id: allocateAgentId(valid.name, taken),
      archived: false,
      createdAt: at,
      updatedAt: at,
    });
    await this.deps.store.put(agent);
    return agent;
  }

  /** Change what a person may edit; the id, the dates and whether it is archived stay. */
  async update(principal: Principal, id: string, input: AgentInput): Promise<AgentSpec> {
    const held = await this.deps.store.get(id);
    if (!held) throw new AgentError(`There is no agent "${id}".`, 404);
    const valid = await this.checked(principal, input, held);
    const { model, ...fields } = valid;
    const { model: _old, ...rest } = held;
    const next = agentSchema.parse({
      ...rest,
      ...fields,
      ...(model ? { model } : {}),
      updatedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    });
    await this.deps.store.put(next);
    return next;
  }

  async setArchived(id: string, archived: boolean): Promise<AgentSpec> {
    const held = await this.deps.store.get(id);
    if (!held) throw new AgentError(`There is no agent "${id}".`, 404);
    const next = { ...held, archived, updatedAt: (this.deps.now?.() ?? new Date()).toISOString() };
    await this.deps.store.put(next);
    return next;
  }

  /** Remove for good: only an archived agent that nothing refers to. */
  async remove(id: string): Promise<void> {
    const held = await this.deps.store.get(id);
    if (!held) throw new AgentError(`There is no agent "${id}".`, 404);
    if (!held.archived) throw new AgentError("Archive an agent before removing it.", 409);
    if (await this.deps.isReferenced?.(id)) throw new AgentError("Something still refers to this agent, so it stays archived.", 409);
    await this.deps.store.delete(id);
  }

  /* ── knowledge every agent shares ─────────────────────────────────── */

  shared(): Promise<SharedAgentKnowledge> {
    return this.deps.store.shared();
  }

  /**
   * Replace the shared knowledge. Its context rules are checked for endpoints
   * that exist; whether each agent may read them is decided per agent when a
   * rule fires, since the same rule serves agents with different reach.
   */
  async putShared(input: unknown): Promise<SharedAgentKnowledge> {
    const parsedInput = sharedAgentKnowledgeSchema.safeParse(input);
    if (!parsedInput.success) throw new AgentError(issues(parsedInput.error, "knowledge"), 400);
    const problems = this.contextProblems(parsedInput.data, null);
    if (problems.length > 0) throw new AgentError(problems.map((one) => one.message).join(" "), 400, problems);
    const next = { ...parsedInput.data, updatedAt: (this.deps.now?.() ?? new Date()).toISOString() };
    await this.deps.store.putShared(next);
    return next;
  }
}
