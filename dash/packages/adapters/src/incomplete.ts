/**
 * What a read that stopped early says, in words a reader can act on.
 *
 * Every one of these reaches a tile, a chat reply or a setup preview, and the
 * person reading it cares about one thing: whether what they see is all of it.
 * So each says what happened and what it means for the numbers. A cap says
 * "excludes", because there is a next page and so there are more records; the
 * others say "may exclude", because nothing proves the rest exists.
 *
 * Nothing claims the missing records are few, large or positive — a total
 * that is short could be short a refund as easily as a sale.
 */
export const INCOMPLETE = {
  pageCap: (pages: number, what: "endpoint" | "tool" = "endpoint"): string =>
    `Only the first ${pages} page(s) were read, and this ${what} has more. What is shown excludes those additional records.`,
  repeatedPage:
    "The API sent the same page twice, so reading stopped there. What is shown may exclude additional records.",
  repeatedArgs:
    "The tool was asked for the same page twice, so reading stopped there. What is shown may exclude additional records.",
  rowsMissing:
    "A page did not carry its records where they were expected, so reading stopped there. What is shown may exclude additional records.",
  unmerged:
    "The pages could not be combined, so only the first one is shown. What is shown excludes the records on the others.",
  unconfirmed:
    "Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records.",
  linkHeader:
    "This connection pages by link headers, which a tool has no equivalent for, so only the first page was read. What is shown may exclude additional records.",
  connectorStopped:
    "The connection's connector stopped before the end of this endpoint's records. What is shown may exclude additional records.",
  reportedMore: (total: number): string =>
    `The API reports ${total} record(s) here and fewer were read. What is shown excludes those additional records.`,
} as const;

const FIXED = new Set<string>([
  INCOMPLETE.repeatedPage,
  INCOMPLETE.repeatedArgs,
  INCOMPLETE.rowsMissing,
  INCOMPLETE.unmerged,
  INCOMPLETE.unconfirmed,
  INCOMPLETE.linkHeader,
  INCOMPLETE.connectorStopped,
]);
const PAGE_CAP = /^Only the first \d+ page\(s\) were read, and this (endpoint|tool) has more\./;
const REPORTED_MORE = /^The API reports \d+ record\(s\) here and fewer were read\./;

/**
 * Whether a read's warning is one of these, rather than some other caveat.
 *
 * A read's `warnings` also carry notes about brittleness — a tool that
 * answered in text that had to be parsed — which say nothing about whether
 * the rows are all there, and must not be shown as if they did.
 */
export const isIncompleteNote = (warning: string): boolean =>
  FIXED.has(warning) || PAGE_CAP.test(warning) || REPORTED_MORE.test(warning);
