import { z } from "zod";
import type { LlmAdapter, LlmTool } from "./llm.js";

/**
 * Choosing which endpoints a request is about, from all of them.
 *
 * This exists because the obvious design does not fit. Putting the endpoint
 * catalogue in the chat prompt works at eleven endpoints and is impossible at
 * two hundred: the field lists alone measured 44.7 KB against a 24 KB budget,
 * so what actually shipped was a truncated roster — forty endpoints, and the
 * other hundred and eighty-six invisible to the model. A user asking about one
 * of those was told it did not exist.
 *
 * Inverting it fixes the truncation and the budget together. The catalogue
 * leaves the shared prompt entirely and becomes the whole of *one* call's
 * input, where thirty kilobytes is unremarkable. Every endpoint is a candidate
 * again, and the prompt every chat turn pays for gets shorter rather than
 * longer as an API grows.
 *
 * Only the picking happens here. What the chosen rows *mean* is a separate
 * call with a much narrower input — the field schemas for the one or two
 * endpoints this returned — which is the point: full schemas for two
 * endpoints, never for two hundred.
 */

/** One endpoint the model may choose. Descriptions come from the API map. */
export interface PickCandidate {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly resource?: string | undefined;
  readonly description?: string | undefined;
}

export interface PickInput {
  /** What the user asked for, in their own words. */
  readonly intent: string;
  readonly candidates: readonly PickCandidate[];
}

export interface PickResult {
  /** The endpoint to build from, or null if nothing was chosen. */
  readonly primary: string | null;
  /** A second endpoint to bring alongside, when the request spans two. */
  readonly secondary: string | null;
  /**
   * What the second endpoint is for: detail on the first's rows, a separate
   * measurement drawn beside it, or neither. Null when there is no second.
   *
   * The distinction decides the entire shape of the widget, and getting it
   * wrong is not recoverable downstream — a comparison forced through a join
   * has nothing to match on, so it silently becomes a chart of the first
   * endpoint alone.
   *
   * `alongside` is the third answer, and it was missing. Asked to show all the
   * properties *and* the available listings, a model with only the first two
   * words has to call that "enrich" — so a join is attempted, finds nothing to
   * match on, and quietly degrades to the properties alone while the reply
   * says the listings are there. Two independent collections somebody wants to
   * see together are not an attribute of one another and are not two
   * measurements over a shared axis. They are simply two things.
   */
  readonly relationship: "enrich" | "compare" | "alongside" | null;
  /**
   * A different reading of the request, when one genuinely exists.
   *
   * The schema used to have no vocabulary for this: `primary` is one required
   * string, so a model looking at two defensible readings had to commit to one
   * and could not say the other was there. That is fine when the two would
   * produce the same answer and wrong when they would not — counting the
   * parents of a thing and counting the thing are different numbers, and
   * "they can change it afterwards" only helps somebody who noticed.
   *
   * Empty on almost every request, and it has to stay that way: a question
   * asked on every build is the endpoint list this flow exists to replace.
   */
  readonly alternatives: readonly {
    readonly id: string;
    readonly role: "primary" | "secondary";
    readonly whatItIs: string;
  }[];
  /** The model's own words for why, shown to the user rather than logged. */
  readonly reason: string;
  readonly error: string | null;
}

/** How much of a description survives into the index. Enough to disambiguate. */
const DESCRIPTION_CHARS = 100;

const pickSchema = z.object({
  primary: z.string().describe("The id of the endpoint to build from. Copy it exactly."),
  secondary: z
    .string()
    .optional()
    .describe(
      "A second endpoint id, only when the request genuinely needs both. Omit otherwise.",
    ),
  relationship: z
    .enum(["enrich", "compare", "alongside"])
    .optional()
    .describe(
      "Only when you name a second endpoint. \"enrich\" means the second adds detail to rows " +
        "of the first — each row of the first points at one of the second. \"compare\" means " +
        "both are measured separately against a shared axis, which is what \"X versus Y\" and " +
        "\"how many X against how many Y\" mean. \"alongside\" means the user simply wants to " +
        "see both — \"show me my X and also my Y\" — where neither is an attribute of the other " +
        "and nothing is being measured against anything. Do not call that one \"enrich\": " +
        "joining two unrelated collections finds nothing to match on and shows only the first.",
    ),
  alternatives: z
    .array(
      z.object({
        id: z.string().describe("Endpoint id, copied exactly."),
        role: z
          .enum(["primary", "secondary"])
          .describe("Which of your picks this is an alternative to."),
        whatItIs: z
          .string()
          .describe(
            "What THESE records are, in one short phrase a person would recognise. Not the " +
              "endpoint's title and not why you did not pick it — what somebody would be " +
              "counting if they chose this.",
          ),
      }),
    )
    .max(2)
    .optional()
    .describe(
      "A different reading of the request that would answer a DIFFERENT question. Leave it " +
        "out unless one really exists.",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence, addressed to the user, saying what you picked and why. " +
        "Plain words — name the records, not the endpoint id.",
    ),
});

