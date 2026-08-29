/**
 * What the reply step is actually shown.
 *
 * Run by hand, spends nothing. It exists because a reply reported a due date
 * of August 12th for a record that says the 17th, and the only way to tell
 * whether the model invented that or was handed a fragment is to look at what
 * it was handed.
 *
 *   pnpm eval:reply [--find dishwasher]
 */

import { renderDashReply, createPromptRotation } from "../chat/respond.js";
import type { FinalReplyContext } from "@freebirdai/core";

const rows = Array.from({ length: 50 }, (_, i) => ({
  Id: 5216600 + i,
  TaskType: "ResidentRequest",
  Category: { Id: 28053, Name: "Inspections", Href: "https://api.buildium.com/v1/x/28053" },
  Title: i === 38 ? "Dishwasher" : "Rent Increase Evaluation",
  Description: "Re Key\nFinal Inspection, plus a good deal of further detail besides.",
  Property: { Id: 213910, Type: "Rental", Href: "https://api.buildium.com/v1/rentals/213910" },
  TaskStatus: "InProgress",
  Priority: "Normal",
  DueDate: i === 38 ? "2026-08-17" : "2026-08-06",
  CreatedDateTime: i === 38 ? "2026-08-07T01:02:32Z" : "2026-08-01T07:18:00Z",
}));

const ctx: FinalReplyContext = {
  sessionId: "probe",
  userText: "are there any tasks dealing with dishwashers? when is it due?",
  draft: "",
  deterministic: "",
  actionState: { phase: "idle", pending: null, journal: [], workflowStack: [] },
  actionsRun: [],
  clarificationQuestion: "",
  executedExtraTools: [
    {
      name: "answer_from_data",
      args: { question: "any tasks about dishwashers?" },
      result: {
        outcome: "found",
        looked: ["all-tasks--new-tab"],
        missing: "",
        answer: "One task titled Dishwasher.",
        requests: 1,
        findings: [
          {
            source: "All Tasks",
            tab: "Test",
            describes: "a table",
            columns: Object.keys(rows[0]!),
            shows: ["TaskType", "Title", "TaskStatus", "Priority", "DueDate", "CreatedDateTime"],
            coverage: "read in full — all 50 record(s)",
            rows,
            caveats: [],
          },
        ],
      },
    },
  ],
};

const prompt = renderDashReply(ctx, {
  sessionId: "probe",
  rotate: createPromptRotation(),
});

const findAt = process.argv.indexOf("--find");
const needle = findAt === -1 ? "Dishwasher" : (process.argv[findAt + 1] ?? "Dishwasher");

console.log(`\nPROMPT  ${prompt.length} chars`);
console.log(`  "${needle}" present: ${prompt.includes(needle)}`);
console.log(`  its due date present: ${prompt.includes("2026-08-17")}`);

const rowsLine = prompt.split("\n").find((line) => line.trim().startsWith("rows: "));
if (!rowsLine) {
  console.log("  NO rows line — the finding was not rendered as rows at all");
} else {
  const json = rowsLine.trim().slice("rows: ".length);
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>[];
    console.log(`  rows rendered: ${parsed.length}, valid JSON, keys ${Object.keys(parsed[0] ?? {}).join(", ")}`);
    const hit = parsed.find((row) => JSON.stringify(row).includes(needle));
    console.log(`  the matching row as the model sees it: ${JSON.stringify(hit ?? null)}`);
  } catch (error) {
    console.log(`  rows line is NOT valid JSON: ${String(error).slice(0, 120)}`);
  }
}
console.log();
