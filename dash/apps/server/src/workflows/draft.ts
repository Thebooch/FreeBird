import {
  actionVariant,
  describeDuration,
  describeTrigger,
  firstNode,
  nextNode,
  nodeName,
  type AgentSpec,
  type Principal,
  type SuggestionId,
  type WorkflowNode,
  type WorkflowSpec,
} from "@freebirdai/dash-spec";
import type { WorkflowProblem, WorkflowService } from "./service.js";

/**
 * A draft workflow, explained: what the chat (and the builder) shows before
 * anything is saved.
 *
 * Whether something is missing is decided by the catalog, never by a model,
 * so the same request always surfaces the same questions. The model's part is
 * matching the person's words to actions and wording the questions; this file
 * says what to ask.
 */

export interface DraftQuestion {
  /** The step it is about, when it is about one. */
  readonly step?: string;
  readonly field?: string;
  readonly question: string;
  /** What is assumed if the person says "use the defaults". */
  readonly default?: string;
  /** `missing` must be answered; `suggestion` may be. */
  readonly kind: "missing" | "suggestion";
  readonly rule?: SuggestionId;
}

export interface DraftExplanation {
  /** The confirmation, in one plain sentence. */
  readonly sentence: string;
  /** Each step as "base · variant", with its mode and why. */
  readonly steps: ReadonlyArray<{ readonly id: string; readonly picked: string; readonly mode: string; readonly name: string }>;
  /** At most three at a time, the required ones first. */
  readonly questions: readonly DraftQuestion[];
  /** Problems that are not just a missing setting. */
  readonly problems: readonly WorkflowProblem[];
}

const words = (node: WorkflowNode, agents: ReadonlyMap<string, AgentSpec>): string => {
  const variant = actionVariant(node.action);
  const s = node.settings;
  if (!variant) return nodeName(node).toLowerCase();
  const agent = typeof s["agentId"] === "string" ? (agents.get(s["agentId"])?.name ?? s["agentId"]) : undefined;
  switch (variant.base) {
    case "outreach":
      return `${agent ?? "an agent"} ${variant.id === "outreach.call" ? "calls" : variant.id === "outreach.email" ? "emails" : "texts"} ${typeof s["to"] === "string" && s["to"] ? s["to"] : "them"}`;
    case "wait":
      return variant.id === "wait.for" ? `waits up to ${describeDuration(s["timeout"] ?? "2d")} for ${s["event"] === "record_change" ? "the record to change" : s["event"] === "decision" ? "an answer" : "a reply"}` : variant.id === "wait.duration" ? `waits ${describeDuration(s["duration"])}` : "waits until the time comes";
    case "branch":
      return `checks ${typeof s["condition"] === "string" ? s["condition"] : "the case"}`;
    case "ask":
      return `asks the team: ${typeof s["question"] === "string" ? s["question"] : "a question"}`;
    default:
      return `${variant.label.toLowerCase()}${typeof s["entity"] === "string" && s["entity"] ? ` (${s["entity"]})` : ""}`;
  }
};

/** The workflow in one sentence, following its main path: "When a new work order appears on Rentvine, …". */
export const sentenceFor = (workflow: Pick<WorkflowSpec, "trigger" | "nodes" | "edges">, agents: ReadonlyMap<string, AgentSpec>, names: Parameters<typeof describeTrigger>[1] = {}): string => {
  const parts: string[] = [];
  const seen = new Set<string>();
  let at = firstNode(workflow);
  while (at && !seen.has(at) && parts.length < 8) {
    seen.add(at);
    const node = workflow.nodes.find((one) => one.id === at);
    if (!node) break;
    parts.push(words(node, agents));
    const variant = actionVariant(node.action);
    at = nextNode(workflow, node.id, variant?.id === "wait.for" ? "timed_out" : variant?.id === "branch.if" ? "yes" : "next") ?? nextNode(workflow, node.id, "happened");
  }
  const trigger = describeTrigger(workflow.trigger, names);
  const opening = trigger === "By hand" ? "When someone runs it" : trigger.charAt(0).toUpperCase() + trigger.slice(1);
  return parts.length > 0 ? `${opening}, ${parts.join(", then ")}.` : `${opening}, nothing happens yet: it has no steps.`;
};

