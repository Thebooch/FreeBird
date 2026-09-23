import type {
  CategorySpec,
  EntitySpec,
  OpDef,
  ResourceSpec,
  StarterSpec,
} from "@freebirdai/dash-spec";
import {
  STARTERS_PER_CATEGORY_MAX,
  compileBrief,
  entityById,
  fnv1a,
  missingInputs,
  starterSchema,
  widgetSources,
} from "@freebirdai/dash-spec";
import type { GraphOp } from "@freebirdai/dash-spec";
import { z } from "zod";
import { briefFromParts, type BriefCandidate } from "./brief.js";
import type { LlmAdapter, LlmTool } from "./llm.js";
import { UNTRUSTED_METADATA, callTool } from "./retry.js";

/**
 * What one part of an API should open with.
 *
 * The pass that turns a category into a dashboard worth looking at. It writes
 * briefs, never widgets, and that distinction is the whole design: a brief
 * names a record type and what the widget is *for*, and `compileBrief` turns
 * it into a validated widget against whichever endpoints the connection in
 * front of it actually carries. A stored widget spec would freeze one
 * account's endpoint ids into an artifact meant to be shared with everybody
 * who ever connects this API.
 *
 * **One call per category, and it resumes.** Unlike the categorising pass,
 * each answer here is about one category in isolation, so batching costs
 * nothing and buys the thing that matters on a paid pass: a run that loses its
 * fourth call keeps the three before it. The batch key is the category's own
 * content, so a category whose record types changed is re-done and the rest
 * are not.
 *
 * **Every brief is compiled before it is stored.** The validation boundary is
 * not "does this name a real record type" — it is "does this actually build".
 * A brief that cannot is dropped here with the compiler's own sentence, rather
 * than stored and discovered by the first person whose board comes up short.
 */

/** A widget the model may ask for, described as the flat brief schema allows. */
const starterProposalSchema = z.object({
  widgets: z
    .array(
      z.object({
        entity: z
          .string()
          .describe("The id of the record type this is about. Copy it exactly."),
        intent: z
          .enum(["records", "measure", "compare"])
          .describe(
            '"records" shows the records themselves, narrowed with filter strips. "measure" ' +
              'is ONE number: how many, or how much. "compare" is that number broken down by ' +
              "something, drawn as a chart.",
          ),
        title: z
          .string()
          .optional()
          .describe(
            "What to call it, in the words somebody in this business would use. Omit to use " +
              "the record type's own name.",
          ),
        filters: z
          .array(
            z.object({
              field: z.string().describe("Field path, copied exactly from the record type."),
              values: z
                .array(z.string())
                .max(8)
                .optional()
                .describe(
                  "Values to start the strip narrowed to. Copy them from the ones the record " +
                    "type lists where it lists any. A value matching nothing is ignored, so " +
                    "the reader sees everything rather than nothing.",
                ),
            }),
          )
          .max(4)
          .optional()
          .describe(
            "Fields to offer as filter strips above the records. Omit to use the record " +
              "type's own defaults, which are usually right.",
          ),
        groupBy: z
          .string()
          .optional()
          .describe('Required for "compare": the field path the number is broken down by.'),
        measureAgg: z
          .enum(["count", "sum"])
          .optional()
          .describe('"count" counts records and is the default. "sum" adds a number up.'),
        measureField: z
          .string()
          .optional()
          .describe('The field path to add up. Required when measureAgg is "sum".'),
        sortField: z.string().optional().describe("A field path to sort by."),
        sortDir: z.enum(["asc", "desc"]).optional(),
        importance: z
          .number()
          .describe(
            "How much of the board this deserves, 1 to 5. 5 is what somebody opens this " +
              "dashboard to see; 1 is worth having and not worth the top of the page. Do not " +
              "give everything a 5 — the order is what makes a dashboard readable.",
          )
          .optional(),
        size: z
          .enum(["sm", "md", "lg", "full"])
          .describe(
            "How large to draw it. A single number wants sm. A chart wants md or lg. The one " +
              "table somebody works from wants lg or full. Omit to let the component choose.",
          )
          .optional(),
      }),
    )
    .describe("The widgets this part of the software should open with, most important first.")
    .optional(),
});

export type StarterProposal = z.infer<typeof starterProposalSchema>;

const starterTool: LlmTool<StarterProposal> = {
  name: "compose_dashboard",
  description: "Say which widgets this part of the software should open with.",
  schema: starterProposalSchema,
};

