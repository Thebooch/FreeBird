/**
 * Ids for the pieces of an agent made in the editor: a tool, a context rule.
 * Short, readable, and unique within the agent, which is all they need to be.
 */
const nextFree = (base: string, taken: readonly string[]): string => {
  const held = new Set(taken);
  if (!held.has(base)) return base;
  for (let n = 2; ; n++) if (!held.has(`${base}-${n}`)) return `${base}-${n}`;
};

export const newRuleId = (taken: readonly string[]): string => nextFree("rule", taken);

export const newToolId = (kind: string, taken: readonly string[]): string => nextFree(kind.replace(/_/g, "-"), taken);

/** A context rule needs a trigger and somewhere to look; one without either is not saved. */
export const usableRules = <T extends { trigger: string; sources: readonly unknown[] }>(rules: readonly T[]): T[] =>
  rules.filter((rule) => rule.trigger.trim() !== "" && rule.sources.length > 0);
