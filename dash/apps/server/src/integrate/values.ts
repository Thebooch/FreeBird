import { readField, type ConnectionSpec, type EntitySpec } from "@freebirdai/dash-spec";

/**
 * The values this account's records hold, where a field holds a small set.
 *
 * A request narrows in its own words — "in US dollars", "money out" — and the
 * records say `USD` and `debit`. Nothing declared either: the documentation
 * said "ISO 4217 code", and a CSV declares nothing at all. So a total asked
 * for in words counted everything, or nothing, and said it was right
 * (measurement 1: multicur, vaultbank). What the records hold is the only
 * account of the words to use.
 *
 * **This account's, and kept apart.** The catalog is shared, and a value is
 * this account's data, so these never go near it — they go to a
 * `SeenValueStore`, per connection, beside the other things one install knows
 * about its own account. They reach the model that writes briefs, as the
 * records themselves reach the assistant.
 *
 * **Only a small set that repeats.** A category is a handful of short words
 * each used many times. Names, ids, dates, amounts, emails and addresses are
 * not, and are never kept: a field is taken only if every value it holds
 * passes, so a set is never a sample of something larger.
 */
export type SeenValues = Readonly<Record<string, readonly string[]>>;

/**
 * What one read showed, and whether it showed every record there is.
 *
 * Only a read whose count matches the total the API reported under the same
 * scope has seen every record. A first page of a catalogue sorted by category
 * showed four categories of twenty-four, and a request for smartphones was
 * sent back for naming one it did not list (measurement 1, real split).
 */
export interface SeenSet {
  readonly fields: SeenValues;
  readonly everyRecord: boolean;
  /**
   * Fields whose values were all different — titles, names, descriptions —
   * named only, never their values. Nothing narrows by one of them: asked for
   * smartphones, a count narrowed a product's title to "smartphones" and
   * found none (checkpoint 2).
   */
  readonly unique?: readonly string[];
}

/** Text fields whose every value was different: what a record is called or says, not a kind of record. */
export const uniqueFields = (rows: readonly unknown[], fields: readonly SeenField[]): string[] => {
  const sample = rows.slice(0, MAX_ROWS);
  if (sample.length < MIN_FILLED) return [];
  return fields
    .filter((field) => field.kinds.includes("string"))
    .filter((field) => {
      const values = sample
        .map((row) => readField(row, field.name))
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      return values.length >= MIN_FILLED && new Set(values).size === values.length;
    })
    .map((field) => field.name);
};

/** Past this it is a list of things, not a set of kinds of thing. */
const MAX_SEEN = 30;
/** Fewer records than this show nothing repeating. */
const MIN_FILLED = 4;
const MAX_CHARS = 60;
/** Enough to know a field; a category shows itself in the first few thousand. */
const MAX_ROWS = 5000;
const IDENTIFIER_PATH = /(^|[._])id$|Id$|_ids?$|(^|[._])(uuid|guid|key|token|hash|email|phone|url|href|link)$/i;
/** An email, an address, a number or a date written as text. */
const NOT_A_WORD = /@|:\/\/|^[-+]?[\d.,\s]+$|^\d{4}-\d{2}-\d{2}/;

interface SeenField {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly format?: string | undefined;
}

export const seenValues = (rows: readonly unknown[], fields: readonly SeenField[]): SeenValues => {
  const sample = rows.slice(0, MAX_ROWS);
  if (sample.length < MIN_FILLED) return {};
  const seen: Record<string, string[]> = {};
  for (const field of fields) {
    if (field.format || IDENTIFIER_PATH.test(field.name)) continue;
    if (!field.kinds.includes("string") || field.kinds.some((kind) => kind !== "string" && kind !== "null")) continue;
    const counts = new Map<string, number>();
    let filled = 0;
    let usable = true;
    for (const row of sample) {
      const value = readField(row, field.name);
      if (value === null || value === undefined) continue;
      if (typeof value !== "string") {
        usable = false;
        break;
      }
      const text = value.trim();
      if (text.length === 0) continue;
      if (text.length > MAX_CHARS || NOT_A_WORD.test(text)) {
        usable = false;
        break;
      }
      filled++;
      counts.set(text, (counts.get(text) ?? 0) + 1);
      if (counts.size > MAX_SEEN) {
        usable = false;
        break;
      }
    }
    /* A set repeats: two values or more, each used twice on average. One value everywhere narrows nothing. */
    if (!usable || filled < MIN_FILLED || counts.size < 2 || filled < counts.size * 2) continue;
    seen[field.name] = [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value]) => value);
  }
  return seen;
};

/**
 * What was seen, by record type: each record type takes what its list
 * endpoint's records held. Record types this connection does not carry, or
 * whose endpoint no read has shown, have none.
 */
export const seenByRecordType = (
  connection: Pick<ConnectionSpec, "resources">,
  entities: readonly Pick<EntitySpec, "id" | "resource">[],
  byOp: Readonly<Record<string, SeenSet>>,
): Record<string, SeenSet> => {
  const out: Record<string, SeenSet> = {};
  for (const entity of entities) {
    const resource = connection.resources.find((one) => one.id === entity.resource);
    const seen = resource?.listOp ? byOp[resource.listOp] : undefined;
    if (seen && (Object.keys(seen.fields).length > 0 || (seen.unique?.length ?? 0) > 0)) out[entity.id] = seen;
  }
  return out;
};
