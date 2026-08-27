import { z } from "zod";
import type { FieldInfo } from "./infer.js";
import type { LlmAdapter, LlmTool } from "./llm.js";

/**
 * What a record shows when somebody opens it.
 *
 * Two questions, and neither has a schema answer. **Which fields belong to a
 * person** — a task carries `Href`s pointing back at the API, ids nobody can
 * read, and columns that are null on every record, alongside the handful
 * somebody actually opened it to see. And **which related collections come
 * with it** — a task has notes, a property has units, and whether those are
 * worth a tab depends on what the record is for.
 *
 * Both were previously decided by not deciding: the record pane took every
 * field the endpoint returned, and carried no related collections at all
 * unless the suggestions engine had built the widget. Everything a developer
 * needed and everything a person needed, in one undifferentiated list.
 *
 * Only asked for components whose marks are records. A point on a monthly
 * count has no record behind it, so a widget of that kind never pays for this
 * — which the component's own `detail` contract decides, not this file.
 */

const detailSchema = z.object({
  title: z
    .string()
    .optional()
    .describe(
      "The one field that names this record — what a person would call it. Copy the name exactly.",
    ),
  subtitle: z
    .string()
    .optional()
    .describe("A field that qualifies the title, if one does. Copy the name exactly."),
  status: z
    .string()
    .optional()
    .describe(
      "A field holding this record's state, if it has one. Copy the name exactly.",
    ),
  facts: z
    .array(z.string())
    .optional()
    .describe(
      "Up to four fields worth reading before anything else — the numbers and dates somebody " +
        "opened this record to check. Copy names exactly.",
    ),
  fields: z
    .array(z.string())
    .describe(
      "The fields worth showing, most important first. Copy names exactly. Leave out anything " +
        "that exists for the API rather than for a person.",
    ),
  groups: z
    .array(
      z.object({
        title: z.string().describe("A short heading, in the API's own domain language."),
        fields: z.array(z.string()).describe("Field names in this section, copied exactly."),
      }),
    )
    .optional()
    .describe(
      "The fields above, arranged into named sections. Leave out entirely if the record is " +
        "short enough to read as one list.",
    ),
  children: z
    .array(z.string())
    .optional()
    .describe(
      "Ids of related collections worth showing beside the record, from the RELATED list. " +
        "Omit any that would not earn a tab. Copy ids exactly.",
    ),
  reason: z
    .string()
    .describe("One short sentence for the user on what you chose to show and what you left out."),
});

export type DetailProposal = z.infer<typeof detailSchema>;

const detailTool: LlmTool<DetailProposal> = {
  name: "plan_record",
  description: "Choose what a person sees when they open one of these records.",
  schema: detailSchema,
};

const SYSTEM_PROMPT = [
  "You decide what somebody sees when they click one record in a dashboard.",
  "",
  "You are given every field the record carries, with example values, and any related",
  "collections that can be shown beside it.",
  "",
  "The record has a heading and a body. The heading is read INSTEAD of scanning: a",
  "title, sometimes a subtitle, sometimes a status, and up to four facts. The body is",
  "everything else, in sections.",
  "",
  "Choosing the heading:",
  "- title is the field somebody would use to say which record this is — a name, a",
  "  number, an address, a subject line. Not an internal id unless nothing else",
  "  identifies it.",
  "- subtitle qualifies the title where a second field genuinely does: the thing it",
  "  belongs to, its type, its owner. Leave it out rather than padding.",
  "- status is a field holding a state — active, overdue, pending, closed. Only where",
  "  the record really has one. A date is not a status and neither is a number.",
  "- facts are the two to four values somebody opened this record to check. Amounts,",
  "  dates, counts. Fewer is better; four is the maximum.",
  "- A field used in the heading must NOT appear again in the sections. It is already",
  "  on screen, and repeating it makes the record look padded.",
  "",
  "Choosing sections:",
  "- Group the remaining fields under short headings in the API's own domain language.",
  "- Two to four sections. One section is not a grouping, and eight is a filing system.",
  "- Leave groups out entirely when the record is short — under about six fields reads",
  "  better as one list than as sections of two.",
  "- Anything you do not put in a group still appears, at the end. Nothing is lost by",
  "  leaving a field ungrouped, so do not invent a section to hold the leftovers.",
  "",
  "Choosing fields:",
  "- Order matters. Put what identifies the record first — its name, title or subject — then",
  "  what somebody opened it to find out: status, dates, amounts, who it belongs to.",
  "- Leave out what exists for the API rather than for a person. Links back to the API",
  "  (\"Href\", \"Url\" pointing at the API itself), internal keys, and fields that are null or",
  "  empty on every example are noise on a record somebody is reading.",
  "- Raw id fields are usually noise, with one exception: an id is worth showing when nothing",
  "  else identifies the record.",
  "- A nested name like `Category.Name` is a real field and usually better than the object",
  "  around it. Prefer the readable half.",
  "- Be selective. A record showing twelve things somebody chose beats one showing forty",
  "  nobody did. If a field is genuinely borderline, leave it out — it can be added back.",
  "",
  "Choosing related collections:",
  "- Include one only if somebody looking at this record would plausibly want it. Notes on a",
  "  task, units in a property, transactions on a lease.",
  "- Leave out collections that repeat what the record already says, and ones that would be",
  "  empty or enormous for a typical record.",
  "- Fewer is better. Four is the maximum and rarely the right number.",
].join("\n");