export const STARTER_SYSTEM_PROMPT = `You are composing the dashboard one part of a software product opens with.

Somebody has just connected this API and asked for this part of it. They have
answered no other questions and will see whatever you choose, so choose what
the person whose job this is looks at first thing in the morning.

Compose FOUR to SIX widgets. Every one of them must earn its place.

WHAT A GOOD ONE LOOKS LIKE:
- Open with the numbers. Two or three counts or totals somebody checks without
  reading anything: how much work is open, how many are overdue, what is owed.
- Then how those numbers break down. One or two charts — by status, by
  category, by month.
- Then the records themselves. One list, with filter strips, of the thing this
  part of the product is mostly about. This is what somebody actually works
  from, so it is usually the largest thing on the board.

RULES:
- Use record type ids and field paths EXACTLY as given. An invented one is
  discarded, never approximated.
- Only the record types offered below. They are the ones in this part of the
  product; anything else belongs to a different dashboard.
- A field path belongs to the record type it is listed under. Never name one
  listed under a different record type.
- "sum" needs a field that holds an amount. Use the ones marked as worth
  totalling, and count records when none of them fits.
- "compare" needs something to break the number down by. A field marked as
  worth narrowing is usually right; a date field gives a month-by-month chart.
- Say as little as possible otherwise. Every record type already knows which
  fields are worth showing, how to sort and what to filter by, and those
  defaults beat a guess. Name a field only where it is the point of the widget.
- Do not build the same widget twice. Two counts of the same records differing
  only by a filter are one widget with a strip.
- Do not pad. Four widgets that answer real questions is a better dashboard
  than six where two are filler, and you are allowed to stop.

${UNTRUSTED_METADATA}`;

export interface StarterInput {
  readonly apiTitle: string;
  readonly category: CategorySpec;
  /**
   * The record types in this category, as the brief layer presents them.
   *
   * Only this category's, so the model cannot reach for records that belong to
   * a dashboard somebody did not ask for.
   */
  readonly candidates: readonly BriefCandidate[];
  /**
   * Record types that only exist underneath another, named so they can be
   * ruled out rather than picked and then refused.
   *
   * `/applicants/{applicantId}/applications` cannot be fetched without an
   * applicant, and a widget on a board has nowhere to get one — so the
   * compiler refuses it, correctly. But the model had already spent a pick on
   * it: measured on a real API, three of Leasing's five widgets went this way
   * and the part opened with two. Naming them is cheaper than refusing them.
   */
  readonly scoped?: readonly string[] | undefined;
}

/** What a compiled check needs in order to know a brief would build. */
export interface StarterCheck {
  readonly entities: readonly EntitySpec[];
  readonly resources: readonly ResourceSpec[];
  readonly ops: readonly GraphOp[];
  /** The connection the check compiles against. Never stored on the starter. */
  readonly connection: string;
  readonly pathOf?: ((op: string | undefined) => string | undefined) | undefined;
  /**
   * The endpoints themselves, for what each one requires.
   *
   * A list endpoint that cannot be called without an input a board has no
   * way to supply — a property id, a date the API insists on — compiles
   * perfectly and fails on every load. `scope` catches the ones the URL gives
   * away; this catches the rest.
   */
  readonly opDefs?: readonly OpDef[] | undefined;
}

export interface StarterResult {
  readonly categories: readonly CategorySpec[];
  readonly completedBatches: readonly string[];
  readonly errors: readonly string[];
  /** Widgets refused, and why. Not errors — the pass declined to store one. */
  readonly skipped: readonly string[];
  /** How many were proposed, against how many survived the compile. */
  readonly proposed: number;
  readonly kept: number;
}

/** A category's identity for resumption: its records, not its prose. */
export const starterBatchKey = (apiTitle: string, category: CategorySpec): string =>
  fnv1a(JSON.stringify({ title: apiTitle, id: category.id, entities: [...category.entities] }));

