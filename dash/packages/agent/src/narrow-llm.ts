import { z } from "zod";
import type { FieldInfo } from "./infer.js";
import type { LlmAdapter, LlmTool } from "./llm.js";
import type { FieldValue } from "./narrow.js";

/**
 * The two questions in a drill-down that are about meaning rather than data.
 *
 * Everything factual — what values exist, how many records carry each — is
 * counted deterministically and never asked of a model. What a model is for is
 * the two judgements no amount of counting settles: which field carries the
 * distinction somebody is describing, and which of its values they meant by a
 * word like "maintenance".
 *
 * Both are guesses, and both are put to the user before anything is built on
 * them. That is the whole design: a model narrows the search, a person
 * confirms the answer, and the confirmation is what gets saved.
 */

const fieldPickSchema = z.object({
  field: z
    .string()
    .describe("The field whose values separate the records being described. Copy it exactly."),
  reason: z
    .string()
    .describe("One short sentence, for the user, on why this field is the one that decides."),
});

const fieldPickTool: LlmTool<z.infer<typeof fieldPickSchema>> = {
  name: "pick_narrowing_field",
  description: "Name the field whose value tells these records apart.",
  schema: fieldPickSchema,
};

const FIELD_SYSTEM_PROMPT = [
  "You are told the fields on one endpoint's records, and what a user asked to see.",
  "Name the single field whose *value* separates the records they want from the rest.",
  "",
  "Rules:",
  "- Copy the field name exactly. An invented one is a failure, not an approximation.",
  "- Pick a field that classifies, not one that identifies. Ids, timestamps, free-text",
  "  descriptions and per-record names cannot be chosen between; a category, type, status,",
  "  kind or priority can.",
  "- Read the example values. They matter more than anything else here: the right field is",
  "  the one whose *values* name what the user asked for. A field with two values called",
  "  \"Todo\" and \"Request\" does not distinguish maintenance however tidy it looks; one whose",
  "  values include \"Maintenance Request\" plainly does.",
  "- Among fields that could work, prefer the one whose name most nearly means what the user",
  "  said. Fewness of values breaks a tie; it is not the goal.",
  "- Nested names like `Category.Name` are real field names and usually the right answer:",
  "  the outer object is a reference, and the name inside it is what a person reads.",
].join("\n");

export interface FieldPick {
  readonly field: string | null;
  readonly reason: string;
  readonly error: string | null;
}

/** Which field carries the distinction, chosen from real field names only. */
export const pickNarrowingField = async (
  llm: LlmAdapter,
  input: { intent: string; opTitle: string; fields: readonly FieldInfo[] },
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<FieldPick> => {
  const none = (error: string | null): FieldPick => ({ field: null, reason: "", error });
  const usable = input.fields.filter((field) => !field.kinds.includes("object"));
  if (usable.length === 0) return none("this endpoint has no fields to narrow by");

  /*
   * `distinct` is the strongest hint available and costs nothing to include:
   * it is how an identifier gives itself away. Zero means nothing has been
   * sampled, which is honest — the model is told so rather than shown a
   * misleading zero.
   */
  const described = usable
    .map((field) => {
      const kinds = field.kinds.join("|");
      const spread = field.distinct > 0 ? `, ${field.distinct} distinct value(s)` : "";
      /*
       * Real values, where any were seen. This is the whole difference between
       * a guess and a reading: asked for "maintenance tasks", a model shown
       * only field names picks `TaskType` because it has the fewest values —
       * and `TaskType` holds "Todo" and "Request". Shown the values, the field
       * holding "Maintenance Request" is obvious.
       */
      const shown = field.samples
        .filter((value) => value !== null && value !== undefined && typeof value !== "object")
        .slice(0, 3)
        .map((value) => JSON.stringify(value))
        .join(", ");
      return `  ${field.name}: ${kinds}${spread}${shown ? ` — e.g. ${shown}` : ""}`;
    })
    .join("\n");

  let result: Awaited<ReturnType<LlmAdapter["generate"]>>;
  try {
    result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 512,
      messages: [
        { role: "system" as const, content: FIELD_SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: [
            `ENDPOINT: ${input.opTitle}`,
            "FIELDS:",
            described,
            "",
            "THE REQUEST:",
            input.intent,
          ].join("\n"),
        },
      ],
      tools: { pick_narrowing_field: fieldPickTool },
      toolChoice: { name: "pick_narrowing_field" as const },
    });
  } catch (cause) {
    return none(cause instanceof Error ? cause.message : String(cause));
  }

  const call = result.toolCalls.find((candidate) => candidate.name === "pick_narrowing_field");
  const parsed = call ? fieldPickSchema.safeParse(call.args) : null;
  if (!parsed?.success) return none("the model did not name a field");

  const known = new Set(usable.map((field) => field.name));
  if (!known.has(parsed.data.field)) {
    return none(`the model chose "${parsed.data.field}", which is not a field here`);
  }
  return { field: parsed.data.field, reason: parsed.data.reason.trim(), error: null };
};

