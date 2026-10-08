import {
  appointmentTypeSchema,
  blockSchema,
  partialSettingsSchema,
  placementSchema,
  poolSchema,
  schedulingProfileSchema,
  type AppointmentType,
  type Block,
  type PartialSettings,
  type Placement,
  type Pool,
  type SchedulingProfile,
} from "@freebirdai/dash-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * Where a workspace's scheduling setup is kept: its defaults, each host's
 * profile, pools, appointment types, blocks and where they are placed.
 *
 * Plug-in point like the other stores: memory for tests and embedders, Dash's
 * database in the open-source build (`dash_scheduling`, one JSON record per
 * row under its kind and id). One store answers for one workspace.
 */

export const SCHEDULING_KINDS = ["defaults", "profile", "pool", "type", "block", "placement"] as const;
export type SchedulingKind = (typeof SCHEDULING_KINDS)[number];

interface KindMap {
  defaults: PartialSettings;
  profile: SchedulingProfile;
  pool: Pool;
  type: AppointmentType;
  block: Block;
  placement: Placement;
}

const PARSE: { readonly [K in SchedulingKind]: (value: unknown) => KindMap[K] } = {
  defaults: (value) => partialSettingsSchema.parse(value),
  profile: (value) => schedulingProfileSchema.parse(value),
  pool: (value) => poolSchema.parse(value),
  type: (value) => appointmentTypeSchema.parse(value),
  block: (value) => blockSchema.parse(value),
  placement: (value) => placementSchema.parse(value),
};

/** A record's key within its kind. */
const keyOf = <K extends SchedulingKind>(kind: K, value: KindMap[K]): string =>
  kind === "defaults" ? "workspace" : kind === "profile" ? (value as SchedulingProfile).member : (value as { id: string }).id;

export interface SchedulingStore {
  list<K extends SchedulingKind>(kind: K): Promise<Array<KindMap[K]>>;
  get<K extends SchedulingKind>(kind: K, id: string): Promise<KindMap[K] | null>;
  put<K extends SchedulingKind>(kind: K, value: KindMap[K]): Promise<KindMap[K]>;
  delete(kind: SchedulingKind, id: string): Promise<void>;
}

export class MemorySchedulingStore implements SchedulingStore {
  private readonly rows = new Map<string, unknown>();
  async list<K extends SchedulingKind>(kind: K): Promise<Array<KindMap[K]>> {
    return [...this.rows.entries()].filter(([key]) => key.startsWith(`${kind}\u0000`)).map(([, value]) => value as KindMap[K]);
  }
  async get<K extends SchedulingKind>(kind: K, id: string): Promise<KindMap[K] | null> {
    return (this.rows.get(`${kind}\u0000${id}`) as KindMap[K] | undefined) ?? null;
  }
  async put<K extends SchedulingKind>(kind: K, value: KindMap[K]): Promise<KindMap[K]> {
    const parsed = PARSE[kind](value);
    this.rows.set(`${kind}\u0000${keyOf(kind, parsed)}`, parsed);
    return parsed;
  }
  async delete(kind: SchedulingKind, id: string): Promise<void> {
    this.rows.delete(`${kind}\u0000${id}`);
  }
}

const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

export class DbSchedulingStore implements SchedulingStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}
  async list<K extends SchedulingKind>(kind: K): Promise<Array<KindMap[K]>> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_scheduling WHERE workspace = ${this.workspace} AND kind = ${kind} ORDER BY id`.execute(this.db.kysely);
    return result.rows.map((row) => PARSE[kind](parsed(row.record)));
  }
  async get<K extends SchedulingKind>(kind: K, id: string): Promise<KindMap[K] | null> {
    const result = await sql<{ record: unknown }>`SELECT record FROM dash_scheduling WHERE workspace = ${this.workspace} AND kind = ${kind} AND id = ${id}`.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? PARSE[kind](parsed(row.record)) : null;
  }
  async put<K extends SchedulingKind>(kind: K, value: KindMap[K]): Promise<KindMap[K]> {
    const one = PARSE[kind](value);
    await sql`
      INSERT INTO dash_scheduling (workspace, kind, id, record) VALUES (${this.workspace}, ${kind}, ${keyOf(kind, one)}, ${JSON.stringify(one)}::jsonb)
      ON CONFLICT (workspace, kind, id) DO UPDATE SET record = EXCLUDED.record
    `.execute(this.db.kysely);
    return one;
  }
  async delete(kind: SchedulingKind, id: string): Promise<void> {
    await sql`DELETE FROM dash_scheduling WHERE workspace = ${this.workspace} AND kind = ${kind} AND id = ${id}`.execute(this.db.kysely);
  }
}
