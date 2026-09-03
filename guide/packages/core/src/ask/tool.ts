import { z } from "zod";
import type { LlmTool } from "../adapters/llm.js";
import type { PendingQuestion, QuestionAnswer, QuestionOption } from "./types.js";

export const ASK_USER_TOOL_NAME = "ask_user";

/**
 * Ask the user a structured question and stop.
 *
 * Unlike `review_items`, this is **not** host-executed: the answer comes from
 * a human, so the turn has to end and resume on the next one. The template is
 * the action layer's `awaiting_confirmation` — emit an event, stop, let the
 * client render, pick the thread back up when the answer arrives.
 */
export const buildAskUserTool = (): LlmTool => ({
  name: ASK_USER_TOOL_NAME,
  description:
    "Ask the user one multiple-choice question when you genuinely cannot proceed without " +
    "their answer — an ambiguous reference, or a choice only they can make. Prefer this " +
    "over guessing, and over asking in prose. Do not use it for anything you can look up, " +
    "and do not use it to confirm an action: actions have their own confirmation step.",
  schema: z.object({
    question: z.string().min(1).describe("The question, in one sentence."),
    options: z
      .array(
        z.object({
          value: z.string().min(1).describe("Stable value returned when chosen."),
          label: z.string().min(1).describe("What the user reads."),
          description: z.string().optional().describe("One line of extra context."),
        }),
      )
      .min(2)
      .max(10)
      .describe("Between two and ten choices."),
    multiSelect: z
      .boolean()
      .optional()
      .describe("True when more than one option may be chosen."),
  }),
});

/** Parse a model's `ask_user` arguments, or null when they are unusable. */
export const parseAskUserArgs = (
  raw: unknown,
): { question: string; options: QuestionOption[]; multiSelect: boolean } | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const question = typeof o.question === "string" ? o.question.trim() : "";
  if (!question) return null;

  const rawOptions = Array.isArray(o.options) ? o.options : [];
  const options: QuestionOption[] = [];
  for (const entry of rawOptions) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const value = typeof e.value === "string" ? e.value : "";
    const label = typeof e.label === "string" && e.label ? e.label : value;
    if (!value) continue;
    options.push({
      value,
      label,
      ...(typeof e.description === "string" && e.description
        ? { description: e.description }
        : {}),
    });
  }
  // A question with fewer than two choices is not a choice. Better to drop the
  // call and let the model speak than to render a card with one button.
  if (options.length < 2) return null;

  return { question, options, multiSelect: o.multiSelect === true };
};

/**
 * The system block telling the model what it already asked and was told.
 *
 * Rendered as fact rather than replayed as a user message: the user did not
 * type "March", they clicked it, and a transcript that claims otherwise makes
 * every later turn reason about words nobody said.
 */
export const buildAnswersPrompt = (answers: readonly QuestionAnswer[]): string => {
  if (answers.length === 0) return "";
  const lines = answers.map(
    (answer) => `- You asked: "${answer.question}" — the user chose: ${answer.values.join(", ")}`,
  );
  return ["## Answers", "", "Treat these as settled; do not ask again.", "", ...lines].join("\n");
};

/** Build the pending question a client renders, from parsed args. */
export const toPendingQuestion = (
  questionId: string,
  parsed: { question: string; options: QuestionOption[]; multiSelect: boolean },
): PendingQuestion => ({
  questionId,
  question: parsed.question,
  options: parsed.options,
  multiSelect: parsed.multiSelect,
});
