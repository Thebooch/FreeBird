import type { ConciergeContext, FieldValue, LlmAdapter } from "@freebirdai/dash-agent";
import {
  distinctValues,
  inferShape,
  looksChoosable,
  matchValues,
  pickNarrowingField,
} from "@freebirdai/dash-agent";
import { pathSegments, singularNoun } from "@freebirdai/dash-spec";

/**
 * Working out what somebody meant by a word their API has never heard of.
 *
 * Somebody asks for "maintenance tasks". The endpoint returns tasks whose kind
 * lives on `Category.Name`, holding "General Inquiry", "Turnover", "Plumbing"
 * — words chosen by whoever set that account up. No schema declares them, no
 * model can guess them, and the person asking has probably never seen them
 * either. The only way to know is to look, and then to ask.
 *
 * Three rules shape this:
 *
 * **Look for free before paying.** Values come from a related lookup endpoint
 * where the API models its own vocabulary, from a sample already taken where
 * one exists, and only then from a scan that costs requests. An API that
 * publishes its categories should not have them rediscovered by reading five
 * hundred records — that is slower and *less* complete, since a scan only
 * finds values that happen to appear.
 *
 * **Count deterministically, judge with a model.** What values exist and how
 * many records carry each is arithmetic and is never asked of a model. Which
 * field carries the distinction, and which values a phrase meant, are
 * questions about meaning and are never decided by arithmetic.
 *
 * **Confirm before building.** Both model judgements are guesses. The caller
 * puts them to the user — the values first, then records matching them — and
 * only what comes back confirmed is written down.
 */

/** Where a value list came from, because the cost and completeness differ. */
export type ValueSource = "lookup" | "sample" | "scan";

export interface NarrowPlan {
  readonly op: string;
  readonly field: string | null;
  /** Why that field, in the model's words, for the user to read. */
  readonly fieldReason: string;
  readonly values: readonly FieldValue[];
  readonly source: ValueSource | null;
  /** The values the model thinks were meant. A proposal, never applied. */
  readonly proposed: readonly (string | number)[];
  readonly proposedReason: string;
  /** The query parameter that would apply this upstream, if one is declared. */
  readonly filterParam: string | undefined;
  /** Why this is thinner than it should be. Never thrown, always reported. */
  readonly notes: readonly string[];
}

const EMPTY: NarrowPlan = {
  op: "",
  field: null,
  fieldReason: "",
  values: [],
  source: null,
  proposed: [],
  proposedReason: "",
  filterParam: undefined,
  notes: [],
};

export interface NarrowInput {
  readonly llm: LlmAdapter;
  /** The user's own words. Both the question and the key it is saved under. */
  readonly phrase: string;
  readonly op: string;
  readonly context: ConciergeContext;
  /**
   * Fetch an endpoint's rows. Absent means no scanning — values then come
   * only from what is already known, which is the right default for a caller
   * that has not yet asked the user to spend anything.
   */
  readonly fetchRows?: ((opId: string) => Promise<unknown>) | undefined;
  readonly model?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * An endpoint that lists the vocabulary of a field, where the API has one.
 *
 * The clue is the field name: `Category.Name` on a task, and a collection
 * called categories. APIs that model a controlled vocabulary almost always
 * expose it, and reading it is one request against a list that is complete by
 * construction — where a scan of records is many requests against a list that
 * is complete only by luck.
 */
const lookupOpFor = (
  field: string,
  context: ConciergeContext,
): { op: string; title: string } | null => {
  const noun = field.split(".")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!noun || noun.length < 3) return null;

  const candidates = context.ops.filter((op) => {
    if ((context.shapes[op.id]?.fields.length ?? 0) === 0) return false;
    const last = pathSegments(op.path ?? "").pop() ?? "";
    /*
     * Singularised properly rather than by stripping an "s": the case that
     * matters most is `categories` → `category`, which no amount of suffix
     * trimming gets right and which is exactly the vocabulary collection this
     * exists to find.
     */
    return singularNoun(last).toLowerCase().replace(/[^a-z0-9]/g, "") === noun;
  });

  const found = candidates[0];
  return found ? { op: found.id, title: found.title } : null;
};

/** The label field of a lookup collection — what a person reads it by. */
const labelFieldOf = (opId: string, context: ConciergeContext): string | null => {
  const fields = context.shapes[opId]?.fields ?? [];
  const named = fields.find((f) => /^(name|title|label|description)$/i.test(f.name));
  return named?.name ?? null;
};

/**
 * Plan a narrowing: which field, what values it holds, and which were meant.
 *
 * Nothing here is applied and nothing is saved. It produces a proposal for the
 * caller to put to the user, which is the whole point — every value in it came
 * from either the account's real data or a model's reading of it, and neither
 * is something to build a filter on unasked.
 */