export type Pick = z.infer<typeof pickSchema>;

const pickTool: LlmTool<Pick> = {
  name: "pick_endpoints",
  description: "Name the endpoint whose rows answer the request, and at most one more.",
  schema: pickSchema,
};

export const PICK_SYSTEM_PROMPT = [
  "You choose which API endpoint a request is about.",
  "",
  "You are given every endpoint that returns a list of records, grouped by the kind of thing",
  "it returns, with its URL path and a description. Pick the one whose rows are the records",
  "the user is asking about.",
  "",
  "Rules:",
  "- Answer with an ENDPOINT ID — the first token on an endpoint's own line, not the group",
  "  heading it sits under. The headings group the list; they are not answers.",
  "- Copy the id exactly. One you invent or abbreviate is a failure, not an approximation.",
  "- The path disambiguates. Many APIs have several endpoints with identical titles, and",
  "  the section a path sits under is often the only thing separating them. Two endpoints",
  "  both called \"Retrieve all items\" under different sections return different records.",
  "- Pick the records the user wants to SEE. A request to see applicants grouped by status is",
  "  an applicants endpoint, not a statuses endpoint.",
  "- Prefer one endpoint. Name a second only when the request genuinely needs both, and say",
  "  which kind of second it is. If the second supplies a field the first's rows point at,",
  "  that is \"enrich\" and the first should be the records being listed. If the request asks",
  "  how two different things compare — counts of each over time, one against the other —",
  "  that is \"compare\", and neither is subordinate to the other. If it asks to SEE both and",
  "  neither of those is true — \"my properties and also my listings\" — that is \"alongside\".",
  "- \"and also\" is usually \"alongside\", not \"enrich\". Enrich means each row of the first",
  "  literally carries the second's identity — a lease pointing at its unit. Two collections",
  "  someone wants on screen together carry nothing of each other, and calling that enrich",
  "  produces a join with nothing to match on: the second endpoint silently disappears and",
  "  the user is told it is there. Only say enrich when you can name the field that links",
  "  them.",
  "- Pick the best available endpoint even if it is an imperfect fit. Refusing helps nobody;",
  "  the user sees what you chose and can change it.",
  "- Commit when the request is clear. Almost every request is: name your pick and move on.",
  "- Name an ALTERNATIVE only when a second endpoint is a genuinely different reading of the",
  "  same words AND choosing it would answer a different question — a different number, not",
  "  a slightly different one. Records and the records they hang off are the usual case:",
  "  counting the things somebody submitted is not counting the people who submitted them.",
  "  Say what those records ARE, in words the person would recognise, so the difference can",
  "  be put to them.",
  "- Do NOT use alternatives to hedge. Two endpoints that would produce the same answer, or",
  "  one that is simply worse, is one pick and no alternative. A question asked on every",
  "  request is worse than an occasional wrong guess the user can see and change.",
  "- Read the descriptions, not just the titles. People describe what they want in their own",
  "  words, and the endpoint that answers it is often named something else entirely. The",
  "  description says what the records ARE; match on that.",
  "- Pick the endpoint whose records are literally the thing asked for, even when a cheaper",
  "  endpoint is nearby. Some are marked as costing a request per record — that is a price",
  "  the user is asked about before anything is fetched, not a reason to substitute something",
  "  adjacent. Counting the parents of a thing is not counting the thing.",
].join("\n");

/**
 * The index the model chooses from.
 *
 * Grouped by resource because an ungrouped list of two hundred lines reads as
 * noise, and because the grouping is the first cut a reader makes anyway. Ids
 * are printed verbatim and never prettified — the model has to return one, and
 * anything it cannot copy exactly it will approximate.
 */
