/**
 * Something the shell wants said in the chat, said exactly once.
 *
 * "Add a widget" posts a sentence into the conversation on the user's behalf.
 * The column used to send it from an effect and then ask the shell to clear
 * it — and between the two, a re-render could see the sentence still set and
 * send it again. The chat store's own updates are synchronous, so `send`
 * re-rendering the column before the shell's clear landed was not a
 * hypothetical: one click became a stream of chat turns, several at a time,
 * each paying for two model calls, until the server was stopped.
 *
 * So the send is guarded by a claim, not by a render. `take` hands the text to
 * exactly one caller and empties the slot in the same synchronous step; a
 * second effect run with a stale prop gets `null` and sends nothing. The slot
 * lives with the shell rather than the column because the column unmounts when
 * the drawer closes, and a flag inside it would be forgotten with it.
 *
 * Kept in a `.ts` file for the reason `editing.ts` gives: vitest collects no
 * `.tsx` under `apps/`, and this is exactly the logic that has to be proven.
 */
export interface PendingMessage {
  /** Queue a sentence to be said. Replaces anything not yet taken. */
  readonly arm: (text: string) => void;
  /** Claim the sentence. Only the first caller gets it. */
  readonly take: () => string | null;
}

export const createPendingMessage = (
  /** Told whenever the slot changes, so the column knows to look. */
  onChange: (text: string | null) => void,
): PendingMessage => {
  let current: string | null = null;
  return {
    arm: (text) => {
      current = text;
      onChange(text);
    },
    take: () => {
      const text = current;
      current = null;
      if (text !== null) onChange(null);
      return text;
    },
  };
};
