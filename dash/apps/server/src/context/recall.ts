import type { LlmAdapter, LlmTool } from "@freebirdai/dash-agent";
import { z } from "zod";
import type { Focus } from "./focus.js";

/**
 * Before searching, look at what is already in hand.
 *
 * Most follow-ups are about the thing just discussed. "Is 123 Main St active?"
 * then "what's the address on file?" is the same record and a different field,
 * and the record is already held whole — searching again would spend requests
 * and model calls to arrive back where the conversation already was, and might
 * land on a different record while doing it.
 *
 * So one cheap call decides between three futures, and the distinction between
 * the last two is the useful part:
 *
 *   `answer`  — the held records contain it. Nothing is read, nothing is spent.
 *   `related` — it is about these records but needs something they only point
 *               at, which is what an identifier is for. A lookup, not a search.
 *   `search`  — a different subject. The focus is replaced by whatever the
 *               search finds.
 *
 * It is asked to lean toward `search` when unsure, because answering from the
 * wrong records is silent and searching again is merely slower.
 */

export const RECALL_SYSTEM_PROMPT = [
  "Some records are already in hand from earlier in this conversation, and a new question",
  "has just been asked. Decide what to do with it.",
  "",
  '- "answer": the records shown below already contain what was asked. Every field is here,',
  "  so nothing needs reading. Put what they say in `answer`.",
  '- "related": the question is about these same records but needs something they do not',
  "  contain and only point at — the things attached to them, their history, what belongs",
  "  to them. Say what is wanted in `wants`, in plain words.",
  '- "search": the question is about something else. A different subject, a different set of',
  "  records, or the same subject over a wider set than the few held here.",
  "",
  "Rules:",
  "- Answer only from the fields actually present. A field that is absent is a reason to",
  "  choose `related` or `search`, never to estimate.",
  "- These are the records a previous question matched, not everything that exists. A question",
  '  about how many there are in total, or about any record beyond these, is "search".',
  '- When you are unsure, choose "search". Reading again is slower; answering from the wrong',
  "  records is wrong and says nothing about being wrong.",
].join("\n");

const recallSchema = z.object({
  decision: z.enum(["answer", "related", "search"]),
  answer: z
    .string()
    .max(1200)
    .default("")
    .describe("What the held records say. Only when the decision is answer."),
  wants: z
    .string()
    .max(300)
    .default("")
    .describe("What related thing is needed. Only when the decision is related."),
});

const recallTool: LlmTool = {
  name: "use_context",
  description: "Decide whether the records already in hand answer this question.",
  schema: recallSchema,
};

export interface RecallResult {
  readonly decision: "answer" | "related" | "search";
  readonly answer: string;
  readonly wants: string;
  readonly error?: string;
}

/** How much of the held records the decision is allowed to see. */
const RECALL_CHARS = 12_000;

export const buildRecallPrompt = (input: {
  readonly question: string;
  readonly focus: Focus;
}): string => {
  const { focus } = input;
  return [
    `New question: ${input.question}`,
    "",
    `These ${focus.records.length} record(s) are in hand. They came from ` +
      `"${focus.sourceTitle || focus.source}" when the earlier question was: ` +
      `${JSON.stringify(focus.question)}.`,
    focus.idField
      ? `Each carries an identifier in "${focus.idField}", so things related to them can be looked up.`
      : "No identifier field was established for these, so nothing related can be looked up from them.",
    "",
    JSON.stringify(focus.records).slice(0, RECALL_CHARS),
  ].join("\n");
};

export const recallFromFocus = async (
  llm: LlmAdapter,
  input: { readonly question: string; readonly focus: Focus },
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<RecallResult> => {
  /*
   * Nothing held, nothing to decide. Not an error and not worth a call — the
   * ordinary search is exactly the right thing for the first question of a
   * conversation.
   */
  if (input.focus.records.length === 0) {
    return { decision: "search", answer: "", wants: "" };
  }

  let result: Awaited<ReturnType<LlmAdapter["generate"]>>;
  try {
    result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 600,
      messages: [
        { role: "system" as const, content: RECALL_SYSTEM_PROMPT },
        { role: "user" as const, content: buildRecallPrompt(input) },
      ],
      tools: { use_context: recallTool },
      toolChoice: { name: "use_context" as const },
    });
  } catch (cause) {
    /*
     * Falling back to a search rather than to an answer. The failure mode of
     * searching is a slower turn; the failure mode of answering from records
     * nobody checked is a confident wrong answer.
     */
    return {
      decision: "search",
      answer: "",
      wants: "",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const call = result.toolCalls.find((candidate) => candidate.name === "use_context");
  const parsed = call ? recallSchema.safeParse(call.args) : null;
  if (!parsed?.success) {
    return { decision: "search", answer: "", wants: "", error: "the model gave no decision" };
  }

  const decision = parsed.data.decision;
  const answer = parsed.data.answer.trim();
  const wants = parsed.data.wants.trim();

  // A decision that contradicts itself is not acted on: "answer" with nothing
  // to say, or "related" with nothing named, both mean the same thing here.
  if (decision === "answer" && !answer) return { decision: "search", answer: "", wants: "" };
  if (decision === "related" && !wants) return { decision: "search", answer: "", wants: "" };

  return { decision, answer, wants };
};
