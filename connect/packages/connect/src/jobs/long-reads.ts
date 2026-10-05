import { createHash } from "node:crypto";
import { AdapterError, INCOMPLETE, parseRetryAfter, type Continuation, type FetchContext, type FetchResult } from "../adapters/index.js";
import { fingerprintConnection, getOp, type ConnectionSpec, type OpSpec, type ResolvedParams } from "@freebirdai/connect-spec";
import type { Job, JobStore } from "./store.js";

/**
 * A read too long for a tile's own limits, carried on in the background.
 *
 * A tile reads at most a page ceiling's worth — or a connector's runs' worth
 * — and says what it left out. Past that it used to stop for good: 1,150
 * records read 50 pages at a time stopped at 500, every time. Now the read is
 * carried on as a job, from where it stopped, behind every tile's own reads,
 * waiting out a rate limit rather than ending, a stretch of pages at a time —
 * and its records kept with it, encrypted, so a restart carries on rather
 * than starting over. When it reaches its end the whole answer is handed to
 * the cache under the tile's own key, and the job's records are deleted.
 *
 * A key read this way is the job's from then on: it is refreshed by starting
 * the job again, never by a capped read that would put the partial answer
 * back over the whole one.
 */

/** Pages one step of a job reads, between turns of other work. */
export const LONG_READ_STEP = 50;
/** The most a job reads in all, before it says where it stopped. */
export const LONG_READ_MAX_PAGES = 2_000;
/** Times a failed step is tried again, further apart each time. */
const MAX_ATTEMPTS = 5;
const RETRY_MS = 30_000;

/** Where a read stopped with more to read: its page ceiling, or its connector's runs. */
const CARRIED = new Set(["page-cap", "run-limit"]);
const carriedOn = (result: FetchResult): Continuation | undefined =>
  result.meta.continuation && CARRIED.has(result.meta.completion?.reason ?? "") ? result.meta.continuation : undefined;

type Overrides = Readonly<Record<string, string | number | boolean>>;

export interface LongReadDeps {
  readonly store: JobStore;
  readonly getConnection: (id: string) => ConnectionSpec | null | undefined;
  /** One stretch of the read, through the server's own chain: journal, renewal, rate-limit waits, gate. */
  readonly read: (connection: ConnectionSpec, op: OpSpec, overrides: Overrides, ctx: FetchContext) => Promise<FetchResult>;
  /** The whole answer, for the cache under the tile's own key. */
  readonly answer: (key: string, connection: string, result: FetchResult) => Promise<void>;
  readonly now: () => number;
  readonly log?: (line: string) => void;
  /** A wake-up for a job waiting out a rate limit. The server's timers by default. */
  readonly schedule?: (ms: number, run: () => void) => () => void;
  /** Pages one stretch reads: `LONG_READ_STEP` unless said. */
  readonly stepPages?: number;
}

/** What a tile is told while its read is carried on. */
export interface LongReadStatus {
  readonly state: Job["state"];
  /** Records read so far, the tile's own first pages included. */
  readonly read: number;
  /** How many the API says there are, where it says. */
  readonly of?: number;
  /** Why it is waiting or blocked, in words. */
  readonly error?: string;
}

interface Progress {
  readonly key: string;
  readonly overrides: Overrides;
  readonly resolved: ResolvedParams;
  readonly continuation: Continuation;
  readonly rowsPath: string;
  readonly pages: number;
  readonly read: number;
  readonly reportedTotal?: number;
}

/** A body holding these rows where the endpoint's answer holds them: `$`, `$.data`, `$.result.items`. */
export const envelopeFor = (rowsPath: string, rows: readonly unknown[]): unknown | null => {
  if (rowsPath === "$" || rowsPath === "") return [...rows];
  const match = /^\$((?:\.[A-Za-z_][\w-]*)+)$/.exec(rowsPath);
  if (!match) return null;
  const keys = match[1]!.split(".").filter(Boolean);
  let body: unknown = [...rows];
  for (const key of keys.reverse()) body = { [key]: body };
  return body;
};

