import { z } from "zod";
import type { EntityKind, EntitySpec, WidgetBrief } from "@freebirdai/dash-spec";
import { facetsFromRecipe, recipeFor } from "@freebirdai/dash-spec";
import type { LlmAdapter, LlmTool } from "./llm.js";

/**
 * Turning a request into a brief, over record types rather than endpoints.
 *
 * The replacement for hunting through an endpoint list. Choosing between two
 * hundred endpoints titled "Retrieve all X" is a job nobody can do well — the
 * model least of all — and it was never the question anybody was asking. The
 * question is which *records* they mean, and once an API has been described
 * that is a list of a hundred plain nouns with a sentence each.
 *
 * **The brief is small on purpose.** It names the record type, what the widget
 * is for, and only what the request actually asked for. Everything else — the
 * columns, the sort, the filter strips, the endpoint, the pipeline — comes
 * from the record type and its kind, deterministically, in `compileBrief`. So
 * the model is never asked to produce a pipeline it could get subtly wrong; it
 * produces a handful of names that are checked against the real thing.
 *
 * **Intent is the whole of the fix.** Asked for records "with a filter by
 * category", the old flow built a chart of counts per category, because a
 * grouping was the only vocabulary it had for "by category". Here, wanting to
 * *see* records and wanting to *count* them across something are different
 * answers to a question the model is asked outright, and the prompt spends
 * most of its length on that one distinction because it is the one that was
 * being got wrong.
 */

/** A field worth naming in a brief. */
export interface BriefField {
  readonly path: string;
  readonly label: string;
  /** `narrow` filters or groups; `total` is a number worth adding up. */
  readonly role: "narrow" | "total";
  /**
   * The values this field is allowed to hold, where the API declares them.
   *
   * Carried so a narrowing phrase can be written in the API's own spelling
   * rather than the user's. Empty on every field of a real API today — nothing
   * has captured the specification's enums yet — which is why an approximate
   * value has to stay safe rather than merely unlikely.
   */
  readonly values?: readonly string[];
}

/** One API's described record types, as one source to choose from. */
export interface BriefSource {
  readonly connection: string;
  /** The API's own name, so two of them can be told apart in the roster. */
  readonly title: string;
  readonly entities: readonly EntitySpec[];
}

/** One record type the model may choose. */
export interface BriefCandidate {
  /**
   * What the model copies, and what makes it unique across every API.
   *
   * The record type's own id where that is unambiguous, qualified with the
   * connection where two APIs both have one — the same rule the chat's widget
   * and record handles follow, and for the same reason: "task" reads as a
   * thing and "task--acme" reads as configuration, so the second is worth
   * paying for only where the first would be ambiguous.
   */
  readonly entity: string;
  /** Which API this came from, and its own id there. */
  readonly connection: string;
  readonly recordType: string;
  /** That API's name, for grouping the roster where there is more than one. */
  readonly source: string;
  readonly many: string;
  readonly kind: EntityKind;
  readonly description?: string | undefined;
  /**
   * Whether somebody would start a widget from these.
   *
   * False for the kinds that only make sense under another record — a list of
   * every category on an account is a glossary, not a dashboard.
   */
  readonly starting: boolean;
  readonly fields: readonly BriefField[];
}

export interface WriteBriefInput {
  /** What the user asked for, in their own words. */
  readonly intent: string;
  readonly candidates: readonly BriefCandidate[];
}

export interface WriteBriefResult {
  readonly brief: WidgetBrief | null;
  /** The model's own words for what it built, shown to the user. */
  readonly reason: string;
  /**
   * A different reading of the same words, offered beside the answer.
   *
   * Deliberately not a question asked before building. Blocking on "did you
   * mean records or a count?" makes every request an interrogation, and the
   * answer is usually obvious — so the better reading is built and the other
   * is offered as one click. It is null on almost every request, and has to
   * stay that way: an alternative on everything is a question on everything
   * wearing different clothes.
   */
  readonly alternative: { readonly label: string; readonly brief: WidgetBrief } | null;
  /**
   * More widgets, when the request asked for separate things seen together.
   *
   * Empty on almost every request, and it has to stay that way: a set on
   * everything would turn "show me my tasks" into a dashboard nobody asked
   * for. A request naming two collections is genuinely two widgets — which is
   * different from one widget carrying a second record's fields, and different
   * again from two readings of one request.
   */
  readonly plus: readonly WidgetBrief[];
  readonly error: string | null;
}

