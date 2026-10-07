import { isWatchedTrigger, type WorkflowSpec, type WorkflowStart } from "@freebirdai/dash-spec";
import { STALL_MS } from "./engine.js";
import { reopenClaims } from "./run.js";
import { isDue } from "./schedule.js";
import { StartError, startWorkflow, type Starter } from "./start.js";

/**
 * What moves workflows on by themselves: one per workspace, beside the keeper.
 *
 * Every 30 seconds it:
 * 1. fires each enabled workflow whose schedule or API poll is due (under its lease);
 * 2. wakes every waiting case whose deadline has passed, down its time-out path
 *    (or to try again, for a step set to retry);
 * 3. hands on signals a busy case could not take when they arrived;
 * 4. carries on cases a stopped call left running, from what they wrote down,
 *    and opens the cases of records claimed by a run that stopped first;
 * 5. checks the records waiting cases watch, as each case may read them, and
 *    wakes those whose condition now holds.
 *
 * A tick still going when the next comes round is not doubled. A workflow the
 * API asked to wait (429) is left until the wait is over. A watched record
 * that cannot be read is tried again next tick, not taken as unchanged.
 *
 * Not started in tests unless asked: a suite that builds a server should not
 * acquire a timer.
 */

export const RUNNER_TICK_MS = 30_000;

export interface WorkflowRunnerOptions extends Starter {
  readonly tickMs?: number;
  readonly log?: { warn(line: string): void };
}

export class WorkflowRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private readonly notBefore = new Map<string, number>();

  constructor(private readonly options: WorkflowRunnerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? RUNNER_TICK_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
  }

  /** The workflows whose trigger is due now. */
  async due(): Promise<WorkflowSpec[]> {
    const { env } = this.options;
    const now = env.now();
    const out: WorkflowSpec[] = [];
    for (const workflow of await env.store.list()) {
      if (!workflow.enabled || workflow.parked || !isWatchedTrigger(workflow.trigger)) continue;
      if ((this.notBefore.get(workflow.id) ?? 0) > now) continue;
      const [last] = await env.store.runs({ workflow: workflow.id, limit: 1 });
      if (isDue(workflow.trigger, last ? Date.parse(last.startedAt) : null, Date.parse(workflow.updatedAt), now)) out.push(workflow);
    }
    return out;
  }

  /** Waiting cases whose watched record now matches. */
  async watchRecords(): Promise<number> {
    try {
      return await this.options.engine.pollRecords();
    } catch (error) {
      this.options.log?.warn(`waiting cases could not check their records: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  /** One pass. Exposed for tests, which drive the clock themselves. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        for (const workflow of await this.due()) {
          try {
            const { waitMs } = await startWorkflow(this.options, workflow, { kind: workflow.trigger.kind as WorkflowStart["kind"] });
            if (waitMs !== undefined) this.notBefore.set(workflow.id, this.options.env.now() + waitMs);
            else this.notBefore.delete(workflow.id);
          } catch (error) {
            if (error instanceof StartError && error.status === 409) continue;
            this.options.log?.warn(`workflow ${workflow.id} could not run: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        await this.options.engine.timeouts();
        await this.options.engine.deliverPending();
        await this.options.engine.recover();
        await reopenClaims(this.options.env, this.options.engine, new Date(this.options.env.now() - STALL_MS).toISOString());
        await this.watchRecords();
      } catch (error) {
        this.options.log?.warn(`workflows could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }
}
