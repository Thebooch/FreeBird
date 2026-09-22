import type { CategorySpec, ApiProfile } from "@freebirdai/dash-spec";
import { CATEGORIES_MAX, categorySchema, profileSchema } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { BriefCandidate } from "./brief.js";
import type { LlmAdapter, LlmTool } from "./llm.js";

/**
 * What an API is for, and how its records divide up.
 *
 * The question a connection cannot answer for itself. Everything before this
 * pass describes an API in its own terms — this endpoint lists these records,
 * that field points at those — and none of it says that leases and applicants
 * are the same job while work orders are a different one. Those are the
 * divisions the people who use the software already think in, and they are the
 * only sensible unit for the question "what do you want from this
 * connection?".
 *
 * **One call over the whole roster, not batched.** This is the one pass here
 * that must not be split, and the reason is the failure `mapApi` paid for
 * twice: a model can only relate what it was shown together, so a batch of six
 * record types cannot know that applicants belong with leases if leases sat in
 * the previous batch. Batching is right when each answer is about one record
 * type in isolation — describing it, laying it out — and wrong when the answer
 * is about how the whole API divides. A hundred record types at a line each is
 * a few thousand tokens, which is what makes the undivided call affordable.
 *
 * **It reads record types, not endpoints.** The same reasoning as the brief
 * layer: choosing between two hundred endpoints titled "Retrieve all X" is a
 * job nobody does well, and the words that make categories obvious — what
 * these records *are* — exist only on the described record type. Every record
 * type names the endpoints behind it, so a category still knows its endpoint
 * count without the endpoints ever being the thing being sorted.
 */

/** Everything the model may say about one record type, as one line. */
const DESCRIPTION_CHARS = 140;

const categoryProposalSchema = z.object({
  product: z
    .string()
    .describe(
      "What this software is, in one sentence, for somebody who has only seen its URL. Say " +
        "what it is used for and by whom, not what its API looks like.",
    )
    .optional(),
  domain: z
    .string()
    .describe('The field it serves, in two or three words: "property management", "payroll".')
    .optional(),
  categories: z
    .array(
      z.object({
        title: z
          .string()
          .describe(
            'What this part of the software is called, in the words its users use: "Leasing", ' +
              '"Maintenance", "Accounting". One or two words, capitalised.',
          ),
        description: z
          .string()
          .describe(
            "One plain line saying what is in here, so somebody deciding whether they want it " +
              "can tell. Say what it covers rather than restating the title.",
          )
          .optional(),
        entities: z
          .array(z.string())
          .describe(
            "The ids of the record types that belong here. Copy each one exactly as given.",
          ),
      }),
    )
    .describe("The parts this software divides into, the one somebody wants most first.")
    .optional(),
});

export type CategoryProposal = z.infer<typeof categoryProposalSchema>;

const categoryTool: LlmTool<CategoryProposal> = {
  name: "divide_api",
  description:
    "Say what this software is and which parts it divides into, and put each record type in " +
    "the part it belongs to.",
  schema: categoryProposalSchema,
};

export const CATEGORY_SYSTEM_PROMPT = `You are dividing a software product's records into the parts its own users think in.

Somebody has just connected this API and is about to be asked what they want
from it. Your answer becomes that question, so it has to be answerable by
somebody who knows the business and nothing about the API.

1. WHAT THIS SOFTWARE IS. One sentence. Read the record types: a system holding
   leases, tenants, work orders and owners is property management software, and
   saying so is what makes every choice below legible.

2. WHAT PARTS IT DIVIDES INTO. The divisions the people who use this software
   already have names for — the modules of the product, not groupings of
   endpoints. Two to eight of them on a real API.

3. WHICH RECORDS BELONG TO EACH PART.

Rules:
- Use record type ids EXACTLY as given. One you invent or abbreviate is
  discarded, never approximated.
- Name a part after the job somebody does with it, in their words. "Leasing",
  "Maintenance", "Accounting", "Ownership". Never after a shape ("Lists",
  "Lookups", "Records"), never after the API ("Rentals endpoints"), and never
  after a technical idea nobody in the business would use.
- Put each record type in ONE part — the one somebody would look for it in. A
  record that genuinely serves two jobs goes where it is most used.
- Order the parts so the one most people want is first. What a dashboard is
  usually opened for beats what is merely present.
- A part needs enough records to be worth a dashboard. Two or three related
  record types is a part; one lookup list on its own is not — leave it out
  rather than inventing a part for it.
- Reference lists are marked as such. They exist for other records to point at,
  so they follow the records that use them rather than forming a part of their
  own.
- Leave a record type out entirely if it fits nowhere. Being unplaced is
  reported honestly; being filed under a part it does not belong to is not.
- Say nothing about widgets, charts or layout. Not this job.`;

