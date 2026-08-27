import type { ComponentRegistry } from "../components/registry.js";
import type { KnowledgeItem } from "../types.js";

/**
 * Lightweight tag <-> component inverted index derived from the ComponentRegistry.
 *
 * Tags are case-insensitive. Use `rebuild()` after modifying the registry
 * (or call it lazily yourself) — the graph doesn't subscribe to registry events.
 */
export class KnowledgeGraph {
  private tagToComponents = new Map<string, Set<string>>();
  private componentToTags = new Map<string, Set<string>>();
  private componentToKnowledge = new Map<string, KnowledgeItem[]>();

  constructor(private readonly registry: ComponentRegistry<any, any>) {
    this.rebuild();
  }

  rebuild(): void {
    this.tagToComponents.clear();
    this.componentToTags.clear();
    this.componentToKnowledge.clear();

    for (const c of this.registry.list()) {
      const tags = (c.tags ?? []).map((t) => t.toLowerCase());
      this.componentToTags.set(c.id, new Set(tags));
      for (const t of tags) {
        const set = this.tagToComponents.get(t) ?? new Set<string>();
        set.add(c.id);
        this.tagToComponents.set(t, set);
      }
      this.componentToKnowledge.set(c.id, c.knowledge ?? []);
    }
  }

  /** Returns all component ids for the given tag (case-insensitive). */
  componentsForTag(tag: string): string[] {
    return Array.from(this.tagToComponents.get(tag.toLowerCase()) ?? []);
  }

  tagsForComponent(componentId: string): string[] {
    return Array.from(this.componentToTags.get(componentId) ?? []);
  }

  knowledgeFor(componentId: string): KnowledgeItem[] {
    return this.componentToKnowledge.get(componentId) ?? [];
  }

  /**
   * Given free-form user text, returns tags present in the registry that
   * appear as whole-word matches. Cheap but effective for "did you mention
   * something I know about".
   */
  extractKnownTags(text: string): string[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const hits: string[] = [];
    for (const tag of this.tagToComponents.keys()) {
      const re = new RegExp(`\\b${escapeRegex(tag)}\\b`, "i");
      if (re.test(lower)) hits.push(tag);
    }
    return hits;
  }

  /** Returns component ids that match by id or tag anywhere in `text`. */
  extractKnownComponents(text: string): string[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const hits = new Set<string>();
    for (const c of this.registry.list()) {
      if (lower.includes(c.id.toLowerCase())) hits.add(c.id);
    }
    for (const tag of this.extractKnownTags(text)) {
      for (const cid of this.componentsForTag(tag)) hits.add(cid);
    }
    return Array.from(hits);
  }
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const createKnowledgeGraph = (registry: ComponentRegistry<any, any>): KnowledgeGraph =>
  new KnowledgeGraph(registry);