const valueMatchSchema = z.object({
  values: z
    .array(z.string())
    .describe("The values that belong to what the user asked for. Copy them exactly."),
  reason: z
    .string()
    .describe("One short sentence, addressed to the user, on why these and not the others."),
});

const valueMatchTool: LlmTool<z.infer<typeof valueMatchSchema>> = {
  name: "match_values",
  description: "Pick the values that match what the user asked for.",
  schema: valueMatchSchema,
};

const VALUE_SYSTEM_PROMPT = [
  "You are shown every value one field actually holds, with how many records carry each,",
  "and what a user asked to see. Pick the values that belong to their request.",
  "",
  "Rules:",
  "- Copy values exactly as given. These are real values from the account's own data, and",
  "  a value you invent matches nothing.",
  "- These words were chosen by whoever set this account up, not by a standard. Read them",
  "  as that person's vocabulary: several may mean the same kind of thing.",
  "- Include every value that plausibly belongs. The user is shown your choice and can",
  "  remove any — too many is a correction, too few is an answer that quietly omits records.",
  "- Pick none if none of them fit. Saying nothing matches is a real answer and better than",
  "  a filter that hides everything.",
].join("\n");

export interface ValueMatch {
  readonly values: readonly (string | number)[];
  readonly reason: string;
  readonly error: string | null;
}

/** Which of a field's real values a request meant, validated against the list. */
export const matchValues = async (
  llm: LlmAdapter,
  input: { intent: string; field: string; values: readonly FieldValue[] },
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<ValueMatch> => {
  const none = (error: string | null): ValueMatch => ({ values: [], reason: "", error });
  if (input.values.length === 0) return none("there are no values to choose from");

  const listed = input.values
    .map((value) => `  ${String(value.value)}  (${value.count} record(s))`)
    .join("\n");

  let result: Awaited<ReturnType<LlmAdapter["generate"]>>;
  try {
    result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 1024,
      messages: [
        { role: "system" as const, content: VALUE_SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: [
            `FIELD: ${input.field}`,
            "VALUES:",
            listed,
            "",
            "THE REQUEST:",
            input.intent,
          ].join("\n"),
        },
      ],
      tools: { match_values: valueMatchTool },
      toolChoice: { name: "match_values" as const },
    });
  } catch (cause) {
    return none(cause instanceof Error ? cause.message : String(cause));
  }

  const call = result.toolCalls.find((candidate) => candidate.name === "match_values");
  const parsed = call ? valueMatchSchema.safeParse(call.args) : null;
  if (!parsed?.success) return none("the model did not choose any values");

  /*
   * Matched back to the real values by string form, so a number stays a
   * number. A filter comparing "3" to 3 matches nothing, and would look like
   * a category that simply has no records.
   */
  const byText = new Map(input.values.map((value) => [String(value.value), value.value]));
  const chosen = parsed.data.values
    .map((text) => byText.get(text))
    .filter((value): value is string | number => value !== undefined);

  return { values: [...new Set(chosen)], reason: parsed.data.reason.trim(), error: null };
};