export const buildPickPrompt = (input: PickInput): string => {
  /*
   * Endpoints the API groups, and endpoints it does not.
   *
   * The ungrouped ones used to be collected under a heading literally called
   * "other", and that heading is an attractive nuisance: this prompt tells the
   * model to answer with an id and never a heading, then offers it one whose
   * name means "any of these". It answered `other`, resolution correctly
   * refused a heading covering dozens of endpoints, and the whole proposal
   * collapsed back to the endpoint list this flow exists to replace.
   *
   * A grouping that does not group is not a grouping. Those endpoints are
   * listed plainly now, with nothing above them to mistake for an answer.
   */
  const byResource = new Map<string, PickCandidate[]>();
  const ungrouped: PickCandidate[] = [];
  for (const candidate of input.candidates) {
    if (!candidate.resource) {
      ungrouped.push(candidate);
      continue;
    }
    const group = byResource.get(candidate.resource);
    if (group) group.push(candidate);
    else byResource.set(candidate.resource, [candidate]);
  }

  const render = (candidate: PickCandidate): string => {
    const summary = (candidate.description ?? candidate.title ?? "")
      .split("\n")[0]
      ?.slice(0, DESCRIPTION_CHARS)
      .trim();
    return `  ${candidate.id}  ${candidate.path}${summary ? `  — ${summary}` : ""}`;
  };

  const lines: string[] = ungrouped.map(render);
  for (const [resource, group] of [...byResource].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${resource}:`);
    for (const candidate of group) lines.push(render(candidate));
  }

  return [
    "ENDPOINTS:",
    ...lines,
    "",
    "THE REQUEST:",
    input.intent,
  ].join("\n");
};

/**
 * The endpoint an answer names, resolved only where it is unambiguous.
 *
 * Ids are printed verbatim and the model is told to copy them, and mostly it
 * does. What it also does — reliably enough to matter, and differently from
 * one model to the next — is answer with the *group heading* instead:
 * "workorder" for a list printed under `workorder:`. That is not a wrong
 * choice, it is a correctly chosen thing named at the wrong level, and
 * throwing it away sends the user back to a list of fifty-nine endpoints.
 *
 * So a name that is not an id is matched against the resource groups, and
 * accepted **only when the group holds exactly one endpoint**. One candidate
 * is not a guess: there is nothing else it could have meant. Two or more is,
 * and is refused — which is the same line every other model boundary here
 * draws.
 */
const resolveId = (named: string, candidates: readonly PickCandidate[]): string | null => {
  const exact = candidates.find((candidate) => candidate.id === named);
  if (exact) return exact.id;

  const key = named.trim().toLowerCase();
  const inGroup = candidates.filter((candidate) => candidate.resource?.toLowerCase() === key);
  if (inGroup.length === 1) return inGroup[0]!.id;

  // A title works the same way, and for the same reason.
  const byTitle = candidates.filter((candidate) => candidate.title.toLowerCase() === key);
  return byTitle.length === 1 ? byTitle[0]!.id : null;
};

/**
 * Ask the model which endpoints a request is about.
 *
 * Every id it returns is checked against the candidate set before it is
 * believed. A model that returns a plausible-looking id for an endpoint that
 * does not exist gets an error, not a widget built against nothing — the same
 * guard `revise` applies to every other name a model supplies.
 */
export const pickEndpoints = async (
  llm: LlmAdapter,
  input: PickInput,
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<PickResult> => {
  const none = (error: string): PickResult => ({
    primary: null,
    secondary: null,
    relationship: null,
    alternatives: [],
    reason: "",
    error,
  });

  if (input.candidates.length === 0) return none("there are no readable endpoints to choose from");

  let result: Awaited<ReturnType<LlmAdapter["generate"]>>;
  try {
    result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 1024,
      messages: [
        { role: "system" as const, content: PICK_SYSTEM_PROMPT },
        { role: "user" as const, content: buildPickPrompt(input) },
      ],
      tools: { pick_endpoints: pickTool },
      toolChoice: { name: "pick_endpoints" as const },
    });
  } catch (cause) {
    return none(cause instanceof Error ? cause.message : String(cause));
  }

  const call = result.toolCalls.find((candidate) => candidate.name === "pick_endpoints");
  const parsed = call ? pickSchema.safeParse(call.args) : null;
  if (!parsed?.success) return none("the model did not name an endpoint");

  const { primary, secondary, reason } = parsed.data;
  const resolvedPrimary = resolveId(primary, input.candidates);
  if (!resolvedPrimary) {
    return none(`the model chose "${primary}", which is not an endpoint here`);
  }

  const resolvedSecond = secondary ? resolveId(secondary, input.candidates) : null;
  const second = resolvedSecond && resolvedSecond !== resolvedPrimary ? resolvedSecond : null;

  /*
   * Alternatives, checked as hard as the picks are.
   *
   * An id that does not resolve is dropped rather than approximated — the same
   * boundary every other pass draws — and one naming something already chosen
   * is not an alternative to anything. Both refusals leave a widget that was
   * going to be built anyway, so the cost of being strict here is nothing.
   */
  const taken = new Set([resolvedPrimary, ...(second ? [second] : [])]);
  const alternatives: Array<{ id: string; role: "primary" | "secondary"; whatItIs: string }> = [];
  for (const entry of parsed.data.alternatives ?? []) {
    const id = resolveId(entry.id, input.candidates);
    if (!id || taken.has(id)) continue;
    // A secondary alternative is meaningless when no second was picked: there
    // is nothing for it to be an alternative to.
    if (entry.role === "secondary" && !second) continue;
    taken.add(id);
    alternatives.push({ id, role: entry.role, whatItIs: entry.whatItIs.trim() });
  }

  return {
    primary: resolvedPrimary,
    // A bad second choice loses the join, not the widget. The first id is the
    // one everything downstream depends on, so only that one is fatal.
    secondary: second,
    // Meaningless without a second endpoint, so it is not carried without one.
    relationship: second ? (parsed.data.relationship ?? "enrich") : null,
    alternatives,
    reason: reason.trim(),
    error: null,
  };
};