export const buildStarterPrompt = (input: StarterInput): string => {
  const lines: string[] = [
    `API: ${input.apiTitle}`,
    `PART OF IT: ${input.category.title}`,
    ...(input.category.description ? [`WHICH COVERS: ${input.category.description}`] : []),
    "",
    "RECORD TYPES IN THIS PART:",
  ];

  /* `scoped` holds record type ids, which is what `recordType` is — `entity`
   * is the id the model copies, qualified where two APIs share a name. */
  const scoped = new Set(input.scoped ?? []);
  const offerable = input.candidates.filter((candidate) => !scoped.has(candidate.recordType));

  for (const candidate of offerable) {
    const summary = (candidate.description ?? "").split("\n")[0]?.slice(0, 160).trim();
    lines.push(`  ${candidate.entity}  ${candidate.many}${summary ? `  — ${summary}` : ""}`);
    const narrow = candidate.fields.filter((field) => field.role === "narrow");
    const total = candidate.fields.filter((field) => field.role === "total");
    if (narrow.length > 0) {
      lines.push(
        `      worth narrowing or grouping by: ${narrow
          .map(
            (field) =>
              `${field.label} (${field.path})${
                field.values && field.values.length > 0
                  ? ` one of: ${field.values.join(" / ")}`
                  : ""
              }`,
          )
          .join(", ")}`,
      );
    }
    if (total.length > 0) {
      lines.push(
        `      worth totalling: ${total
          .map((field) => `${field.label} (${field.path})`)
          .join(", ")}`,
      );
    }
  }

  /*
   * Said out loud rather than silently omitted. These records are genuinely
   * part of this category, and a model shown a list it cannot account for will
   * reach for the nearest thing it can — better that it knows they exist and
   * knows why they are not on offer.
   */
  const unavailable = input.candidates.filter((candidate) => scoped.has(candidate.recordType));
  if (unavailable.length > 0) {
    lines.push(
      "",
      "ALSO IN THIS PART, BUT NOT AVAILABLE — these only exist underneath another",
      "record, so they are shown on that record's page and can never be a widget here:",
      ...unavailable.map((candidate) => `  ${candidate.many}`),
    );
  }

  return lines.join("\n");
};

/**
 * Keep the widgets that would actually build.
 *
 * Exported and pure so the boundary can be tested without a model. Two checks,
 * and the second is the one that matters: a record type that was offered, and
 * a brief the compiler accepts. Everything a brief can get wrong — a field the
 * records do not carry, a comparison with nothing to break down, a sum of
 * something that is not a number — the compiler already knows and says in a
 * sentence worth showing.
 */