/** How many fields of each kind are worth putting in front of the model. */
const MAX_NARROW = 4;
const MAX_TOTAL = 2;
const DESCRIPTION_CHARS = 100;

/** Numbers worth totalling, as opposed to identifiers that happen to be numeric. */
const TOTALLABLE = new Set(["currency", "number", "count", "duration", "bytes", "percent"]);

/**
 * The record types a request could be about, with the few fields worth naming.
 *
 * Deliberately not every field. A brief names what somebody asked to narrow or
 * total by, and those are a handful per record type — where the whole field
 * dictionary for a real API is twelve hundred entries and would put the
 * prompt back where the endpoint list had it.
 */
/**
 * The record types to choose between, across every API that has any.
 *
 * Takes sources rather than a flat list because *which API* is part of the
 * answer: a workspace with two connections has two rosters, and a brief that
 * could only ever see one of them made the assistant fall back to picking
 * endpoints by hand the moment somebody connected a second.
 */
export const briefCandidates = (sources: readonly BriefSource[]): BriefCandidate[] => {
  /*
   * Qualified only on collision. Two APIs that both call something a task
   * genuinely need telling apart; one that does not should not be made to read
   * like configuration for the sake of the one that might.
   */
  const owners = new Map<string, number>();
  for (const source of sources) {
    for (const entity of source.entities) {
      owners.set(entity.id, (owners.get(entity.id) ?? 0) + 1);
    }
  }

  return sources.flatMap((source) =>
    source.entities.map((entity) => {
    const recipe = recipeFor(entity.kind);
    const visible = entity.fields.filter((field) => field.visibility !== "hidden");

    const narrowPaths =
      entity.views.facets.length > 0
        ? entity.views.facets
        : facetsFromRecipe(recipe, visible.map((field) => field.path));

    const labelOf = (path: string): string =>
      entity.fields.find((field) => field.path === path)?.label ?? path;

    const valuesOf = (path: string): readonly string[] =>
      entity.fields.find((field) => field.path === path)?.values ?? [];

    const narrow: BriefField[] = narrowPaths.slice(0, MAX_NARROW).map((path) => ({
      path,
      label: labelOf(path),
      role: "narrow" as const,
      ...(valuesOf(path).length > 0 ? { values: valuesOf(path).slice(0, 8) } : {}),
    }));

    const total: BriefField[] = visible
      .filter((field) => field.semantic && TOTALLABLE.has(field.semantic))
      .slice(0, MAX_TOTAL)
      .map((field) => ({ path: field.path, label: field.label ?? field.path, role: "total" as const }));

    return {
      entity:
        (owners.get(entity.id) ?? 0) > 1 ? `${entity.id}--${source.connection}` : entity.id,
      connection: source.connection,
      recordType: entity.id,
      source: source.title,
      many: entity.name.many,
      kind: entity.kind,
      ...(entity.description ? { description: entity.description } : {}),
      starting: recipe.starting,
      fields: [...narrow, ...total],
    };
    }),
  );
};

/**
 * The record type a brief named, and which API it belongs to.
 *
 * Null when the model wrote something that was not offered — never
 * approximated, on the same rule every other pass here follows.
 */
export const resolveCandidate = (
  candidates: readonly BriefCandidate[],
  named: string,
): BriefCandidate | null => candidates.find((one) => one.entity === named) ?? null;

