import type { LlmAdapter, LlmTool } from "@freebirdai/dash-agent";
import { z } from "zod";
import { PAGE_SIZE } from "./read.js";
import type { Evidence } from "./types.js";

/**
 * Did what we just read actually answer the question?
 *
 * This is the step that makes the loop a search rather than a single guess.
 * Without it the first source picked is the answer whatever it contains, and
 * the failure mode is the one this whole pass exists to remove: a confident
 * reply drawn from data that does not support it.
 *
 * It deliberately does not write the answer. The final response step does
 * that, with everything in hand; asking a cheap model to both judge and
 * phrase would put the user-facing voice on the wrong model and make a
 * mis-judgement invisible inside a fluent sentence.
 */

export const JUDGE_SYSTEM_PROMPT = [
  "You are checking whether a sample of somebody's own data answers their question.",
  "",
  "You are given the question and the rows that were read, with a note saying how much of",
  "the source was covered. Decide one of three things:",
  "",
  '- "found": the rows contain what was asked for. Say what the answer is in `answer`,',
  "  drawn only from the rows - never from what you expect the data to look like.",
  '- "partial": the rows are relevant but not sufficient. Common reasons: the answer needs',
  "  a second source, or only part of the records were read and the rest could change it.",
  '- "miss": these rows cannot answer the question at all.',
  "",
  "Rules:",
  "- Coverage is part of the judgement. If only some records were read and the question is",
  '  about a maximum, a total, or "all" of something, that is "partial", not "found" - the',
  "  records not read could change the answer.",
  "- Never fill a gap with a plausible value. If a field is absent, that is a miss or a",
  "  partial, and saying so is what lets the next source be tried.",
  "- In `missing`, say what is still needed in plain words, so the next search can use it.",
].join("\n");

const judgeSchema = z.object({
  verdict: z.enum(["found", "partial", "miss"]),
  answer: z
    .string()
    .max(1200)
    .default("")
    .describe("What the rows say, when the verdict is found or partial. Facts, not prose."),
  missing: z
    .string()
    .max(400)
    .default("")
    .describe("What is still needed. Empty when the verdict is found."),
  matched: z
    .array(z.number().int().min(0))
    .max(50)
    .default([])
    .describe(
      "The 0-based positions of the rows the question is actually about, from the list " +
        "you were shown. Name every one that matches and nothing that does not. Leave it " +
        "empty when the question is about the set as a whole rather than particular rows.",
    ),
});

const judgeTool: LlmTool = {
  name: "judge_evidence",
  description: "Say whether these rows answer the question.",
  schema: judgeSchema,
};

export interface JudgeResult {
  readonly verdict: "found" | "partial" | "miss";
  readonly answer: string;
  readonly missing: string;
  /**
   * Which rows the question was about, by position in what the judge was shown.
   *
   * These become the conversation's focus — kept whole, so a follow-up about a
   * different field of the same record costs nothing, and its identifier is in
   * hand for looking up anything related.
   */
  readonly matched: readonly number[];
  readonly error?: string;
}

/**
 * How many rows the judge is shown.
 *
 * The whole ordinary sample, deliberately. It was 20 against a 50-row read,
 * and the judge — correctly reporting what it could see — answered "none of
 * the 20 checked" while the coverage line beside it said all 50 were read.
 * The reply then carried both, which is worse than either: the reader cannot
 * tell whether 30 records are unknown or the assistant simply lost track.
 *
 * A judge that sees less than was read cannot help but understate the scope,
 * so on the ordinary path it now sees all of it. A deep read is bigger than
 * this on purpose and is judged by the chunked pass instead — which is why
 * the prompt below is told the numbers rather than left to assume them.
 */
const JUDGE_ROWS = PAGE_SIZE;

export const describeCoverage = (evidence: Evidence): string => {
  const { coverage } = evidence;
  if (!coverage.partial) {
    return `All ${coverage.scanned} record(s) this source holds were read.`;
  }
  const ordering = coverage.orderedBy
    ? `the first ${coverage.scanned} in order of ${coverage.orderedBy}`
    : `the first ${coverage.scanned} this source lists, in no particular order`;
  return (
    `Only part of this source was read: ${ordering}` +
    (coverage.of !== null ? ` out of ${coverage.of}` : "") +
    ". Records that were not read could change an answer about a maximum, a total, or all of something."
  );
};

