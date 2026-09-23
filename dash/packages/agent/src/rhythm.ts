import type { Volatility } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { BriefCandidate } from "./brief.js";
import type { LlmAdapter, LlmTool } from "./llm.js";
import { UNTRUSTED_METADATA, callTool } from "./retry.js";

/**
 * How often new records of each kind appear.
 *
 * What decides how often the keeper asks an API again, answered once per API
 * and stored beside its categories. Its own call rather than a field on the
 * dividing one, for three reasons that all showed up at once:
 *
 * - **It has to run on an API that is already divided.** Buried in the
 *   dividing call, it only ever ran when an API was divided for the first
 *   time, so every API set up before it existed sat on the default cadence
 *   with no way to be read short of re-dividing and orphaning its parts.
 * - **It must not be able to cost the division.** A rating per record type is
 *   a hundred-odd lines of output on a real API; sharing a token budget with
 *   the categories meant a long roster could cut the answer off, and a cut-off
 *   tool call is no answer at all.
 * - **It is a different question.** "Which parts does this divide into" is
 *   about how record types relate; "how often do these arrive" is about each
 *   one alone. Asked together, each answer bent the other.
 *
 * Costs model tokens and zero requests against anybody's account.
 */

const DESCRIPTION_CHARS = 140;

const rhythmProposalSchema = z.object({
  ratings: z
    .array(
      z.object({
        entity: z.string().describe("The record type id being rated. Copy it exactly as given."),
        changes: z
          .enum(["constant", "daily", "rare"])
          .describe(
            'How often NEW records of this kind appear. "constant" means all day — ' +
              'messages, charges, applications, work as it comes in. "daily" means a ' +
              'handful most days. "rare" means weeks or months between them — the ' +
              "reference data a business sets up once and leaves alone.",
          ),
        because: z
          .string()
          .describe(
            "Half a sentence on why, in a reader's words: \"new applications arrive all " +
              'day", "a bank account is set up once". Shown to the person confirming it.',
          )
          .optional(),
      }),
    )
    .describe("Every record type, rated by how often new ones appear."),
});

export type RhythmProposal = z.infer<typeof rhythmProposalSchema>;

const rhythmTool: LlmTool<RhythmProposal> = {
  name: "rate_arrivals",
  description: "Say how often new records of each kind appear.",
  schema: rhythmProposalSchema,
};

export const RHYTHM_SYSTEM_PROMPT = `You are rating how often new records of each kind appear in a software product.

Your answer decides how often the product asks this API for them again, so it
is about arrival, not editing:

- "constant" for the things that come in all day — messages, charges,
  applications, work orders, transactions.
- "daily" for a handful most days.
- "rare" for the reference data a business sets up once and then leaves alone:
  users, vendors, properties, bank accounts, categories, templates.

Ask yourself what somebody would be annoyed to find out of date, not what the
API lets you filter by. Nearly every endpoint accepts a "last updated" filter
and it tells you nothing about whether anything arrives.

Rules:
- Rate EVERY record type listed.
- Use record type ids EXACTLY as given. One you invent or abbreviate is
  discarded, never approximated.

${UNTRUSTED_METADATA}`;

export interface RhythmInput {
  readonly apiTitle: string;
  /** The record types, as the brief layer presents them. */
  readonly candidates: readonly BriefCandidate[];
}

export interface RhythmResult {
  /** Record type id → how often new ones appear. */
  readonly rhythm: Readonly<Record<string, Volatility>>;
  /** Why each reading was given, for the person being asked to confirm it. */
  readonly because: Readonly<Record<string, string>>;
  /** Ratings refused, and why. Not errors: the pass worked and declined them. */
  readonly skipped: readonly string[];
  readonly errors: readonly string[];
}

export const buildRhythmPrompt = (input: RhythmInput): string =>
  [
    `API: ${input.apiTitle}`,
    "",
    "RECORD TYPES:",
    ...input.candidates.map((candidate) => {
      const summary = (candidate.description ?? "")
        .split("\n")[0]
        ?.slice(0, DESCRIPTION_CHARS)
        .trim();
      return `  ${candidate.entity}  ${candidate.many}${summary ? `  — ${summary}` : ""}`;
    }),
  ].join("\n");

/**
 * Keep the ratings that name a record type this API has.
 *
 * Exported and pure so the boundary can be tested without a model. A rating
 * for something invented would end up on a shared artifact keyed by a record
 * type nobody has.
 */
export const rhythmFromProposal = (input: {
  readonly proposal: RhythmProposal;
  readonly candidates: readonly BriefCandidate[];
}): { rhythm: Record<string, Volatility>; because: Record<string, string>; skipped: string[] } => {
  const offered = new Map(input.candidates.map((candidate) => [candidate.entity, candidate]));
  const rhythm: Record<string, Volatility> = {};
  const because: Record<string, string> = {};
  const skipped: string[] = [];
  for (const rating of input.proposal.ratings) {
    const candidate = offered.get(rating.entity);
    if (!candidate) {
      skipped.push(`a rating named "${rating.entity}", which is not a record type on this API.`);
      continue;
    }
    rhythm[candidate.recordType] = rating.changes;
    if (rating.because) because[candidate.recordType] = rating.because.slice(0, 200);
  }
  return { rhythm, because, skipped };
};

export const classifyRhythm = async (
  llm: LlmAdapter,
  input: RhythmInput,
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<RhythmResult> => {
  const none = (error: string): RhythmResult => ({
    rhythm: {},
    because: {},
    skipped: [],
    errors: [error],
  });
  if (input.candidates.length === 0) return none("this API has no record types described yet");

  let answer: Awaited<ReturnType<typeof callTool<RhythmProposal>>>;
  try {
    answer = await callTool(llm, {
      tool: rhythmTool,
      system: RHYTHM_SYSTEM_PROMPT,
      user: buildRhythmPrompt(input),
      model: options.model,
      signal: options.signal,
      accept: (proposal) =>
        Object.keys(rhythmFromProposal({ proposal, candidates: input.candidates }).rhythm)
          .length > 0
          ? null
          : "none of your ratings named a record type from the list. Copy the ids exactly.",
    });
  } catch (cause) {
    return none(cause instanceof Error ? cause.message : String(cause));
  }
  if ("error" in answer) return none(answer.error);

  const built = rhythmFromProposal({ proposal: answer.args, candidates: input.candidates });
  return {
    ...built,
    errors: Object.keys(built.rhythm).length === 0 ? ["nothing usable was rated"] : [],
  };
};
