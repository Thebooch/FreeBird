import {
  agentInputSchema,
  agentSchema,
  dedupeReach,
  type AgentInput,
  type AgentReach,
  type AgentSpec,
  type Principal,
  type ReachProblem,
} from "@freebirdai/dash-spec";
import type { Policy } from "../identity/policy.js";
import type { AgentStore } from "./store.js";

/**
 * Making, changing and retiring agents, in one place for the routes and the
 * assistant's actions to share — two paths would eventually disagree about
 * what an agent may be given.
 *
 * The rule that matters: nobody grants more than they hold. An agent's
 * effective permission on anything is the intersection of its `reach` and the
 * permission of the person who approves the change, so it never exceeds a
 * human; and a person never writes into an agent a reach they lack themselves,
 * so an agent is never a way around one's own permissions.
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

  private async checked(principal: Principal, input: unknown) {
    const parsedInput = agentInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new AgentError(parsedInput.error.issues.map((issue) => `${issue.path.join(".") || "agent"}: ${issue.message}`).join("; "), 400);
    }
    const reach = dedupeReach(parsedInput.data.reach ?? []);
    const problems = await this.problems(principal, reach);
    if (problems.length > 0) {
      const unknown = problems.some((one) => one.reason === "unknown-connection");
      throw new AgentError(problems.map((one) => one.message).join(" "), unknown ? 400 : 403, problems);
    }
    return { ...parsedInput.data, reach };
  }

  async create(principal: Principal, input: AgentInput): Promise<AgentSpec> {
    const valid = await this.checked(principal, input);
    const taken = new Set((await this.deps.store.list()).map((one) => one.id));
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const agent = agentSchema.parse({
      id: allocateAgentId(valid.name, taken),
      name: valid.name,
      color: valid.color,
      instructions: valid.instructions ?? "",
      reach: valid.reach,
      ...(valid.model ? { model: valid.model } : {}),
      archived: false,
      createdAt: at,
      updatedAt: at,
    });
    await this.deps.store.put(agent);
    return agent;
  }

  /** Replace what a person may edit; the id, the dates and whether it is archived stay. */
  async update(principal: Principal, id: string, input: AgentInput): Promise<AgentSpec> {
    const held = await this.deps.store.get(id);
    if (!held) throw new AgentError(`There is no agent "${id}".`, 404);
    const valid = await this.checked(principal, input);
    const { model: _model, ...rest } = held;
    const next = agentSchema.parse({
      ...rest,
      name: valid.name,
      color: valid.color,
      instructions: valid.instructions ?? "",
      reach: valid.reach,
      ...(valid.model ? { model: valid.model } : {}),
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
}
