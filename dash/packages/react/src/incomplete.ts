import { isIncompleteNote, type FetchMeta } from "@freebirdai/dash-adapters";

/**
 * Every reason what a widget draws is not all of it, one sentence each.
 *
 * Read from every request the widget made, not only the first: a joined or
 * fanned-out widget whose second source stopped at its page cap is as
 * incomplete as one whose first did. Only a read's notes about missing rows
 * are taken; its other caveats (a tool whose answer had to be parsed) say
 * nothing about whether the rows are all there.
 */
export const incompleteNotes = (input: {
  readonly metas: readonly (FetchMeta | undefined)[];
  readonly fanOut?: {
    /** More parent records than were read in full. */
    readonly truncated: boolean;
    readonly read: number;
    readonly of: number;
    /** Children that could not be read at all. */
    readonly missing: number;
  };
}): readonly string[] => {
  const notes: string[] = [];
  const fanOut = input.fanOut;
  if (fanOut?.truncated)
    notes.push(
      `Only ${fanOut.read} of ${fanOut.of} records were read in full, so what is shown excludes the rest.`,
    );
  /*
   * A fan-out child that could not be read is stated rather than absorbed.
   * The tile still draws — that is the whole point of treating these as
   * optional — but a total quietly missing three of its twenty-five parts is
   * a number somebody would act on, so it says which it is.
   */
  if (fanOut && fanOut.missing > 0)
    notes.push(
      `${fanOut.missing} of ${fanOut.read} related records could not be read, so what is shown excludes them.`,
    );
  for (const meta of input.metas) {
    if (!meta) continue;
    const said = meta.warnings.filter(isIncompleteNote);
    notes.push(...said);
    if (meta.truncated && said.length === 0)
      notes.push("Not every page was read, so what is shown may exclude additional records.");
  }
  return [...new Set(notes)];
};
