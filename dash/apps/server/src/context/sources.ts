import type { LlmAdapter, LlmTool } from "@freebirdai/dash-agent";
import { z } from "zod";
import type { Candidate } from "./types.js";

/**
 * Which source to look in first.
 *
 * Ordering matters for two separate reasons and they point the same way.
 * Cheapest first, because a widget whose rows are already cached costs nothing
 * and an unread endpoint costs a request against somebody's account. And most
 * likely first, because every candidate tried and rejected is budget spent on
 * a wrong guess. The deterministic half enforces the first; the model does the
 * second, within it.
 */

export const RANK_SYSTEM_PROMPT = [
  "You are choosing where to look for the answer to a question about somebody's own data.",
  "",
  "You are shown sources: widgets that already exist on their dashboards, and endpoints",
  "on the APIs they have connected. Each lists what its records are and which fields it",
  "carries. Return the ids worth reading, best first, and nothing else.",
  "",
  "Rules:",
  "- Answer only with ids from the list. An id that is not there is an error, never an",
  "  approximation.",
  "- Judge by what the records ARE and which fields are present. A question about rent",
  "  needs a source carrying a rent field; a question about when something happened needs",
  "  one carrying a date.",
  "- Prefer a source marked `cached` when it is an equally good fit: it costs nothing to",
  "  read, and a wrong guess against an uncached one spends the user's API quota.",
  "- Return at most 4, and fewer when only one or two are plausible. Padding the list",
  "  wastes the budget on sources you already doubt.",
  "- If nothing here could hold the answer, return an empty list and say why in `reason`.",
  "  That is a useful answer; a bad guess is not.",
].join("\n");

const rankSchema = z.object({
  sources: z
    .array(z.string())
    .max(8)
    .describe("Ids of sources worth reading, best first. Only ids you were shown."),
  reason: z
    .string()
    .max(400)
    .default("")
    .describe("One sentence on why these, or why none of them fit."),
});

const rankTool: LlmTool = {
  name: "rank_sources",
  description: "Name the sources worth reading for this question, best first.",
  schema: rankSchema,
};

export interface RankInput {
  readonly question: string;
  readonly candidates: readonly Candidate[];
  /** Ids already read this turn, so the model is not offered them again. */
  readonly exclude?: readonly string[];
  /** What a previous attempt could not find, to steer the next pick. */
  readonly missing?: string;
}

export interface RankResult {
  readonly sources: readonly string[];
  readonly reason: string;
  readonly error?: string;
}

export const buildRankPrompt = (input: RankInput): string => {
  const excluded = new Set(input.exclude ?? []);
  const lines: string[] = [`Question: ${input.question}`];
  if (input.missing) {
    lines.push(
      "",
      `An earlier source was already read and did not answer it. What is still missing: ${input.missing}`,
    );
  }
  lines.push("", "Sources:");
  for (const candidate of input.candidates) {
    if (excluded.has(candidate.id)) continue;
    const where = candidate.tab ? ` on the "${candidate.tab}" tab` : "";
    const cost = candidate.cached ? " [cached, free to read]" : " [costs one request]";
    lines.push(
      `- ${candidate.id} (${candidate.kind}${where})${cost}: ${candidate.title}` +
        (candidate.describes ? ` - ${candidate.describes}` : "") +
        (candidate.fields.length > 0
          ? `\n    fields: ${candidate.fields.slice(0, 40).join(", ")}`
          : ""),
    );
  }
  return lines.join("\n");
};

/**
 * Free before priced, and only then by relevance.
 *
 * Applied to the model's answer rather than instead of it: the model decides
 * what could hold the answer, and this decides what order to spend money in.
 * A stable sort keeps the model's ordering inside each group.
 */
export const cheapestFirst = (
  ids: readonly string[],
  candidates: readonly Candidate[],
): string[] => {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return [...ids].sort((a, b) => {
    const left = byId.get(a);
    const right = byId.get(b);
    return Number(right?.cached ?? false) - Number(left?.cached ?? false);
  });
};

export const rankSources = async (
  llm: LlmAdapter,
  input: RankInput,
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<RankResult> => {
  const excluded = new Set(input.exclude ?? []);
  const available = input.candidates.filter((candidate) => !excluded.has(candidate.id));
  if (available.length === 0) {
    return { sources: [], reason: "there is nothing left to read" };
  }

  let result: Awaited<ReturnType<LlmAdapter["generate"]>>;
  try {
    result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 512,
      messages: [
        { role: "system" as const, content: RANK_SYSTEM_PROMPT },
        { role: "user" as const, content: buildRankPrompt({ ...input, exclude: [...excluded] }) },
      ],
      tools: { rank_sources: rankTool },
      toolChoice: { name: "rank_sources" as const },
    });
  } catch (cause) {
    return {
      sources: [],
      reason: "",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const call = result.toolCalls.find((candidate) => candidate.name === "rank_sources");
  const parsed = call ? rankSchema.safeParse(call.args) : null;
  if (!parsed?.success) return { sources: [], reason: "", error: "the model named no source" };

  /*
   * An invented id is dropped rather than approximated - the same boundary
   * every other model boundary in this codebase draws. Dropping leaves the
   * loop to try the next real candidate, which is strictly better than reading
   * something nobody chose.
   */
  const known = new Set(available.map((candidate) => candidate.id));
  const seen = new Set<string>();
  const sources = parsed.data.sources.filter((id) => {
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return { sources: cheapestFirst(sources, available), reason: parsed.data.reason.trim() };
};
