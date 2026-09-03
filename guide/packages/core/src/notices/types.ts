/**
 * Something the user did that the model should know about but not answer.
 *
 * The gap this fills: a component can fire an action and a user can send a
 * message, but there was no way to say "the date filter moved to Q3" without
 * starting a whole turn. So hosts either started one — and the assistant
 * replied to something nobody asked — or said nothing, and the assistant
 * answered the next question against a view it could not see.
 *
 * A notice is neither. It accumulates silently and rides along with the next
 * real message, which is the only turn where it could possibly matter.
 */
export interface StateNotice {
  /** What happened, in the host's own vocabulary: "filter_changed". */
  readonly kind: string;
  /**
   * One line the model reads. The host writes this, not FreeBird, because
   * FreeBird has no idea what "Q3" means on this site.
   */
  readonly summary: string;
  /** Optional structured detail. Kept small; the summary does the work. */
  readonly detail?: Record<string, unknown>;
  /** Epoch ms, so the engine can render them in order. */
  readonly at: number;
}