/** One collection that could be shown beside the record. */
export interface ChildOption {
  /** Stable id the model answers with. */
  readonly id: string;
  readonly title: string;
  /** The endpoint listing it. */
  readonly op: string;
  /** Field on the child's rows carrying the parent's identity. */
  readonly linkField: string;
  /**
   * Whether this record's rows can be asked for directly.
   *
   * True when the endpoint takes the parent's id — in its path, or as a filter
   * it declares — so one request returns this record's rows and nothing else.
   *
   * False when neither exists and the collection has to be read a page at a
   * time and matched here. That is not merely slower: the reading stops at a
   * page cap, so rows belonging to this record can sit past the last page
   * fetched and the section renders as though the record has none. Worth
   * knowing when choosing between two collections that would otherwise tie.
   */
  readonly exact: boolean;
  /** What the child's rows carry, for choosing columns. */
  readonly fields: readonly FieldInfo[];
}

export interface DetailPlanInput {
  /** What the records are, in the API's words. */
  readonly recordTitle: string;
  /** Every field the record carries. */
  readonly fields: readonly FieldInfo[];
  /** Collections that could sit beside it. Empty is normal. */
  readonly children: readonly ChildOption[];
  /** What the user said they wanted, when there is anything to go on. */
  readonly intent?: string | undefined;
}

/**
 * The block at the top of a record, which is what makes it a record rather
 * than a list of pairs.
 *
 * Every field named here is real — validated against what the record carries —
 * and appears in the heading INSTEAD of the body, never in both.
 */
export interface DetailHeader {
  readonly title?: string;
  readonly subtitle?: string;
  readonly status?: string;
  readonly facts: readonly string[];
}

/** A named section of the body. Fields not in any group fall to the end. */
export interface DetailGroup {
  readonly title: string;
  readonly fields: readonly string[];
}

export interface DetailPlan {
  /** Fields to show, in order. Empty when nothing could be chosen. */
  readonly fields: readonly string[];
  /**
   * The identity block, when the record has one worth drawing.
   *
   * Absent means the record renders as a plain field list — which is what
   * every record did before this existed, so it degrades to the old behaviour
   * rather than to nothing.
   */
  readonly header?: DetailHeader | undefined;
  /** Named sections over `fields`. Empty means one undifferentiated list. */
  readonly groups: readonly DetailGroup[];
  /** Chosen children, in the order they should appear. */
  readonly children: readonly ChildOption[];
  readonly reason: string;
  readonly error: string | null;
}

/** Four is the spec's cap on sections, and more than a person can scan anyway. */
const MAX_CHILDREN = 4;

/** The spec's own caps, mirrored so an over-long answer is trimmed not rejected. */
const MAX_FACTS = 4;
const MAX_GROUPS = 8;

/**
 * A field's example values, which is what makes noise recognisable.
 *
 * `Href` is obvious from a value and invisible from a name; a column that is
 * null on every record can only be spotted by looking. The names alone are not
 * enough, and this is the same lesson the narrowing pass learned.
 */
const describe = (field: FieldInfo): string => {
  const kinds = field.kinds.join("|");
  const shown = field.samples
    .filter((value) => value !== null && value !== undefined && typeof value !== "object")
    .slice(0, 2)
    .map((value) => JSON.stringify(value))
    .join(", ");
  /*
   * No showable sample means no *non-null* value was ever seen: `inferShape`
   * only ever stores those. So an empty list is not missing information, it is
   * the information — this field is null or blank on every record sampled, and
   * that is usually the reason a row on a record renders empty.
   */
  return `  ${field.name}: ${kinds}${shown ? ` — e.g. ${shown}` : " — always empty"}`;
};

