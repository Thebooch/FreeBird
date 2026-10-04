import { createHash } from "node:crypto";
import { AdapterError, parseRetryAfter } from "@freebirdai/dash-adapters";
import type { ResolvedParams } from "@freebirdai/dash-spec";
import type { Job as StoredJob, JobStore } from "../jobs/store.js";

/**
 * Reading every record's related records, past the twenty-five a tile reads
 * first.
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
 * While it runs, a job is kept in the job store: what
 * it asks, which records are read, and each record's answer, sealed — so a
 * restart carries it on rather than starting again. A finished answer is held
 * here, in memory, and its records leave the store.
 *
 * One record refused or missing (403, 404) is counted and the read goes on;
 * the rest may well be readable. The whole read stops only when the API
 * refuses the key (401), or has refused every record so far, three at least —
 * then every remaining read would be refused the same way. A rate limit is
 * waited out and the same record read again. What was not read is said.
 */

/** The most records read one at a time for one tile. */
export const EACH_MAX = 500;
/** How long a finished read is served before it is read again. */
export const EACH_KEEP_MS = 30 * 60_000;
/** How many reads are held at once, oldest out first. */
export const EACH_JOBS_MAX = 20;
/** Reads in flight per job. The connection's gate still decides when each runs. */
const IN_FLIGHT = 2;
/** Refusals in a row from the start, at least, before a 403 is taken to mean every record. */
const REFUSED_MIN = 3;
/** A rate limit's wait, when the API does not say, and the longest one waited out. */
const RATE_WAIT_MS = 30_000;
const RATE_WAIT_MAX_MS = 15 * 60_000;

export type EachValue = string | number | boolean;

/** One record's read: its answer, and what it said it left out. */
export interface EachRead {
  readonly body: unknown;
  readonly notes?: readonly string[];
}

/** One record's read, stopped when the job is. */
export type EachReader = (index: number, signal: AbortSignal) => Promise<EachRead>;

/** What a job asks, kept so a restart can ask it again: the tile's request, its window resolved. */
export interface EachRequest {
  readonly connection: string;
  readonly op: string;
  readonly params: Readonly<Record<string, EachValue>>;
  readonly input: string;
  readonly values: readonly EachValue[];
  readonly window: ResolvedParams;
  /** `fingerprintConnection` when it started: under another configuration it is not carried on. */
  readonly configVersion: string;
}

export interface EachAnswer {
  readonly status: "reading" | "done";
  /** Records whose related records were read. */
  readonly read: number;
  /** Records asked about. */
  readonly of: number;
  /** Records whose read failed on its own (a 404 for that one record, say). */
  readonly failed: number;
  /** Records the API would not let this key read (403), each on its own. */
  readonly denied?: number;
  /**
   * What the records' own reads said they left out, once each — a page cap,
   * paging not yet confirmed. The whole answer is no more complete than its
   * parts.
   */
  readonly notes: readonly string[];
  /** Why the rest were not read, when the API stopped the whole read. */
  readonly stopped?: string;
  /** Waiting out a rate limit until then (epoch ms), and carrying on after. */
  readonly waitingUntil?: number;
  /** One answer per record read, in the order asked. Only when done. */
  readonly bodies?: readonly unknown[];
  /** When the read finished, for the tile's age. */
  readonly fetchedAt?: number;
}

interface Job {
  readonly key: string;
  readonly id: string;
  readonly connection: string;
  readonly of: number;
  readonly request?: EachRequest | undefined;
  readonly controller: AbortController;
  /** Records still to read, lowest first. */
  readonly queue: number[];
  readonly done: Set<number>;
  read: number;
  failed: number;
  denied: number;
  /** Records whose read came back one way or another. */
  attempted: number;
  readonly notes: Set<string>;
  stopped?: string;
  waitingUntil?: number | undefined;
  readonly bodies: (unknown | typeof SKIPPED)[];
  finished: boolean;
  startedAt: number;
  fetchedAt?: number;
}

/** Where a job got to, as the store keeps it. */
interface Progress {
  readonly key: string;
  readonly request: EachRequest;
  readonly done: readonly number[];
  readonly failed: number;
  readonly denied: number;
  readonly attempted: number;
  readonly notes: readonly string[];
}

const SKIPPED = Symbol("skipped");