/** Whether a step, or one after it, is one `matches` takes. */
const reaches = (workflow: Pick<WorkflowSpec, "nodes" | "edges">, from: string | undefined, matches: (node: WorkflowSpec["nodes"][number]) => boolean): boolean => {
  const seen = new Set<string>();
  const queue = from ? [from] : [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = workflow.nodes.find((one) => one.id === id);
    if (!node) continue;
    if (matches(node)) return true;
    for (const edge of workflow.edges) if (edge.from === id) queue.push(edge.to);
  }
  return false;
};

/** The suggestions a draft earns, by the catalog's rules. */
export const suggestionsFor = (workflow: Pick<WorkflowSpec, "nodes" | "edges">): DraftQuestion[] => {
  const out: DraftQuestion[] = [];
  for (const node of workflow.nodes) {
    const variant = actionVariant(node.action);
    if (!variant?.suggestions) continue;
    for (const rule of variant.suggestions) {
      if (rule === "follow_up_after_outreach") {
        const after = workflow.nodes.find((one) => one.id === nextNode(workflow, node.id, "next"));
        const waits = after?.action === "wait.for" && after.settings["event"] !== "record_change" && after.settings["step"] === node.id;
        if (!waits) out.push({ kind: "suggestion", rule, step: node.id, question: `Add a follow-up if they don't reply to "${nodeName(node)}"? How long should it wait first?`, default: "Yes, after 2 days" });
      }
      if (rule === "outreach_on_auto" && node.mode === "auto") out.push({ kind: "suggestion", rule, step: node.id, field: "mode", question: `"${nodeName(node)}" will reach people without anyone reviewing it. Keep it on Approve?`, default: "Yes, approve" });
      if (rule === "delete_on_auto" && node.mode === "auto") out.push({ kind: "suggestion", rule, step: node.id, field: "mode", question: `"${nodeName(node)}" deletes records without review. Keep it on Approve?`, default: "Yes, approve" });
      /* Telling the person: a booking that was offered other times or denied should hear it from someone. */
      if (rule === "inform_after_decision") {
        const silent = ["suggested", "denied"].filter((outcome) => {
          const to = workflow.edges.find((edge) => edge.from === node.id && edge.outcome === outcome)?.to;
          return !reaches(workflow, to, (one) => one.action === "outreach.inform" || one.action.startsWith("outreach."));
        });
        if (silent.length > 0) {
          out.push({ kind: "suggestion", rule, step: node.id, question: `When "${nodeName(node)}" is ${silent.join(" or ")}, tell the person? Add Tell them what was decided after it?`, default: "Yes, tell them" });
        }
      }
      /* Without a timed-out path the case ends quietly and the slot stays held until its hold runs out. */
      if (rule === "booking_timeout_path" && !workflow.edges.some((edge) => edge.from === node.id && edge.outcome === "timed_out")) {
        out.push({ kind: "suggestion", rule, step: node.id, question: `If nobody answers "${nodeName(node)}" in time, what happens? Without a path the time stays held until the hold runs out.`, default: "Cancel and tell them" });
      }
    }
  }
  return out;
};

/** Explain a draft: the sentence, what was picked, and what to ask (three at most). */
export const explainDraft = async (
  service: WorkflowService,
  principal: Principal,
  workflow: WorkflowSpec,
  agents: readonly AgentSpec[],
  names: Parameters<typeof describeTrigger>[1] = {},
): Promise<DraftExplanation> => {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const problems = await service.problems(principal, workflow, workflow.id);
  const missing: DraftQuestion[] = problems
    .filter((one) => one.incomplete)
    .map((one) => ({ kind: "missing" as const, question: one.ask ?? one.message, ...(one.step ? { step: one.step } : {}), ...(one.field ? { field: one.field } : {}) }));
  return {
    sentence: sentenceFor(workflow, byId, names),
    steps: workflow.nodes.map((node) => {
      const variant = actionVariant(node.action);
      return {
        id: node.id,
        name: nodeName(node),
        picked: variant ? `${variant.base === "run_workflow" ? "Run a workflow" : variant.base.charAt(0).toUpperCase() + variant.base.slice(1)} · ${variant.label}` : node.action,
        mode: variant?.leavesDash ? (node.mode === "auto" ? "Auto" : "Approve") : "Always done",
      };
    }),
    questions: [...missing, ...suggestionsFor(workflow)].slice(0, 3),
    problems: problems.filter((one) => !one.incomplete),
  };
};
