import { taskLabel, type AgentSpec, type Check, type ScenarioInput, type Task, type Turn, type WorkflowCase, type WorkflowSpec } from "@freebirdai/dash-spec";
import { Redactor } from "./redact.js";
import { packForWorkflow } from "./workflow-pack.js";

/**
 * A real case, saved as a scenario: its stimulus and its world taken from
 * the case, its people redacted, and a check that keeps what went wrong from
 * happening again unattended. "Save as scenario" on a reversed or declined
 * task turns a mistake into a regression test.
 */

/** What started the case, as the turns a sandbox plays. Null when it cannot be played yet. */
const turnsOf = (one: WorkflowCase, workflow: WorkflowSpec): Turn[] | null => {
  const row = (one.data.row ?? {}) as Record<string, unknown>;
  switch (one.start.kind) {
    case "message":
      return [{ id: "email", kind: "message", payload: { from: (row["from"] as { address?: string } | undefined)?.address ?? "", name: (row["from"] as { name?: string } | undefined)?.name ?? "", subject: row["subject"] ?? "", text: row["text"] ?? row["snippet"] ?? "", ...(row["contact"] ? { contact: row["contact"] } : {}) } }];
    case "booking":
      return workflow.trigger.kind === "booking" ? [{ id: "booking", kind: "booking", payload: { event: workflow.trigger.events[0], row } }] : null;
    case "record_created":
    case "record_changed":
      return [
        { id: "record", kind: "record", payload: { add: [row] } },
        { id: "later", kind: "clock", payload: { ms: 24 * 3_600_000 }, after: "record" },
      ];
    case "manual":
    case "agent":
    case "approval":
      return [{ id: "start", kind: "start", payload: { workflow: workflow.id, inputs: one.data.input ?? {} } }];
    default:
      return null;
  }
};

/** What must not happen again: the step that was reversed or declined never runs unattended in this situation. */
const regressionOf = (task: Task): Check[] => {
  const label = taskLabel(task);
  if (!task.node || (label !== "wrong" && label !== "wrong_shipped" && label !== "partly_wrong")) return [];
  const words = label === "wrong_shipped" ? "was reversed" : label === "wrong" ? "was declined" : "was edited before it went";
  return [
    {
      kind: "rule",
      id: "not-again",
      dimension: "correctness",
      says: `"${task.title}" ${words}: in this situation it must not run unattended again.`,
      expect: "none",
      expr: `node == ${JSON.stringify(task.node)} && status == "done" && approvedBy == null`,
    },
  ];
};

export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveError";
  }
}

export const scenarioFromTask = (task: Task, one: WorkflowCase, workflow: WorkflowSpec, agents: readonly AgentSpec[], id: string): ScenarioInput => {
  /* The workflow as the case ran it: a later version may already have fixed what went wrong. */
  const turns = turnsOf(one, workflow);
  if (!turns) throw new SaveError("Dash cannot play what started this case in a test yet.");
  const row = (one.data.row ?? {}) as Record<string, unknown>;
  const contact = row["contact"] as { name?: string } | undefined;
  const from = row["from"] as { name?: string } | undefined;
  const redact = new Redactor([contact?.name ?? "", from?.name ?? "", String(row["title"] ?? "").replace(/^.* with /, "")]);
  const base = packForWorkflow(workflow, agents)[0];
  return {
    id,
    name: redact.text(`Saved from "${task.title}"`).slice(0, 120),
    direction: one.start.kind === "message" ? "inbound" : "outbound",
    target: { workflow: workflow.id },
    world: { provider: "empty", workspace: { agents: [...agents], workflows: [redact.value({ ...workflow, enabled: true, parked: undefined })], records: [] } },
    turns: redact.value(turns),
    ...(base?.scriptedModel ? { scriptedModel: base.scriptedModel } : {}),
    checks: [...(base?.checks ?? []), ...redact.value(regressionOf(task))],
  };
};
