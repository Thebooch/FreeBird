import { sql } from "kysely";
import type { DashDb } from "@freebirdai/connect/platform/db";

/**
 * What a number on a board was, day by day — history the API does not keep.
 *
 * A total read now says nothing about last month, and most APIs cannot be
 * asked what a count was then. So each number tile's value is kept once a day
 * while its board is looked after (`record.ts`), and the tile shows it with
 * the day it started: history starts when it was first kept, never earlier,
 * and says so.
 *
 * The account's own numbers: kept per workspace, forgotten with the board,
 * and pruned past the retention. A plug-in point: memory in tests, Dash's
 * database in the open-source build, wherever a hosted build keeps it.
 */
export interface HistoryPoint {
  /** YYYY-MM-DD, in UTC. */
  readonly day: string;
  readonly value: number;
}

export interface SnapshotStore {
  /** Keep one value for a day, in place of any kept earlier that day. */
  record(dashboard: string, widget: string, point: HistoryPoint): Promise<void>;
  /** Oldest first. */
  list(dashboard: string, widget: string): Promise<HistoryPoint[]>;
  /** Everything before a day, gone. */
  prune(before: string): Promise<void>;
  forget(dashboard: string, widget?: string): Promise<void>;
}

export class MemorySnapshotStore implements SnapshotStore {
  private readonly rows = new Map<string, Map<string, number>>();
  private key(dashboard: string, widget: string): string {
    return `${dashboard}\n${widget}`;
  }
  async record(dashboard: string, widget: string, point: HistoryPoint): Promise<void> {
    const days = this.rows.get(this.key(dashboard, widget)) ?? new Map<string, number>();
    days.set(point.day, point.value);
    this.rows.set(this.key(dashboard, widget), days);
  }
  async list(dashboard: string, widget: string): Promise<HistoryPoint[]> {
    return [...(this.rows.get(this.key(dashboard, widget)) ?? [])]
      .map(([day, value]) => ({ day, value }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }
  async prune(before: string): Promise<void> {
    for (const days of this.rows.values()) for (const day of [...days.keys()]) if (day < before) days.delete(day);
  }
  async forget(dashboard: string, widget?: string): Promise<void> {
    for (const key of [...this.rows.keys()])
      if (widget ? key === this.key(dashboard, widget) : key.startsWith(`${dashboard}\n`)) this.rows.delete(key);
  }
}

export class DbSnapshotStore implements SnapshotStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async record(dashboard: string, widget: string, point: HistoryPoint): Promise<void> {
    await sql`
      INSERT INTO dash_snapshots (workspace, dashboard, widget, day, value, at)
      VALUES (${this.workspace}, ${dashboard}, ${widget}, ${point.day}, ${point.value}, ${new Date().toISOString()})
      ON CONFLICT (workspace, dashboard, widget, day) DO UPDATE SET value = EXCLUDED.value, at = EXCLUDED.at
    `.execute(this.db.kysely);
  }

  async list(dashboard: string, widget: string): Promise<HistoryPoint[]> {
    const result = await sql<{ day: string; value: number }>`
      SELECT day, value FROM dash_snapshots
      WHERE workspace = ${this.workspace} AND dashboard = ${dashboard} AND widget = ${widget}
      ORDER BY day ASC
    `.execute(this.db.kysely);
    return result.rows.map((row) => ({ day: row.day, value: Number(row.value) }));
  }

  async prune(before: string): Promise<void> {
    await sql`DELETE FROM dash_snapshots WHERE workspace = ${this.workspace} AND day < ${before}`.execute(this.db.kysely);
  }

  async forget(dashboard: string, widget?: string): Promise<void> {
    await (widget
      ? sql`DELETE FROM dash_snapshots WHERE workspace = ${this.workspace} AND dashboard = ${dashboard} AND widget = ${widget}`
      : sql`DELETE FROM dash_snapshots WHERE workspace = ${this.workspace} AND dashboard = ${dashboard}`
    ).execute(this.db.kysely);
  }
}