/**
 * Fit a sample into a budget by losing detail, never a whole record.
 *
 * The failure that wrote this: asked whether any task mentioned a dishwasher,
 * the assistant said it had read all fifty and found none. One of them was
 * titled "Dishwasher" — at index 38 of 50, in a set that serializes to 35,654
 * characters. The judge was handed `JSON.stringify(rows).slice(0, 12_000)`,
 * which is the first seventeen rows and half of the eighteenth. It answered
 * honestly about what it could see and the answer was wrong, with no hint that
 * anything was missing.
 *
 * So the order of sacrifice is fixed, and it is the opposite of what a naive
 * cap does. Every row survives if at all possible, because a dropped row turns
 * "no match" into a confident lie. What gets dropped first is *width*: a
 * Buildium task row is 700 characters of nested objects and href URLs around
 * six fields anybody is actually looking at. Narrowing to the columns the tile
 * draws takes the same fifty rows to a tenth of the size.
 *
 * Only if the narrow form still does not fit are rows dropped, and then the
 * caller is told exactly how many so the prompt can say so and the verdict can
 * be held to `partial`.
 */
export interface FittedRows {
  readonly shown: Record<string, unknown>[];
  readonly json: string;
  /** Fields removed to make it fit. Empty when every field survived. */
  readonly droppedFields: string[];
  /** Rows that did not fit even narrowed. Zero when all of them are shown. */
  readonly droppedRows: number;
}

const encode = (rows: readonly Record<string, unknown>[]): string => JSON.stringify(rows);

const narrow = (
  rows: readonly Record<string, unknown>[],
  keep: readonly string[],
): Record<string, unknown>[] =>
  rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const field of keep) if (field in row) out[field] = row[field];
    return out;
  });

