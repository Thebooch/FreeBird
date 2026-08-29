import type { ToolBinding } from "./types.js";

/**
 * What the assistant can open, as one line each.
 *
 * The counterpart to the static tool description. The engine takes its tool
 * schemas once, so `read_record` cannot enumerate what exists — but the
 * workspace knowledge is rebuilt every turn, which means a connection added
 * five minutes ago is usable without a restart.
 *
 * Kept to one line per resource on purpose. This is paid for on every turn,
 * and the lesson already learnt here is that tool descriptions are prompt
 * tokens: a hundred and thirty-five near-identical action schemas were once
 * ninety percent of the chat prompt. A name, where it lives, and what
 * identifies it is everything needed to make the call; anything more belongs
 * behind a lookup.
 */
export const readRoster = (bindings: readonly ToolBinding[]): string => {
  const openable = bindings.filter((binding) => binding.verb === "read");
  if (openable.length === 0) {
    return (
      "RECORDS YOU CAN OPEN — none. Nothing connected here exposes an endpoint that " +
      "returns a single record, so a field missing from a collection's rows cannot be " +
      "fetched. Say that rather than implying it could be looked up."
    );
  }

  /*
   * Grouped by connection, because "which API is this" is the first thing a
   * cross-source question needs and the last thing a flat list conveys.
   */
  const byConnection = new Map<string, ToolBinding[]>();
  for (const binding of openable) {
    const group = byConnection.get(binding.connectionTitle) ?? [];
    group.push(binding);
    byConnection.set(binding.connectionTitle, group);
  }

  /*
   * One sentence, capped.
   *
   * An API's own description of a collection is often a paragraph with its
   * permission requirements appended — real documentation, and far more than
   * is needed to decide whether this is the right noun. Forty resources times
   * a paragraph is a prompt cost paid on every single turn.
   */
  const gist = (text: string): string => {
    const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
    const trimmed = first.length > 90 ? `${first.slice(0, 89).trimEnd()}…` : first;
    return trimmed.trim();
  };

  const lines = [...byConnection].flatMap(([title, group]) => [
    `  ${title}:`,
    ...group.map((binding) => {
      const identity = binding.idField ? `identified by ${binding.idField}` : "no identifier known";
      const describes = binding.describes ? ` — ${gist(binding.describes)}` : "";
      return `    ${binding.id} (${identity})${describes}`;
    }),
  ]);

  return [
    "RECORDS YOU CAN OPEN — call `read_record` with one of these names and an identifier",
    "to get the whole record. A collection's rows are a summary; descriptions, notes and",
    "long text are exactly what they leave out, so a field being missing from rows in hand",
    "is a reason to open the record, not a reason to say the field is unavailable.",
    ...lines,
  ].join("\n");
};

/**
 * What can be narrowed before it is read, and by what.
 *
 * Names the inputs rather than describing them, because the model has to pass
 * a parameter name and a made-up one is silently dropped. Enum values are
 * carried where the API declared them — "which statuses exist" is otherwise a
 * question that costs a request to answer badly.
 */
export const queryRoster = (bindings: readonly ToolBinding[]): string => {
  const queryable = bindings.filter((binding) => binding.verb === "query");
  if (queryable.length === 0) {
    return (
      "COLLECTIONS YOU CAN NARROW — none. Nothing connected here declares an input that " +
      "filters a collection, so finding a record means reading a page and matching in it. " +
      "Say that rather than implying the API was searched."
    );
  }

  const byConnection = new Map<string, ToolBinding[]>();
  for (const binding of queryable) {
    const group = byConnection.get(binding.connectionTitle) ?? [];
    group.push(binding);
    byConnection.set(binding.connectionTitle, group);
  }

  /*
   * Named briefly, because this is paid for on every turn.
   *
   * Fifty collections with every filter and every enum spelled out came to
   * seven thousand characters — for a question that touches one of them. The
   * names are what the model needs to make the call; the full parameter list
   * is one `look_up_endpoint` away and only wanted when it is actually going
   * to filter.
   */
  const describeFilters = (binding: ToolBinding): string => {
    const parts: string[] = [];
    if (binding.search) parts.push(`text via ${binding.search}`);
    if (binding.range) parts.push("a date range");

    const all = binding.filters ?? [];
    for (const filter of all.slice(0, MAX_FILTERS_LISTED)) {
      // Accepted values inline only when they are short enough to be cheaper
      // than the lookup they would save.
      const values = filter.enum ?? [];
      const inline = values.length > 0 && values.length <= 4 && values.join("|").length <= 40;
      parts.push(inline ? `${filter.name} (${values.join("|")})` : filter.name);
    }
    const more = all.length - Math.min(all.length, MAX_FILTERS_LISTED);
    if (more > 0) parts.push(`and ${more} more`);
    return parts.join(", ");
  };

  const lines = [...byConnection].flatMap(([title, group]) => [
    `  ${title}:`,
    ...group.map((binding) => `    ${binding.id} — ${describeFilters(binding)}`),
  ]);

  return [
    "COLLECTIONS YOU CAN NARROW — call `query_records` with one of these names, plus text",
    "or any of its filters. Only the inputs named here are sent; anything else is reported",
    "as not applied. When a collection has no text input, the words are matched against the",
    "records that were read, which is a search over a page and not over the collection.",
    ...lines,
  ].join("\n");
};

/** Filters named per collection before the rest are left to `look_up_endpoint`. */
const MAX_FILTERS_LISTED = 5;
