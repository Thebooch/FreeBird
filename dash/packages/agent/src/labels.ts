import type { MappedField } from "@freebirdai/dash-spec";
import { humanLabel } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { LlmAdapter, LlmTool } from "./llm.js";

/**
 * What each field is called, in the words somebody would use out loud.
 *
 * An API names fields for the people who write against it, and those names
 * reach the screen unchanged: `CurrentNumberOfOccupants` as a column header,
 * `LastUpdatedDateTime` on a record. `humanLabel` fixes the casing and can do
 * nothing about the vocabulary, because the vocabulary is a judgement — that
 * `PropertyId` is the *property*, that a `DateTime` suffix is noise, that
 * `Category.Name` is just the category.
 *
 * So the judgement is made once, by a model, and stored. Two properties make
 * that cheap and safe.
 *
 * **It is keyed by distinct field name across the whole API, not per
 * endpoint.** A large API carries thousands of field entries and around a
 * thousand distinct names, and `Amount` means the same thing on every endpoint
 * that has one. Labelling the names rather than the entries is the difference
 * between a handful of calls and a hundred.
 *
 * **It says nothing about anybody's data.** Field names come from the spec, so
 * this is a fact about the API and travels with the map — a new user inherits
 * readable headers before they have read a single row, and before they have
 * spent a request.
 *
 * Every guard here fails toward `humanLabel`. A name the model invented, a
 * label that is too long, two fields on one endpoint that would end up sharing
 * a label — all of them drop the entry rather than record something wrong, and
 * the mechanical label is what shows. That is the same behaviour as an API
 * nobody has labelled, which is a state the product has to work in regardless.
 */

/** How many field names go into one call. */
const BATCH = 150;

/** A label longer than this is a sentence, not a column header. */
const MAX_LABEL = 48;

const labelProposalSchema = z.object({
  labels: z
    .array(
      z.object({
        name: z.string().describe("Field name, copied exactly as given."),
        label: z
          .string()
          .describe(
            "What to call it on screen. Sentence case, as few words as carry the meaning.",
          ),
      }),
    )
    .optional(),
});

export type LabelProposal = z.infer<typeof labelProposalSchema>;

const labelTool: LlmTool<LabelProposal> = {
  name: "name_fields",
  description: "Give each field the name a person reading a dashboard would use for it.",
  schema: labelProposalSchema,
};

export const LABEL_SYSTEM_PROMPT = `You are renaming an API's fields for people who will never see the API.

They are looking at a dashboard: a table of records, or one record opened up.
Your labels become column headers and row labels. Nothing else about them is
shown, so a label has to carry the meaning on its own.

One job: for each field name you are given, write what to call it.

How to choose:
- Sentence case. "Unit number", not "Unit Number" and not "unit number".
- As few words as carry the meaning. A column header has around twenty
  characters before it starts truncating.
- Drop the plumbing. Suffixes saying how a value is stored rather than what it
  is — DateTime, Timestamp, Str, Num, Flag, Val — are not something a reader
  needs.
- A field whose name ends in Id and which points at another kind of record IS
  that record. Name it after the thing, not after the identifier.
- For a nested name, label the whole path as one idea, not just its last word
  in isolation.
- Keep a qualifier wherever dropping it would collide. If a record carries both
  something's identifier and its name, they cannot both be called the same
  thing.
- Expand an abbreviation only when you are sure of it. A wrong expansion is
  worse than an abbreviation the reader already knows.
- Use the API's own domain words. You are translating register, not concepts —
  do not rename one kind of record into another.

Rules:
- Only use names that appear in the list. A name that was not given is
  discarded.
- Leave a field out entirely if you have nothing better to offer than the name
  itself. Something sensible is already shown for anything you skip, so
  skipping costs nothing and guessing costs accuracy.
- A label is never a sentence, never punctuated, and never explains.`;

/** One field name, and what is known about it, for the prompt. */
export interface FieldCandidate {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly format?: string | undefined;
  /** Whatever the spec said about it, where any endpoint said anything. */
  readonly description?: string | undefined;
  /** Endpoint titles this name appears on. Truncated; context, not an index. */
  readonly seenOn: readonly string[];
  /** How many endpoints carry it, so the common names get labelled first. */
  readonly count: number;
}

