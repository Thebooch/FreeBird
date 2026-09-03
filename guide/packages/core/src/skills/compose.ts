import type { Skill, SkillProvider } from "./types.js";

/**
 * Layer several providers into one.
 *
 * "A set of defaults, plus whatever this tenant picked" is the managed case
 * on day one, and every host that needed it would otherwise write the same
 * merge — badly, because the interesting part is not concatenation but what
 * happens on a collision.
 *
 * Later providers win on `id`. That ordering is the useful one: pass the
 * defaults first and a tenant can override a shipped skill by keeping its id,
 * which is exactly how someone customises "how we handle refunds" without
 * losing the rest of the set.
 *
 * Providers run concurrently and a failing one is skipped rather than taking
 * the others down with it — the same reasoning as the engine catching a
 * throwing provider: instructions are worth having, never worth a failed turn.
 */
export const composeSkillProviders =
  (...providers: readonly SkillProvider[]): SkillProvider =>
  async (ctx) => {
    // `async` on the wrapper matters: a provider is free to be synchronous, and
    // one that throws rather than rejecting would blow up inside `.map()`
    // before `allSettled` ever saw it — taking down the providers beside it.
    const settled = await Promise.allSettled(providers.map(async (provider) => provider(ctx)));
    const byId = new Map<string, Skill>();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const skill of result.value) byId.set(skill.id, skill);
    }
    return [...byId.values()];
  };
