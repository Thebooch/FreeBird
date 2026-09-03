/**
 * A structured question the assistant needs answered before it can continue.
 *
 * The action layer already collects arguments conversationally — but only once
 * an action is open. This is the gap before that: "did you mean the March
 * invoice or the April one?" is a question the model must resolve *in order to
 * choose* an action, and today it has to ask in prose and then parse the reply
 * out of free text. That is exactly the guesswork the typed action layer was
 * built to remove, reappearing one step earlier.
 */

export interface QuestionOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface PendingQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly options: readonly QuestionOption[];
  /** When true the client may return more than one value. */
  readonly multiSelect: boolean;
}

/** What the user chose, carried up on the next turn. */
export interface QuestionAnswer {
  readonly questionId: string;
  readonly question: string;
  /** Option values, or free text when the client allowed it. */
  readonly values: readonly string[];
}
