import { agentSchema, type AgentSpec } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * Where a workspace's agents are kept: named AI workers, each with a colour,
 * instructions and what it may touch (`@freebirdai/dash-spec` `agent.ts`).
 *
 * A plug-in point like the others: memory for tests and embedders, Dash's
 * database in the open-source build, wherever a hosted build keeps it. One
 * store answers for one workspace.
 */
export interface AgentStore {
  /** Every agent, archived ones included, in the order they were made. */
  list(): Promise<AgentSpec[]>;
  get(id: string): Promise<AgentSpec | null>;
  put(agent: AgentSpec): Promise<void>;
  delete(id: string): Promise<void>;
}

const byCreation = (a: AgentSpec, b: AgentSpec): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export class MemoryAgentStore implements AgentStore {
  private readonly rows = new Map<string, AgentSpec>();
  async list(): Promise<AgentSpec[]> {
    return [...this.rows.values()].sort(byCreation);
  }
  async get(id: string): Promise<AgentSpec | null> {
    return this.rows.get(id) ?? null;
  }
  async put(agent: AgentSpec): Promise<void> {
    this.rows.set(agent.id, agentSchema.parse(agent));
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

const parsed = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

export class DbAgentStore implements AgentStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async list(): Promise<AgentSpec[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_agents WHERE workspace = ${this.workspace}
    `.execute(this.db.kysely);
    return result.rows.map((row) => agentSchema.parse(parsed(row.record))).sort(byCreation);
  }

  async get(id: string): Promise<AgentSpec | null> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_agents WHERE workspace = ${this.workspace} AND id = ${id}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? agentSchema.parse(parsed(row.record)) : null;
  }

  async put(agent: AgentSpec): Promise<void> {
    const one = agentSchema.parse(agent);
    await sql`
      INSERT INTO dash_agents (workspace, id, record) VALUES (${this.workspace}, ${one.id}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
  }

  async delete(id: string): Promise<void> {
    await sql`DELETE FROM dash_agents WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
  }
}
