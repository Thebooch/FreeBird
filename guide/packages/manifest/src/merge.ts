import type { ManifestKnowledgeItem, RegistrationManifest } from "./schema.js";

/**
 * Merge an incoming manifest into a base manifest, upserting components by id
 * (incoming wins). Used by the managed backend when the embed's scanner or the
 * WP plugin re-pushes a partial manifest: previously known components survive,
 * re-scanned ones are refreshed.
 *
 * Top-level knowledge: when `incoming.knowledge` is undefined it is preserved
 * from base — embed-scanned manifests never carry knowledge and must not
 * clobber Studio-ingested items. When present, items upsert by id (incoming
 * wins) and id-less incoming items append.
 */
export const mergeManifests = (
  base: RegistrationManifest,
  incoming: RegistrationManifest,
): RegistrationManifest => {
  const byId = new Map(base.components.map((c) => [c.id, c]));
  for (const component of incoming.components) {
    byId.set(component.id, component);
  }
  const knowledge = mergeKnowledge(base.knowledge, incoming.knowledge);
  return {
    version: 1,
    ...((incoming.siteId ?? base.siteId) !== undefined
      ? { siteId: incoming.siteId ?? base.siteId }
      : {}),
    components: [...byId.values()],
    ...(knowledge !== undefined ? { knowledge } : {}),
  };
};

const knowledgeId = (item: ManifestKnowledgeItem): string | undefined =>
  typeof item === "string" ? undefined : item.id;

const mergeKnowledge = (
  base: ManifestKnowledgeItem[] | undefined,
  incoming: ManifestKnowledgeItem[] | undefined,
): ManifestKnowledgeItem[] | undefined => {
  if (incoming === undefined) return base;
  if (base === undefined || base.length === 0) return incoming;
  const incomingIds = new Set(
    incoming.map(knowledgeId).filter((id): id is string => id !== undefined),
  );
  const kept = base.filter((item) => {
    const id = knowledgeId(item);
    return id === undefined || !incomingIds.has(id);
  });
  return [...kept, ...incoming];
};
