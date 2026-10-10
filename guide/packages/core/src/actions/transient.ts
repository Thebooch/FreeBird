/**
 * Values a person sees once and nothing keeps: a link that is itself a key
 * (a booking page, a calendar feed), a one-time code.
 *
 * An action returns them beside its result with `withTransient`. The
 * `/actions/confirm` response carries them to the person who approved it;
 * the audit record saved in the conversation and every server event leave
 * them out (`withoutTransient`), so the key is never stored in the clear.
 */

export const TRANSIENT_KEY = "freebirdTransient" as const;

/** An action's result, with values to show once and never keep. */
export const withTransient = <T extends object>(result: T, values: Readonly<Record<string, string>>): T & { readonly [TRANSIENT_KEY]: Readonly<Record<string, string>> } => ({
  ...result,
  [TRANSIENT_KEY]: values,
});

/** The values to show once, or null when the result carries none. */
export const transientOf = (result: unknown): Readonly<Record<string, string>> | null => {
  if (!result || typeof result !== "object") return null;
  const value = (result as Record<string, unknown>)[TRANSIENT_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : null;
};

/** The result as it may be kept: without the values to show once. */
export const withoutTransient = <T>(result: T): T => {
  if (!result || typeof result !== "object" || Array.isArray(result) || !(TRANSIENT_KEY in (result as object))) return result;
  const { [TRANSIENT_KEY]: _dropped, ...kept } = result as Record<string, unknown>;
  return kept as T;
};
