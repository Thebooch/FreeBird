import { isWatchedTrigger, type WorkflowSpec, type WorkflowStart } from "@freebirdai/dash-spec";
import { isDue } from "./schedule.js";
import { StartError, startWorkflow, type Starter } from "./start.js";

/**
 * What starts workflows by themselves: one per workspace, beside the keeper.
 *
 * Every 30 seconds it lists the enabled workflows whose trigger is time or an
 * API, works out which are due from the trigger and when each last started,
 * and runs those, one at a time, each under its lease. A workflow the API
 * asked to wait (429) is left until the wait is over. A tick still going when
 * the next comes round is not doubled.
 *
 * Not started in tests unless asked, like the keeper: a suite that builds a
 * server should not acquire a timer.
 */

export const RUNNER_TICK_MS = 30_000;

export interface WorkflowRunnerOptions extends Starter {
  readonly tickMs?: number;
  readonly log?: { warn(line: string): void };
}

export class WorkflowRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  /** Workflows an API asked to wait, and until when. */
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

  /** The workflows due now. */
  async due(): Promise<WorkflowSpec[]> {
    const { env } = this.options;
    const now = env.now();
    const out: WorkflowSpec[] = [];
    for (const workflow of await env.store.list()) {
      if (!workflow.enabled || workflow.parked || !isWatchedTrigger(workflow.trigger)) continue;
      if ((this.notBefore.get(workflow.id) ?? 0) > now) continue;
      const [last] = await env.store.runs({ workflow: workflow.id, limit: 1 });
      const lastStartedAt = last ? Date.parse(last.startedAt) : null;
      /* Never run: counted from when it was last saved, which is when it was turned on. */
      if (isDue(workflow.trigger, lastStartedAt, Date.parse(workflow.updatedAt), now)) out.push(workflow);
    }
    return out;
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
            /* Another server holds it: it is running there. */
            if (error instanceof StartError && error.status === 409) continue;
            this.options.log?.warn(`workflow ${workflow.id} could not run: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        this.options.log?.warn(`workflows could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }
}