/** The same request's spelling, however long its list of records. */
export const eachKey = (connection: string, childKeys: readonly string[]): string =>
  `${connection}|${createHash("sha256").update(childKeys.join("\n")).digest("hex")}`;

const jobIdOf = (key: string): string => `each:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export interface EachReadsOptions {
  readonly max?: number;
  readonly keepMs?: number;
  readonly now?: () => number;
  /** Where a running job is kept, so a restart carries it on. Memory only when absent. */
  readonly store?: JobStore;
  /** A job's reads, rebuilt from what it asks: null when it no longer can be — the connection gone or changed. */
  readonly reader?: (request: EachRequest) => EachReader | null;
  /** Waiting out a rate limit. Stopped when the job is. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly log?: (line: string) => void;
}

export class EachReads {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly options: EachReadsOptions = {}) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * The read of these records, started if nobody asked for it yet.
   *
   * `read(index)` reads the related records of the index'th record asked
   * about, and says what that read left out. A finished read older than the
   * keep time is started again. With `request`, the job is kept in the store
   * while it runs, and carried on after a restart.
   */
  ask(input: {
    readonly key: string;
    readonly connection: string;
    readonly count: number;
    readonly read: EachReader;
    readonly request?: EachRequest;
  }): EachAnswer {
    const held = this.jobs.get(input.key);
    const keepMs = this.options.keepMs ?? EACH_KEEP_MS;
    if (held && !(held.finished && this.now - (held.fetchedAt ?? held.startedAt) > keepMs)) {
      /* Re-inserted, so the least recently asked is the first out. */
      this.jobs.delete(input.key);
      this.jobs.set(input.key, held);
      return answerOf(held);
    }
    if (held) this.drop(held);
    const job = this.start({
      key: input.key,
      connection: input.connection,
      of: input.count,
      request: input.request,
      queue: Array.from({ length: input.count }, (_, index) => index),
    });
    void this.run(job, input.read);
    return answerOf(job);
  }

  /** Answers read under the old key or account are not served again, and reads under way stop. */
  forget(connection?: string): void {
    for (const job of [...this.jobs.values()]) if (connection === undefined || job.connection === connection) this.drop(job);
    const { store } = this.options;
    if (store)
      void (async () => {
        for (const kept of await store.list({ kind: "each", ...(connection ? { connection } : {}) })) await store.remove(kept.id);
      })().catch((error: unknown) => this.options.log?.(`per-record reads could not be forgotten: ${String(error)}`));
  }

  /** On start: every job that was running when the server stopped, carried on from where it got to. */
  async resume(): Promise<void> {
    const { store, reader } = this.options;
    if (!store) return;
    for (const kept of await store.list({ kind: "each" })) {
      const progress = kept.progress as unknown as Progress;
      const read = reader?.(progress.request) ?? null;
      if (!read || this.jobs.has(progress.key)) {
        if (!read) await store.remove(kept.id);
        continue;
      }
      const done = new Set(progress.done);
      const job = this.start({
        key: progress.key,
        connection: kept.connection,
        of: progress.request.values.length,
        request: progress.request,
        queue: progress.request.values.map((_, index) => index).filter((index) => !done.has(index)),
      });
      for (const row of await store.rows(kept.id)) {
        const { index, body } = row as { index: number; body: unknown };
        if (!job.done.has(index)) {
          job.done.add(index);
          job.bodies[index] = body;
        }
      }
      job.read = job.done.size;
      job.failed = progress.failed;
      job.denied = progress.denied;
      job.attempted = progress.attempted;
      for (const note of progress.notes) job.notes.add(note);
      this.options.log?.(`carrying on ${kept.connection}'s per-record read: ${job.read} of ${job.of} read before the restart`);
      void this.run(job, read);
    }
  }

  private start(input: {
    readonly key: string;
    readonly connection: string;
    readonly of: number;
    readonly request: EachRequest | undefined;
    readonly queue: number[];
  }): Job {
    const job: Job = {
      key: input.key,
      id: jobIdOf(input.key),
      connection: input.connection,
      of: input.of,
      request: input.request,
      controller: new AbortController(),
      queue: input.queue,
      done: new Set(),
      read: 0,
      failed: 0,
      denied: 0,
      attempted: 0,
      notes: new Set(),
      bodies: Array.from({ length: input.of }, () => SKIPPED),
      finished: false,
      startedAt: this.now,
    };
    this.jobs.delete(input.key);
    this.jobs.set(input.key, job);
    while (this.jobs.size > (this.options.max ?? EACH_JOBS_MAX)) {
      const oldest = this.jobs.values().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    return job;
  }

  /** Out of the map, its workers stopped, its kept records gone. */
  private drop(job: Job): void {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.controller.abort();
    if (this.options.store && job.request)
      void this.options.store.remove(job.id).catch((error: unknown) => this.options.log?.(`a per-record read could not be removed: ${String(error)}`));
  }

  private async run(job: Job, read: EachReader): Promise<void> {
    const { signal } = job.controller;
    const sleep = this.options.sleep ?? abortableSleep;
    await this.keep(job);
    const worker = async (): Promise<void> => {
      while (!signal.aborted && job.stopped === undefined) {
        const index = job.queue.shift();
        if (index === undefined) return;
        for (;;) {
          try {
            const answer = await read(index, signal);
            if (signal.aborted) return;
            job.bodies[index] = answer.body;
            job.done.add(index);
            job.read += 1;
            job.attempted += 1;
            for (const note of answer.notes ?? []) job.notes.add(note);
            await this.keep(job, { index, body: answer.body });
            break;
          } catch (error) {
            if (signal.aborted) return;
            const status = error instanceof AdapterError ? error.status : undefined;
            /* Asked to wait: waited, and the same record read again. */
            if (status === 429) {
              const retryAfter = error instanceof AdapterError ? error.retryAfter : undefined;
              const wait = Math.min(Math.max(parseRetryAfter(retryAfter, this.now) ?? RATE_WAIT_MS, 1_000), RATE_WAIT_MAX_MS);
              job.waitingUntil = this.now + wait;
              await this.keep(job);
              await sleep(wait, signal);
              job.waitingUntil = undefined;
              continue;
            }
            job.attempted += 1;
            const said = error instanceof AdapterError ? error.userMessage : String(error);
            if (status === 401) job.stopped = said;
            else if (status === 403) {
              job.denied += 1;
              /* Every record so far refused: the key, not the records. */
              if (job.denied === job.attempted && job.attempted >= REFUSED_MIN) job.stopped = said;
            } else job.failed += 1;
            await this.keep(job);
            break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, Math.max(job.queue.length, 1)) }, worker));
    if (signal.aborted) return;
    job.finished = true;
    job.fetchedAt = this.now;
    /* Whole, and held here: its records leave the store. */
    if (this.options.store && job.request) await this.options.store.remove(job.id).catch(() => undefined);
  }

  /** Where a job got to, and a record's answer, kept while it runs: only a job that can be asked again. */
  private async keep(job: Job, answered?: { readonly index: number; readonly body: unknown }): Promise<void> {
    const { store } = this.options;
    if (!store || !job.request || job.controller.signal.aborted) return;
    try {
      if (answered) await store.appendRows(job.id, [answered]);
      const progress: Progress = {
        key: job.key,
        request: job.request,
        done: [...job.done],
        failed: job.failed,
        denied: job.denied,
        attempted: job.attempted,
        notes: [...job.notes],
      };
      const now = this.now;
      const kept: StoredJob = {
        id: job.id,
        kind: "each",
        connection: job.connection,
        op: job.request.op,
        configVersion: job.request.configVersion,
        state: job.waitingUntil !== undefined ? "waiting" : "running",
        priority: 0,
        progress: progress as unknown as Record<string, unknown>,
        ...(job.waitingUntil !== undefined ? { notBefore: job.waitingUntil } : {}),
        attempts: 0,
        createdAt: job.startedAt,
        updatedAt: now,
      };
      await store.put(kept);
    } catch (error) {
      this.options.log?.(`a per-record read could not be kept: ${String(error)}`);
    }
  }
}

const answerOf = (job: Job): EachAnswer => ({
  status: job.finished ? "done" : "reading",
  read: job.read,
  of: job.of,
  failed: job.failed,
  ...(job.denied > 0 ? { denied: job.denied } : {}),
  notes: [...job.notes],
  ...(job.stopped !== undefined ? { stopped: job.stopped } : {}),
  ...(job.waitingUntil !== undefined ? { waitingUntil: job.waitingUntil } : {}),
  ...(job.finished
    ? {
        bodies: job.bodies.filter((body) => body !== SKIPPED),
        ...(job.fetchedAt !== undefined ? { fetchedAt: job.fetchedAt } : {}),
      }
    : {}),
});