export const briefSchema = z.object({
  entity: z.string().describe("The id of the record type this is about. Copy it exactly."),
  intent: z
    .enum(["records", "measure", "compare"])
    .describe(
      'What the widget is for. "records" shows the records themselves, which the reader ' +
        'narrows with filter strips — this is what "show me X", "list X" and "X filtered by ' +
        'Y" all mean. "measure" is ONE number about them: how many there are, or how much ' +
        'they come to. "compare" is that number broken down by something and drawn as a ' +
        'chart — "how many X per Y", "X by month", "compare X across Y".',
    ),
  title: z.string().optional().describe("What to call it, in the user's words. Omit to use the record type's own name."),
  filters: z
    .array(
      z.object({
        field: z.string().describe("Field path, copied exactly from the record type's list."),
        values: z
          .array(z.string())
          .max(8)
          .optional()
          .describe(
            'Values to start the strip narrowed to, when the request named some — "open X" ' +
              'starts the state strip on "Open". Copy one of the values the record type lists ' +
              "where it lists any; otherwise use the user's own word. A value matching nothing " +
              "is ignored and the reader simply sees everything, so an approximate word is " +
              "safe here — an invented FIELD is not.",
          ),
      }),
    )
    .max(4)
    .optional()
    .describe(
      'Fields to offer as filter strips. This is where "filtered by Y" goes, and also where a ' +
        'narrowing phrase goes. Omit to use the record type\'s own defaults, which are usually ' +
        "right.",
    ),
  columns: z
    .array(z.string())
    .max(6)
    .optional()
    .describe(
      "Field paths to show, only when the user named particular ones. Omit otherwise — the " +
        "record type already knows which fields are worth showing.",
    ),
  groupBy: z
    .string()
    .optional()
    .describe('Required for "compare": the field path the number is broken down by.'),
  measureAgg: z
    .enum(["count", "sum"])
    .optional()
    .describe(
      'What is being measured, for "measure" and "compare". "count" counts records and is ' +
        'the default. "sum" adds a number up and needs measureField.',
    ),
  measureField: z.string().optional().describe('The field path to add up. Required when measureAgg is "sum".'),
  sortField: z
    .string()
    .optional()
    .describe("A field path to sort by, only when the user asked for a particular sort."),
  sortDir: z.enum(["asc", "desc"]).optional().describe("Which way to sort."),
  limit: z.number().int().min(1).max(1000).optional().describe('Only when the user asked for "top" or "first" so many.'),
  alongsideEntity: z
    .string()
    .optional()
    .describe(
      "A SECOND kind of record, when the request names two — \"my X alongside their Y\", " +
        '"X with their Y", "X against Y". Copy its id from the list exactly, the same way ' +
        "you copy the first. Leave it out unless the request really is about two kinds of " +
        "record.",
    ),
  alongsideAs: z
    .enum(["join", "beside"])
    .optional()
    .describe(
      'Which question the second kind answers. "join" reads one record and the other ' +
        "together, a row at a time — what else is true of this one. \"beside\" sets two " +
        "measurements against each other on one axis, which is a chart and only makes sense " +
        'with "compare". Defaults to "join".',
    ),
  plus: z
    .array(
      z.object({
        entity: z.string().describe("The id of this one's record type. Copy it exactly."),
        intent: z.enum(["records", "measure", "compare"]),
        title: z.string().optional(),
        filters: z
          .array(z.object({ field: z.string(), values: z.array(z.string()).max(8).optional() }))
          .max(4)
          .optional(),
        groupBy: z.string().optional(),
        measureAgg: z.enum(["count", "sum"]).optional(),
        measureField: z.string().optional(),
      }),
    )
    .max(3)
    .optional()
    .describe(
      "MORE widgets, when the request asks for separate things to be seen together — " +
        '"my X and my Y", "X, Y and Z on one tab". One entry each, described exactly as the ' +
        "first one is. Leave it out for every ordinary request, which is nearly all of them. " +
        "Never use it to hedge between two readings of the same words — that is `alternative` " +
        "— and never for a second kind of record that belongs ON these rows, which is " +
        "`alongsideEntity`.",
    ),
  alternative: z
    .object({
      label: z
        .string()
        .describe(
          "What this other reading would show, in the user's own words. A short phrase — " +
            '"how many per category" — never a sentence and never a field path.',
        ),
      intent: z.enum(["records", "measure", "compare"]),
      entity: z
        .string()
        .optional()
        .describe("Only when the other reading is about a different kind of record."),
      groupBy: z.string().optional(),
      filters: z
        .array(z.object({ field: z.string(), values: z.array(z.string()).max(8).optional() }))
        .max(4)
        .optional(),
      measureAgg: z.enum(["count", "sum"]).optional(),
      measureField: z.string().optional(),
    })
    .optional()
    .describe(
      "A genuinely different reading of the same words, offered beside your answer rather " +
        "than instead of it. The usual one: they asked to see records and might have meant a " +
        "count broken down, or the other way about. Leave it out unless choosing it would " +
        "answer a DIFFERENT question — never to hedge between two readings that show the " +
        "same thing.",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence, addressed to the user, saying what you built. Plain words — name " +
        "the records, never the record type id or a field path.",
    ),
});

type BriefArgs = z.infer<typeof briefSchema>;

const briefTool: LlmTool<BriefArgs> = {
  name: "write_brief",
  description: "Say which records the request is about, and what the widget should do with them.",
  schema: briefSchema,
};

