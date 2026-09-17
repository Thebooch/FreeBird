import {
  entityRefSchema,
  identityValueSchema,
  relationshipsForEntity,
  humanLabel,
  type RecordSummary,
  type RecordPageData,
  type RelatedRecordViews,
  type EntityCollectionView,
  type EntityCatalogEntry,
  type Completeness,
  type ConnectionBinding,
  type EntityRef,
  type IntegrationDefinition,
  type IntegrationEntity,
} from "@freebirdai/dash-spec";
import { integrationFingerprint } from "./repository.js";

type Scalar = string | number | boolean;
type Row = Record<string, unknown>;
export interface EntityRecord {
  ref: EntityRef | null;
  values: Row;
}
export interface EntityRows {
  records: EntityRecord[];
  completeness: Completeness;
}
export interface IntegrationReadContext {
  tenant: string;
  /** Changes whenever the caller's effective authorization changes. */
  authorizationRevision: string;
  maxRequests: number;
  maxRows: number;
  /** Set by the session; adapters must not substitute a newer binding mid-read. */
  binding?: Pick<ConnectionBinding, "integration" | "version" | "revision">;
  signal?: AbortSignal;
}
export interface IntegrationReadDeps {
  load(
    tenant: string,
    connection: string,
  ): Promise<{ definition: IntegrationDefinition; binding: ConnectionBinding } | null>;
  authorize(
    context: IntegrationReadContext,
    connection: string,
    entity: string,
    op: string,
  ): Promise<boolean>;
  /** Must enforce the supplied row bound at the adapter, including pagination. */
  fetch(
    context: IntegrationReadContext,
    connection: string,
    op: string,
    inputs: Record<string, Scalar>,
    maxRows: number,
  ): Promise<{ rows: Row[]; completeness: Completeness }>;
}
export class IntegrationReadError extends Error {
  constructor(
    readonly code: "missing" | "denied" | "unsupported" | "ambiguous" | "limit" | "invalid",
    message: string,
  ) {
    super(message);
  }
}
export type RelationshipResult =
  | { status: "ok"; data: EntityRows }
  | {
      status:
        | "absent"
        | "missing"
        | "denied"
        | "unsupported"
        | "ambiguous"
        | "limit"
        | "invalid"
        | "unavailable";
      message: string;
    };

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
const equal = (a: unknown, b: unknown) =>
  scalar(a) && scalar(b) && typeof a === typeof b && a === b;
const asRows = (value: unknown): Row[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (row): row is Row => row !== null && typeof row === "object" && !Array.isArray(row),
  );

