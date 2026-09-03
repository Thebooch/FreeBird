import type { DbAdapter } from "../adapters/db.js";
import { requireSkills } from "../adapters/db.js";
import type { SkillProvider } from "./types.js";

/**
 * Serve skills from the host's own database.
 *
 * The one-line wiring for the common case. Reads through `requireSkills` so a
 * host that reaches for this with an adapter that cannot store skills gets a
 * clear error naming the missing methods, rather than an empty list that looks
 * like "this tenant has no skills".
 */
export const dbSkillProvider = (db: DbAdapter): SkillProvider => {
  const store = requireSkills(db);
  return ({ auth }) => store.list(auth);
};