export const buildDetailPrompt = (input: DetailPlanInput): string => {
  const lines = [
    `RECORD: ${input.recordTitle}`,
    "",
    "FIELDS:",
    ...input.fields.map(describe),
  ];

  if (input.children.length > 0) {
    lines.push("", "RELATED COLLECTIONS:");
    for (const child of input.children) {
      const columns = child.fields
        .slice(0, 6)
        .map((field) => field.name)
        .join(", ");
      /*
       * Marked rather than hidden. A best-effort collection is still often the
       * one somebody asked for, and refusing to offer it would be worse than
       * offering it with the caveat — but between two that would otherwise
       * tie, the one that can be asked for exactly is the better tab.
       */
      const caveat = child.exact ? "" : " [best-effort: read page by page and matched here]";
      lines.push(`  ${child.id} — ${child.title}${columns ? ` (${columns})` : ""}${caveat}`);
    }
    lines.push(
      "  Prefer a collection that can be asked for directly over one marked best-effort,",
      "  unless the best-effort one is plainly what was asked for.",
    );
  }

  if (input.intent) lines.push("", "WHAT THEY ASKED FOR:", input.intent);
  return lines.join("\n");
};

/**
 * Propose what a record shows, validated against what it really carries.
 *
 * Every name comes back checked. A model handed forty fields will occasionally
 * answer with a plausible one that does not exist, and a record bound to a
 * field nothing produces renders a blank row rather than failing — which is
 * the kind of wrong that survives review.
 */
export const planDetail = async (
  llm: LlmAdapter,
  input: DetailPlanInput,
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<DetailPlan> => {
  const none = (error: string | null): DetailPlan => ({
    fields: [],
    groups: [],
    children: [],
    reason: "",
    error,
  });

  if (input.fields.length === 0) return none("this record has no fields to show");

  let result: Awaited<ReturnType<LlmAdapter["generate"]>>;
  try {
    result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 1536,
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: buildDetailPrompt(input) },
      ],
      tools: { plan_record: detailTool },
      toolChoice: { name: "plan_record" as const },
    });
  } catch (cause) {
    return none(cause instanceof Error ? cause.message : String(cause));
  }

  const call = result.toolCalls.find((candidate) => candidate.name === "plan_record");
  const parsed = call ? detailSchema.safeParse(call.args) : null;
  if (!parsed?.success) return none("the model did not choose what to show");

  const known = new Set(input.fields.map((field) => field.name));
  const real = (name: string | undefined): string | undefined =>
    name && known.has(name) ? name : undefined;

  /*
   * The heading, taken first, because what it claims decides what the body
   * must not repeat.
   *
   * `title` doubling as `subtitle` is the one collision worth guarding: it
   * happens when a record really only has one identifying field, and drawing
   * it twice under two different weights looks like a rendering fault.
   */
  const title = real(parsed.data.title);
  const subtitle = real(parsed.data.subtitle) === title ? undefined : real(parsed.data.subtitle);
  const status = real(parsed.data.status);
  const facts = [
    ...new Set((parsed.data.facts ?? []).filter((name) => known.has(name))),
  ]
    .filter((name) => name !== title && name !== subtitle && name !== status)
    .slice(0, MAX_FACTS);

  const header: DetailHeader | undefined =
    title || subtitle || status || facts.length > 0
      ? {
          ...(title ? { title } : {}),
          ...(subtitle ? { subtitle } : {}),
          ...(status ? { status } : {}),
          facts,
        }
      : undefined;

  /*
   * A field in the heading is not repeated in the body.
   *
   * The model is told this and mostly obeys it; enforcing it here is what
   * makes the record's shape a property of the code rather than of how well
   * the instruction landed on a given run.
   */
  const promoted = new Set(
    [title, subtitle, status, ...facts].filter((name): name is string => name !== undefined),
  );
  const fields = [
    ...new Set(parsed.data.fields.filter((name) => known.has(name) && !promoted.has(name))),
  ];

  /*
   * Sections over the fields that survived. A group naming something the body
   * does not hold would render an empty heading, and one naming a promoted
   * field would put it on screen twice.
   */
  const inBody = new Set(fields);
  const claimed = new Set<string>();
  const groups: DetailGroup[] = [];
  for (const group of parsed.data.groups ?? []) {
    const members = [
      ...new Set(group.fields.filter((name) => inBody.has(name) && !claimed.has(name))),
    ];
    if (members.length === 0) continue;
    for (const name of members) claimed.add(name);
    groups.push({ title: group.title.trim(), fields: members });
    if (groups.length >= MAX_GROUPS) break;
  }

  const byId = new Map(input.children.map((child) => [child.id, child]));
  const children = [...new Set(parsed.data.children ?? [])]
    .map((id) => byId.get(id))
    .filter((child): child is ChildOption => child !== undefined)
    .slice(0, MAX_CHILDREN);

  if (fields.length === 0 && !header) {
    // Every name invented is a different failure from a thin choice, and the
    // caller should fall back rather than build a record showing nothing.
    return none("none of the fields the model named exist on this record");
  }

  return {
    fields,
    ...(header ? { header } : {}),
    groups,
    children,
    reason: parsed.data.reason.trim(),
    error: null,
  };
};