export interface CategoryInput {
  readonly apiTitle: string;
  /**
   * The record types, exactly as the brief layer already presents them.
   *
   * Reused rather than re-derived: `briefCandidates` already answers "what is
   * this record called, what is it, is it a reference list" and a second
   * spelling of that would disagree with the first the day either changed.
   */
  readonly candidates: readonly BriefCandidate[];
  /** Endpoints behind each record type, by its id. Shown so scope is visible. */
  readonly endpointCounts?: Readonly<Record<string, number>> | undefined;
}

export interface CategoryResult {
  readonly profile: ApiProfile | null;
  readonly categories: readonly CategorySpec[];
  /** Record types the pass placed nowhere. Data, not a fault. */
  readonly uncategorised: readonly string[];
  readonly errors: readonly string[];
  /**
   * Readings refused, and why.
   *
   * Separate from `errors` because nothing went wrong: the pass worked and
   * declined something it could not justify. A category that came back short
   * needs a reason attached or it reads as the pass not noticing.
   */
  readonly skipped: readonly string[];
}

/**
 * The roster, as one line per record type.
 *
 * Deliberately the same shape `buildBriefPrompt` uses, minus the field lists:
 * which fields a record carries says nothing about which part of the business
 * it belongs to, and on a real API those lines are most of the prompt.
 */
export const buildCategoryPrompt = (input: CategoryInput): string => {
  const render = (candidate: BriefCandidate): string => {
    const summary = (candidate.description ?? "")
      .split("\n")[0]
      ?.slice(0, DESCRIPTION_CHARS)
      .trim();
    const endpoints = input.endpointCounts?.[candidate.recordType];
    const scope = endpoints && endpoints > 1 ? `  [${endpoints} endpoints]` : "";
    return `  ${candidate.entity}  ${candidate.many}${summary ? `  — ${summary}` : ""}${scope}`;
  };

  const starting = input.candidates.filter((candidate) => candidate.starting);
  const reference = input.candidates.filter((candidate) => !candidate.starting);

  return [
    `API: ${input.apiTitle}`,
    "",
    "RECORD TYPES:",
    ...starting.map(render),
    ...(reference.length > 0
      ? [
          "",
          "REFERENCE LISTS — things other records point at:",
          ...reference.map(render),
        ]
      : []),
  ].join("\n");
};

/**
 * A category id from its title, on the same terms every other id here follows.
 *
 * Slugged rather than asked for, because an id is a mechanical consequence of
 * a name and asking a model for both invites them to disagree. Deduped against
 * what has already been taken, so two categories the model called nearly the
 * same thing both survive.
 */
