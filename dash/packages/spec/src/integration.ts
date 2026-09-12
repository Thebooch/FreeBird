import { z } from "zod";
import { idSchema } from "./primitives.js";
import { mappedFieldSchema } from "./dialect.js";
import { opDefSchema } from "./connection.js";

/** Account data is never part of an integration definition. */
export const identityValueSchema = z.union([z.string().min(1), z.number().finite(), z.boolean()]);
const fieldPath = z.string().min(1).max(300).regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/);
const keyValues = z.record(idSchema, identityValueSchema);
export const entityRefSchema = z.object({
  connection: idSchema,
  entity: idSchema,
  keys: keyValues,
  context: keyValues.default({}),
}).strict();
export type EntityRef = z.infer<typeof entityRefSchema>;

export const completenessSchema = z.object({
  status: z.enum(["complete", "partial", "unknown"]),
  reason: z.string().min(1),
  scope: z.enum(["record", "query", "loaded-records"]),
  continuation: z.string().optional(),
}).strict();
export type Completeness = z.infer<typeof completenessSchema>;

export const capabilityEvidenceSchema = z.object({
  id: idSchema,
  claim: z.enum(["request", "extraction", "identity", "filter", "pagination", "relationship", "cardinality", "units", "intent"]),
  subject: z.string().min(1).max(200),
  status: z.enum(["unverified", "passed", "failed", "inconclusive", "stale"]),
  source: z.enum(["schema", "probe", "fixture"]),
  contractFingerprint: z.string().min(1),
  checkedAt: z.string().datetime().optional(),
  /** Counts only. Never store sampled account keys or response bodies here. */
  distinctCases: z.number().int().nonnegative().default(0),
  code: z.string().regex(/^[a-z0-9_-]+$/),
}).strict();
export type CapabilityEvidence = z.infer<typeof capabilityEvidenceSchema>;

const inputBindingSchema = z.object({ param: z.string().min(1), field: fieldPath }).strict();
const matchBindingSchema = z.object({
  source: fieldPath,
  target: fieldPath,
  sourceArray: z.boolean().default(false),
  targetArray: z.boolean().default(false),
}).strict();
/** Requests are named contracts, never arbitrary URLs provided by a caller. */
export const traversalPlanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("embedded"), field: fieldPath }).strict(),
  z.object({
    kind: z.literal("request"), op: idSchema,
    inputs: z.array(inputBindingSchema).max(20),
    matches: z.array(matchBindingSchema).min(1).max(20),
    maxRequests: z.number().int().min(1).max(100).default(1),
    maxRows: z.number().int().min(1).max(10000).default(100),
  }).strict(),
  z.object({
    kind: z.literal("bounded-match"), op: idSchema,
    matches: z.array(matchBindingSchema).min(1).max(20),
    maxRows: z.number().int().min(1).max(10000),
  }).strict(),
]);
export type TraversalPlan = z.infer<typeof traversalPlanSchema>;

const directionSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  cardinality: z.enum(["one", "many"]),
  optional: z.boolean().default(true),
  visibility: z.enum(["primary", "related", "hidden"]).default("related"),
  status: z.enum(["unverified", "verified", "contradicted"]).default("unverified"),
  evidence: z.array(idSchema).default([]),
  plan: traversalPlanSchema,
}).strict();

export const integrationRelationshipSchema = z.object({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  /** Roles distinguish e.g. assigned supplier from invoicing supplier. */
  role: idSchema,
  forward: directionSchema,
  reverse: directionSchema,
  discriminator: z.object({ field: fieldPath, value: identityValueSchema }).strict().optional(),
}).strict();
export type IntegrationRelationship = z.infer<typeof integrationRelationshipSchema>;

export const integrationEntitySchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  identity: z.array(z.object({ name: idSchema, field: fieldPath }).strict()).max(20),
  context: z.array(z.object({ name: idSchema, field: fieldPath }).strict()).max(20).default([]),
  labelField: fieldPath.optional(),
  fields: z.array(mappedFieldSchema.extend({
    id: idSchema,
    provenance: z.enum(["declared", "inferred", "manual"]).default("declared"),
    visibility: z.enum(["normal", "advanced", "hidden"]).default("normal"),
  }).strict()).max(10000),
  listOp: idSchema.optional(),
  detail: z.object({ op: idSchema, inputs: z.array(inputBindingSchema).min(1).max(20) }).strict().optional(),
  view: z.object({
    fields: z.array(idSchema).default([]),
    filters: z.array(idSchema).default([]),
    related: z.array(z.object({ relationship: idSchema, direction: z.enum(["forward", "reverse"]) }).strict()).default([]),
  }).strict().default({}),
}).strict();
export type IntegrationEntity = z.infer<typeof integrationEntitySchema>;