export const BRIEF_SYSTEM_PROMPT = [
  "You turn a request for a dashboard widget into a brief.",
  "",
  "You are given every kind of record this API has, with a description and the few fields",
  "worth naming. Say which records the request is about, and what the widget is for.",
  "",
  "THE ONE DISTINCTION THAT MATTERS — what is the widget FOR?",
  "",
  '- "records" — they want to SEE the records. A list they can read, and narrow with filter',
  "  strips. This is what almost every request means.",
  '- "measure" — they want ONE number. How many there are, or how much they add up to.',
  '- "compare" — they want a number BROKEN DOWN by something, drawn as a chart.',
  "",
  "Getting this wrong is the most damaging thing you can do here, and it goes wrong in one",
  "direction: turning a request to SEE records into a chart that COUNTS them.",
  "",
  '- "show me X with a filter by Y" is records. Put Y in filters. It is NOT a comparison —',
  "  the person wants the records in front of them with a way to narrow down, not a count.",
  '- "X filtered by Y", "X by Y" where they asked to see or list X: records, Y in filters.',
  '- "how many X per Y", "X by month", "compare X and Y", "breakdown of X by Y": compare.',
  '- "how many X", "total X", "what are we owed": measure.',
  "- When the words could be read either way, prefer records. A list can be read and then",
  "  narrowed; a chart of counts answers one question and hides the records entirely.",
  "",
  "A WORD THAT NAMES A VALUE, NOT A FIELD.",
  "",
  '- "maintenance tasks", "open work", "unpaid bills" name a *value* one of the fields holds.',
  "  That is still records — the whole set — with the strip for that field started narrowed to",
  "  the value. Put the field in `filters` and the word in that filter's `values`.",
  "- Never leave the word out and hand back the unnarrowed list: they asked for a subset.",
  "- Never answer it with a count either. They want to see the ones that match.",
  "- Copy the value from the ones the record type lists where it lists any; otherwise use their",
  "  own word. A value matching nothing is ignored and they simply see everything, so an",
  "  approximate word is worth writing and a wrong field is not.",
  "",
  "Choosing the records:",
  "- Answer with a RECORD TYPE ID — the first token on its line. Copy it exactly. One you",
  "  invent or abbreviate is a failure, not an approximation.",
  "- Read the descriptions. People describe what they want in their own words, and the",
  "  records that answer it are often named something else.",
  "- Pick the records the user wants to see. A request to see work grouped by who it is",
  "  assigned to is about the work, not about the people.",
  "- Some record types are marked as reference lists. Those are things other records point",
  "  at — a set of categories, a set of statuses. Somebody almost never wants a board of",
  "  them; pick one only if the request is plainly about the list itself.",
  "",
  "Narrowing phrases:",
  "- A word in front of the records usually narrows them rather than naming something else.",
  '  "open X", "overdue X", "unpaid X" are all X with a strip started on that value. Choose',
  "  the records the noun names, put the field in filters, and put the word in its values.",
  "- Never leave a narrowing invisible. Somebody who cannot see what was narrowed cannot",
  "  widen it, and will believe they are looking at everything there is.",
  "",
  "SEVERAL THINGS AT ONCE.",
  "",
  "- Four different things can be a \"second\" one, and they are not interchangeable:",
  "  - another record's fields ON each row  -> alongsideEntity, alongsideAs \"join\"",
  "  - two counts set against each other    -> alongsideEntity, alongsideAs \"beside\"",
  "  - the same words read two ways         -> alternative",
  "  - two separate things asked for        -> plus",
  '- "show me my X and my Y" is `plus`: two widgets, seen together. "Show me X with their Y"',
  "  is not — that is one widget with the other's fields on it.",
  "- Never use `plus` to hedge. If you are unsure which of two readings they meant, that is",
  "  `alternative` and it is one widget either way.",
  "",
  "Offering the other reading:",
  "- When the words genuinely read two ways, build the better one and offer the other as an",
  "  alternative with a short label. Do not ask first: the person sees what you built and",
  '  can switch in one click, which is faster than answering a question.',
  "- Only when choosing it would answer a DIFFERENT question. Two readings that show the",
  "  same thing are one reading, and an alternative on every request is an interrogation",
  "  wearing different clothes.",
  "",
  "TWO KINDS OF RECORD AT ONCE.",
  "",
  '- Some requests name two: "X alongside their Y", "X with their Y", "X against Y". Put the',
  "  first in entity and the second in alongsideEntity, both copied from the list.",
  '- alongsideAs says which question is being asked. "join" reads one record and the other',
  '  together, a row at a time, and is the usual one. "beside" sets two measurements against',
  '  each other on one axis, which is a chart and only ever goes with "compare".',
  "- A word that names a VALUE is not a second kind of record. A narrowing phrase belongs in",
  "  filters, as above; name a second record type only when the request is about both.",
  "- Leave it out when in doubt. One kind of record answered well is almost always the right",
  "  answer, and a second one nothing links to the first is dropped anyway.",
  "",
  "Naming fields:",
  "- Copy field paths exactly from the chosen record type's own list. Never invent one, and",
  "  never name a field listed under a different record type.",
  "- Say as little as possible. Every record type already knows which fields are worth",
  "  showing, how to sort them and what to filter by, and those defaults are usually better",
  "  than a guess. Name a field only when the request actually asked for that field.",
  "- Leave columns out unless particular fields were asked for by name.",
].join("\n");

