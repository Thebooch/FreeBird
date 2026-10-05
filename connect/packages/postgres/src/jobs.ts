import { sql } from "kysely";
import type { ConnectDb } from "./db.js";
import { matches, ordered, type Job, type JobFilter, type JobStore, type RowCipher } from "@freebirdai/connect/jobs/store";

const parsed = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

/* Where a job got to is kept sealed too: an API's signed next address, connector code's `resume`. */
type Sealed = Omit<Job, "progress"> & { readonly progress: { readonly sealed: string } };


export class DbJobStore implements JobStore {
  constructor(
    private readonly db: ConnectDb,
    private readonly cipher: RowCipher,
    private readonly workspace = "local",
  ) {}

  async put(job: Job): Promise<void> {
    await sql`
      INSERT INTO connect_jobs (workspace, id, kind, connection, op, state, priority, not_before, updated_at, record)
      VALUES (
        ${this.workspace}, ${job.id}, ${job.kind}, ${job.connection}, ${job.op ?? null}, ${job.state}, ${job.priority},
        ${job.notBefore !== undefined ? new Date(job.notBefore).toISOString() : null}, ${new Date(job.updatedAt).toISOString()},
        ${JSON.stringify(this.seal(job))}::jsonb
      )
      ON CONFLICT (workspace, id) DO UPDATE SET
        state = EXCLUDED.state, priority = EXCLUDED.priority, not_before = EXCLUDED.not_before,
        updated_at = EXCLUDED.updated_at, record = EXCLUDED.record
    `.execute(this.db.kysely);
  }

  async get(id: string): Promise<Job | null> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM connect_jobs WHERE workspace = ${this.workspace} AND id = ${id}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    return row ? this.open(parsed<Sealed>(row.record)) : null;
  }

  async list(filter: JobFilter = {}): Promise<Job[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM connect_jobs WHERE workspace = ${this.workspace}
      ORDER BY priority DESC, updated_at
    `.execute(this.db.kysely);
    return ordered(result.rows.map((row) => this.open(parsed<Sealed>(row.record))).filter((job) => matches(job, filter)));
  }

  private seal(job: Job): Sealed {
    return { ...job, progress: { sealed: this.cipher.encrypt(JSON.stringify(job.progress)) } };
  }

  private open(record: Sealed): Job {
    return { ...record, progress: JSON.parse(this.cipher.decrypt(record.progress.sealed)) as Record<string, unknown> };
  }

  async appendRows(id: string, rows: readonly unknown[]): Promise<void> {
    if (rows.length === 0) return;
    const next = await sql<{ seq: number | null }>`
      SELECT MAX(seq) AS seq FROM connect_job_rows WHERE workspace = ${this.workspace} AND job = ${id}
    `.execute(this.db.kysely);
    const seq = (next.rows[0]?.seq ?? -1) + 1;
    await sql`
      INSERT INTO connect_job_rows (workspace, job, seq, rows)
      VALUES (${this.workspace}, ${id}, ${seq}, ${this.cipher.encrypt(JSON.stringify(rows))})
    `.execute(this.db.kysely);
  }

  async rows(id: string): Promise<unknown[]> {
    const result = await sql<{ rows: string }>`
      SELECT rows FROM connect_job_rows WHERE workspace = ${this.workspace} AND job = ${id} ORDER BY seq
    `.execute(this.db.kysely);
    return result.rows.flatMap((row) => JSON.parse(this.cipher.decrypt(row.rows)) as unknown[]);
  }

  async remove(id: string): Promise<void> {
    await sql`DELETE FROM connect_job_rows WHERE workspace = ${this.workspace} AND job = ${id}`.execute(this.db.kysely);
    await sql`DELETE FROM connect_jobs WHERE workspace = ${this.workspace} AND id = ${id}`.execute(this.db.kysely);
  }

  async forget(connection: string): Promise<void> {
    await sql`
      DELETE FROM connect_job_rows WHERE workspace = ${this.workspace}
        AND job IN (SELECT id FROM connect_jobs WHERE workspace = ${this.workspace} AND connection = ${connection})
    `.execute(this.db.kysely);
    await sql`DELETE FROM connect_jobs WHERE workspace = ${this.workspace} AND connection = ${connection}`.execute(this.db.kysely);
  }
}