/** Deliberately no credentials, account identifiers, example values or arbitrary metadata. */
export const integrationDefinitionSchema = z.object({
  specVersion: z.literal(1).default(1),
  id: idSchema,
  version: z.string().min(1).max(100),
  title: z.string().min(1),
  protocol: z.enum(["rest", "graphql", "mcp"]),
  graphqlSchema: z.string().min(1).max(2000000).optional(),
  schemaFingerprint: z.string().min(1),
  origin: z.enum(["catalog-import", "prepared", "manual"]),
  /** Versioned read contracts. Auth is supplied by the private connection binding. */
  operations: z.array(opDefSchema.omit({ auth: true, authRequired: true }).strict()).max(10000).default([]),
  entities: z.array(integrationEntitySchema).max(2000),
  relationships: z.array(integrationRelationshipSchema).max(20000),
  evidence: z.array(capabilityEvidenceSchema).max(50000).default([]),
}).strict().superRefine((value, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const unique = (ids: string[], what: string) => {
    if (new Set(ids).size !== ids.length) problem(`Duplicate ${what}.`);
  };
  unique(value.entities.map(e => e.id), "entity id");
  unique(value.operations.map(op => op.id), "operation id");
  unique(value.relationships.map(r => r.id), "relationship id");
  unique(value.evidence.map(e => e.id), "evidence id");
  const entities = new Map(value.entities.map(e => [e.id, e]));
  const evidence = new Map(value.evidence.map(e => [e.id, e]));
  const operationIds = new Set(value.operations.map(op => op.id));
  for (const entity of value.entities) {
    for (const op of [entity.listOp, entity.detail?.op]) if (op && !operationIds.has(op)) problem(`Unknown entity operation ${op}.`);
    unique(entity.fields.map(f => f.id), `field id in ${entity.id}`);
    unique([...entity.identity, ...entity.context].map(k => k.name), `identity key in ${entity.id}`);
    const fields = new Set(entity.fields.map(f => f.name));
    for (const key of [...entity.identity, ...entity.context]) if (!fields.has(key.field)) problem(`Unknown identity field ${entity.id}.${key.field}.`);
    for (const field of [...entity.view.fields, ...entity.view.filters]) if (!entity.fields.some(f => f.id === field)) problem(`Unknown view field ${entity.id}.${field}.`);
    for (const link of entity.view.related) {
      const relation = value.relationships.find(r => r.id === link.relationship);
      if (!relation || (link.direction === "forward" ? relation.source : relation.target) !== entity.id) problem(`Invalid related view ${entity.id}.${link.relationship}.`);
    }
  }
  for (const relationship of value.relationships) {
    if (!entities.has(relationship.source) || !entities.has(relationship.target)) problem(`Unknown relationship entity: ${relationship.id}.`);
    for (const name of ["forward", "reverse"] as const) {
      const direction = relationship[name];
      if ("op" in direction.plan && !operationIds.has(direction.plan.op)) problem(`Unknown traversal operation ${direction.plan.op}.`);
      const subject = `${relationship.id}:${name}`;
      const proofs = direction.evidence.map(id => evidence.get(id));
      if (proofs.some(p => !p)) problem(`Unknown evidence for ${subject}.`);
      if (direction.status === "verified" && !proofs.some(p => p?.claim === "relationship" && p.subject === subject && p.status === "passed" && p.source !== "schema" && p.distinctCases > 0 && p.contractFingerprint === value.schemaFingerprint)) problem(`Verified traversal ${subject} requires current relationship evidence.`);
      if (direction.status === "verified" && direction.plan.kind === "unavailable") problem(`Unavailable traversal ${subject} cannot be verified.`);
    }
  }
});
export type IntegrationDefinition = z.infer<typeof integrationDefinitionSchema>;

export const connectionBindingSchema = z.object({
  connection: idSchema,
  integration: idSchema,
  version: z.string().min(1),
  revision: z.number().int().positive(),
  /** Account values belong here, never in the published definition. */
  context: keyValues.default({}),
  disabledRelationships: z.array(idSchema).default([]),
}).strict();
export type ConnectionBinding = z.infer<typeof connectionBindingSchema>;

/** All record surfaces use the same graph. It never performs reads. */
export const relationshipsForEntity = (definition: IntegrationDefinition, entity: string) =>
  definition.relationships.flatMap(relationship => [
    ...(relationship.source === entity ? [{ relationship: relationship.id, direction: "forward" as const, target: relationship.target, ...relationship.forward }] : []),
    ...(relationship.target === entity ? [{ relationship: relationship.id, direction: "reverse" as const, target: relationship.source, ...relationship.reverse }] : []),
  ]);
