import type { StateNotice } from "../notices/types.js";

/**
 * The system block for things that happened without anyone speaking.
 *
 * Deliberately phrased as background rather than as a request. A model handed
 * "the user changed the date range to Q3" at the top of a turn will otherwise
 * cheerfully open its reply by acknowledging it, which is precisely the
 * behaviour tier-1 exists to avoid — the whole point is that this needed no
 * response when it happened, and still needs none now.
 */

const DEFAULT_MAX_CHARS = 2000;

export interface BuildNoticesPromptOptions {
  /** Max characters for the block (default 2000). */
  maxChars?: number;
}

export const buildNoticesPrompt = (
  notices: readonly StateNotice[],
  opts: BuildNoticesPromptOptions = {},
): string => {
  if (notices.length === 0) return "";
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  const header = [
    "## Since your last reply",
    "",
    "The user did these things without saying anything. They are context for " +
      "the message below, not requests — do not acknowledge or respond to them " +
      "directly, and do not thank the user for them.",
    "",
  ].join("\n");

  const ordered = [...notices].sort((a, b) => a.at - b.at);
  const lines: string[] = [];
  let used = header.length;

  /*
   * Room held back for the "N omitted" line.
   *
   * Reserved up front rather than appended at the end, because a marker added
   * after the budget was already spent pushes the block over it — which makes
   * `maxChars` a suggestion instead of a cap, exactly in the case where the
   * caller most needs it honoured.
   */
  const markerReserve = 48;
  const contentBudget = maxChars - markerReserve;

  for (const notice of ordered) {
    const line = `- ${notice.summary}`;
    if (used + line.length + 1 > contentBudget) {
      // Say the list was trimmed rather than quietly ending it. A model told
      // nothing changed when something did is worse off than one told the
      // list is incomplete.
      lines.push(`- (${ordered.length - lines.length} earlier changes omitted)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  return header + lines.join("\n");
};
