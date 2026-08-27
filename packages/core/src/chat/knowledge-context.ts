import type { ComponentRegistry } from "../components/registry.js";
import type { KnowledgeItem } from "../types.js";

export interface BuildKnowledgePromptOptions {
  /** Max characters for the full block (default 6000). */
  maxChars?: number;
  /**
   * Override the site-wide knowledge list (normally
   * `registry.listKnowledge()`) — used by hosts that retrieve a relevant
   * subset per message (embeddings search) instead of injecting everything.
   * Component-attached knowledge is unaffected.
   */
  siteItems?: KnowledgeItem[];
}

const DEFAULT_MAX_CHARS = 6000;

/** One bullet line for a site knowledge item, with its citable id when present. */
const siteKnowledgeBullet = (item: KnowledgeItem): string => {
  const idTag = item.id ? `[${item.id}] ` : "";
  const category = item.category ? `[${item.category}] ` : "";
  const source = item.source
    ? ` (source: ${item.source.page}${item.source.selector ?? ""}${
        item.source.heading ? ` "${item.source.heading}"` : ""
      })`
    : "";
  return `- ${idTag}${category}${item.text}${source}`;
};

/**
 * System-prompt block listing registered component knowledge and site-wide
 * knowledge items for the LLM. Returns "" when neither exists — callers
 * should skip injection.
 */
export const buildKnowledgePrompt = (
  registry: ComponentRegistry<any, any>,
  opts: BuildKnowledgePromptOptions = {},
): string => {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const withKnowledge = registry
    .list()
    .filter((c) => (c.knowledge?.length ?? 0) > 0);
  const siteItems = opts.siteItems ?? registry.listKnowledge();
  if (withKnowledge.length === 0 && siteItems.length === 0) return "";

  const header = [
    "## Site knowledge",
    "",
    "The facts below come from the site's registered knowledge base. Use them to answer " +
      "visitor questions. When you state a fact from this section, cite its id — the " +
      "component id, or for Site knowledge items the bracketed item id — using [[cite:id]] " +
      "at the end of your reply (see Citations).",
    "",
  ].join("\n");

  const sections: string[] = [];
  let used = header.length;
  let truncated = false;

  const pushSection = (sectionHeader: string, bullets: string[]): void => {
    if (truncated) return;
    const section = [sectionHeader, ...bullets].join("\n");
    const withSep = sections.length > 0 ? `\n\n${section}` : section;
    if (used + withSep.length > maxChars) {
      const remaining = maxChars - used;
      if (remaining > sectionHeader.length + 20) {
        sections.push(section.slice(0, remaining - 3) + "...");
      }
      truncated = true;
      return;
    }
    sections.push(section);
    used += withSep.length;
  };

  for (const component of withKnowledge) {
    pushSection(
      `### ${component.title} (id: ${component.id})`,
      (component.knowledge ?? []).map((item) => {
        const prefix = item.category ? `[${item.category}] ` : "";
        return `- ${prefix}${item.text}`;
      }),
    );
  }

  if (siteItems.length > 0) {
    pushSection("### Site knowledge", siteItems.map(siteKnowledgeBullet));
  }

  if (sections.length === 0) return "";
  return header + sections.join("\n\n");
};
