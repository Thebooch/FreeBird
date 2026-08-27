import type { DbAdapter } from "../adapters/db.js";
import type { KnowledgeGraph } from "../knowledge/graph.js";
import type { AuthContext, ChatMessage, Reference } from "../types.js";

export interface ResolveReferencesOptions {
  /** New user message text. */
  text: string;
  /** Current session id (excluded from the search). */
  currentSessionId: string;
  /** Max references to return (default 5). */
  limit?: number;
}

/**
 * Given a user message, find prior cross-chat messages worth injecting as
 * LLM context. Matches are driven by the KnowledgeGraph (tags + component ids).
 *
 * This is intentionally simple — semantic vector search can be added later
 * as a secondary resolver. The goal here is: "if the user mentioned something
 * we already know about in *another* chat, surface it."
 */
export const resolveReferences = async (
  db: DbAdapter,
  graph: KnowledgeGraph,
  auth: AuthContext,
  opts: ResolveReferencesOptions,
): Promise<{ references: Reference[]; contextMessages: ChatMessage[] }> => {
  const limit = opts.limit ?? 5;
  const tags = graph.extractKnownTags(opts.text);
  const componentIds = graph.extractKnownComponents(opts.text);

  if (tags.length === 0 && componentIds.length === 0) {
    return { references: [], contextMessages: [] };
  }

  const seen = new Set<string>();
  const matches: ChatMessage[] = [];
  for (const tag of tags) {
    const msgs = await db.listMessagesByTag(
      tag,
      { limit, excludeSessionId: opts.currentSessionId },
      auth,
    );
    for (const m of msgs) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        matches.push(m);
      }
    }
    if (matches.length >= limit) break;
  }

  const ranked = matches
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);

  const references: Reference[] = ranked.map((m) => ({
    sourceSessionId: m.sessionId,
    sourceMessageId: m.id,
    tag: tags[0],
    componentId: componentIds[0],
    reason:
      tags.length > 0
        ? `Previous discussion tagged "${tags[0]}"`
        : `Previous mention of "${componentIds[0]}"`,
  }));

  return { references, contextMessages: ranked };
};
