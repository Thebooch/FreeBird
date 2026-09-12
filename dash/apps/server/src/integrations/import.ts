import {
  integrationDefinitionSchema, deriveResourceGraph, humanLabel, resolveOp, connectionSchema,
  type CatalogEntry, type IntegrationDefinition, type IntegrationRelationship,
} from "@freebirdai/dash-spec";
import { integrationFingerprint, type IntegrationRepository } from "./repository.js";

/** Import declarations only. Legacy `verified` flags are not traversal evidence. */
export const integrationFromCatalog = (entry: CatalogEntry): IntegrationDefinition => {
  const ops = new Map(entry.ops.map(op => [op.id, op]));
  const resources = entry.resources.length ? entry.resources : deriveResourceGraph(entry.ops).resources;
  const entities: IntegrationDefinition["entities"] = resources.map(resource => {
    const list = resource.listOp ? ops.get(resource.listOp) : undefined;
    const detail = resource.detailOp ? ops.get(resource.detailOp) : undefined;
    const fields = new Map([...(list?.fields ?? []), ...(detail?.fields ?? [])].map(field => [field.name, field]));
    const hasId = resource.idField && fields.has(resource.idField);
    return {
      id: resource.id, title: resource.title,
      ...(list?.description ? { description: list.description } : {}),
      identity: hasId ? [{ name: "id", field: resource.idField! }] : [],
      context: [],
      ...(resource.labelField && fields.has(resource.labelField) ? { labelField: resource.labelField } : {}),
      fields: [...fields.values()].map(field => ({
        ...field,
        id: `field-${integrationFingerprint(field.name).slice(0, 24)}`,
        label: field.label ?? entry.labels[field.name] ?? humanLabel(field.name),
        provenance: "declared" as const,
        visibility: field.name === resource.idField ? "advanced" as const : "normal" as const,
      })),
      ...(list ? { listOp: list.id } : {}),
      ...(hasId && detail && resource.detailParam ? { detail: { op: detail.id, inputs: [{ param: resource.detailParam, field: resource.idField! }] } } : {}),
      view: { fields: [], filters: [], related: [] },
    };
  });
  const relationships: IntegrationRelationship[] = [];
  for (const source of resources) for (const relation of source.relations) {
    const target = resources.find(resource => resource.id === relation.resource);
    if (!target) continue;
    const forward = {
      title: relation.title, cardinality: relation.cardinality,
      optional: true, visibility: "related" as const, status: "unverified" as const, evidence: [],
      plan: { kind: "unavailable" as const, reason: "This relationship needs its retrieval contract checked." },
    };
    const reverse = {
      ...forward, title: source.title,
      // Reverse uniqueness is not implied by a forward one-to-one lookup.
      cardinality: "many" as const,
      plan: { kind: "unavailable" as const, reason: "The reverse relationship has no verified retrieval contract." },
    };
    const mapped: IntegrationRelationship = {
      id: `relation-${integrationFingerprint([source.id, relation.id, target.id]).slice(0, 24)}`,
      source: source.id, target: target.id, role: relation.id,
      forward, reverse,
    };
    if (relation.cardinality === "one" && relation.localField && target.idField && target.detailOp && target.detailParam && relation.linkKind !== "array" && relation.linkKind !== "objectRef") {
      mapped.forward.plan = {
        kind: "request", op: target.detailOp,
        inputs: [{ param: target.detailParam, field: relation.localField }],
        matches: [{ source: relation.localField, target: target.idField, sourceArray: false, targetArray: false }],
        maxRequests: 1, maxRows: 1,
      };
      // A declared query input is a candidate, never evidence that filtering works.
      const query = source.listOp ? ops.get(source.listOp)?.params.find(param => param.in === "query" && param.name === relation.localField) : undefined;
      if (query && source.listOp) mapped.reverse.plan = {
        kind: "request", op: source.listOp,
        inputs: [{ param: query.name, field: target.idField }],
        matches: [{ source: target.idField, target: relation.localField, sourceArray: false, targetArray: false }],
        maxRequests: 1, maxRows: 100,
      };
    }
    relationships.push(mapped);
  }
  for (const entity of entities) entity.view.related = relationships.flatMap(relationship => [
    ...(relationship.source === entity.id ? [{ relationship: relationship.id, direction: "forward" as const }] : []),
    ...(relationship.target === entity.id ? [{ relationship: relationship.id, direction: "reverse" as const }] : []),
  ]);
  // Materialise inheritance so a later dialect edit cannot change this version.
  const declaredConnection = connectionSchema.parse({ id: entry.id, title: entry.title, kind: "rest", baseUrl: entry.baseUrl, auth: { type: "none" }, dialect: entry.dialect, ops: entry.ops });
  const operations = declaredConnection.ops.map(op => {
    const { auth: _auth, authRequired: _required, ...resolved } = resolveOp(declaredConnection, { ...op, timeFiltered: false });
    return { ...resolved, timeFiltered: false };
  });
  const structural = { title: entry.title, protocol: "rest" as const, entities, relationships, operations };
  const fingerprint = integrationFingerprint(structural);
  return integrationDefinitionSchema.parse({
    ...structural, id: entry.id, version: `import-${fingerprint.slice(0, 24)}`,
    schemaFingerprint: fingerprint, origin: "catalog-import", evidence: [],
  });
};

/** Additive and repeatable. Existing bindings and dashboards are never repointed. */
export const importCatalog = async (
  repository: IntegrationRepository, tenant: string, entries: readonly CatalogEntry[],
  connections: readonly { id: string; catalog?: string }[],
): Promise<{ imported: number; bound: number; errors: { id: string; message: string }[] }> => {
  let imported = 0;
  let bound = 0;
  const errors: { id: string; message: string }[] = [];
  for (const entry of entries) {
    try {
      const definition = integrationFromCatalog(entry);
      await repository.putVersion(tenant, definition);
      imported++;
      for (const connection of connections.filter(c => c.catalog === entry.id)) {
        if (await repository.getBinding(tenant, connection.id)) continue;
        await repository.bind(tenant, tenant, {
          connection: connection.id, integration: definition.id, version: definition.version,
          context: {}, disabledRelationships: [],
        }, 0);
        bound++;
      }
    } catch (error) {
      errors.push({ id: entry.id, message: error instanceof Error ? error.message : "Integration import failed." });
    }
  }
  return { imported, bound, errors };
};
