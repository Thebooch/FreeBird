
/**
 * Work that outlives a request: a read too long for a tile's own limits, the
 * related records of every row, an endpoint's check waiting its turn.
 *
 * Each job keeps where it got to — a cursor, the next address, the page, an
 * export's id, connector code's `resume`, which rows' reads are done — so a
 * restart carries on rather than starting over, and a rate limit is waited
 * out (`notBefore`) rather than ending it. Keyed by the configuration it was
 * started under: a new key or address makes it stale, and it is dropped.
 *
 * A running read's records, and where it got to, are kept with it, encrypted, until it finishes,
 * is cancelled or goes stale — the one narrow exception to "no disk
 * cache" (2026-09-30). They are never served as a cache: a finished read's
 * answer goes to the memory cache like any other, and its records are deleted.
 *
 * A plug-in point: memory in tests, Dash's database in the open-source build
 * (`connect_jobs`, `connect_job_rows`), wherever a hosted build keeps the rest.
 * Every row carries a workspace.
 */

export type JobKind = "read" | "each" | "check";
export type JobState = "pending" | "running" | "waiting" | "blocked" | "done" | "cancelled";

export interface Job {
  readonly id: string;
  readonly kind: JobKind;
  readonly connection: string;
  readonly op?: string | undefined;
  /** `fingerprintConnection` when it started: a job under another is stale. */
  readonly configVersion: string;
  /** What the read asks for (`resolveReadRequest`'s digest), where it is a read. */
  readonly scope?: string | undefined;
  readonly state: JobState;
  /** Higher first. */
  readonly priority: number;
  /** Where it got to. Opaque to the store: the job's runner reads and writes it. */
  readonly progress: Readonly<Record<string, unknown>>;
  /** Not to be taken up again before this (epoch ms): a rate limit's wait, a retry's. */
  readonly notBefore?: number | undefined;
  readonly attempts: number;
  /** Why it is blocked, or what last went wrong, in words. */
  readonly error?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface JobFilter {
  readonly connection?: string;
  readonly kind?: JobKind;
  readonly states?: readonly JobState[];
}

export interface JobStore {
  put(job: Job): Promise<void>;
  get(id: string): Promise<Job | null>;
  /** Highest priority first, then oldest. */
  list(filter?: JobFilter): Promise<Job[]>;
  /** Records a running read has gathered: appended chunk by chunk, kept only while it runs. */
  appendRows(id: string, rows: readonly unknown[]): Promise<void>;
  rows(id: string): Promise<unknown[]>;
  /** The job and every record it held. */
  remove(id: string): Promise<void>;
  /** Every job of a connection, and their records: the connection was removed, or its configuration changed. */
  forget(connection: string): Promise<void>;
}

/** How records are kept at rest: the vault's own encryption, the master key it already holds. */
export interface RowCipher {
  encrypt(plaintext: string): string;
  decrypt(token: string): string;
}

export const ordered = (jobs: Job[]): Job[] => jobs.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

export const matches = (job: Job, filter: JobFilter): boolean =>
  (filter.connection === undefined || job.connection === filter.connection) &&
  (filter.kind === undefined || job.kind === filter.kind) &&
  (filter.states === undefined || filter.states.includes(job.state));

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly held = new Map<string, unknown[]>();

  async put(job: Job): Promise<void> {
    this.jobs.set(job.id, job);
  }

  async get(id: string): Promise<Job | null> {
    return this.jobs.get(id) ?? null;
  }

  async list(filter: JobFilter = {}): Promise<Job[]> {
    return ordered([...this.jobs.values()].filter((job) => matches(job, filter)));
  }

  async appendRows(id: string, rows: readonly unknown[]): Promise<void> {
    this.held.set(id, [...(this.held.get(id) ?? []), ...rows]);
  }

  async rows(id: string): Promise<unknown[]> {
    return [...(this.held.get(id) ?? [])];
  }

  async remove(id: string): Promise<void> {
    this.jobs.delete(id);
    this.held.delete(id);
  }

  async forget(connection: string): Promise<void> {
    for (const [id, job] of [...this.jobs]) if (job.connection === connection) await this.remove(id);
  }
}