/**
 * The roster the model chooses from.
 *
 * Record types, not endpoints — a hundred plain nouns with a sentence each,
 * where the endpoint list was two hundred lines of "Retrieve all X" separated
 * only by their URLs. Reference lists sit at the end under their own heading,
 * because they are legitimate answers and almost never the right one.
 */
export const buildBriefPrompt = (input: WriteBriefInput): string => {
  const render = (candidate: BriefCandidate): string => {
    const summary = (candidate.description ?? "")
      .split("\n")[0]
      ?.slice(0, DESCRIPTION_CHARS)
      .trim();
    const head = `  ${candidate.entity}  ${candidate.many}${summary ? `  — ${summary}` : ""}`;
    if (candidate.fields.length === 0) return head;
    const narrow = candidate.fields.filter((field) => field.role === "narrow");
    const total = candidate.fields.filter((field) => field.role === "total");
    const lines = [head];
    if (narrow.length > 0) {
      lines.push(
        `      narrow by: ${narrow
          .map(
            (f) =>
              `${f.label} (${f.path})${f.values && f.values.length > 0 ? ` one of: ${f.values.join(" / ")}` : ""}`,
          )
          .join(", ")}`,
      );
    }
    if (total.length > 0) {
      lines.push(`      total by: ${total.map((f) => `${f.label} (${f.path})`).join(", ")}`);
    }
    return lines.join("\n");
  };

  const starting = input.candidates.filter((candidate) => candidate.starting);
  const reference = input.candidates.filter((candidate) => !candidate.starting);

  /*
   * Grouped by API only when there is more than one.
   *
   * A workspace with a single connection should not be made to read like one
   * with several — the heading would be noise on every request. With two, that
   * grouping is the only thing telling the model that two similarly named
   * record types are different things in different systems.
   */
  const sources = [...new Set(input.candidates.map((candidate) => candidate.source))];
  const listed = (group: readonly BriefCandidate[]): string[] =>
    sources.length < 2
      ? group.map(render)
      : sources.flatMap((source) => {
          const mine = group.filter((candidate) => candidate.source === source);
          return mine.length > 0 ? [`  from ${source}:`, ...mine.map(render)] : [];
        });

  return [
    "RECORD TYPES:",
    ...listed(starting),
    ...(reference.length > 0
      ? [
          "",
          "REFERENCE LISTS — things other records point at, rarely a board of their own:",
          ...listed(reference),
        ]
      : []),
    "",
    "THE REQUEST:",
    input.intent,
  ].join("\n");
};

/**
 * Ask the model to write a brief.
 *
 * The record type it names is checked against the roster before anything is
 * believed — the same boundary every other model pass here draws. Field paths
 * are left to `compileBrief`, which holds the record type's whole field list
 * and reports what it dropped, rather than being checked twice against two
 * different ideas of what exists.
 */
