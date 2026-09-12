import {
  entityRefSchema, identityValueSchema, relationshipsForEntity,
  type Completeness, type ConnectionBinding, type EntityRef,
  type IntegrationDefinition, type IntegrationEntity,
} from "@freebirdai/dash-spec";
import { integrationFingerprint } from "./repository.js";

type Scalar = string | number | boolean;
type Row = Record<string, unknown>;
export interface EntityRecord { ref: EntityRef | null; values: Row }
export interface EntityRows { records: EntityRecord[]; completeness: Completeness }
export interface IntegrationReadContext {
  tenant: string;
  /** Changes whenever the caller's effective authorization changes. */
  authorizationRevision: string;
  maxRequests: number;
  maxRows: number;
  signal?: AbortSignal;
}
export interface IntegrationReadDeps {
  load(tenant: string, connection: string): Promise<{ definition: IntegrationDefinition; binding: ConnectionBinding } | null>;
  authorize(context: IntegrationReadContext, connection: string, entity: string, op: string): Promise<boolean>;
  /** Must enforce the supplied row bound at the adapter, including pagination. */
  fetch(context: IntegrationReadContext, connection: string, op: string, inputs: Record<string, Scalar>, maxRows: number): Promise<{ rows: Row[]; completeness: Completeness }>;
}
export class IntegrationReadError extends Error {
  constructor(readonly code: "missing" | "denied" | "unsupported" | "ambiguous" | "limit" | "invalid", message: string) { super(message); }
}
export type RelationshipResult =
  | { status: "ok"; data: EntityRows }
  | { status: "absent" | "missing" | "denied" | "unsupported" | "ambiguous" | "limit" | "invalid" | "unavailable"; message: string };

/** Own properties only; provider payloads must not traverse prototypes. */
export const readEntityField = (row: Row, path: string): unknown => {
  if (Object.hasOwn(row, path)) return row[path];
  let value: unknown = row;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Row)[part];
  }
  return value;
};
const scalar = (value: unknown): value is Scalar => identityValueSchema.safeParse(value).success;
const equal = (a: unknown, b: unknown) => scalar(a) && scalar(b) && typeof a === typeof b && a === b;
const asRows = (value: unknown): Row[] => (Array.isArray(value) ? value : [value])
  .filter((row): row is Row => row !== null && typeof row === "object" && !Array.isArray(row));

export const recordReference = (connection: string, entity: IntegrationEntity, row: Row): EntityRef | null => {
  if (!entity.identity.length) return null;
  const keys: Record<string, Scalar> = {};
  const context: Record<string, Scalar> = {};
  for (const [fields, output] of [[entity.identity, keys], [entity.context, context]] as const) {
    for (const key of fields) {
      const value = readEntityField(row, key.field);
      if (!scalar(value)) return null;
      output[key.name] = value;
    }
  }
  return { connection, entity: entity.id, keys, context };
};

/** One bounded interaction. All consumers use this executor, never provider-specific logic. */
export class IntegrationReadSession {
  private requests = 0;
  private pending = new Map<string, Promise<{ rows: Row[]; completeness: Completeness }>>();
  constructor(private readonly deps: IntegrationReadDeps, private readonly context: IntegrationReadContext) {
    if (!context.tenant || !context.authorizationRevision || !Number.isSafeInteger(context.maxRequests) || context.maxRequests < 1 || !Number.isSafeInteger(context.maxRows) || context.maxRows < 1) throw new Error("A scoped, bounded read context is required.");
  }

  private async model(connection: string, entityId: string) {
    const loaded = await this.deps.load(this.context.tenant, connection);
    if (!loaded || loaded.binding.connection !== connection || loaded.binding.integration !== loaded.definition.id || loaded.binding.version !== loaded.definition.version) throw new IntegrationReadError("missing", "This connection has no matching integration version.");
    const entity = loaded.definition.entities.find(item => item.id === entityId);
    if (!entity) throw new IntegrationReadError("missing", "This record type is not available.");
    return { ...loaded, entity };
  }

