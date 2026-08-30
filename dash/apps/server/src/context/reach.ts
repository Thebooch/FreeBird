import type { ChildCollection, ConciergeContext } from "@freebirdai/dash-agent";
import type { Candidate, Evidence, OpReader } from "./types.js";
import type { LookupOption } from "./related.js";
import { asOption, readRelated } from "./related.js";
import { expansionFor, referencesFrom } from "../tools/bindings.js";
import { identityValue, readRecords, readReferenced } from "../tools/read.js";
import type { Reference, ToolBinding, ToolDeps } from "../tools/types.js";

/**
 * Where else the answer could be, given records already in hand.
 *
 * ## The turn this exists to remove
 *
 * > — How many tasks are about garage door issues?
 * > — Four. (read from a list of fifty)
 * > — Are there any notes on them? Any correlating issue?
 * > — I don't have notes, descriptions or task-history results for those four.
 * > — Can you look up the task history for each and check for notes?
 * > — (opens them, finds the notes, answers the original question)
 *
 * The third turn is the bug. Nothing was missing: the API exposed the records'
 * own detail and a collection under each one, the relation graph had both, and
 * the answer was one request away the whole time. What was missing was the
 * *move* — the search could rank another top-level source and it could open a
 * matched record, but it could not ask "what else, of everything reachable
 * from these rows, would hold what is still missing?"
 *
 * That move already existed for FOLLOW-UPS — a question asked against records
 * kept from a previous turn walked exactly this list. It was unreachable from
 * a search, so whether the assistant could answer depended on which turn the
 * question happened to land in, and the user closed the gap by naming the
 * mechanism themselves. They should not have to: "task history" is this API's
 * word, and knowing to ask for it is knowing how the product is wired.
 *
 * So the step lives here, and both paths call it.
 *
 * ## Why it cannot know anything about any particular API
 *
 * Every option below is derived, never named:
 *
 *   - the record's own fuller version comes from a binding, which exists
 *     because a sampled response proved an endpoint returns one record and
 *     proved which field carries its identity.
 *   - collections attached to a record come from `ConciergeContext.children`,
 *     which the relation graph worked out from paths and foreign keys.
 *   - records this one points at come from proven links, not from field names
 *     that look like foreign keys.
 *
 * An API with a different shape offers different options and this reads the
 * same. Nothing here knows what a task, a note or a history is.
 *
 * ## Why all three kinds, always
 *
 * Notes are a subcollection on one API, a field on the detail record on the
 * next, and a row in a flat collection keyed by parent id on a third. A step
 * that could see only one of the three could only ever find some of them —
 * and would report the rest as absent, confidently, which is the failure this
 * whole module is organised against.
 */

/**
 * One thing that can be opened from a record in hand.
 *
 * A `LookupOption` — id, title, and what choosing it would get in plain words
 * — carrying whichever mechanism actually reads it. The plain words are what
 * the model picks on and what the reply quotes, so neither has to know that
 * three different mechanisms are involved.
 */
export type Openable = LookupOption &
  (
    | { readonly kind: "record"; readonly binding: ToolBinding }
    | { readonly kind: "collection"; readonly child: ChildCollection }
    | { readonly kind: "reference"; readonly reference: Reference }
  );

/** Everything reachable from records that came out of `op`, as one list. */
export const openableFrom = (input: {
  readonly context: ConciergeContext;
  readonly bindings: readonly ToolBinding[];
  readonly op: string;
}): Openable[] => {
  const expansion = expansionFor(input.bindings, input.op);
  const references = referencesFrom(input.context, input.op, input.bindings);

  return [
    ...(expansion
      ? [
          {
            id: "the-record-itself",
            title: `The full ${expansion.resource} record`,
            note:
              "every field the collection left out — descriptions, notes and anything " +
              "else only the record itself carries",
            kind: "record" as const,
            binding: expansion,
          },
        ]
      : []),
    ...input.context.children
      .filter((child) => child.parentOp === input.op)
      .map((child) => ({ ...asOption(child), kind: "collection" as const, child })),
    ...references.map((reference) => ({
      id: `points-at-${reference.field}`,
      title: reference.title,
      note: `the ${reference.to.resource} this record points at, by its ${reference.field}`,
      kind: "reference" as const,
      reference,
    })),
  ];
};