export interface LabelInput {
  readonly apiTitle: string;
  readonly ops: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly fields?: readonly MappedField[] | undefined;
  }>;
}

/** How many endpoint titles are quoted as context for one name. */
const SEEN_SHOWN = 2;

/**
 * Every distinct field name in an API, with what the spec knows about it.
 *
 * Deterministic and free — it reads the declared field lists the importer
 * already produced. The `seenOn` titles are what disambiguate a bare `Number`
 * or `Status`, and they cost a few words each.
 */
export const collectFieldNames = (input: LabelInput): FieldCandidate[] => {
  const found = new Map<
    string,
    { kinds: Set<string>; format?: string; description?: string; seenOn: string[]; count: number }
  >();

  for (const op of input.ops) {
    for (const field of op.fields ?? []) {
      let entry = found.get(field.name);
      if (!entry) {
        entry = { kinds: new Set<string>(), seenOn: [], count: 0 };
        found.set(field.name, entry);
      }
      entry.count += 1;
      for (const kind of field.kinds) entry.kinds.add(kind);
      // First one wins for both: any endpoint's description of a shared name
      // describes the same field, and a second copy adds nothing.
      if (field.format && !entry.format) entry.format = field.format;
      if (field.description && !entry.description) entry.description = field.description;
      if (entry.seenOn.length < SEEN_SHOWN) entry.seenOn.push(op.title);
    }
  }

  return [...found.entries()]
    .map(
      ([name, entry]): FieldCandidate => ({
        name,
        kinds: [...entry.kinds],
        ...(entry.format ? { format: entry.format } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        seenOn: entry.seenOn,
        count: entry.count,
      }),
    )
    /*
     * Commonest first. Batches fail independently, so if one call is going to
     * be lost it should be the one holding names that appear on a single
     * endpoint rather than the one holding the identity and name fields every
     * record in the API carries.
     */
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

export const buildLabelPrompt = (
  input: LabelInput,
  batch: readonly FieldCandidate[],
): string => {
  const lines: string[] = [`API: ${input.apiTitle}`, "", "FIELDS:"];
  for (const field of batch) {
    const shape = field.kinds.includes("array")
      ? " · a list"
      : field.kinds.includes("object")
        ? " · a nested record"
        : field.format
          ? ` · ${field.format}`
          : "";
    const seen = field.seenOn.length > 0 ? ` · on ${field.seenOn.join(", ")}` : "";
    const said = field.description ? `\n      the spec says: ${field.description}` : "";
    lines.push(`  ${field.name}${shape}${seen}${said}`);
  }
  return lines.join("\n");
};

export interface LabelResult {
  /** field name → label. Only names the pass improved on appear. */
  readonly labels: Readonly<Record<string, string>>;
  /** Batches that failed outright, so a partial pass can say what it missed. */
  readonly errors: readonly string[];
  /**
   * Proposals that were refused, and why.
   *
   * Separate from `errors` because nothing went wrong — the pass declined a
   * label it could not justify, and the mechanical one is shown instead.
   */
  readonly skipped: readonly string[];
}

/**
 * Whether a proposed label is worth storing.
 *
 * Everything refused here falls back to `humanLabel`, so the bar is "is this
 * better than the mechanical answer", not "is this acceptable". A label equal
 * to what `humanLabel` already produces is not wrong — it is an entry that
 * would occupy the lexicon in order to say nothing.
 */
export const acceptLabel = (name: string, raw: string): string | null => {
  const label = raw.replace(/\s+/g, " ").trim();
  if (label.length === 0 || label.length > MAX_LABEL) return null;
  // A label is a name: not markup, not a template, not a sentence.
  if (/[{}<>$|\\]/.test(label) || label.includes("`")) return null;
  if (/[.!?]$/.test(label)) return null;
  if (label === name) return null;
  if (label.toLowerCase() === humanLabel(name).toLowerCase()) return null;
  return label;
};

/**
 * Drop labels that would leave one endpoint showing two identically-named
 * columns.
 *
 * The lexicon is API-wide and the collision is per endpoint, so this cannot be
 * decided while labelling: a reference to a record and that reference's id may
 * both shorten to the same word perfectly reasonably, and it is only a problem
 * on an endpoint carrying both. Where that happens the longer name keeps its
 * mechanical label — two columns under one heading is worse than one heading
 * that reads like a database column.
 */
export const dropCollisions = (
  labels: Readonly<Record<string, string>>,
  input: LabelInput,
): { labels: Record<string, string>; dropped: string[] } => {
  const kept: Record<string, string> = { ...labels };
  const dropped: string[] = [];

  for (const op of input.ops) {
    const byLabel = new Map<string, string[]>();
    for (const field of op.fields ?? []) {
      const label = kept[field.name];
      if (!label) continue;
      const key = label.toLowerCase();
      byLabel.set(key, [...(byLabel.get(key) ?? []), field.name]);
    }
    for (const names of byLabel.values()) {
      if (names.length < 2) continue;
      /*
       * Keep the shortest name's label — it is the one most likely to be the
       * plain thing rather than a qualified corner of it — and drop the rest.
       */
      const sorted = [...names].sort((a, b) => a.length - b.length || a.localeCompare(b));
      const winner = sorted[0]!;
      for (const name of sorted.slice(1)) {
        if (kept[name] === undefined) continue;
        delete kept[name];
        dropped.push(
          `"${name}" would have shared a label with "${winner}" on ${op.title}, so it keeps its plain name.`,
        );
      }
    }
  }

  return { labels: kept, dropped };
};

/**
 * Run the pass, batch by batch.
 *
 * Batches fail independently, exactly as the mapping pass does: a lexicon
 * covering most of an API is worth keeping and worth re-running for the rest,
 * and one that throws away six good calls because the seventh timed out is
 * not.
 */
export const labelFields = async (
  llm: LlmAdapter,
  input: LabelInput,
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<LabelResult> => {
  const candidates = collectFieldNames(input);
  const labels: Record<string, string> = {};
  const errors: string[] = [];
  const skipped: string[] = [];

  for (let start = 0; start < candidates.length; start += BATCH) {
    const batch = candidates.slice(start, start + BATCH);
    const offered = new Set(batch.map((field) => field.name));
    const where = `fields ${start + 1}–${start + batch.length}`;

    try {
      const result = await llm.generate({
        ...(options.model ? { model: options.model } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        temperature: 0.2,
        maxOutputTokens: 8192,
        messages: [
          { role: "system" as const, content: LABEL_SYSTEM_PROMPT },
          { role: "user" as const, content: buildLabelPrompt(input, batch) },
        ],
        tools: { name_fields: labelTool },
        toolChoice: { name: "name_fields" as const },
      });

      const call = result.toolCalls.find((candidate) => candidate.name === "name_fields");
      if (!call) {
        errors.push(`${where}: the model answered without calling the tool.`);
        continue;
      }

      /*
       * Salvaged entry by entry rather than parsed as a unit.
       *
       * The same reasoning as the mapping pass: a list validated whole is
       * all-or-nothing, and one malformed row should not cost a hundred and
       * forty-nine good ones.
       */
      const args = call.args as { labels?: unknown };
      const rows = Array.isArray(args.labels) ? args.labels : [];
      const row = labelProposalSchema.shape.labels.unwrap().element;

      let invented = 0;
      let malformed = 0;
      for (const entry of rows) {
        const one = row.safeParse(entry);
        if (!one.success) {
          malformed += 1;
          continue;
        }
        /*
         * The same boundary every other pass draws: a name that was not
         * offered is an error, never an approximation of one that was.
         */
        if (!offered.has(one.data.name)) {
          invented += 1;
          continue;
        }
        const label = acceptLabel(one.data.name, one.data.label);
        if (label === null) continue;
        labels[one.data.name] = label;
      }

      if (invented > 0) {
        skipped.push(`${where}: ${invented} label(s) named a field that was not offered.`);
      }
      if (malformed > 0) {
        skipped.push(`${where}: ${malformed} label(s) were malformed and dropped.`);
      }
    } catch (cause) {
      errors.push(`${where}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  const settled = dropCollisions(labels, input);
  return { labels: settled.labels, errors, skipped: [...skipped, ...settled.dropped] };
};