export const startersFromProposal = (input: {
  readonly proposal: StarterProposal;
  readonly candidates: readonly BriefCandidate[];
  readonly category: CategorySpec;
  readonly check?: StarterCheck | undefined;
}): { starters: readonly StarterSpec[]; skipped: readonly string[]; proposed: number } => {
  const offered = new Map(input.candidates.map((candidate) => [candidate.entity, candidate]));
  const rows = input.proposal.widgets ?? [];
  const skipped: string[] = [];
  const starters: StarterSpec[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (starters.length >= STARTERS_PER_CATEGORY_MAX) {
      skipped.push(
        `${input.category.title}: stopped at ${STARTERS_PER_CATEGORY_MAX} widgets, which is as many as one board opens with.`,
      );
      break;
    }

    const candidate = offered.get(row.entity);
    if (!candidate) {
      skipped.push(
        `${input.category.title}: a widget named "${row.entity}", which is not a record type in this part.`,
      );
      continue;
    }

    const brief = briefFromParts({ ...row, entity: candidate.entity });

    /*
     * A total has to be over something that holds an amount.
     *
     * The compiler refuses a sum of a record or of a field the records do not
     * carry, and allows a sum of a string that happens to exist — which
     * renders as zero on every row forever, with a title over it claiming to
     * be money. Caught here because this is where the offered set is known: a
     * field marked as worth totalling is the only thing the model was shown,
     * and the prompt tells it to count records when none of them fits. So a
     * sum over anything else is not an approximation to be salvaged, it is a
     * field that was never offered.
     */
    if (brief.measure?.agg === "sum") {
      const totallable = new Set(
        candidate.fields.filter((field) => field.role === "total").map((field) => field.path),
      );
      if (!brief.measure.field || !totallable.has(brief.measure.field)) {
        skipped.push(
          `${input.category.title}: a widget totalled "${
            brief.measure.field ?? "nothing"
          }", which is not an amount ${candidate.many} carry.`,
        );
        continue;
      }
    }

    /*
     * The same widget twice is what a model produces when it is padding, and
     * two of them on a starting board read as a bug rather than a choice.
     */
    const identity = JSON.stringify([
      brief.entity,
      brief.intent,
      brief.groupBy ?? null,
      brief.measure ?? null,
    ]);
    if (seen.has(identity)) {
      skipped.push(
        `${input.category.title}: a second widget showing the same thing as an earlier one.`,
      );
      continue;
    }

    if (input.check) {
      const entity = entityById(input.check.entities, candidate.recordType);
      const resource = entity
        ? input.check.resources.find((one) => one.id === entity.resource)
        : undefined;
      if (!entity || !resource) {
        skipped.push(
          `${input.category.title}: ${candidate.many} are not a record type this API carries.`,
        );
        continue;
      }
      const compiled = compileBrief({
        brief,
        entity,
        resource,
        connection: input.check.connection,
        id: "check",
        ...(input.check.pathOf ? { listPath: input.check.pathOf(resource.listOp) } : {}),
        related: {
          entities: input.check.entities,
          resources: input.check.resources,
          ops: input.check.ops,
        },
      });
      if (!compiled.widget) {
        skipped.push(
          `${input.category.title}: ${
            compiled.errors[0] ??
            compiled.notes[0] ??
            `a widget of ${candidate.many} could not be built.`
          }`,
        );
        continue;
      }

      /*
       * Built, but can it be fetched? Fan-out sources are exempt: their
       * inputs come from another source's rows by design.
       */
      const needs = input.check.opDefs
        ? widgetSources(compiled.widget).flatMap((source) => {
            if (source.fanOut) return [];
            const def = input.check!.opDefs!.find((one) => one.id === source.op);
            return def ? missingInputs(def, source.params) : [];
          })
        : [];
      if (needs.length > 0) {
        skipped.push(
          `${input.category.title}: ${candidate.many} cannot be listed without ${[
            ...new Set(needs),
          ].join(", ")}, which a board has no way to supply.`,
        );
        continue;
      }
    }

    const parsed = starterSchema.safeParse({
      brief,
      ...(row.importance !== undefined
        ? { importance: Math.min(5, Math.max(1, Math.round(row.importance))) }
        : {}),
      ...(row.size ? { size: row.size } : {}),
    });
    if (!parsed.success) {
      skipped.push(
        `${input.category.title}: a widget did not validate (${parsed.error.issues
          .slice(0, 2)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}).`,
      );
      continue;
    }

    seen.add(identity);
    starters.push(parsed.data);
  }

  return { starters, skipped, proposed: rows.length };
};

/** What composing one category came to. */
export interface ComposedCategory {
  /**
   * The category with its set written and its status set: `ready` with
   * starters, `empty` when it was composed and nothing could be built — so
   * it is not paid for again until the API changes — or `failed`, which is
   * retried on the next run.
   */
  readonly category: CategorySpec;
  readonly skipped: readonly string[];
  readonly proposed: number;
  /** Set when the call itself failed. The category is `failed`. */
  readonly error?: string | undefined;
}

/**
 * Write one category's starter set.
 *
 * One call, retried once with the compiler's own reasons when nothing it
 * proposed would build. The unit onboarding resumes by: every category is
 * composed on its own and its status stored straight after, so a run that
 * loses its fourth call keeps the three before it.
 */
