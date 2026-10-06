import type { WriteIntent } from "@freebirdai/connect";
import {
  renderText,
  renderValue,
  stepMode,
  type AgentSpec,
  type CalendarEvent,
  type Principal,
  type WorkflowRunOutput,
  type WorkflowSpec,
  type WorkflowStep,
  type WorkflowStepKind,
} from "@freebirdai/dash-spec";
import { makeChange } from "./changes.js";
import type { WorkflowEnv } from "./env.js";
import { runThink } from "./think.js";

/**
 * What each kind of step does.
 *
 * A registry rather than a switch, so the steps that arrive later — a report
 * sent (step 6), an email or a text delivered (steps 7 and 9) — each register
 * an executor beside these without touching the run.
 */

export interface StepInput<K extends WorkflowStepKind = WorkflowStepKind> {
  readonly env: WorkflowEnv;
  readonly workflow: WorkflowSpec;
  readonly run: string;
  readonly step: Extract<WorkflowStep, { kind: K }>;
  /** Whose permission an auto step uses. */
  readonly actor: Principal | null;
  /** The agent the run is in the name of: it started the run. */
  readonly agent: AgentSpec | null;
  /** The connection the workflow reads, for steps that do not name one. */
  readonly connection?: string | undefined;
  /** For a step done once a row: the row, with the inputs as `input`, and its key. */
  readonly row?: Record<string, unknown> | undefined;
  readonly rowKey?: string | undefined;
  /** For a step done once a run: every matched row. */
  readonly rows: ReadonlyArray<{ readonly key: string; readonly row: Record<string, unknown> }>;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export type WorkflowStepExecutor<K extends WorkflowStepKind = WorkflowStepKind> = (input: StepInput<K>) => Promise<WorkflowRunOutput[]>;

export type ExecutorRegistry = { readonly [K in WorkflowStepKind]?: WorkflowStepExecutor<K> };

const base = (input: { readonly step: { readonly id: string; readonly kind: string }; readonly rowKey?: string | undefined }) => ({ step: input.step.id, kind: input.step.kind, ...(input.rowKey !== undefined ? { row: input.rowKey } : {}) });

/** The row a step done once a run reads its templates against: how many matched, and the inputs. */
const runRow = (input: { readonly rows: StepInput["rows"]; readonly inputs: StepInput["inputs"] }): Record<string, unknown> => ({ count: input.rows.length, input: input.inputs });

/** A date or a date and time, from whatever a template made: an ISO string, a date, epoch milliseconds. */
export const toWhen = (value: unknown): { readonly at: string; readonly dateOnly: boolean } | null => {
  if (typeof value === "number" && Number.isFinite(value)) return { at: new Date(value).toISOString(), dateOnly: false };
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(text))) return { at: text, dateOnly: true };
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? { at: new Date(parsed).toISOString(), dateOnly: false } : null;
};

const calendar: WorkflowStepExecutor<"calendar"> = async (input) => {
  const { env, step } = input;
  const row = input.row ?? runRow(input);
  const now = env.now();
  let title: string;
  let when: ReturnType<typeof toWhen>;
  let end: ReturnType<typeof toWhen> = null;
  try {
    title = renderText(step.title, row, now).trim();
    when = toWhen(renderValue(step.at, row, now));
    if (step.end) end = toWhen(renderValue(step.end, row, now));
  } catch (error) {
    return [{ ...base(input), outcome: "failed", detail: `The calendar entry could not be written: ${error instanceof Error ? error.message : String(error)}` }];
  }
  if (!when) return [{ ...base(input), outcome: "skipped", detail: `"${title || step.title}" has no date to put it on.` }];
  const owner = step.owner ?? (input.agent ? { kind: "agent" as const, id: input.agent.id } : undefined);
  const event: CalendarEvent = {
    id: env.newId(),
    title: title || "Untitled",
    at: when.at,
    ...(end ? { end: end.at } : {}),
    allDay: step.allDay || when.dateOnly,
    deadline: step.deadline,
    ...(owner ? { owner } : {}),
    workflow: input.workflow.id,
    run: input.run,
    ...(input.rowKey !== undefined ? { row: input.rowKey } : {}),
    createdAt: new Date(now).toISOString(),
  };
  await env.calendar.put(event);
  return [{ ...base(input), outcome: "done", detail: `${event.deadline ? "Deadline" : "On the calendar"}: ${event.title}, ${event.at}`, calendar: event.id }];
};

const note: WorkflowStepExecutor<"note"> = async (input) => {
  try {
    const text = renderText(input.step.text, input.row ?? runRow(input), input.env.now()).trim();
    return [{ ...base(input), outcome: "done", detail: text }];
  } catch (error) {
    return [{ ...base(input), outcome: "failed", detail: `The note could not be written: ${error instanceof Error ? error.message : String(error)}` }];
  }
};

const proposeChange: WorkflowStepExecutor<"propose_change"> = async (input) => {
  const { env, step } = input;
  const connection = step.connection ?? input.connection;
  if (!connection) return [{ ...base(input), outcome: "failed", detail: "Say which connection the change is on." }];
  const row = input.row ?? runRow(input);
  const now = env.now();
  let intent: WriteIntent;
  try {
    const id = step.recordId !== undefined && step.change !== "create" ? renderText(step.recordId, row, now).trim() : undefined;
    if (step.change !== "create" && !id) return [{ ...base(input), outcome: "skipped", detail: `This row has no ${step.entity} to change.` }];
    const parents = step.parents ? Object.fromEntries(Object.entries(step.parents).map(([name, value]) => [name, renderText(value, row, now)])) : undefined;
    const values = step.values ? Object.fromEntries(Object.entries(step.values).map(([path, value]) => [path, renderValue(value, row, now)])) : undefined;
    intent = {
      connection,
      entity: step.entity,
      kind: step.change,
      ...(step.change === "action" && step.action ? { action: step.action } : {}),
      ...(id ? { id } : {}),
      ...(parents ? { parents } : {}),
      ...(values ? { values } : {}),
    };
  } catch (error) {
    return [{ ...base(input), outcome: "failed", detail: `The change could not be worked out: ${error instanceof Error ? error.message : String(error)}` }];
  }
  return [
    await makeChange(
      {
        env,
        workflow: input.workflow,
        run: input.run,
        actor: input.actor,
        agent: input.agent,
        mode: stepMode(step),
        step: step.id,
        stepKind: step.kind,
        rowKey: input.rowKey,
      },
      step.change,
      intent,
    ),
  ];
};

/**
 * Hand a conversation to an agent. Texts, calls and email are delivered by
 * Comms (steps 7 and 9), which registers the real executor; until then the
 * run says what it would have done.
 */
const message: WorkflowStepExecutor<"message"> = async (input) => {
  const { step } = input;
  const row = input.row ?? runRow(input);
  let to = step.to;
  try {
    to = renderText(step.to, row, input.env.now());
  } catch {
    /* Said as written. */
  }
  return [{ ...base(input), outcome: "skipped", detail: `Would have had ${step.agentId} ${step.channel} ${to || "nobody"}: texts, calls and email are not set up yet.` }];
};

const think: WorkflowStepExecutor<"think"> = (input) => runThink(input);

export const DEFAULT_EXECUTORS: ExecutorRegistry = {
  calendar,
  note,
  propose_change: proposeChange,
  message,
  think,
};
