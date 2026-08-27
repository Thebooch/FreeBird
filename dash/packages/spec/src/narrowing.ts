import { z } from "zod";
import { idSchema } from "./primitives.js";

/**
 * A narrowing a person confirmed: what a phrase means, in this account's data.
 *
 * The account-specific half of a drill-down, and the reason it cannot live in
 * the shared map. "Maintenance means these three categories" is true of one
 * install — the words were chosen by whoever set it up — where "the kind of a
 * task lives on `Category.Name`" is true of the API for everybody and travels
 * with the map instead.
 *
 * Saved so it is asked once. The questions a drill-down asks are good ones the
 * first time and tedious the fourth, and a person who has already said what
 * they mean by "maintenance" should not be asked again on the next widget.
 */
export const narrowingSchema = z.object({
  /** The endpoint whose records this narrows. */
  op: z.string().min(1).max(200),
  /** The field carrying the distinction. May be nested one level. */
  field: z.string().min(1).max(160),
  /**
   * The values that count as a match. Strings or numbers, never coerced —
   * comparing "1688" to 1688 matches nothing and looks like an empty category.
   */
  values: z.array(z.union([z.string().max(200), z.number()])).min(1).max(60),
  /**
   * What the user called it, in their words.
   *
   * The key this is found by later. Somebody who says "maintenance work" next
   * month means what they meant this month, and matching on their own phrase
   * is what makes that reusable without asking again.
   */
  phrase: z.string().min(1).max(120),
  /**
   * The query parameter that applies this upstream, where one exists.
   *
   * One filtered request against the API beats fetching everything and
   * discarding most of it — the same choice a join makes. Absent means the
   * endpoint declares no such parameter and the pipeline does the filtering.
   */
  filterParam: z.string().max(160).optional(),
  /** When a person confirmed it, so a stale one can be spotted. */
  confirmedAt: z.string().datetime(),
});

export type Narrowing = z.infer<typeof narrowingSchema>;

/** Every narrowing confirmed against one connection. */
export const narrowingFileSchema = z.object({
  specVersion: z.literal(1).default(1),
  connection: idSchema,
  narrowings: z.array(narrowingSchema).max(200).default([]),
});

export type NarrowingFile = z.infer<typeof narrowingFileSchema>;

/** Loose matching, because nobody types the same phrase twice. */
const normalise = (phrase: string): string =>
  phrase
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .sort()
    .join(" ");

/** Words that carry no meaning in a request and would blur every match. */
const STOP_WORDS = new Set([
  "the", "and", "for", "all", "any", "only", "show", "list", "get", "with",
  "that", "this", "them", "those", "from", "into", "our", "his", "her",
]);

/**
 * A narrowing already confirmed for this endpoint and this phrase.
 *
 * Matched on the meaningful words rather than the exact string: "only the
 * maintenance tasks" and "maintenance tasks please" are the same request, and
 * asking again because the wording moved is exactly the tedium this avoids.
 */
export const findNarrowing = (
  saved: readonly Narrowing[],
  input: { op: string; phrase: string },
): Narrowing | null => {
  const wanted = normalise(input.phrase);
  if (!wanted) return null;

  const forOp = saved.filter((entry) => entry.op === input.op);
  const exact = forOp.find((entry) => normalise(entry.phrase) === wanted);
  if (exact) return exact;

  /*
   * Otherwise the most recent whose words are wholly contained in the
   * request. "maintenance" saved earlier answers "maintenance tasks this
   * month" — the extra words narrow further but do not change what the phrase
   * meant. The reverse is not true: a saved "urgent maintenance" must not
   * answer a plain "maintenance", so containment runs one way only.
   */
  const wantedWords = new Set(wanted.split(" "));
  return (
    [...forOp]
      .filter((entry) => {
        const words = normalise(entry.phrase).split(" ").filter(Boolean);
        return words.length > 0 && words.every((word) => wantedWords.has(word));
      })
      .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt))[0] ?? null
  );
};