export const composeCategory = async (
  llm: LlmAdapter,
  input: {
    readonly apiTitle: string;
    readonly category: CategorySpec;
    /** Every record type on the API; this category's own are selected here. */
    readonly candidates: readonly BriefCandidate[];
    readonly check?: StarterCheck | undefined;
  },
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<ComposedCategory> => {
  const { category } = input;
  const byId = new Map(input.candidates.map((candidate) => [candidate.entity, candidate]));
  const empty = (reason: string): ComposedCategory => ({
    category: { ...category, starters: [], status: "empty", error: reason },
    skipped: [reason],
    proposed: 0,
  });

  const candidates = category.entities
    .map((id) => byId.get(id))
    .filter((candidate): candidate is BriefCandidate => candidate !== undefined);
  if (candidates.length === 0) {
    return empty(
      `${category.title}: none of its record types are described, so nothing could be composed.`,
    );
  }

  /*
   * Read off the record types themselves: `scope` is set when the API lists
   * a collection underneath another, which is a fact from the URL rather
   * than a judgement. Only meaningful when there is something to read it
   * from, so a caller with no check simply offers everything and lets the
   * compiler have the last word.
   */
  const scoped = (input.check?.entities ?? [])
    .filter((entity) => entity.scope !== undefined)
    .map((entity) => entity.id);
  const scopedHere = new Set(scoped);
  if (candidates.every((candidate) => scopedHere.has(candidate.recordType))) {
    return empty(
      `${category.title}: every one of its record types only exists underneath another, so it has no dashboard of its own.`,
    );
  }

  let proposed = 0;
  const attempt = async () =>
    callTool(llm, {
      tool: starterTool,
      system: STARTER_SYSTEM_PROMPT,
      user: buildStarterPrompt({ apiTitle: input.apiTitle, category, candidates, scoped }),
      model: options.model,
      signal: options.signal,
      accept: (proposal) => {
        const tried = startersFromProposal({ proposal, candidates, category, check: input.check });
        return tried.starters.length > 0
          ? null
          : `nothing you proposed could be built. ${tried.skipped.slice(0, 4).join(" ")}`;
      },
    });

  let answer: Awaited<ReturnType<typeof attempt>>;
  try {
    answer = await attempt();
  } catch (cause) {
    const error = `${category.title}: ${cause instanceof Error ? cause.message : String(cause)}`;
    return {
      category: { ...category, status: "failed", error },
      skipped: [],
      proposed,
      error,
    };
  }
  if ("error" in answer) {
    const error = `${category.title}: ${answer.error}`;
    return {
      category: { ...category, status: "failed", error },
      skipped: [],
      proposed,
      error,
    };
  }

  const built = startersFromProposal({
    proposal: answer.args,
    candidates,
    category,
    ...(input.check ? { check: input.check } : {}),
  });
  proposed = built.proposed;

  if (built.starters.length === 0) {
    const reason = `${category.title}: nothing it proposed could be built.`;
    return {
      category: { ...category, starters: [], status: "empty", error: reason },
      skipped: [...built.skipped, reason],
      proposed,
    };
  }

  const { error: _previous, ...rest } = category;
  return {
    category: { ...rest, starters: [...built.starters], status: "ready" },
    skipped: built.skipped,
    proposed,
  };
};

/**
 * Write a starter set for every category that has not got one.
 *
 * A loop over `composeCategory`, kept for callers that want the whole API
 * composed in one go — the evaluation scripts, and the catalog route a script
 * would call. Categories fail independently, exactly as the mapping and
 * describing passes do: a set covering most of an API is worth keeping and
 * worth re-running for the rest.
 */
export const composeStarters = async (
  llm: LlmAdapter,
  input: {
    readonly apiTitle: string;
    readonly categories: readonly CategorySpec[];
    /** Every record type on the API; each category's own are selected here. */
    readonly candidates: readonly BriefCandidate[];
    readonly check?: StarterCheck | undefined;
  },
  options: {
    model?: string | undefined;
    signal?: AbortSignal | undefined;
    completedBatches?: readonly string[];
    onCheckpoint?: (result: StarterResult) => void;
  } = {},
): Promise<StarterResult> => {
  const previous = new Set(options.completedBatches ?? []);
  const completed = new Set<string>();
  const errors: string[] = [];
  const skipped: string[] = [];
  const written = new Map(input.categories.map((category) => [category.id, category]));
  let proposed = 0;
  let kept = 0;

  for (const category of input.categories) {
    const batchKey = starterBatchKey(input.apiTitle, category);
    /*
     * A category whose set was already written is skipped only when it still
     * *has* one: a completed batch with no starters behind it is a run that
     * was interrupted between the call and the write.
     */
    if (previous.has(batchKey) && category.starters.length > 0) {
      completed.add(batchKey);
      kept += category.starters.length;
      continue;
    }

    const result = await composeCategory(
      llm,
      {
        apiTitle: input.apiTitle,
        category,
        candidates: input.candidates,
        ...(input.check ? { check: input.check } : {}),
      },
      { model: options.model, signal: options.signal },
    );
    proposed += result.proposed;
    kept += result.category.starters.length;
    skipped.push(...result.skipped);
    written.set(category.id, result.category);

    if (result.error) {
      errors.push(result.error);
      continue;
    }
    completed.add(batchKey);
    options.onCheckpoint?.({
      categories: [...written.values()],
      completedBatches: [...completed],
      errors,
      skipped,
      proposed,
      kept,
    });
  }

  return {
    categories: [...written.values()],
    completedBatches: [...completed],
    errors,
    skipped,
    proposed,
    kept,
  };
};
