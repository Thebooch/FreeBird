import { createHash } from "node:crypto";
import { AdapterError } from "@freebirdai/dash-adapters";

/**
 * Reading every record's related records, past the twenty-five a tile reads
 * first (plan, track D).
 *
 * An endpoint that answers for one record at a time — a lease's charges, a
 * vendor's bills — is read once per record. A tile reads the first twenty-five
 * of those itself, at once, so it can draw; past that it said "only 25 of 212
 * records were read in full" and stopped there for good. This reads the rest,
 * here, behind every tile's own reads (`Priority.Background`) and paced by the
 * connection's gate, and hands the tile the whole answer when it has it.
 *
 * Held here, not in the response cache: two hundred per-record answers would
 * push every board's own reads out of a cache that holds five hundred. A job
 * is kept a while, bounded in number, and forgotten with its connection.
 *
 * Stops, rather than failing record after record, when the API refuses the
 * account (401/403) or asks to wait longer than a read waits (429): every
 * remaining read would be refused the same way. What was not read is said.
 */

/** The most records read one at a time for one tile. */
export const EACH_MAX = 500;
/** How long a finished read is served before it is read again. */
export const EACH_KEEP_MS = 30 * 60_000;
/** How many reads are held at once, oldest out first. */
export const EACH_JOBS_MAX = 20;
/** Reads in flight per job. The connection's gate still decides when each runs. */
const IN_FLIGHT = 2;

export type EachValue = string | number | boolean;

/** One record's read: its answer, and what it said it left out. */
export interface EachRead {
  readonly body: unknown;
  readonly notes?: readonly string[];
}

export interface EachAnswer {
  readonly status: "reading" | "done";
  /** Records whose related records were read. */
  readonly read: number;
  /** Records asked about. */
  readonly of: number;
  /** Records whose read failed on its own (a 404 for that one record, say). */
  readonly failed: number;
  /**
   * What the records' own reads said they left out, once each — a page cap,
   * paging not yet confirmed. The whole answer is no more complete than its
   * parts.
   */
  readonly notes: readonly string[];
  /** Why the rest were not read, when the API stopped the whole read. */
  readonly stopped?: string;
  /** One answer per record read, in the order asked. Only when done. */
  readonly bodies?: readonly unknown[];
  /** When the read finished, for the tile's age. */
  readonly fetchedAt?: number;
}

interface Job {
  readonly connection: string;
  readonly of: number;
  read: number;
  failed: number;
  readonly notes: Set<string>;
  stopped?: string;
  readonly bodies: (unknown | typeof SKIPPED)[];
  done: boolean;
  startedAt: number;
  fetchedAt?: number;
}

const SKIPPED = Symbol("skipped");

/** The same request's spelling, however long its list of records. */
export const eachKey = (connection: string, childKeys: readonly string[]): string =>
  `${connection}|${createHash("sha256").update(childKeys.join("\n")).digest("hex")}`;

/** A refusal every other record's read would meet too. */
const stopsTheRead = (error: unknown): string | null => {
  if (!(error instanceof AdapterError)) return null;
  if (error.status === 429 || error.status === 401 || error.status === 403)
    return error.userMessage;
  return null;
};

export class EachReads {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly options: {
      readonly max?: number;
      readonly keepMs?: number;
      readonly now?: () => number;
    } = {},
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * The read of these records, started if nobody asked for it yet.
   *
   * `read(index)` reads the related records of the index'th record asked
   * about, and says what that read left out. A finished read older than the keep time is started again.
   */
  ask(input: {
    readonly key: string;
    readonly connection: string;
    readonly count: number;
    readonly read: (index: number) => Promise<EachRead>;
  }): EachAnswer {
    const held = this.jobs.get(input.key);
    const keepMs = this.options.keepMs ?? EACH_KEEP_MS;
    if (held && !(held.done && this.now - (held.fetchedAt ?? held.startedAt) > keepMs)) {
      /* Re-inserted, so the least recently asked is the first out. */
      this.jobs.delete(input.key);
      this.jobs.set(input.key, held);
      return answerOf(held);
    }
    const job: Job = {
      connection: input.connection,
      of: input.count,
      read: 0,
      failed: 0,
      notes: new Set(),
      bodies: Array.from({ length: input.count }, () => SKIPPED),
      done: false,
      startedAt: this.now,
    };
    this.jobs.delete(input.key);
    this.jobs.set(input.key, job);
    while (this.jobs.size > (this.options.max ?? EACH_JOBS_MAX)) {
      const oldest = this.jobs.keys().next().value;
      if (oldest === undefined) break;
      this.jobs.delete(oldest);
    }
    void this.run(job, input.read);
    return answerOf(job);
  }

  /** Answers read under the old key or account are not served again. */
  forget(connection?: string): void {
    for (const [key, job] of [...this.jobs]) {
      if (connection === undefined || job.connection === connection) this.jobs.delete(key);
    }
  }

  private async run(job: Job, read: (index: number) => Promise<EachRead>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < job.of && job.stopped === undefined) {
        const index = next++;
        try {
          const answer = await read(index);
          job.bodies[index] = answer.body;
          job.read += 1;
          for (const note of answer.notes ?? []) job.notes.add(note);
        } catch (error) {
          const stop = stopsTheRead(error);
          if (stop) job.stopped = stop;
          else job.failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, job.of) }, worker));
    job.done = true;
    job.fetchedAt = this.now;
  }
}

const answerOf = (job: Job): EachAnswer => ({
  status: job.done ? "done" : "reading",
  read: job.read,
  of: job.of,
  failed: job.failed,
  notes: [...job.notes],
  ...(job.stopped !== undefined ? { stopped: job.stopped } : {}),
  ...(job.done
    ? {
        bodies: job.bodies.filter((body) => body !== SKIPPED),
        ...(job.fetchedAt !== undefined ? { fetchedAt: job.fetchedAt } : {}),
      }
    : {}),
});