export const categoryId = (title: string, taken: ReadonlySet<string>): string => {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "part";
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${taken.size}`;
};

/**
 * Turn the proposal into categories, keeping only what the roster supports.
 *
 * Exported and pure so the boundary can be tested without a model. Every rule
 * here exists because the alternative is a category somebody is offered and
 * cannot be given: an invented record type, the same records under two
 * headings, or a heading with nothing behind it.
 */
export const categoriesFromProposal = (input: {
  readonly proposal: CategoryProposal;
  readonly candidates: readonly BriefCandidate[];
}): {
  profile: ApiProfile | null;
  categories: readonly CategorySpec[];
  uncategorised: readonly string[];
  skipped: readonly string[];
} => {
  const offered = new Map(input.candidates.map((candidate) => [candidate.entity, candidate]));
  const skipped: string[] = [];
  const categories: CategorySpec[] = [];
  const taken = new Set<string>();
  /* One part each: a record under two headings is the same board twice. */
  const claimed = new Set<string>();

  for (const proposed of input.proposal.categories ?? []) {
    if (categories.length >= CATEGORIES_MAX) {
      skipped.push(
        `"${proposed.title}" and anything after it were dropped: an API divides into at most ${CATEGORIES_MAX} parts.`,
      );
      break;
    }

    const entities: string[] = [];
    for (const named of proposed.entities ?? []) {
      if (!offered.has(named)) {
        skipped.push(
          `${proposed.title}: named "${named}", which is not a record type on this API.`,
        );
        continue;
      }
      if (claimed.has(named)) {
        skipped.push(
          `${proposed.title}: ${offered.get(named)?.many ?? named} already belong to an earlier part, so they stay there.`,
        );
        continue;
      }
      claimed.add(named);
      entities.push(named);
    }

    if (entities.length === 0) {
      skipped.push(
        `"${proposed.title}" was dropped: none of the record types it named could be used.`,
      );
      continue;
    }

    const id = categoryId(proposed.title, taken);
    const parsed = categorySchema.safeParse({
      id,
      title: proposed.title.slice(0, 80),
      ...(proposed.description ? { description: proposed.description.slice(0, 400) } : {}),
      entities,
      starters: [],
    });
    if (!parsed.success) {
      skipped.push(
        `"${proposed.title}" did not validate (${parsed.error.issues
          .slice(0, 2)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}).`,
      );
      continue;
    }
    taken.add(id);
    categories.push(parsed.data);
  }

  /*
   * Unplaced record types are reported rather than swept into an "Other".
   *
   * A part named after the absence of a part is not something anybody wants a
   * dashboard of, and filing the leftovers under one would make the choice
   * look complete when it is not.
   */
  const uncategorised = input.candidates
    .filter((candidate) => candidate.starting && !claimed.has(candidate.entity))
    .map((candidate) => candidate.entity);

  const profile = profileSchema.safeParse({
    summary: input.proposal.product ?? "",
    ...(input.proposal.domain ? { domain: input.proposal.domain } : {}),
  });

  return {
    profile: profile.success ? profile.data : null,
    categories,
    uncategorised,
    skipped,
  };
};

/**
 * Run the pass.
 *
 * No resumption and no batching, so no checkpoint: it is one call, and a
 * failed one is retried whole. The starter sets in `composeStarters` are the
 * expensive half and those do resume, per category.
 */
export const categoriseApi = async (
  llm: LlmAdapter,
  input: CategoryInput,
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<CategoryResult> => {
  const none = (error: string): CategoryResult => ({
    profile: null,
    categories: [],
    uncategorised: [],
    errors: [error],
    skipped: [],
  });

  if (input.candidates.length === 0) {
    return none("this API has no record types described yet");
  }

  let result: Awaited<ReturnType<LlmAdapter["generate"]>>;
  try {
    result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0.2,
      maxOutputTokens: 8_192,
      messages: [
        { role: "system" as const, content: CATEGORY_SYSTEM_PROMPT },
        { role: "user" as const, content: buildCategoryPrompt(input) },
      ],
      tools: { divide_api: categoryTool },
      toolChoice: { name: "divide_api" as const },
    });
  } catch (cause) {
    return none(cause instanceof Error ? cause.message : String(cause));
  }

  const call = result.toolCalls.find((candidate) => candidate.name === "divide_api");
  if (!call) return none("the model answered without calling the tool.");

  const parsed = categoryProposalSchema.safeParse(call.args);
  if (!parsed.success) return none("the division did not parse.");

  const built = categoriesFromProposal({
    proposal: parsed.data,
    candidates: input.candidates,
  });

  return {
    ...built,
    errors: built.categories.length === 0 ? ["nothing usable was proposed"] : [],
  };
};