export const recordReference = (
  connection: string,
  entity: IntegrationEntity,
  row: Row,
): EntityRef | null => {
  if (!entity.identity.length) return null;
  const keys: Record<string, Scalar> = {};
  const context: Record<string, Scalar> = {};
  for (const [fields, output] of [
    [entity.identity, keys],
    [entity.context, context],
  ] as const) {
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
  private models = new Map<string, ReturnType<IntegrationReadDeps["load"]>>();
  constructor(
    private readonly deps: IntegrationReadDeps,
    private readonly context: IntegrationReadContext,
  ) {
    if (
      !context.tenant ||
      !context.authorizationRevision ||
      !Number.isSafeInteger(context.maxRequests) ||
      context.maxRequests < 1 ||
      !Number.isSafeInteger(context.maxRows) ||
      context.maxRows < 1
    )
      throw new Error("A scoped, bounded read context is required.");
  }

  private async connectionModel(connection: string) {
    let model = this.models.get(connection);
    if (!model) {
      model = this.deps
        .load(this.context.tenant, connection)
        .then((value) => (value ? structuredClone(value) : null));
      this.models.set(connection, model);
    }
    const loaded = await model;
    if (
      !loaded ||
      loaded.binding.connection !== connection ||
      loaded.binding.integration !== loaded.definition.id ||
      loaded.binding.version !== loaded.definition.version
    )
      throw new IntegrationReadError(
        "missing",
        "This connection has no matching integration version.",
      );
    return loaded;
  }

  private async model(connection: string, entityId: string) {
    const loaded = await this.connectionModel(connection);
    const entity = loaded.definition.entities.find((item) => item.id === entityId);
    if (!entity) throw new IntegrationReadError("missing", "This record type is not available.");
    return { ...loaded, entity };
  }

  private async request(
    connection: string,
    entity: string,
    binding: ConnectionBinding,
    op: string,
    inputs: Record<string, Scalar>,
    maxRows: number,
  ) {
    if (this.context.signal?.aborted)
      throw new IntegrationReadError("unsupported", "The read was cancelled.");
    if (!(await this.deps.authorize(this.context, connection, entity, op)))
      throw new IntegrationReadError("denied", "You do not have access to these records.");
    const limit = Math.min(maxRows, this.context.maxRows);
    const key = integrationFingerprint([
      this.context.tenant,
      this.context.authorizationRevision,
      connection,
      binding.integration,
      binding.version,
      binding.revision,
      entity,
      op,
      inputs,
      limit,
    ]);
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.requests >= this.context.maxRequests)
        throw new IntegrationReadError("limit", "This view reached its request limit.");
      this.requests++;
      pending = this.deps
        .fetch(
          {
            ...this.context,
            binding: {
              integration: binding.integration,
              version: binding.version,
              revision: binding.revision,
            },
          },
          connection,
          op,
          inputs,
          limit,
        )
        .then((result) => ({
          rows: result.rows.slice(0, limit),
          completeness:
            result.rows.length > limit
              ? {
                  status: "partial" as const,
                  scope: "loaded-records" as const,
                  reason: "The record limit was reached.",
                }
              : result.completeness,
        }));
      this.pending.set(key, pending);
    }
    return pending;
  }

  async describe(connection: string, entityId: string) {
    const { definition, binding, entity } = await this.model(connection, entityId);
    if (!(await this.canDescribe(connection, entity)))
      throw new IntegrationReadError("denied", "You do not have access to this record type.");
    const relationships = [];
    for (const relation of relationshipsForEntity(definition, entityId)) {
      if (
        binding.disabledRelationships.includes(relation.relationship) ||
        relation.visibility === "hidden"
      )
        continue;
      const target = definition.entities.find((item) => item.id === relation.target)!;
      const allowed =
        "op" in relation.plan
          ? await this.deps.authorize(this.context, connection, target.id, relation.plan.op)
          : await this.canDescribe(connection, target);
      if (allowed) relationships.push(relation);
    }
    return { entity, relationships, version: definition.version };
  }

  /** Describing a type does not grant access to its collection or detail operation. */
  private async canDescribe(connection: string, entity: IntegrationEntity) {
    for (const op of new Set([entity.listOp, entity.detail?.op]))
      if (op && (await this.deps.authorize(this.context, connection, entity.id, op))) return true;
    return false;
  }

  async discover(connection: string): Promise<EntityCatalogEntry[]> {
    const { definition } = await this.connectionModel(connection);
    const result: EntityCatalogEntry[] = [];
    for (const entity of definition.entities) {
      try {
        const browsable = Boolean(
          entity.listOp &&
          (await this.deps.authorize(this.context, connection, entity.id, entity.listOp)),
        );
        if (!browsable && !(await this.canDescribe(connection, entity))) continue;
        result.push({
          id: entity.id,
          title: entity.title,
          description: entity.description,
          browsable,
        });
      } catch (error) {
        if (!(error instanceof IntegrationReadError && error.code === "denied")) throw error;
      }
    }
    return result;
  }

  private summary(
    entity: IntegrationEntity,
    record: EntityRecord,
    definition: IntegrationDefinition,
  ): RecordSummary {
    const identities = new Set([...entity.identity, ...entity.context].map((key) => key.field));
    const referencePaths = new Set(
      definition.relationships
        .filter((relation) => relation.source === entity.id)
        .flatMap((relation) =>
          "matches" in relation.forward.plan
            ? relation.forward.plan.matches.map((match) => match.source)
            : [],
        ),
    );
    const title = entity.labelField ? readEntityField(record.values, entity.labelField) : undefined;
    // Keys stay in advanced details; an unresolved ID never masquerades as a name.
    const readableTitle =
      typeof title === "string" &&
      title.trim() &&
      !identities.has(entity.labelField!) &&
      !referencePaths.has(entity.labelField!) &&
      entity.fields.some(
        (field) => field.name === entity.labelField && field.visibility !== "hidden",
      )
        ? title
        : entity.title;
    const visible = entity.fields.filter((field) => field.visibility !== "hidden");
    const ordered = entity.view.fields.length
      ? [
          ...entity.view.fields.flatMap((id) => visible.filter((field) => field.id === id)),
          ...visible.filter((field) => !entity.view.fields.includes(field.id)),
        ]
      : visible;
    return {
      ref: entity.detail ? record.ref : null,
      title: readableTitle,
      fields: ordered.map((field) => ({
        id: field.id,
        label: field.label ?? humanLabel(field.name),
        description: field.description,
        format: field.format,
        value: readEntityField(record.values, field.name) ?? null,
        advanced:
          field.visibility === "advanced" ||
          identities.has(field.name) ||
          referencePaths.has(field.name) ||
          Boolean(entity.view.fields.length && !entity.view.fields.includes(field.id)),
      })),
    };
  }

  private filters(entity: IntegrationEntity, records: RecordSummary[]) {
    return entity.view.filters.flatMap((id) => {
      const field = entity.fields.find((item) => item.id === id);
      if (
        !field ||
        field.visibility !== "normal" ||
        [...entity.identity, ...entity.context].some((key) => key.field === field.name) ||
        records.some((record) => record.fields.some((item) => item.id === id && item.advanced))
      )
        return [];
      return [
        { field: id, label: field.label ?? humanLabel(field.name), description: field.description },
      ];
    });
  }

  private forwardReferences(
    entity: IntegrationEntity,
    relationships: Awaited<ReturnType<IntegrationReadSession["describe"]>>["relationships"],
  ) {
    const preferred = (relation: (typeof relationships)[number]) =>
      relation.visibility === "primary" ||
      entity.view.related.some(
        (item) =>
          item.direction === relation.direction && item.relationship === relation.relationship,
      );
    return relationships
      .filter((item) => item.direction === "forward" && item.cardinality === "one")
      .sort((a, b) => Number(preferred(b)) - Number(preferred(a)));
  }

  async browse(connection: string, entityId: string): Promise<EntityCollectionView> {
    const description = await this.describe(connection, entityId);
    const { definition } = await this.connectionModel(connection);
    const data = await this.list(connection, entityId);
    const records: RecordSummary[] = [];
    const references = this.forwardReferences(description.entity, description.relationships);
    for (const record of data.records) {
      const summary = this.summary(description.entity, record, definition);
      // Repeated references share the session cache. The session request bound
      // applies to the entire collection, not independently to each row.
      for (const relation of references.slice(0, 3)) {
        const related =
          relation.status === "verified" && relation.plan.kind !== "unavailable"
            ? await this.relatedView(
                connection,
                relation.target,
                await this.resolve(
                  connection,
                  entityId,
                  record.values,
                  relation.relationship,
                  "forward",
                ),
              )
            : { status: "unsupported" as const, records: [] };
        const target = related.records[0];
        summary.fields.unshift({
          id: `reference-${relation.relationship}`,
          label: relation.title,
          description: relation.description,
          value: target?.title ?? (related.status === "absent" ? "Not set" : "Not available"),
          advanced: false,
          ...(target?.ref ? { reference: target.ref } : {}),
        });
      }
      records.push(summary);
    }
    return {
      entity: entityId,
      title: description.entity.title,
      description: description.entity.description,
      version: description.version,
      records,
      filters: this.filters(description.entity, records),
      completeness: data.completeness,
    };
  }

  private async relatedView(
    connection: string,
    targetId: string,
    result: RelationshipResult,
  ): Promise<RelatedRecordViews> {
    if (result.status !== "ok")
      return { status: result.status, records: [], message: result.message };
    const { entity, definition } = await this.model(connection, targetId);
    const records = result.data.records.map((record) => this.summary(entity, record, definition));
    return {
      status: "ok",
      records,
      filters: this.filters(entity, records),
      completeness: result.data.completeness,
    };
  }

  async related(
    ref: EntityRef,
    relationship: string,
    direction: "forward" | "reverse",
  ): Promise<RelatedRecordViews> {
    const description = await this.describe(ref.connection, ref.entity);
    const relation = description.relationships.find(
      (item) => item.relationship === relationship && item.direction === direction,
    );
    if (!relation)
      return { status: "denied", records: [], message: "This relationship is unavailable." };
    return this.relatedView(
      ref.connection,
      relation.target,
      await this.follow(ref, relationship, direction),
    );
  }

  async page(ref: EntityRef): Promise<RecordPageData> {
    const { entity, relationships, version } = await this.describe(ref.connection, ref.entity);
    const { definition } = await this.connectionModel(ref.connection);
    const record = await this.read(ref);
    const summary = this.summary(entity, record, definition);
    const references: RecordPageData["references"] = [];
    const forward = this.forwardReferences(entity, relationships);
    for (const relation of forward.slice(0, 8)) {
      const result =
        relation.status === "verified" && relation.plan.kind !== "unavailable"
          ? await this.relatedView(
              ref.connection,
              relation.target,
              await this.resolve(
                ref.connection,
                ref.entity,
                record.values,
                relation.relationship,
                "forward",
              ),
            )
          : {
              status: "unsupported" as const,
              records: [],
              message: "This reference has not been verified yet.",
            };
      references.push({ relationship: relation.relationship, result });
    }
    return {
      ...summary,
      version,
      entityTitle: entity.title,
      description: entity.description,
      references,
      relationships: relationships.map((relation) => ({
        relationship: relation.relationship,
        direction: relation.direction,
        title: relation.title,
        description: relation.description,
        cardinality: relation.cardinality,
        available: relation.status === "verified" && relation.plan.kind !== "unavailable",
        preferred:
          relation.visibility === "primary" ||
          entity.view.related.some(
            (item) =>
              item.relationship === relation.relationship && item.direction === relation.direction,
          ),
      })),
    };
  }

  async list(
    connection: string,
    entityId: string,
    inputs: Record<string, Scalar> = {},
  ): Promise<EntityRows> {
    const { binding, entity } = await this.model(connection, entityId);
    if (!entity.listOp)
      throw new IntegrationReadError("unsupported", "This API does not expose this collection.");
    const data = await this.request(
      connection,
      entity.id,
      binding,
      entity.listOp,
      inputs,
      this.context.maxRows,
    );
    return {
      records: data.rows.map((values) => ({
        ref: recordReference(connection, entity, values),
        values,
      })),
      completeness: data.completeness,
    };
  }

  async read(input: EntityRef): Promise<EntityRecord> {
    const ref = entityRefSchema.parse(input);
    const { binding, entity } = await this.model(ref.connection, ref.entity);
    if (!entity.detail || !entity.identity.length)
      throw new IntegrationReadError("unsupported", "This API has no supported record lookup.");
    const supplied = new Map<string, Scalar>();
    for (const [fields, values] of [
      [entity.identity, ref.keys],
      [entity.context, ref.context],
    ] as const) {
      if (Object.keys(values).length !== fields.length)
        throw new IntegrationReadError(
          "invalid",
          "This record reference has incomplete or unexpected identity keys.",
        );
      for (const key of fields) {
        const value = values[key.name];
        if (!scalar(value))
          throw new IntegrationReadError(
            "invalid",
            "This record needs its full identity and parent context.",
          );
        supplied.set(key.field, value);
      }
    }
    const inputs: Record<string, Scalar> = {};
    for (const binding of entity.detail.inputs) {
      const value = supplied.get(binding.field);
      if (!scalar(value))
        throw new IntegrationReadError(
          "invalid",
          "The lookup is missing a required identity mapping.",
        );
      inputs[binding.param] = value;
    }
    const data = await this.request(
      ref.connection,
      entity.id,
      binding,
      entity.detail.op,
      inputs,
      2,
    );
    if (data.rows.length > 1)
      throw new IntegrationReadError("ambiguous", "This identity returned more than one record.");
    if (data.completeness.status === "partial")
      throw new IntegrationReadError(
        "limit",
        "The record lookup was incomplete; its identity cannot be established safely.",
      );
    const values = data.rows[0];
    if (!values) throw new IntegrationReadError("missing", "This record was not found.");
    const actual = recordReference(ref.connection, entity, values);
    if (!actual || integrationFingerprint(actual) !== integrationFingerprint(ref))
      throw new IntegrationReadError(
        "invalid",
        "The returned record did not match the requested identity.",
      );
    return { ref: actual, values };
  }

  async follow(
    ref: EntityRef,
    relationship: string,
    direction: "forward" | "reverse",
  ): Promise<RelationshipResult> {
    try {
      const source = await this.read(ref);
      return await this.resolve(ref.connection, ref.entity, source.values, relationship, direction);
    } catch (error) {
      return this.failure(error);
    }
  }

  /** Server preparation only. Uses the same bounds, matching and authorization as reads.
   * Never expose this method through consumer routes: candidates are not usable capabilities.
   */
  async probeRelationship(
    connection: string,
    entity: string,
    row: Row,
    relationship: string,
    direction: "forward" | "reverse",
  ): Promise<RelationshipResult> {
    return this.resolve(connection, entity, row, relationship, direction, true);
  }

  /** Enrich without joining or multiplying primary rows. Repeated keys share one request. */
  async enrich(
    connection: string,
    entity: string,
    rows: readonly Row[],
    relationship: string,
    direction: "forward" | "reverse" = "forward",
  ) {
    const output: { record: Row; related: RelationshipResult }[] = [];
    for (const row of rows.slice(0, this.context.maxRows))
      output.push({
        record: row,
        related: await this.resolve(connection, entity, row, relationship, direction),
      });
    return output;
  }

  private failure(error: unknown): RelationshipResult {
    return error instanceof IntegrationReadError
      ? { status: error.code, message: error.message }
      : { status: "unavailable", message: "The related records could not be loaded." };
  }

  private async resolve(
    connection: string,
    entityId: string,
    row: Row,
    relationshipId: string,
    directionName: "forward" | "reverse",
    preparation = false,
  ): Promise<RelationshipResult> {
    try {
      const { definition, binding, entity } = await this.model(connection, entityId);
      if (!(await this.canDescribe(connection, entity)))
        throw new IntegrationReadError("denied", "You do not have access to this record.");
      const relation = definition.relationships.find((item) => item.id === relationshipId);
      if (
        !relation ||
        (directionName === "forward" ? relation.source : relation.target) !== entity.id
      )
        throw new IntegrationReadError(
          "invalid",
          "This relationship does not belong to this record.",
        );
      if (binding.disabledRelationships.includes(relation.id))
        throw new IntegrationReadError(
          "denied",
          "This relationship is unavailable for this account.",
        );
      if (
        directionName === "forward" &&
        relation.discriminator &&
        !equal(readEntityField(row, relation.discriminator.field), relation.discriminator.value)
      )
        return { status: "absent", message: "This record refers to a different record type." };
      const direction = relation[directionName];
      if (!preparation && direction.status !== "verified")
        throw new IntegrationReadError("unsupported", "This relationship has not been verified.");
      const target = definition.entities.find(
        (item) => item.id === (directionName === "forward" ? relation.target : relation.source),
      )!;
      const plan = direction.plan;
      if (plan.kind === "unavailable") throw new IntegrationReadError("unsupported", plan.reason);
      let rows: Row[];
      let completeness: Completeness;
      if (plan.kind === "embedded") {
        if (!(await this.canDescribe(connection, target)))
          throw new IntegrationReadError(
            "denied",
            "You do not have access to this related record.",
          );
        const embedded = readEntityField(row, plan.field);
        if (embedded === null || embedded === undefined)
          return { status: "absent", message: "No related record is set." };
        rows = asRows(embedded);
        completeness = {
          status: "unknown",
          scope: "loaded-records",
          reason: "The API embedded these records; collection completeness is not established.",
        };
      } else {
        if (
          plan.matches.some((match) => {
            const value = readEntityField(row, match.source);
            return (
              value === null || value === undefined || (Array.isArray(value) && value.length === 0)
            );
          })
        )
          return { status: "absent", message: "No related record is set." };
        const combinations: Record<string, Scalar>[] = [{}];
        if (plan.kind === "request") {
          let arrayInput = false;
          for (const input of plan.inputs) {
            const value = readEntityField(row, input.field);
            if (value === null || value === undefined)
              return { status: "absent", message: "No related record is set." };
            if (Array.isArray(value)) {
              if (arrayInput || value.some((item) => !scalar(item)))
                throw new IntegrationReadError(
                  "unsupported",
                  "This array reference needs an explicit key mapping.",
                );
              arrayInput = true;
              const distinct = [...new Set(value)] as Scalar[];
              const base = combinations.pop()!;
              for (const item of distinct) combinations.push({ ...base, [input.param]: item });
            } else {
              if (!scalar(value))
                throw new IntegrationReadError(
                  "invalid",
                  "This reference is not a supported identity value.",
                );
              for (const item of combinations) item[input.param] = value;
            }
          }
          if (combinations.length > plan.maxRequests)
            throw new IntegrationReadError("limit", "This relationship exceeds its request limit.");
        }
        if (!combinations.length)
          return { status: "absent", message: "No related records are set." };
        rows = [];
        completeness = {
          status: "complete",
          scope: "query",
          reason: "All declared relationship queries were exhausted.",
        };
        for (const inputs of combinations) {
          const result = await this.request(
            connection,
            target.id,
            binding,
            plan.op,
            inputs,
            direction.cardinality === "one" ? Math.max(2, plan.maxRows) : plan.maxRows,
          );
          if (
            result.completeness.status === "partial" ||
            (result.completeness.status === "unknown" && completeness.status !== "partial")
          )
            completeness = result.completeness;
          rows.push(...result.rows);
        }
        const matches = (candidate: Row) =>
          (directionName !== "reverse" ||
            !relation.discriminator ||
            equal(
              readEntityField(candidate, relation.discriminator.field),
              relation.discriminator.value,
            )) &&
          plan.matches.every((match) => {
            const left = readEntityField(row, match.source);
            const right = readEntityField(candidate, match.target);
            const a = match.sourceArray && Array.isArray(left) ? left : [left];
            const b = match.targetArray && Array.isArray(right) ? right : [right];
            return a.some((x) => b.some((y) => equal(x, y)));
          });
        if (plan.kind === "request" && rows.some((candidate) => !matches(candidate)))
          throw new IntegrationReadError(
            "invalid",
            "The API returned records outside this relationship.",
          );
        rows = rows.filter(matches);
        if (direction.cardinality === "many" && rows.length > plan.maxRows) {
          rows = rows.slice(0, plan.maxRows);
          completeness = {
            status: "partial",
            scope: "loaded-records",
            reason: "The relationship record limit was reached.",
          };
        }
      }
      if (direction.cardinality === "one" && rows.length > 1)
        throw new IntegrationReadError("ambiguous", "This reference matched more than one record.");
      if (direction.cardinality === "one" && completeness.status === "partial")
        throw new IntegrationReadError("limit", "The related record lookup was incomplete.");
      if (rows.length > this.context.maxRows) {
        rows = rows.slice(0, this.context.maxRows);
        completeness = {
          status: "partial",
          scope: "loaded-records",
          reason: "The relationship record limit was reached.",
        };
      }
      if (direction.cardinality === "one" && !rows.length && completeness.status === "complete")
        return { status: "missing", message: "The related record was not found." };
      return {
        status: "ok",
        data: {
          records: rows.map((values) => ({
            ref: recordReference(connection, target, values),
            values,
          })),
          completeness,
        },
      };
    } catch (error) {
      return this.failure(error);
    }
  }
}