export const fitRows = (
  rows: readonly Record<string, unknown>[],
  budget: number,
  /**
   * Fields to keep whatever it costs. The record's identity, in practice.
   *
   * Size is a good proxy for importance and not a guarantee: squeezed to two
   * fields per row, this keeps `UnitId` over `Id` purely because the unit
   * number is a shorter number — dropping the one field every follow-up lookup
   * needs. So the identity is named rather than inferred.
   */
  protect: readonly string[] = [],
): FittedRows => {
  const whole = encode(rows);
  if (whole.length <= budget) {
    return { shown: [...rows], json: whole, droppedFields: [], droppedRows: 0 };
  }

  const present = [...new Set(rows.flatMap((row) => Object.keys(row)))];

  /*
   * Width first, by size: the widest field goes, then the next, until the rows
   * fit. A nested object full of hrefs is worth many times a title, and it is
   * the title the question is about.
   *
   * This used to keep the widget's own columns instead, on the reasoning that
   * people ask about what they can see. Twice that reasoning produced a
   * confident wrong answer. Asked whether any task mentioned a dishwasher, the
   * reply said it had read all fifty and found none — the row was there, and
   * the field holding it was not one the tile drew. Asked for a property's
   * identifier, the reply said it was "omitted from the displayed data", while
   * the same row sat whole in the session's own memory and the widget's
   * drill-down was `{{row.Id}}` — a field the tile depends on and does not
   * show.
   *
   * So the rule is reversed: the model always gets the fullest record that
   * fits, whatever the tile happens to draw. Being unable to answer is a
   * bigger failure than quoting a field nobody can see, and the rarer case —
   * "where did that come from, I don't see it" — is a question somebody can
   * simply ask, answered from `shows` and `look_up_widget`.
   *
   * Sorting by size also protects identifiers for free. An `Id` is among the
   * smallest fields a record has, so it is the last thing to go rather than,
   * as before, one of the first.
   */
  const width = new Map<string, number>();
  for (const field of present) {
    let total = 0;
    for (const row of rows) total += JSON.stringify(row[field] ?? null).length;
    width.set(field, total);
  }
  const kept = new Set(protect.filter((field) => present.includes(field)));
  const widestFirst = [...present]
    .filter((field) => !kept.has(field))
    .sort((a, b) => (width.get(b) ?? 0) - (width.get(a) ?? 0));

  const keeping = new Set(present);
  const droppedBySize: string[] = [];
  for (const field of widestFirst) {
    // Never drop the last field: a row of nothing is not a narrower row.
    if (keeping.size <= 1) break;
    const narrowed = narrow(rows, [...keeping]);
    const json = encode(narrowed);
    if (json.length <= budget) {
      return { shown: narrowed, json, droppedFields: [...droppedBySize], droppedRows: 0 };
    }
    keeping.delete(field);
    droppedBySize.push(field);
  }

  /*
   * Only now, rows — whole ones, and counted so the caller can say how many
   * and the prompt can refuse a definitive answer.
   */
  const keptFields = [...keeping];
  const base = narrow(rows, keptFields);
  const droppedFields = present.filter((field) => !keptFields.includes(field));
  const shown: Record<string, unknown>[] = [];
  let used = 2; // the enclosing brackets
  for (const row of base) {
    const encoded = JSON.stringify(row);
    const cost = encoded.length + (shown.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    used += cost;
    shown.push(row);
  }
  return {
    shown,
    json: encode(shown),
    droppedFields,
    droppedRows: base.length - shown.length,
  };
};

/** What the judge may be shown, in characters. */
const JUDGE_CHARS = 24_000;

/**
 * The sample the judge sees, computed once.
 *
 * Shared with `judgeEvidence` because the positions the judge answers with are
 * indices into *this* list. Recomputing it there with different arguments —
 * even accidentally — would map a matched row onto a different record, and the
 * conversation would then be about something nobody asked about.
 *
 * Narrowing preserves order and never removes a row, so position `i` here is
 * position `i` of what was read; only a sample that had to drop rows is
 * shorter, and it is a prefix.
 */
export const judgeSample = (evidence: Evidence) =>
  fitRows(
    evidence.rows.slice(0, JUDGE_ROWS),
    JUDGE_CHARS,
    evidence.candidate.idField ? [evidence.candidate.idField] : [],
  );

export const buildJudgePrompt = (input: {
  readonly question: string;
  readonly evidence: Evidence;
}): string => {
  const { evidence } = input;
  const fitted = judgeSample(evidence);
  const rows = fitted.shown;
  return [
    `Question: ${input.question}`,
    "",
    `Source: ${evidence.candidate.title}` +
      (evidence.candidate.describes ? ` - ${evidence.candidate.describes}` : ""),
    `Columns: ${evidence.columns.join(", ") || "(none)"}`,
    describeCoverage(evidence),
    ...(evidence.warnings.length > 0
      ? [`Caveats from reading it: ${evidence.warnings.join("; ")}`]
      : []),
    "",
    fitted.droppedRows > 0
      ? `Rows: ${rows.length} of ${evidence.rows.length}. ${fitted.droppedRows} did not fit ` +
        `and you have NOT seen them. If what you are looking for is absent from these, the ` +
        `verdict is "partial", never "found" — you cannot rule out a record you were not shown.`
      : `Rows: all ${rows.length} of them. Nothing was withheld, so "not present here" is a ` +
        `real finding you can report as found.`,
    ...(fitted.droppedFields.length > 0
      ? [
          `Each row has been narrowed to the columns this widget displays. Fields not shown ` +
            `to you: ${fitted.droppedFields.slice(0, 20).join(", ")}. If the question needs ` +
            `one of those, say so in \`missing\` rather than answering without it.`,
        ]
      : []),
    fitted.json,
  ].join("\n");
};

export const judgeEvidence = async (
  llm: LlmAdapter,
  input: { readonly question: string; readonly evidence: Evidence },
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<JudgeResult> => {
  /*
   * Nothing came back. Asking a model to judge an empty table spends a call to
   * be told what is already known - and an empty source is a real answer to
   * some questions, so it is reported rather than treated as a failure.
   */
  if (input.evidence.rows.length === 0) {
    return {
      verdict: "miss",
      answer: "",
      missing: `"${input.evidence.candidate.title}" is empty, so it says nothing about this`,
      matched: [],
    };
  }

  let result: Awaited<ReturnType<LlmAdapter["generate"]>>;
  try {
    result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 800,
      messages: [
        { role: "system" as const, content: JUDGE_SYSTEM_PROMPT },
        { role: "user" as const, content: buildJudgePrompt(input) },
      ],
      tools: { judge_evidence: judgeTool },
      toolChoice: { name: "judge_evidence" as const },
    });
  } catch (cause) {
    return {
      verdict: "partial",
      answer: "",
      missing: "",
      matched: [],
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const call = result.toolCalls.find((candidate) => candidate.name === "judge_evidence");
  const parsed = call ? judgeSchema.safeParse(call.args) : null;
  /*
   * An unreadable verdict is treated as "partial", not "miss": the rows were
   * really read and really are in hand, so discarding them because the judge
   * malfunctioned would throw away evidence the response step can still use.
   */
  if (!parsed?.success) {
    return {
      verdict: "partial",
      answer: "",
      missing: "",
      matched: [],
      error: "the model gave no verdict",
    };
  }
  /*
   * Positions are indices into what the judge was *shown*, which is not always
   * what was read — a narrowed or truncated sample renumbers nothing, but one
   * that dropped rows makes an out-of-range index possible. Anything outside
   * the sample is dropped rather than clamped: guessing which row was meant is
   * how the wrong record ends up in focus.
   */
  const matched = [...new Set(parsed.data.matched)].filter(
    (index) => index < judgeSample(input.evidence).shown.length,
  );

  return {
    verdict: parsed.data.verdict,
    answer: parsed.data.answer.trim(),
    missing: parsed.data.missing.trim(),
    matched,
  };
};
