import { isIncompleteNote, type FetchMeta } from "@freebirdai/connect/adapters";

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
    /**
     * The host's read of every record, past the ones the tile read itself.
     * While it reads, the tile's own notes stand and its progress is said;
     * once done, its answer replaces the tile's, and so do its notes.
     */
    readonly whole?: {
      readonly status: "reading" | "done";
      readonly read: number;
      /** Records asked about. */
      readonly asked: number;
      /** Records past the ceiling, never asked about. */
      readonly beyond: number;
      readonly failed: number;
      /** What the records' own reads said they left out, once each. */
      readonly notes: readonly string[];
      /** Why the read stopped, when the API stopped it. */
      readonly stopped?: string;
    };
  };
}): readonly string[] => {
  const notes: string[] = [];
  const fanOut = input.fanOut;
  const whole = fanOut?.whole;
  if (whole?.status === "done") {
    const total = whole.asked + whole.beyond;
    if (whole.stopped !== undefined || whole.beyond > 0)
      notes.push(
        `Only ${whole.read} of ${total} records were read in full, so what is shown excludes the rest.`,
      );
    if (whole.stopped !== undefined) notes.push(`The rest were not read: ${whole.stopped}`);
    if (whole.failed > 0)
      notes.push(
        `${whole.failed} of ${whole.asked} related records could not be read, so what is shown excludes them.`,
      );
    notes.push(...whole.notes);
    return [...new Set([...notes, ...metaNotes(input.metas)])];
  }
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
  if (whole?.status === "reading")
    notes.push(`The rest are being read: ${whole.read} of ${whole.asked} so far.`);
  return [...new Set([...notes, ...metaNotes(input.metas)])];
};

/** What each read said about the rows it left out. */
const metaNotes = (metas: readonly (FetchMeta | undefined)[]): string[] => {
  const notes: string[] = [];
  for (const meta of metas) {
    if (!meta) continue;
    const said = meta.warnings.filter(isIncompleteNote);
    notes.push(...said);
    if (meta.truncated && said.length === 0)
      notes.push("Not every page was read, so what is shown may exclude additional records.");
  }
  return notes;
};