export const planNarrowing = async (input: NarrowInput): Promise<NarrowPlan> => {
  const { context } = input;
  const op = context.ops.find((candidate) => candidate.id === input.op);
  const shape = context.shapes[input.op];
  if (!op || !shape) return { ...EMPTY, op: input.op };

  const notes: string[] = [];

  /*
   * 1. Read some records first, and take the field list from them.
   *
   * The declared schema is not good enough for this. A field list read from
   * an OpenAPI document describes an endpoint's *shape*, and the thing being
   * looked for is usually a level down inside it — Buildium's tasks carry
   * their kind on `Category.Name`, and until that nesting survives into the
   * map the only fields on offer are the flat ones, none of which say
   * anything about maintenance.
   *
   * Real rows do not have that problem: `inferShape` flattens one level, so
   * `Category.Name` is simply there. The rows have to be fetched to count the
   * values anyway, so reading the fields from them as well costs nothing and
   * removes the dependency on how well the API documented itself.
   */
  let rows: unknown = null;
  let fields = shape.fields;
  if (input.fetchRows) {
    try {
      rows = await input.fetchRows(input.op);
      const seen = inferShape(rows, shape.rowsPath ? { rowsPath: shape.rowsPath } : {});
      if (seen.fields.length > 0) fields = seen.fields;
    } catch (cause) {
      notes.push(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // 2. Which field decides. A question about meaning, so a model answers it.
  const picked = await pickNarrowingField(
    input.llm,
    { intent: input.phrase, opTitle: op.title, fields },
    {
      ...(input.model ? { model: input.model } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (!picked.field) {
    return { ...EMPTY, op: input.op, notes: [...notes, ...(picked.error ? [picked.error] : [])] };
  }

  // 3. What that field actually holds. Arithmetic, cheapest source first.
  let values: readonly FieldValue[] = [];
  let source: ValueSource | null = null;

  const lookup = lookupOpFor(picked.field, context);
  if (lookup && input.fetchRows) {
    const label = labelFieldOf(lookup.op, context);
    if (label) {
      try {
        const body = await input.fetchRows(lookup.op);
        const found = distinctValues(body, label, {
          rowsPath: context.shapes[lookup.op]?.rowsPath ?? "$",
        });
        if (found.values.length > 0) {
          values = found.values;
          source = "lookup";
        }
      } catch (cause) {
        notes.push(
          `${lookup.title} could not be read (${cause instanceof Error ? cause.message : String(cause)}), ` +
            "so the values were looked for in the records themselves.",
        );
      }
    }
  }

  if (values.length === 0 && rows !== null) {
    {
      const body = rows;
      const found = distinctValues(body, picked.field, { rowsPath: shape.rowsPath || "$" });
      if (!looksChoosable(found)) {
        /*
         * Said plainly rather than offering the list anyway. A field where
         * every record carries its own value cannot be chosen between, and a
         * truncated list would produce a filter that silently omits records.
         */
        notes.push(
          found.truncated
            ? `${picked.field} holds more distinct values than can be chosen from — it looks like an identifier rather than a category.`
            : `${picked.field} does not separate these records into groups.`,
        );
        return { ...EMPTY, op: input.op, field: picked.field, fieldReason: picked.reason, notes };
      }
      values = found.values;
      source = "scan";
      if (found.missing > 0) {
        notes.push(
          `${found.missing} of ${found.rowsScanned} record(s) have no ${picked.field} at all, and will not match any choice.`,
        );
      }
    }
  }

  if (values.length === 0) {
    return {
      ...EMPTY,
      op: input.op,
      field: picked.field,
      fieldReason: picked.reason,
      notes: [
        ...notes,
        `Nothing here shows what values ${picked.field} holds yet. Reading some records would.`,
      ],
    };
  }

  // 3. Which of them were meant. A question about meaning again.
  const matched = await matchValues(
    input.llm,
    { intent: input.phrase, field: picked.field, values },
    {
      ...(input.model ? { model: input.model } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (matched.error) notes.push(matched.error);

  /*
   * Whether the API can apply this itself. One filtered request beats fetching
   * everything and discarding most of it — the same choice a join makes, and
   * the same reason: it is the difference between a widget that loads and one
   * that burns a rate limit.
   */
  const filterParam = context.searchable.find((entry) => entry.op === input.op)?.param;

  return {
    op: input.op,
    field: picked.field,
    fieldReason: picked.reason,
    values,
    source,
    proposed: matched.values,
    proposedReason: matched.reason,
    filterParam,
    notes,
  };
};