const rowsOf = (body: unknown, rowsPath: string): unknown[] => {
  if (rowsPath === "$" || rowsPath === "") return Array.isArray(body) ? body : [];
  let cursor: unknown = body;
  for (const key of rowsPath.replace(/^\$\.?/, "").split(".").filter(Boolean)) {
    if (cursor === null || typeof cursor !== "object") return [];
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return Array.isArray(cursor) ? cursor : [];
};

/** Where an answer's records are: a connector answers with the records themselves. */
const rowsPathOf = (op: OpSpec, continuation: Continuation): string =>
  continuation.kind === "connector" ? "$" : (op.rowsPath ?? "$");

export const longReadId = (key: string): string => `read:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

const active = (job: Job | null): job is Job => job !== null && job.state !== "done" && job.state !== "cancelled";

export class LongReads {
  private running: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly deps: LongReadDeps) {}

  /**
   * A read that stopped at its own limit, carried on from there. Returns the
   * job, or null where it cannot be: an answer whose records a body cannot be
   * rebuilt around, or one that did not say where it stopped.
   */
  async carryOn(input: {
    readonly key: string;
    readonly connection: ConnectionSpec;
    readonly op: OpSpec;
    readonly overrides: Overrides;
    readonly resolved: ResolvedParams;
    readonly first: FetchResult;
  }): Promise<Job | null> {
    const { first, op } = input;
    const continuation = carriedOn(first);
    if (!continuation) return null;
    const rowsPath = rowsPathOf(op, continuation);
    if (envelopeFor(rowsPath, []) === null) return null;
    const id = longReadId(input.key);
    const configVersion = fingerprintConnection(input.connection);
    const held = await this.deps.store.get(id);
    if (active(held) && held.configVersion === configVersion) return held;
    if (held) await this.deps.store.remove(id);
    const rows = rowsOf(first.body, rowsPath);
    const now = this.deps.now();
    const progress: Progress = {
      key: input.key,
      overrides: input.overrides,
      resolved: input.resolved,
      continuation,
      rowsPath,
      pages: first.meta.pages,
      read: rows.length,
      ...(first.meta.reportedTotal !== undefined ? { reportedTotal: first.meta.reportedTotal } : {}),
    };
    const job: Job = {
      id,
      kind: "read",
      connection: input.connection.id,
      op: op.id,
      configVersion,
      ...(first.meta.scope ? { scope: first.meta.scope } : {}),
      state: "pending",
      priority: 0,
      progress: progress as unknown as Record<string, unknown>,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.appendRows(id, rows);
    await this.deps.store.put(job);
    this.deps.log?.(`carrying on ${input.connection.id}/${op.id} past ${first.meta.pages} page(s) in the background`);
    this.kick();
    return job;
  }

  /** Whether a key is read this way: refreshed through `refresh`, never with a capped read. */
  async owns(key: string): Promise<boolean> {
    return (await this.deps.store.get(longReadId(key))) !== null;
  }

  /**
   * A refresh of a key read this way: its first stretch read here, not
   * through the cache, and the rest carried on — so the whole answer the
   * cache holds stays until a new whole one replaces it. A read that now ends
   * within its first stretch is answered at once.
   */
  async refresh(input: {
    readonly key: string;
    readonly connection: ConnectionSpec;
    readonly op: OpSpec;
    readonly overrides: Overrides;
    readonly resolved: ResolvedParams;
  }): Promise<void> {
    const held = await this.deps.store.get(longReadId(input.key));
    if (active(held) && held.configVersion === fingerprintConnection(input.connection)) {
      this.kick();
      return;
    }
    const first = await this.deps.read(input.connection, { ...input.op, maxPages: this.deps.stepPages ?? LONG_READ_STEP }, input.overrides, {
      params: input.resolved,
      now: this.deps.now(),
    });
    if (carriedOn(first)) await this.carryOn({ ...input, first });
    else await this.deps.answer(input.key, input.connection.id, first);
  }

  /** How far a key's read has got, while it is carried on; null once it is done, or when it never was. */
  async status(key: string): Promise<LongReadStatus | null> {
    const job = await this.deps.store.get(longReadId(key));
    if (!active(job)) return null;
    const progress = job.progress as unknown as Progress;
    return {
      state: job.state,
      read: progress.read,
      ...(progress.reportedTotal !== undefined ? { of: progress.reportedTotal } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  /** Every read carried on, for whoever asks how they are going: no records, no addresses. */
  async list(connection?: string): Promise<Array<{ id: string; connection: string; op?: string; status: LongReadStatus }>> {
    const jobs = await this.deps.store.list({ kind: "read", ...(connection ? { connection } : {}) });
    return jobs.filter(active).map((job) => {
      const progress = job.progress as unknown as Progress;
      return {
        id: job.id,
        connection: job.connection,
        ...(job.op ? { op: job.op } : {}),
        status: {
          state: job.state,
          read: progress.read,
          ...(progress.reportedTotal !== undefined ? { of: progress.reportedTotal } : {}),
          ...(job.error ? { error: job.error } : {}),
        },
      };
    });
  }

  /** A connection's reads, and the records they held: its configuration changed, or it was removed. Its other work is not this one's. */
  async forget(connection: string): Promise<void> {
    for (const job of await this.deps.store.list({ kind: "read", connection })) await this.deps.store.remove(job.id);
  }

  /** On start: whatever was running when the server stopped is taken up again. */
  async resume(): Promise<void> {
    for (const job of await this.deps.store.list({ kind: "read", states: ["running"] }))
      await this.deps.store.put({ ...job, state: "pending", updatedAt: this.deps.now() });
    this.kick();
  }

  /** Work through what is due, one job at a time; started again whenever there is more. */
  kick(): void {
    if (this.running || this.stopped) return;
    this.wake?.();
    this.wake = null;
    this.running = this.drain()
      .catch((error: unknown) => this.deps.log?.(`long reads stopped: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.running = null;
      });
  }

  /** Once nothing due is left to read: what a caller that wants the whole answer now waits for. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** No more work, and no wake-up left behind: the server is closing. */
  stop(): void {
    this.stopped = true;
    this.wake?.();
    this.wake = null;
  }

  /** Until nothing is due. A job waiting out a rate limit is woken when its wait is over. */
  async drain(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const now = this.deps.now();
      const waiting = await this.deps.store.list({ kind: "read", states: ["pending", "waiting"] });
      const due = waiting.find((job) => job.notBefore === undefined || job.notBefore <= now);
      if (!due) {
        const soonest = Math.min(...waiting.map((job) => job.notBefore ?? Infinity));
        if (Number.isFinite(soonest)) this.later(Math.max(0, soonest - now));
        return;
      }
      await this.step(due);
    }
  }

  private later(ms: number): void {
    const schedule =
      this.deps.schedule ??
      ((wait: number, run: () => void) => {
        const timer = setTimeout(run, wait);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.wake?.();
    this.wake = schedule(ms, () => {
      this.wake = null;
      this.kick();
    });
  }

  /** One step of one job: a stretch of pages, from where it stopped. */
  private async step(job: Job): Promise<void> {
    const progress = job.progress as unknown as Progress;
    const connection = this.deps.getConnection(job.connection);
    const op = connection && job.op ? getOp(connection, job.op) : undefined;
    /* Gone, or changed since it started: what it read describes another configuration. */
    if (!connection || !op || fingerprintConnection(connection) !== job.configVersion) {
      await this.deps.store.remove(job.id);
      return;
    }
    await this.deps.store.put({ ...job, state: "running", updatedAt: this.deps.now() });
    let result: FetchResult;
    try {
      result = await this.deps.read(connection, { ...op, maxPages: this.deps.stepPages ?? LONG_READ_STEP }, progress.overrides, {
        params: progress.resolved,
        now: this.deps.now(),
        continueFrom: progress.continuation,
      });
    } catch (error) {
      await this.failed(job, error);
      return;
    }
    /* Forgotten while that stretch was read — a new key, the connection removed: nothing it read stands. */
    if ((await this.deps.store.get(job.id)) === null) return;
    const rows = rowsOf(result.body, progress.rowsPath);
    await this.deps.store.appendRows(job.id, rows);
    const pages = progress.pages + result.meta.pages;
    const read = progress.read + rows.length;
    const next = carriedOn(result);
    const reportedTotal = progress.reportedTotal ?? result.meta.reportedTotal;
    if (next && pages < LONG_READ_MAX_PAGES) {
      const carried: Progress = { ...progress, continuation: next, pages, read, ...(reportedTotal !== undefined ? { reportedTotal } : {}) };
      await this.deps.store.put({
        ...job,
        state: "pending",
        attempts: 0,
        progress: carried as unknown as Record<string, unknown>,
        updatedAt: this.deps.now(),
      });
      return;
    }
    await this.finish(job, progress, result, { pages, capped: next !== undefined, reportedTotal });
  }

  /** At its end, or as far as a job reads: the whole answer goes to the tile's key, the records go. */
  private async finish(
    job: Job,
    progress: Progress,
    result: FetchResult,
    end: { readonly pages: number; readonly capped: boolean; readonly reportedTotal: number | undefined },
  ): Promise<void> {
    const { pages, capped, reportedTotal } = end;
    const all = await this.deps.store.rows(job.id);
    const short = capped || result.meta.truncated;
    const warnings = [
      ...result.meta.warnings.filter((warning) => !/^Only the first \d+ page\(s\) were read/.test(warning)),
      ...(capped && progress.continuation.kind === "rest" ? [INCOMPLETE.pageCap(pages)] : []),
    ];
    const body = envelopeFor(progress.rowsPath, all);
    const { continuation: _continuation, ...meta } = result.meta;
    await this.deps.answer(progress.key, job.connection, {
      body,
      meta: {
        ...meta,
        pages,
        truncated: short,
        warnings,
        completion: short
          ? { state: "partial", reason: result.meta.completion?.reason ?? "page-cap" }
          : (result.meta.completion ?? { state: "unknown", reason: "connector-silent" }),
        ...(reportedTotal !== undefined ? { reportedTotal } : {}),
        /* A count stated on this read's own first page is about exactly what it asked for. */
        ...(job.scope && reportedTotal !== undefined && progress.continuation.kind === "rest" ? { totalScope: job.scope } : {}),
      },
    });
    /* The records go; the job stays, done, so a refresh knows this key is read this way. */
    await this.deps.store.remove(job.id);
    await this.deps.store.put({
      ...job,
      state: "done",
      attempts: 0,
      progress: { key: progress.key, read: all.length, pages },
      updatedAt: this.deps.now(),
    });
    this.deps.log?.(`read ${job.connection}/${job.op} to ${short ? "as far as a job reads" : "its end"}: ${all.length} records over ${pages} page(s)`);
  }

  /** A stretch that failed: a rate limit waited out, a refusal kept, anything else tried again later. */
  private async failed(job: Job, error: unknown): Promise<void> {
    const status = error instanceof AdapterError ? error.status : (error as { status?: number } | null)?.status;
    const message = (error instanceof AdapterError ? error.userMessage : error instanceof Error ? error.message : String(error)).slice(0, 300);
    const now = this.deps.now();
    /* The read changed under it: begun again from the start by the next refresh, not carried on. */
    if (status === 409) {
      await this.deps.store.remove(job.id);
      return;
    }
    /* The key was refused: nothing waiting will change that; a new key forgets the job. */
    if (status === 401 || status === 403) {
      await this.deps.store.put({ ...job, state: "blocked", error: message, updatedAt: now });
      return;
    }
    const attempts = job.attempts + 1;
    if (status === 429) {
      const retryAfter = error instanceof AdapterError ? error.retryAfter : undefined;
      const wait = Math.max(RETRY_MS, parseRetryAfter(retryAfter, now) ?? 0);
      await this.deps.store.put({ ...job, state: "waiting", attempts, notBefore: now + wait, error: message, updatedAt: now });
      return;
    }
    await this.deps.store.put({
      ...job,
      state: attempts >= MAX_ATTEMPTS ? "blocked" : "waiting",
      attempts,
      notBefore: now + RETRY_MS * 2 ** job.attempts,
      error: message,
      updatedAt: now,
    });
  }
}
