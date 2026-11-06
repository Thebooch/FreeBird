import { actionVariant, type AgentSpec, type Check, type ScenarioInput, type ScriptedReply, type Turn, type WorkflowSpec } from "@freebirdai/dash-spec";

/**
 * The scenario pack Dash offers a workspace's own workflow: scenarios whose
 * turns fit its trigger, played against a copy of the workflow and the
 * workspace's agents, with checks every workflow should pass plus the
 * workflow's own standing checks.
 */

const HOUR = 3_600_000;

/** Someone outside the team, the same in every scenario so checks can name her. */
export const SAMPLE_CONTACT = { id: "sample-contact", name: "Dana Ruiz", email: "dana@example.com", phone: "+15550100" };

const sampleRecord = { id: "sample-1", title: "Sample record", status: "open", contact: SAMPLE_CONTACT };

/** What starts the workflow, as turns. */
const turnsFor = (workflow: WorkflowSpec): Turn[] | null => {
  const trigger = workflow.trigger;
  switch (trigger.kind) {
    case "booking":
      return [
        {
          id: "booking",
          kind: "booking",
          payload: {
            event: trigger.events[0],
            type: trigger.types[0] ?? "sample",
            row: { id: "sample-booking", title: `Booking with ${SAMPLE_CONTACT.name}`, when: "Tue, Oct 13, 9:00 AM CDT", contact: SAMPLE_CONTACT, type: { id: trigger.types[0] ?? "sample", name: "Sample appointment" }, host: { name: "Sam" } },
          },
        },
      ];
    case "message_received":
      return [{ id: "email", kind: "message", payload: { from: SAMPLE_CONTACT.email, name: SAMPLE_CONTACT.name, subject: "A question", text: "Hi, can someone call me back about my account? Thanks, Dana", mailbox: trigger.mailboxes[0] ?? "inbox", contact: SAMPLE_CONTACT } }];
    case "record_created":
    case "record_changed":
      return [
        { id: "record", kind: "record", payload: { add: [sampleRecord] } },
        { id: "later", kind: "clock", payload: { ms: 24 * HOUR }, after: "record" },
      ];
    case "every":
    case "schedule":
      return [{ id: "later", kind: "clock", payload: { ms: 25 * HOUR } }];
    case "manual":
    case "agent":
      return [{ id: "start", kind: "start", payload: { workflow: workflow.id, inputs: {} } }];
    default:
      return null;
  }
};

/** A plausible reply for each step that asks a model, in the order the steps come. */
const scriptedFor = (workflow: WorkflowSpec): ScriptedReply[] =>
  workflow.nodes.flatMap((node): ScriptedReply[] => {
    const variant = actionVariant(node.action);
    if (!variant?.modelTask) return [];
    if (node.action === "think.classify") {
      const categories = Array.isArray(node.settings["categories"]) ? (node.settings["categories"] as unknown[]) : [];
      return [{ args: { category: String(categories[0] ?? "other"), reason: "Scripted for a test." } }];
    }
    if (node.action === "think.extract") return [{ args: {} }];
    return [{ text: `Hi ${SAMPLE_CONTACT.name}, this is a scripted test message.` }];
  });

/** Checks every workflow should pass, whatever it does. */
const baseChecks = (workflow: WorkflowSpec): Check[] => {
  const outside = workflow.nodes.filter((node) => actionVariant(node.action)?.leavesDash && !node.graduated).map((node) => node.id);
  const checks: Check[] = [
    { kind: "rule", id: "did-something", dimension: "completion", says: "It ran at least one step.", expect: "some", expr: "true" },
    { kind: "rule", id: "no-failed-step", dimension: "completion", says: "No step failed or was lost.", expect: "none", expr: 'status == "failed" || status == "lost"' },
  ];
  if (workflow.trial > 0 && outside.length > 0) {
    checks.push({
      kind: "rule",
      id: "asks-in-trial",
      dimension: "authority",
      says: "In trial, every outside step waits for a person.",
      expect: "none",
      expr: `node in ${JSON.stringify(outside)} && status != "waiting_approval" && status != "skipped" && status != "dismissed"`,
    });
  }
  return checks;
};

/** The pack for one workflow. Empty when its trigger cannot be played yet. */
export const packForWorkflow = (workflow: WorkflowSpec, agents: readonly AgentSpec[]): ScenarioInput[] => {
  const turns = turnsFor(workflow);
  if (!turns) return [];
  const own = workflow.checks.filter((check) => !["did-something", "no-failed-step", "asks-in-trial"].includes(check.id));
  return [
    {
      id: `${workflow.id}-basic`.slice(0, 64),
      name: `${workflow.name}: what starts it`,
      direction: "outbound",
      target: { workflow: workflow.id },
      world: { provider: "empty", workspace: { agents: [...agents], workflows: [{ ...workflow, enabled: true, parked: undefined }], records: [] } },
      turns,
      scriptedModel: scriptedFor(workflow),
      checks: [...baseChecks(workflow), ...own],
    },
  ];
};
