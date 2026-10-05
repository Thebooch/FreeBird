import type { EntitySpec, WriteField } from "@freebirdai/connect-spec";
import { z } from "zod";
import type { LlmAdapter, LlmTool } from "./llm.js";
import { UNTRUSTED_METADATA, callTool } from "./retry.js";

/**
 * Where a request's fields are shown on the record, for the ones no name
 * rule could settle.
 *
 * A replace sends the whole record, so every value it means to keep has to
 * be read off the record first. Most request fields share their name with
 * the record's (`mapWriteFields` handles those without any of this); a few
 * do not — one API's request says `PropertyManagerId`, its record says
 * `RentalManager.Id` — and those are the ones an edit would silently clear.
 *
 * Configuration time only, and only for the leftovers. The answer is checked
 * before it is kept: a record field the model names must exist and hold the
 * same kind of value, or the field stays unmatched. An unmatched field is
 * safe — the review says it will not be sent — and a wrong match is not.
 */

export const matchFieldsSchema = z.object({
  matches: z
    .array(
      z.object({
        field: z.string().describe("The request field, exactly as listed."),
        readFrom: z
          .string()
          .optional()
          .describe(
            "The record field holding its current value, exactly as listed. Leave out when no record field holds it.",
          ),
        label: z.string().optional().describe("A short label for a form, in plain words."),
        hidden: z
          .boolean()
          .optional()
          .describe("True only when a person should never set this: an internal flag or a system value."),
        reason: z.string().optional().describe("One short sentence: why these two are the same value."),
      }),
    )
    .describe("One entry per request field listed."),
});

export type MatchFieldsProposal = z.infer<typeof matchFieldsSchema>;

export const matchFieldsTool: LlmTool<MatchFieldsProposal> = {
  name: "match_fields",
  description: "Say which record field holds each request field's current value.",
  schema: matchFieldsSchema,
};

const SYSTEM = `You match the fields an API's update request takes to the fields its records show.

Each request field needs the record field that holds its CURRENT value, so an edit can send it back unchanged. The two are often spelled differently — a request "ManagerId" may be the record's "Manager.Id" — but they must hold the same value, not merely a related one.

Rules:
- Only name record fields from the list. Copy them exactly.
- Leave "readFrom" out when no record field holds the value. A wrong match overwrites real data; a missing one is safe.
- An id in the request matches an id on the record, never a name or a label.
- Keep labels short and plain.

${UNTRUSTED_METADATA}`;

export interface MatchFieldsInput {
  readonly apiTitle: string;
  readonly entity: EntitySpec;
  /** The request's unmatched fields. */
  readonly fields: readonly WriteField[];
  /** A few values each record field was seen holding, when some were read. Never stored. */
  readonly samples?: Readonly<Record<string, readonly unknown[]>>;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

const KIND_OF: Record<WriteField["type"], string> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
  object: "object",
  array: "array",
};

export const buildMatchPrompt = (input: MatchFieldsInput): string => {
  const record = input.entity.fields
    .filter((field) => !field.kinds.includes("object"))
    .map((field) => {
      const seen = input.samples?.[field.path]?.slice(0, 3).map((value) => JSON.stringify(value)).join(", ");
      return `- ${field.path} (${field.kinds.join("|") || "?"})${field.label ? ` "${field.label}"` : ""}${
        field.description ? ` — ${field.description.slice(0, 160)}` : ""
      }${seen ? ` e.g. ${seen}` : ""}`;
    })
    .join("\n");
  const wanted = input.fields
    .map(
      (field) =>
        `- ${field.path} (${field.type}${field.required ? ", required" : ""})${
          field.description ? ` — ${field.description.slice(0, 160)}` : ""
        }`,
    )
    .join("\n");
  return `API: ${input.apiTitle}
Record type: ${input.entity.name.one}${input.entity.description ? ` — ${input.entity.description.slice(0, 200)}` : ""}

RECORD FIELDS:
${record}

REQUEST FIELDS TO MATCH:
${wanted}

Call match_fields once, with one entry per request field.`;
};

export type MatchFieldsResult =
  | { readonly fields: WriteField[]; readonly matched: number; readonly refused: string[] }
  | { readonly error: string };

/**
 * Ask, check, and return the fields with what survived: `readFrom` and
 * `mappedBy: "model"` where a match held up, `readFrom: null` where the
 * model said there is none, and untouched where it named something that
 * does not exist.
 */
export const matchWriteFields = async (llm: LlmAdapter, input: MatchFieldsInput): Promise<MatchFieldsResult> => {
  if (input.fields.length === 0) return { fields: [], matched: 0, refused: [] };
  const byPath = new Map(input.entity.fields.map((field) => [field.path, field]));
  const wanted = new Set(input.fields.map((field) => field.path));

  const answer = await callTool(llm, {
    tool: matchFieldsTool,
    system: SYSTEM,
    user: buildMatchPrompt(input),
    ...(input.model ? { model: input.model } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    maxOutputTokens: 4_096,
    accept: (args) => {
      const unknown = args.matches.filter((match) => !wanted.has(match.field)).map((match) => match.field);
      return unknown.length > 0 ? `these are not request fields from the list: ${unknown.slice(0, 5).join(", ")}.` : null;
    },
  });
  if ("error" in answer) return { error: answer.error };

  const refused: string[] = [];
  let matched = 0;
  const decided = new Map(answer.args.matches.map((match) => [match.field, match]));
  const fields = input.fields.map((field): WriteField => {
    const match = decided.get(field.path);
    if (!match) return field;
    const label = match.label?.trim().slice(0, 120);
    const common = {
      ...(label ? { label } : {}),
      ...(match.hidden === true && !field.required ? { hidden: true } : {}),
    };
    if (!match.readFrom) return { ...field, ...common, readFrom: null, mappedBy: "model" };
    const read = byPath.get(match.readFrom);
    const compatible =
      read !== undefined &&
      !read.kinds.includes("object") &&
      (read.kinds.length === 0 || read.kinds.includes(KIND_OF[field.type] as never) || field.type === "string");
    if (!compatible) {
      refused.push(`${field.path} → ${match.readFrom}`);
      return { ...field, ...common };
    }
    matched++;
    return { ...field, ...common, readFrom: match.readFrom, mappedBy: "model" };
  });
  return { fields, matched, refused };
};
