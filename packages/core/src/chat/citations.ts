import type { ComponentRegistry } from "../components/registry.js";
import type { ComponentCitation } from "../types.js";

/**
 * Inline marker the model appends after a sentence grounded in a registered
 * component's knowledge, e.g. `[[cite:openingHours]]`. Parsed and stripped
 * server-side by {@link extractCitations} before the reply is persisted —
 * never shown to the visitor as raw text.
 */
export const CITE_MARKER_RE = /\[\[cite:([a-zA-Z0-9_-]+)\]\]/g;

/**
 * System-prompt block teaching the model the citation convention, listing
 * which registered components it may cite. Returns "" when nothing is
 * citable (empty registry, or no component has knowledge/a locatable
 * region, and no citable site knowledge) — callers should skip injecting an
 * empty block.
 */
export const buildCitationsPrompt = (registry: ComponentRegistry<any, any>): string => {
  const citable = registry
    .list()
    .filter((c) => c.domAnchor || (c.knowledge?.length ?? 0) > 0);
  const citableKnowledge = registry.listKnowledge().some((k) => k.id);
  if (citable.length === 0 && !citableKnowledge) return "";

  const lines = [
    "## Citations",
    "",
    "When your reply states a fact drawn from a registered component's knowledge, or references a " +
      "registered form/section, append a citation marker at the END of your reply for each one " +
      "referenced, using this exact syntax: [[cite:componentId]]. Only cite componentIds from the " +
      "list below. Do not cite a component for general knowledge that isn't grounded in its listed " +
      "facts, and don't mention the marker syntax itself to the user.",
  ];
  if (citableKnowledge) {
    lines.push(
      "",
      "You may also cite Site knowledge items the same way, using the bracketed id shown next to " +
        "the fact in the Site knowledge section, e.g. [[cite:kb_ab12cd34ef56]].",
    );
  }
  if (citable.length > 0) {
    lines.push("", "Citable components:", ...citable.map((c) => `- ${c.id}: ${c.title} — ${c.description}`));
  }
  return lines.join("\n");
};

/**
 * Defensive extraction of citations from a persisted `ChatMessage.toolPayload`
 * (untyped JSON on the wire). Tolerates payloads without `kind` and
 * drops entries missing the fields every chip needs.
 */
export const citationsFromToolPayload = (payload: unknown): ComponentCitation[] => {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as { citations?: unknown }).citations;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is ComponentCitation =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as ComponentCitation).componentId === "string" &&
      typeof (c as ComponentCitation).title === "string",
  );
};

/**
 * Strip `[[cite:id]]` markers from `content` and resolve each into a
 * {@link ComponentCitation}. Ids resolve against registered components first
 * (via `domAnchor`), then site knowledge items (via their `source`) — so a
 * knowledge id shadowed by a component id yields the component. Unresolvable
 * or hallucinated ids (unknown, or missing any locatable target) are
 * silently dropped rather than surfaced as an error — same defensive
 * posture used elsewhere for LLM-supplied ids.
 */
export const extractCitations = (
  content: string,
  registry: ComponentRegistry<any, any>,
): { text: string; citations: ComponentCitation[] } => {
  const seen = new Set<string>();
  const citations: ComponentCitation[] = [];
  const text = content
    .replace(CITE_MARKER_RE, (_match, id: string) => {
      if (seen.has(id)) return "";
      const component = registry.get(id);
      const selector = component?.domAnchor?.selector;
      if (component && selector) {
        seen.add(id);
        citations.push({
          componentId: id,
          title: component.title,
          directive: "highlight",
          selector,
          ...(component.domAnchor?.page ? { page: component.domAnchor.page } : {}),
        });
        return "";
      }
      const item = registry.getKnowledgeItem(id);
      if (item && (item.source?.page || item.source?.selector)) {
        seen.add(id);
        citations.push({
          componentId: id,
          title: item.title ?? item.source?.heading ?? item.text.slice(0, 60),
          directive: "highlight",
          kind: "knowledge",
          ...(item.source?.selector ? { selector: item.source.selector } : {}),
          ...(item.source?.page ? { page: item.source.page } : {}),
        });
      }
      return "";
    })
    .replace(/[ \t]+(\r?\n)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, citations };
};
