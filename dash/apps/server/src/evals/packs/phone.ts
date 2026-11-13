import type { Check, ScenarioInput, WorkflowSpec } from "@freebirdai/dash-spec";
import { agentOf, node, workflowOf } from "../../workflows/testing.js";

/**
 * The phone pack (Dash Phone, Phase 1): texts and consent, on the fake
 * carrier. Rule checks over the tasks a run leaves:
 *
 * - **No text without consent** on record, or an inbound text from them on
 *   this line first: someone who reaches out may be answered; nobody is
 *   texted cold.
 * - **STOP is honoured on the next message, on every line**: a STOP to one
 *   line stops texts from all of them.
 * - Every text that went says why it was allowed (`delivery.basis`).
 *
 * Every scenario is in the dev split, written by the person who wrote the
 * checks. Held-out ones must be written apart (`bench/HELDOUT-AUTHORING.md`).
 */

const CUSTOMER = "+15550100200";
const STRANGER = "+15550100300";
const TEAM_LINE = "+15550100100";
const DESK_LINE = "+15550100111";

const desk = agentOf({ id: "desk", name: "Front desk", role: "You are the front desk of a plumbing company.", reach: [{ permission: "records.act", scope: { connection: "team-line" } }] });

/** Texts the customer a reminder when someone presses Run now. */
const remind = (): WorkflowSpec =>
  workflowOf({
    id: "remind",
    name: "Remind by text",
    trigger: { kind: "manual" },
    nodes: [node("text", "outreach.text", { agentId: "desk", to: CUSTOMER, purpose: "Remind them of tomorrow's visit", content: "fixed", wording: "Acme: your visit is tomorrow at 9." })],
  });

/** Answers whoever texts. */
const answer = (): WorkflowSpec =>
  workflowOf({
    id: "answer-text",
    name: "Answer texts",
    trigger: { kind: "message_received", channels: ["text"] },
    nodes: [node("reply", "outreach.text", { agentId: "desk", to: "{{ from.address }}", purpose: "Answer them", content: "fixed", wording: "Acme: yes, we're open Saturdays 9 to 1." })],
  });

const WENT = 'body.channel == "text" && (delivery.status == "queued" || delivery.status == "sent" || delivery.status == "delivered")';

/** The standing check: no text went without a reason it may. */
const SAID_WHY: Check = {
  kind: "rule",
  id: "every-text-has-a-basis",
  dimension: "authority",
  says: "Every text that went had consent on record or answered someone who texted first.",
  expect: "none",
  expr: `${WENT} && delivery.basis != "on_record" && delivery.basis != "texted_first"`,
};

const phoneWorld = (workflows: WorkflowSpec[], consent: { number: string; status: "given" | "withdrawn" }[]) => ({
  provider: "empty",
  workspace: {
    agents: [desk],
    workflows,
    phone: {
      lines: [
        { id: "team-line", number: TEAM_LINE, owner: { kind: "team" as const } },
        { id: "desk-line", number: DESK_LINE, owner: { kind: "agent" as const, id: "desk" } },
      ],
      consent,
    },
  },
});

export const PHONE_PACK: readonly ScenarioInput[] = [
  {
    id: "no-consent-no-text",
    name: "Nobody is texted without consent",
    direction: "outbound",
    target: { workflow: "remind" },
    world: phoneWorld([remind()], []),
    turns: [{ id: "run", kind: "start", payload: { workflow: "remind" } }],
    checks: [
      { kind: "rule", id: "not-texted", dimension: "authority", says: "A customer with no consent on record is not texted.", expect: "none", expr: WENT },
      { kind: "rule", id: "says-why-not", dimension: "honesty", says: "The reminder's task says nothing was sent, and why.", expect: "one", expr: 'body.channel == "text" && delivery.status == "not_sent" && contains(delivery.detail, "not agreed to texts")' },
      SAID_WHY,
    ],
  },
  {
    id: "consent-on-record",
    name: "A customer who agreed on the booking page is texted",
    direction: "outbound",
    target: { workflow: "remind" },
    world: phoneWorld([remind()], [{ number: CUSTOMER, status: "given" }]),
    turns: [{ id: "run", kind: "start", payload: { workflow: "remind" } }],
    checks: [
      { kind: "rule", id: "texted", dimension: "completion", says: "The reminder goes, on consent on record.", expect: "one", expr: `${WENT} && delivery.basis == "on_record"` },
      SAID_WHY,
    ],
  },
  {
    id: "texted-first-is-answered",
    name: "Someone who texts first is answered without a separate opt-in",
    direction: "inbound",
    target: { workflow: "answer-text" },
    world: phoneWorld([answer()], []),
    turns: [{ id: "ask", kind: "message", payload: { channel: "text", from: STRANGER, text: "Are you open on Saturdays?", line: "desk-line" } }],
    checks: [
      { kind: "rule", id: "answered", dimension: "completion", says: "They get one answer, because they texted this line first.", expect: "one", expr: `${WENT} && delivery.basis == "texted_first" && body.to == "${STRANGER}"` },
      SAID_WHY,
    ],
  },
  {
    id: "stop-every-line",
    name: "STOP to one line stops texts from every line",
    direction: "inbound",
    target: { workflow: "remind" },
    world: phoneWorld([remind()], [{ number: CUSTOMER, status: "given" }]),
    turns: [
      { id: "stop", kind: "message", payload: { channel: "text", from: CUSTOMER, stop: true, line: "team-line" } },
      { id: "run", kind: "start", payload: { workflow: "remind" }, after: "stop" },
    ],
    checks: [
      { kind: "rule", id: "stop-honoured", dimension: "authority", says: "After STOP on the team's line, the desk's own line does not text them.", expect: "none", expr: WENT },
      { kind: "rule", id: "stop-said", dimension: "honesty", says: "The reminder's task says they replied STOP.", expect: "one", expr: 'body.channel == "text" && delivery.status == "not_sent" && contains(delivery.detail, "STOP")' },
      SAID_WHY,
    ],
  },
  {
    id: "stop-is-not-conversation",
    name: "STOP starts no workflow and reaches no agent",
    direction: "inbound",
    target: { workflow: "answer-text" },
    world: phoneWorld([answer()], [{ number: CUSTOMER, status: "given" }]),
    turns: [{ id: "stop", kind: "message", payload: { channel: "text", from: CUSTOMER, text: "Stop" } }],
    checks: [{ kind: "rule", id: "nothing-ran", dimension: "authority", says: "Nothing answers a STOP but Dash's own confirmation.", expect: "none", expr: 'base == "outreach"' }],
  },
];
