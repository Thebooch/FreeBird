import type { ActionDefinition, ComponentDefinition, KnowledgeItem } from "../types.js";
import { componentMetadataSchema, knowledgeItemSchema } from "./schema.js";
import {
  ALL_REVIEW_DISPOSITIONS,
  type ReviewableComponentSummary,
} from "../review/types.js";

/**
 * The ComponentRegistry is the single source of truth for what components
 * exist in a FreeBird app. The chat engine reads it to build the `plan_layout`
 * tool schema, the layout solver reads it for grid constraints, and the
 * digest engine reads it to pull `dataSource()`.
 *
 * It is intentionally in-memory: component definitions are code, not data.
 * Multi-process deployments should register the same components in every
 * process (typically by importing a shared module on boot).
 */
export class ComponentRegistry<TRender = unknown, TAuth = unknown> {
  private readonly byId = new Map<string, ComponentDefinition<any, TRender, TAuth>>();
  /** Site-wide knowledge items not attached to any component (keyed by id). */
  private siteKnowledge = new Map<string, KnowledgeItem>();

  register<TProps>(def: ComponentDefinition<TProps, TRender, TAuth>): void {
    componentMetadataSchema.parse({
      id: def.id,
      title: def.title,
      description: def.description,
      tags: def.tags,
      knowledge: def.knowledge,
      grid: def.grid,
      actions: def.actions?.map((a) => ({
        id: a.id,
        description: a.description,
        requiresConfirmation: a.requiresConfirmation,
        previewStrategy: a.previewStrategy,
      })),
    });
    if (this.byId.has(def.id)) {
      throw new Error(`FreeBird: component "${def.id}" is already registered.`);
    }
    this.byId.set(def.id, def as ComponentDefinition<any, TRender, TAuth>);
  }

  /** Replace an existing component (useful for hot-reload in dev). */
  upsert<TProps>(def: ComponentDefinition<TProps, TRender, TAuth>): void {
    this.byId.delete(def.id);
    this.register(def);
  }

  unregister(id: string): boolean {
    return this.byId.delete(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): ComponentDefinition<any, TRender, TAuth> | undefined {
    return this.byId.get(id);
  }

  /** Strict variant that throws if missing. */
  getOrThrow(id: string): ComponentDefinition<any, TRender, TAuth> {
    const d = this.byId.get(id);
    if (!d) throw new Error(`FreeBird: unknown component id "${id}"`);
    return d;
  }

  list(): ComponentDefinition<any, TRender, TAuth>[] {
    return Array.from(this.byId.values());
  }

  /**
   * Replace the site-wide knowledge collection (knowledge not attached to a
   * component — e.g. facts ingested from the site's own pages). Items are
   * validated; items whose id collides with a registered component id are
   * skipped with a warning so `[[cite:id]]` resolution stays unambiguous
   * (components win). Id-less items are kept — they inform the LLM but are
   * not citable.
   */
  setKnowledge(items: KnowledgeItem[]): void {
    const next = new Map<string, KnowledgeItem>();
    let anon = 0;
    for (const item of items) {
      const parsed = knowledgeItemSchema.parse(item);
      if (parsed.id && this.byId.has(parsed.id)) {
        console.warn(
          `FreeBird: knowledge item id "${parsed.id}" collides with a registered component id — skipped.`,
        );
        continue;
      }
      const key = parsed.id ?? `__anon_${anon++}`;
      next.set(key, parsed);
    }
    this.siteKnowledge = next;
  }

  /** All site-wide knowledge items, in insertion order. */
  listKnowledge(): KnowledgeItem[] {
    return Array.from(this.siteKnowledge.values());
  }

  /** Look up a citable site knowledge item by id. */
  getKnowledgeItem(id: string): KnowledgeItem | undefined {
    const item = this.siteKnowledge.get(id);
    return item?.id === id ? item : undefined;
  }

  /** Look up an action by its owning component id and action id. */
  getAction(
    componentId: string,
    actionId: string,
  ): ActionDefinition<any, any, TAuth> | undefined {
    const c = this.byId.get(componentId);
    return c?.actions?.find((a) => a.id === actionId);
  }

  /**
   * List all actions across the registry, optionally restricted to a set of
   * component ids (e.g. only currently visible components on the page).
   */
  listActions(filter?: {
    componentIds?: string[];
  }): Array<{
    componentId: string;
    action: ActionDefinition<any, any, TAuth>;
  }> {
    const out: Array<{
      componentId: string;
      action: ActionDefinition<any, any, TAuth>;
    }> = [];
    const allow = filter?.componentIds
      ? new Set(filter.componentIds)
      : undefined;
    for (const c of this.byId.values()) {
      if (allow && !allow.has(c.id)) continue;
      for (const a of c.actions ?? []) {
        out.push({ componentId: c.id, action: a });
      }
    }
    return out;
  }

  /**
   * Components declaring a {@link ReviewCapability}, summarized for the LLM
   * review prompt and the `review_items` tool schema.
   */
  listReviewable(filter?: { componentIds?: string[] }): ReviewableComponentSummary[] {
    const allow = filter?.componentIds
      ? new Set(filter.componentIds)
      : undefined;
    const out: ReviewableComponentSummary[] = [];
    for (const c of this.byId.values()) {
      if (!c.review) continue;
      if (allow && !allow.has(c.id)) continue;
      out.push({
        componentId: c.id,
        title: c.title,
        itemNoun: c.review.itemNoun ?? "item",
        dispositions: c.review.dispositions ?? ALL_REVIEW_DISPOSITIONS,
        guidance: c.review.guidance,
      });
    }
    return out;
  }

  /**
   * Returns a lightweight summary used to build the LLM tool schema.
   * Excludes runtime-only fields (render, dataSource, handler).
   */
  describeForLLM(): Array<{
    id: string;
    title: string;
    description: string;
    tags: string[];
    grid: ComponentDefinition["grid"];
    knowledge: string[];
    /** Pulled from grid.sizes for convenience in the tool description builder. */
    sizes?: Array<{ name: string; w: number; h: number }>;
    preferredSize?: string;
    /** Action summaries for the action harness. */
    actions: Array<{
      id: string;
      description: string;
      requiresConfirmation: "none" | "preview" | "strict";
    }>;
  }> {
    return this.list().map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      tags: c.tags ?? [],
      grid: c.grid,
      knowledge: (c.knowledge ?? []).map((k) => k.text),
      sizes: c.grid.sizes?.map((s) => ({ name: s.name, w: s.w, h: s.h })),
      preferredSize: c.grid.preferredSize,
      actions: (c.actions ?? []).map((a) => ({
        id: a.id,
        description: a.description,
        requiresConfirmation: a.requiresConfirmation ?? "preview",
      })),
    }));
  }
}

export const createComponentRegistry = <TRender = unknown, TAuth = unknown>() =>
  new ComponentRegistry<TRender, TAuth>();