  private async request(connection: string, entity: string, version: string, op: string, inputs: Record<string, Scalar>, maxRows: number) {
    if (this.context.signal?.aborted) throw new IntegrationReadError("unsupported", "The read was cancelled.");
    if (!await this.deps.authorize(this.context, connection, entity, op)) throw new IntegrationReadError("denied", "You do not have access to these records.");
    const limit = Math.min(maxRows, this.context.maxRows);
    const key = integrationFingerprint([this.context.tenant, this.context.authorizationRevision, connection, version, entity, op, inputs, limit]);
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.requests >= this.context.maxRequests) throw new IntegrationReadError("limit", "This view reached its request limit.");
      this.requests++;
      pending = this.deps.fetch(this.context, connection, op, inputs, limit).then(result => ({
        rows: result.rows.slice(0, limit),
        completeness: result.rows.length > limit
          ? { status: "partial" as const, scope: "loaded-records" as const, reason: "The record limit was reached." }
          : result.completeness,
      }));
      this.pending.set(key, pending);
    }
    return pending;
  }

  async describe(connection: string, entityId: string) {
    const { definition, binding, entity } = await this.model(connection, entityId);
    const op = entity.listOp ?? entity.detail?.op;
    if (!op || !await this.deps.authorize(this.context, connection, entityId, op)) throw new IntegrationReadError("denied", "You do not have access to this record type.");
    const relationships = [];
    for (const relation of relationshipsForEntity(definition, entityId)) {
      if (binding.disabledRelationships.includes(relation.relationship) || relation.visibility === "hidden") continue;
      const target = definition.entities.find(item => item.id === relation.target)!;
      const targetOp = "op" in relation.plan ? relation.plan.op : target.listOp ?? target.detail?.op;
      if (targetOp && await this.deps.authorize(this.context, connection, target.id, targetOp)) relationships.push(relation);
    }
    return { entity, relationships, version: definition.version };
  }

  async list(connection: string, entityId: string, inputs: Record<string, Scalar> = {}): Promise<EntityRows> {
    const { definition, entity } = await this.model(connection, entityId);
    if (!entity.listOp) throw new IntegrationReadError("unsupported", "This API does not expose this collection.");
    const data = await this.request(connection, entity.id, definition.version, entity.listOp, inputs, this.context.maxRows);
    return { records: data.rows.map(values => ({ ref: recordReference(connection, entity, values), values })), completeness: data.completeness };
  }

  async read(input: EntityRef): Promise<EntityRecord> {
    const ref = entityRefSchema.parse(input);
    const { definition, entity } = await this.model(ref.connection, ref.entity);
    if (!entity.detail || !entity.identity.length) throw new IntegrationReadError("unsupported", "This API has no supported record lookup.");
    const supplied = new Map<string, Scalar>();
    for (const [fields, values] of [[entity.identity, ref.keys], [entity.context, ref.context]] as const) {
      if (Object.keys(values).length !== fields.length) throw new IntegrationReadError("invalid", "This record reference has incomplete or unexpected identity keys.");
      for (const key of fields) {
        const value = values[key.name];
        if (!scalar(value)) throw new IntegrationReadError("invalid", "This record needs its full identity and parent context.");
        supplied.set(key.field, value);
      }
    }
    const inputs: Record<string, Scalar> = {};
    for (const binding of entity.detail.inputs) {
      const value = supplied.get(binding.field);
      if (!scalar(value)) throw new IntegrationReadError("invalid", "The lookup is missing a required identity mapping.");
      inputs[binding.param] = value;
    }
    const data = await this.request(ref.connection, entity.id, definition.version, entity.detail.op, inputs, 2);
    if (data.rows.length > 1) throw new IntegrationReadError("ambiguous", "This identity returned more than one record.");
    if (data.completeness.status === "partial") throw new IntegrationReadError("limit", "The record lookup was incomplete; its identity cannot be established safely.");
    const values = data.rows[0];
    if (!values) throw new IntegrationReadError("missing", "This record was not found.");
    const actual = recordReference(ref.connection, entity, values);
    if (!actual || integrationFingerprint(actual) !== integrationFingerprint(ref)) throw new IntegrationReadError("invalid", "The returned record did not match the requested identity.");
    return { ref: actual, values };
  }

  async follow(ref: EntityRef, relationship: string, direction: "forward" | "reverse"): Promise<RelationshipResult> {
    try {
      const source = await this.read(ref);
      return await this.resolve(ref.connection, ref.entity, source.values, relationship, direction);
    } catch (error) { return this.failure(error); }
  }

  /** Enrich without joining or multiplying primary rows. Repeated keys share one request. */
  async enrich(connection: string, entity: string, rows: readonly Row[], relationship: string, direction: "forward" | "reverse" = "forward") {
    const output: { record: Row; related: RelationshipResult }[] = [];
    for (const row of rows.slice(0, this.context.maxRows)) output.push({ record: row, related: await this.resolve(connection, entity, row, relationship, direction) });
    return output;
  }

  private failure(error: unknown): RelationshipResult {
    return error instanceof IntegrationReadError ? { status: error.code, message: error.message }
      : { status: "unavailable", message: "The related records could not be loaded." };
  }

  private async resolve(connection: string, entityId: string, row: Row, relationshipId: string, directionName: "forward" | "reverse"): Promise<RelationshipResult> {
    try {
      const { definition, binding, entity } = await this.model(connection, entityId);
      const sourceOp = entity.listOp ?? entity.detail?.op;
      if (!sourceOp || !await this.deps.authorize(this.context, connection, entityId, sourceOp)) throw new IntegrationReadError("denied", "You do not have access to this record.");
      const relation = definition.relationships.find(item => item.id === relationshipId);
      if (!relation || (directionName === "forward" ? relation.source : relation.target) !== entity.id) throw new IntegrationReadError("invalid", "This relationship does not belong to this record.");
      if (binding.disabledRelationships.includes(relation.id)) throw new IntegrationReadError("denied", "This relationship is unavailable for this account.");
      if (directionName === "forward" && relation.discriminator && !equal(readEntityField(row, relation.discriminator.field), relation.discriminator.value)) return { status: "absent", message: "This record refers to a different record type." };
      const direction = relation[directionName];
      if (direction.status !== "verified") throw new IntegrationReadError("unsupported", "This relationship has not been verified.");
      const target = definition.entities.find(item => item.id === (directionName === "forward" ? relation.target : relation.source))!;
      const plan = direction.plan;
      if (plan.kind === "unavailable") throw new IntegrationReadError("unsupported", plan.reason);
      let rows: Row[];
      let completeness: Completeness;
      if (plan.kind === "embedded") {
        const op = target.detail?.op ?? target.listOp;
        if (!op || !await this.deps.authorize(this.context, connection, target.id, op)) throw new IntegrationReadError("denied", "You do not have access to this related record.");
        const embedded = readEntityField(row, plan.field);
        if (embedded === null || embedded === undefined) return { status: "absent", message: "No related record is set." };
        rows = asRows(embedded);
        completeness = { status: "unknown", scope: "loaded-records", reason: "The API embedded these records; collection completeness is not established." };
      } else {
        if (plan.matches.some(match => {
          const value = readEntityField(row, match.source);
          return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
        })) return { status: "absent", message: "No related record is set." };
        const combinations: Record<string, Scalar>[] = [{}];
        if (plan.kind === "request") {
          let arrayInput = false;
          for (const input of plan.inputs) {
            const value = readEntityField(row, input.field);
            if (value === null || value === undefined) return { status: "absent", message: "No related record is set." };
            if (Array.isArray(value)) {
              if (arrayInput || value.some(item => !scalar(item))) throw new IntegrationReadError("unsupported", "This array reference needs an explicit key mapping.");
              arrayInput = true;
              const distinct = [...new Set(value)] as Scalar[];
              const base = combinations.pop()!;
              for (const item of distinct) combinations.push({ ...base, [input.param]: item });
            } else {
              if (!scalar(value)) throw new IntegrationReadError("invalid", "This reference is not a supported identity value.");
              for (const item of combinations) item[input.param] = value;
            }
          }
          if (combinations.length > plan.maxRequests) throw new IntegrationReadError("limit", "This relationship exceeds its request limit.");
        }
        if (!combinations.length) return { status: "absent", message: "No related records are set." };
        rows = [];
        completeness = { status: "complete", scope: "query", reason: "All declared relationship queries were exhausted." };
        for (const inputs of combinations) {
          const result = await this.request(connection, target.id, definition.version, plan.op, inputs, direction.cardinality === "one" ? Math.max(2, plan.maxRows) : plan.maxRows);
          if (result.completeness.status === "partial" || (result.completeness.status === "unknown" && completeness.status !== "partial")) completeness = result.completeness;
          rows.push(...result.rows);
        }
        const matches = (candidate: Row) => plan.matches.every(match => {
          const left = readEntityField(row, match.source);
          const right = readEntityField(candidate, match.target);
          const a = match.sourceArray && Array.isArray(left) ? left : [left];
          const b = match.targetArray && Array.isArray(right) ? right : [right];
          return a.some(x => b.some(y => equal(x, y)));
        });
        if (plan.kind === "request" && rows.some(candidate => !matches(candidate))) throw new IntegrationReadError("invalid", "The API returned records outside this relationship.");
        rows = rows.filter(matches);
        if (direction.cardinality === "many" && rows.length > plan.maxRows) {
          rows = rows.slice(0, plan.maxRows);
          completeness = { status: "partial", scope: "loaded-records", reason: "The relationship record limit was reached." };
        }
      }
      if (direction.cardinality === "one" && rows.length > 1) throw new IntegrationReadError("ambiguous", "This reference matched more than one record.");
      if (direction.cardinality === "one" && completeness.status === "partial") throw new IntegrationReadError("limit", "The related record lookup was incomplete.");
      if (rows.length > this.context.maxRows) {
        rows = rows.slice(0, this.context.maxRows);
        completeness = { status: "partial", scope: "loaded-records", reason: "The relationship record limit was reached." };
      }
      if (direction.cardinality === "one" && !rows.length && completeness.status === "complete") return { status: "missing", message: "The related record was not found." };
      return { status: "ok", data: { records: rows.map(values => ({ ref: recordReference(connection, target, values), values })), completeness } };
    } catch (error) { return this.failure(error); }
  }
}