export const writeBrief = async (
  llm: LlmAdapter,
  input: WriteBriefInput,
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<WriteBriefResult> => {
  const none = (error: string): WriteBriefResult => ({
    brief: null,
    reason: "",
    alternative: null,
    plus: [],
    error,
  });

  if (input.candidates.length === 0) {
    return none("this API has no record types described yet");
  }

  let result: Awaited<ReturnType<LlmAdapter["generate"]>>;
  try {
    result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 1024,
      messages: [
        { role: "system" as const, content: BRIEF_SYSTEM_PROMPT },
        { role: "user" as const, content: buildBriefPrompt(input) },
      ],
      tools: { write_brief: briefTool },
      toolChoice: { name: "write_brief" as const },
    });
  } catch (cause) {
    return none(cause instanceof Error ? cause.message : String(cause));
  }

  const call = result.toolCalls.find((candidate) => candidate.name === "write_brief");
  const parsed = call ? briefSchema.safeParse(call.args) : null;
  if (!parsed?.success) return none("the model did not write a brief");

  const args = parsed.data;
  const found = input.candidates.find((candidate) => candidate.entity === args.entity);
  if (!found) return none(`the model chose "${args.entity}", which is not a record type here`);

  const brief: WidgetBrief = {
    entity: found.entity,
    intent: args.intent,
    ...(args.title?.trim() ? { title: args.title.trim() } : {}),
    ...(args.columns && args.columns.length > 0 ? { columns: args.columns } : {}),
    ...(args.filters && args.filters.length > 0
      ? {
          filters: args.filters.map((one) => ({
            field: one.field,
            ...(one.values && one.values.length > 0 ? { values: one.values } : {}),
          })),
        }
      : {}),
    ...(args.groupBy ? { groupBy: args.groupBy } : {}),
    ...(args.sortField
      ? { sort: { field: args.sortField, ...(args.sortDir ? { dir: args.sortDir } : {}) } }
      : {}),
    /*
     * A measure is only carried where it means something. A count is the
     * default for every intent, and naming one on a plain list of records
     * would turn a list into a number nobody asked for.
     */
    ...(args.intent !== "records" && (args.measureAgg || args.measureField)
      ? {
          measure: {
            agg: args.measureAgg ?? "count",
            ...(args.measureField ? { field: args.measureField } : {}),
          },
        }
      : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    /*
     * The second record type, by the record type's own id.
     *
     * Resolved against the roster like the first, and carried through
     * unresolved where it is not on it: `compileBrief` holds the record types
     * and says plainly that there is no such thing, which beats dropping the
     * half of the request nobody would then know had gone missing.
     */
    ...(args.alongsideEntity
      ? {
          alongside: {
            entity:
              input.candidates.find((one) => one.entity === args.alongsideEntity)?.recordType ??
              args.alongsideEntity,
            ...(args.alongsideAs ? { as: args.alongsideAs } : {}),
          },
        }
      : {}),
  };

  /*
   * The other reading, checked as hard as the first.
   *
   * A record type it names has to be one on the roster, and one that would
   * build the very same widget is not an alternative to anything — offering it
   * would be asking a question with one answer.
   */
  let alternative: WriteBriefResult["alternative"] = null;
  const other = args.alternative;
  if (other?.label.trim()) {
    const entity = other.entity
      ? input.candidates.find((candidate) => candidate.entity === other.entity)?.entity
      : found.entity;
    const differs = entity !== found.entity || other.intent !== args.intent;
    if (entity && differs) {
      alternative = {
        label: other.label.trim(),
        brief: {
          entity,
          intent: other.intent,
          ...(other.filters && other.filters.length > 0
            ? {
                filters: other.filters.map((one) => ({
                  field: one.field,
                  ...(one.values && one.values.length > 0 ? { values: one.values } : {}),
                })),
              }
            : {}),
          ...(other.groupBy ? { groupBy: other.groupBy } : {}),
          ...(other.intent !== "records" && (other.measureAgg || other.measureField)
            ? {
                measure: {
                  agg: other.measureAgg ?? "count",
                  ...(other.measureField ? { field: other.measureField } : {}),
                },
              }
            : {}),
        },
      };
    }
  }

  /*
   * The other things asked for, each checked as hard as the first.
   *
   * A record type not on the roster is dropped rather than approximated, and
   * one repeating the primary is not a second widget — it is the same request
   * written twice, which is what a model does when it is padding.
   */
  const plus: WidgetBrief[] = [];
  for (const extra of args.plus ?? []) {
    const match = input.candidates.find((candidate) => candidate.entity === extra.entity);
    if (!match) continue;
    if (match.entity === found.entity && extra.intent === args.intent) continue;
    plus.push({
      entity: match.entity,
      intent: extra.intent,
      ...(extra.title?.trim() ? { title: extra.title.trim() } : {}),
      ...(extra.filters && extra.filters.length > 0
        ? {
            filters: extra.filters.map((one) => ({
              field: one.field,
              ...(one.values && one.values.length > 0 ? { values: one.values } : {}),
            })),
          }
        : {}),
      ...(extra.groupBy ? { groupBy: extra.groupBy } : {}),
      ...(extra.intent !== "records" && (extra.measureAgg || extra.measureField)
        ? {
            measure: {
              agg: extra.measureAgg ?? "count",
              ...(extra.measureField ? { field: extra.measureField } : {}),
            },
          }
        : {}),
    });
  }

  return { brief, reason: args.reason.trim(), alternative, plus, error: null };
};
