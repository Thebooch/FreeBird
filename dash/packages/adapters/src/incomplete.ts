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
    "This connection pages by the next page's address, which a tool has no equivalent for, so only the first page was read. What is shown may exclude additional records.",
  connectorStopped:
    "The connection's connector stopped before the end of this endpoint's records. What is shown may exclude additional records.",
  laterPageRefused:
    "The API refused a later page, so reading stopped there. What is shown may exclude additional records.",
  reportedMore: (total: number): string =>
    `The API reports ${total} record(s) here and fewer were read. What is shown excludes those additional records.`,
  streamWindow: (events: number, seconds: number): string =>
    `This endpoint is a stream: what is shown is what arrived in one window (up to ${events} events or ${seconds} seconds), not everything it has carried. What is shown may exclude additional records.`,
} as const;

const FIXED = new Set<string>([
  INCOMPLETE.repeatedPage,
  INCOMPLETE.repeatedArgs,
  INCOMPLETE.rowsMissing,
  INCOMPLETE.unmerged,
  INCOMPLETE.unconfirmed,
  INCOMPLETE.linkHeader,
  INCOMPLETE.connectorStopped,
  INCOMPLETE.laterPageRefused,
]);
const PAGE_CAP = /^Only the first \d+ page\(s\) were read, and this (endpoint|tool) has more\./;
const REPORTED_MORE = /^The API reports \d+ record\(s\) here and fewer were read\./;
const STREAM_WINDOW = /^This endpoint is a stream: what is shown is what arrived in one window/;

/**
 * Whether a read's warning is one of these, rather than some other caveat.
 *
 * A read's `warnings` also carry notes about brittleness — a tool that
 * answered in text that had to be parsed — which say nothing about whether
 * the rows are all there, and must not be shown as if they did.
 */
export const isIncompleteNote = (warning: string): boolean =>
  FIXED.has(warning) || PAGE_CAP.test(warning) || REPORTED_MORE.test(warning) || STREAM_WINDOW.test(warning);

/**
 * What a read says when its endpoint no longer answers in the shape it was
 * accepted in: a field a widget reads is gone, holds another kind of thing,
 * or the records moved. Not a note about missing records — every record may
 * be there — but one that changes what a number means just as much, so it is
 * said on the tile beside those.
 */
export const CHANGED = {
  since: (title: string, what: string): string =>
    `${title} has changed since it was checked: ${what}. What is shown may be wrong until it is rebuilt.`,
} as const;

const CHANGED_SINCE = /^.+ has changed since it was checked: .+\. What is shown may be wrong until it is rebuilt\.$/s;

export const isChangedNote = (warning: string): boolean => CHANGED_SINCE.test(warning);
