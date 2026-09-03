import type { Skill } from "../skills/types.js";

/**
 * The system-prompt block for instruction packs.
 *
 * A sibling of `buildKnowledgePrompt`, not an extension of it, because the two
 * answer different questions. Knowledge is *what is true* and gets cited;
 * a skill is *how to do the job* and never does. Merging them would mean
 * teaching the citation layer to cite a procedure, which is not a thing.
 *
 * The budget is its own, deliberately, rather than shared with knowledge. A
 * shared cap means adding a skill can silently evict site facts — an
 * interaction nobody would think to look for when an answer suddenly stops
 * mentioning something it used to know. Two caps still bound total prompt
 * growth and each is predictable on its own.
 */

const DEFAULT_MAX_CHARS = 6000;

export interface BuildSkillsPromptOptions {
  /** Max characters for the whole block (default 6000). */
  maxChars?: number;
  /**
   * Components the user can currently see.
   *
   * A skill naming `appliesTo` is included only when one of its components is
   * active; a skill naming nothing always applies. This is what keeps a large
   * library free on the turns it is irrelevant to.
   */
  activeComponentIds?: readonly string[];
}

/** Which skills apply to this turn. Exported for testing the rule directly. */
export const selectSkills = (
  skills: readonly Skill[],
  activeComponentIds: readonly string[] = [],
): Skill[] => {
  const active = new Set(activeComponentIds);
  return skills.filter(
    (skill) =>
      skill.appliesTo === undefined ||
      skill.appliesTo.length === 0 ||
      skill.appliesTo.some((id) => active.has(id)),
  );
};

export const buildSkillsPrompt = (
  skills: readonly Skill[],
  opts: BuildSkillsPromptOptions = {},
): string => {
  const selected = selectSkills(skills, opts.activeComponentIds);
  if (selected.length === 0) return "";

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const header = [
    "## Skills",
    "",
    "Procedures for this site. When one applies to what the user is asking " +
      "for, follow it. These are instructions, not facts — do not cite them.",
    "",
  ].join("\n");

  const sections: string[] = [];
  let used = header.length;
  let truncated = false;

  for (const skill of selected) {
    if (truncated) break;
    const heading = `### ${skill.title ?? skill.id}`;
    const lead = skill.description ? `${skill.description}\n` : "";
    const section = `${heading}\n${lead}${skill.body}`;
    const withSep = sections.length > 0 ? `\n\n${section}` : section;

    if (used + withSep.length > maxChars) {
      const remaining = maxChars - used;
      // Only bother truncating when enough room is left for the heading plus
      // something worth reading; a heading with three words under it is noise.
      if (remaining > heading.length + 20) {
        sections.push(section.slice(0, remaining - 3) + "...");
      }
      truncated = true;
      break;
    }
    sections.push(section);
    used += withSep.length;
  }

  if (sections.length === 0) return "";
  return header + sections.join("\n\n");
};