/**
 * What was on offer, in words a person can read.
 *
 * The reply needs this when nothing was opened or what was opened held
 * nothing: "I checked the task's own record and its history, and neither
 * carries notes" is an answer somebody can act on, while "I don't have notes"
 * invites them to ask again for the same thing. Titles and notes only — an op
 * id in a sentence is the product's plumbing, not the user's vocabulary.
 */
export const describeOpenables = (
  options: readonly Openable[],
): ReadonlyArray<{ readonly title: string; readonly note: string }> =>
  options.map((option) => ({ title: option.title, note: option.note }));

/** What opening one of them produced. */
export interface Reached {
  /** Normalised to evidence whichever mechanism read it, so callers are alike. */
  readonly evidence: Evidence | null;
  /** What was read, in words, because it spent requests nobody asked for. */
  readonly note: string;
  /** The records themselves, for merging back into what is in focus. */
  readonly records: readonly Record<string, unknown>[];
  readonly requests: number;
  /** The endpoint that was read, for saying what was looked at. */
  readonly op: string;
  /** The identity field of what was opened, when opening changed it. */
  readonly idField?: string | undefined;
}

/**
 * Open one of them against the records it applies to.
 *
 * Everything comes back as `Evidence` regardless of which mechanism ran. The
 * three produce different shapes natively — a collection read is already
 * evidence, opening records is a list of rows — and normalising here is what
 * lets the search loop judge the result exactly as it judges any other read,
 * rather than growing a second path for things reached this way.
 */
export const openFrom = async (input: {
  readonly chosen: Openable;
  /** The records this is being opened for — already narrowed to the subject. */
  readonly subject: readonly Record<string, unknown>[];
  /** The candidate they came from, so the evidence can say where it started. */
  readonly from: Candidate;
  /** Identity field of the holding records, when the binding does not carry one. */
  readonly fallbackIdField?: string | null | undefined;
  readonly deps: ToolDeps;
  readonly read: OpReader;
  readonly resolved: Parameters<OpReader>[0]["resolved"];
  readonly rowsOf: (body: unknown, rowsPath: string) => Record<string, unknown>[];
  readonly rowsPath: string;
  readonly limit?: number | undefined;
}): Promise<Reached> => {
  const { chosen } = input;

  /*
   * A collection under the record. Already evidence, and already carries its
   * own coverage — a fan-out that read three of five records must not report
   * as though it read all of them.
   */
  if (chosen.kind === "collection") {
    const related = await readRelated({
      focus: {
        question: "",
        source: input.from.id,
        sourceTitle: input.from.title,
        connection: input.from.connection,
        op: input.from.op,
        idField: input.fallbackIdField ?? null,
        records: [...input.subject],
        savedAt: "",
      },
      child: chosen.child,
      read: input.read,
      resolved: input.resolved,
      rowsOf: input.rowsOf,
      rowsPath: input.rowsPath,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return {
      evidence: related.evidence,
      note: related.note,
      records: related.evidence?.rows ?? [],
      requests: related.requests,
      op: chosen.child.op,
    };
  }

  const opened =
    chosen.kind === "record"
      ? await readRecords({
          binding: chosen.binding,
          ids: input.subject.flatMap((record) =>
            identityValue(
              record,
              chosen.binding.idField ?? input.fallbackIdField ?? "",
              chosen.binding.idField,
            ),
          ),
          deps: input.deps,
        })
      : await readReferenced({
          reference: chosen.reference,
          from: input.subject,
          deps: input.deps,
        });

  const op = chosen.kind === "record" ? chosen.binding.op : chosen.reference.to.op;
  if (opened.records.length === 0) {
    return { evidence: null, note: opened.note, records: [], requests: opened.requests, op };
  }

  return {
    evidence: {
      candidate: {
        ...input.from,
        // Named as what it is, so a reply can say where the answer came from
        // without implying the whole collection was read again.
        title:
          chosen.kind === "record"
            ? `${input.from.title} — opened in full`
            : chosen.reference.to.title,
        op,
        cached: false,
      },
      rows: opened.records,
      columns: [...new Set(opened.records.flatMap((row) => Object.keys(row)))],
      coverage: {
        scanned: opened.records.length,
        of: opened.records.length,
        orderedBy: null,
        partial: false,
      },
      warnings: opened.warnings,
      requests: opened.requests,
    },
    note: opened.note,
    records: opened.records,
    requests: opened.requests,
    op,
    ...(chosen.kind === "record"
      ? { idField: chosen.binding.idField ?? input.fallbackIdField ?? undefined }
      : {}),
  };
};
