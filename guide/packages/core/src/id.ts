import { customAlphabet } from "nanoid";

/**
 * URL-safe short id. Slightly bigger than the default nanoid to keep
 * collision probability negligible for small/medium apps.
 */
const nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  16,
);

export const newId = (prefix?: string): string =>
  prefix ? `${prefix}_${nanoid()}` : nanoid();
