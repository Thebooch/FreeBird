import { createHash, randomUUID } from "node:crypto";
import { Kysely, sql } from "kysely";
import { z } from "zod";
import {
  connectionBindingSchema,
  integrationDefinitionSchema,
  capabilityEvidenceSchema,
  preparationEstimateSchema,
  preparationJobSchema,
  type PreparationJob,
  type ConnectionBinding,
  type IntegrationDefinition,
} from "@freebirdai/dash-spec";

const statements = [
  `CREATE TABLE IF NOT EXISTS dash_integration_version (
    owner TEXT NOT NULL, integration TEXT NOT NULL, version TEXT NOT NULL,
    fingerprint TEXT NOT NULL, definition JSONB NOT NULL,
    PRIMARY KEY (owner, integration, version))`,
  `CREATE TABLE IF NOT EXISTS dash_integration_binding (
    tenant TEXT NOT NULL, connection TEXT NOT NULL, owner TEXT NOT NULL,
    integration TEXT NOT NULL, version TEXT NOT NULL, revision INTEGER NOT NULL,
    binding JSONB NOT NULL, PRIMARY KEY (tenant, connection),
    FOREIGN KEY (owner, integration, version) REFERENCES dash_integration_version(owner, integration, version))`,
  `CREATE TABLE IF NOT EXISTS dash_integration_job (
    tenant TEXT NOT NULL, id TEXT NOT NULL, integration TEXT NOT NULL,
    revision INTEGER NOT NULL, state TEXT NOT NULL, job JSONB NOT NULL,
    lease_token TEXT, lease_until BIGINT,
    PRIMARY KEY (tenant, id))`,
  `CREATE TABLE IF NOT EXISTS dash_integration_check (
    tenant TEXT NOT NULL, job_id TEXT NOT NULL, capability TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, result JSONB,
    PRIMARY KEY (tenant, job_id, capability),
    FOREIGN KEY (tenant, job_id) REFERENCES dash_integration_job(tenant, id))`,
];

const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, ordered(item)]),
        )
      : value;
export const integrationFingerprint = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");

export class IntegrationConflict extends Error {}

export {
  preparationEstimateSchema,
  preparationJobSchema,
  type PreparationJob,
} from "@freebirdai/dash-spec";
export const preparationCheckSchema = z
  .object({
    capability: z.string().min(1),
    attempts: z.number().int().min(0).max(3),
    result: z.array(capabilityEvidenceSchema).nullable(),
  })
  .strict();
export type PreparationCheck = z.infer<typeof preparationCheckSchema>;

/** No implicit tenant: every access must carry the authenticated scope. */
const scope = (value: string): string => {
  if (!value.trim()) throw new Error("An integration scope is required.");
  return value;
};

export class IntegrationRepository {
  constructor(readonly db: Kysely<never>) {}

  async migrate(): Promise<void> {
    for (const statement of statements) await sql.raw(statement).execute(this.db);
  }

  async putVersion(owner: string, input: IntegrationDefinition): Promise<void> {
    scope(owner);
    const definition = integrationDefinitionSchema.parse(input);
    const fingerprint = integrationFingerprint(definition);
    await this.db.transaction().execute(async (trx) => {
      await sql`INSERT INTO dash_integration_version (owner, integration, version, fingerprint, definition)
        VALUES (${owner}, ${definition.id}, ${definition.version}, ${fingerprint}, ${JSON.stringify(definition)}::jsonb)
        ON CONFLICT DO NOTHING`.execute(trx);
      const stored = await sql<{
        fingerprint: string;
      }>`SELECT fingerprint FROM dash_integration_version
        WHERE owner = ${owner} AND integration = ${definition.id} AND version = ${definition.version}`.execute(
        trx,
      );
      if (stored.rows[0]?.fingerprint !== fingerprint)
        throw new IntegrationConflict("An integration version is immutable; create a new version.");
    });
  }

  async getVersion(
    owner: string,
    integration: string,
    version: string,
  ): Promise<IntegrationDefinition | null> {
    scope(owner);
    const result = await sql<{
      definition: unknown;
    }>`SELECT definition FROM dash_integration_version
      WHERE owner = ${owner} AND integration = ${integration} AND version = ${version}`.execute(
      this.db,
    );
    return result.rows[0] ? integrationDefinitionSchema.parse(result.rows[0].definition) : null;
  }

  async listVersions(owner: string): Promise<IntegrationDefinition[]> {
    scope(owner);
    const result = await sql<{
      definition: unknown;
    }>`SELECT definition FROM dash_integration_version
      WHERE owner = ${owner} ORDER BY integration, version`.execute(this.db);
    return result.rows.map((row) => integrationDefinitionSchema.parse(row.definition));
  }

  async getBinding(
    tenant: string,
    connection: string,
  ): Promise<{ owner: string; binding: ConnectionBinding } | null> {
    scope(tenant);
    const result = await sql<{
      owner: string;
      binding: unknown;
    }>`SELECT owner, binding FROM dash_integration_binding
      WHERE tenant = ${tenant} AND connection = ${connection}`.execute(this.db);
    const row = result.rows[0];
    return row ? { owner: row.owner, binding: connectionBindingSchema.parse(row.binding) } : null;
  }

  async bind(
    tenant: string,
    owner: string,
    input: Omit<ConnectionBinding, "revision">,
    expectedRevision: number,
  ): Promise<ConnectionBinding> {
    scope(tenant);
    scope(owner);
    // Shared publication is a separate service. Private definitions never cross tenants.
    if (owner !== tenant)
      throw new Error("A private integration cannot be bound in another tenant.");
    const binding = connectionBindingSchema.parse({ ...input, revision: expectedRevision + 1 });
    const encoded = JSON.stringify(binding);
    if (expectedRevision === 0) {
      const inserted = await sql<{ revision: number }>`INSERT INTO dash_integration_binding
        (tenant, connection, owner, integration, version, revision, binding)
        VALUES (${tenant}, ${binding.connection}, ${owner}, ${binding.integration}, ${binding.version}, 1, ${encoded}::jsonb)
        ON CONFLICT DO NOTHING RETURNING revision`.execute(this.db);
      if (!inserted.rows.length) throw new IntegrationConflict("Connection binding changed.");
    } else {
      const updated = await sql<{ revision: number }>`UPDATE dash_integration_binding SET
        owner = ${owner}, integration = ${binding.integration}, version = ${binding.version},
        revision = ${binding.revision}, binding = ${encoded}::jsonb
        WHERE tenant = ${tenant} AND connection = ${binding.connection} AND revision = ${expectedRevision}
        RETURNING revision`.execute(this.db);
      if (!updated.rows.length) throw new IntegrationConflict("Connection binding changed.");
    }
    return binding;
  }

  async unbind(tenant: string, connection: string, expectedRevision: number): Promise<void> {
    scope(tenant);
    const removed = await sql<{ connection: string }>`DELETE FROM dash_integration_binding
      WHERE tenant = ${tenant} AND connection = ${connection} AND revision = ${expectedRevision}
      RETURNING connection`.execute(this.db);
    if (!removed.rows.length) throw new IntegrationConflict("Connection binding changed.");
  }

  async createJob(
    tenant: string,
    integration: string,
    estimate: z.infer<typeof preparationEstimateSchema>,
    target?: PreparationJob["target"],
  ): Promise<PreparationJob> {
    scope(tenant);
    const job = preparationJobSchema.parse({
      id: randomUUID(),
      createdAt: Date.now(),
      integration,
      revision: 1,
      state: "awaiting-approval",
      estimate,
      target,
    });
    await sql`INSERT INTO dash_integration_job (tenant, id, integration, revision, state, job)
      VALUES (${tenant}, ${job.id}, ${integration}, 1, ${job.state}, ${JSON.stringify(job)}::jsonb)`.execute(
      this.db,
    );
    return job;
  }

  async getJob(tenant: string, id: string): Promise<PreparationJob | null> {
    scope(tenant);
    const result = await sql<{
      job: unknown;
    }>`SELECT job FROM dash_integration_job WHERE tenant = ${tenant} AND id = ${id}`.execute(
      this.db,
    );
    return result.rows[0] ? preparationJobSchema.parse(result.rows[0].job) : null;
  }

  async connectionJobs(tenant: string, connection: string): Promise<PreparationJob[]> {
    scope(tenant);
    const result = await sql<{ job: unknown }>`SELECT job FROM dash_integration_job
      WHERE tenant = ${tenant} AND job->'target'->>'connection' = ${connection}
      ORDER BY COALESCE((job->>'createdAt')::bigint, 0) DESC, id DESC LIMIT 20`.execute(this.db);
    return result.rows.map((row) => preparationJobSchema.parse(row.job));
  }

  async approveJob(
    tenant: string,
    id: string,
    revision: number,
    fingerprint: string,
    now: number,
  ): Promise<PreparationJob> {
    const old = await this.getJob(tenant, id);
    if (
      !old ||
      old.state !== "awaiting-approval" ||
      old.revision !== revision ||
      old.estimate.contractFingerprint !== fingerprint
    )
      throw new IntegrationConflict("The preparation estimate changed; review it again.");
    const next = preparationJobSchema.parse({
      ...old,
      state: "queued",
      approvedAt: now,
      revision: revision + 1,
    });
    const changed = await sql<{
      id: string;
    }>`UPDATE dash_integration_job SET state = ${next.state}, revision = ${next.revision}, job = ${JSON.stringify(next)}::jsonb
      WHERE tenant = ${tenant} AND id = ${id} AND revision = ${revision} RETURNING id`.execute(
      this.db,
    );
    if (!changed.rows.length) throw new IntegrationConflict("Preparation changed.");
    return next;
  }

  /** A new token fences out an old worker after its lease expires. */
  async claimJob(
    tenant: string,
    id: string,
    now: number,
    leaseMs: number,
  ): Promise<{ token: string; job: PreparationJob } | null> {
    scope(tenant);
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs <= 0 ||
      leaseMs > 300000
    )
      throw new Error("Invalid job lease.");
    const token = randomUUID();
    const result = await sql<{
      job: unknown;
    }>`UPDATE dash_integration_job SET lease_token = ${token}, lease_until = ${now + leaseMs}, state = 'running',
      revision = revision + 1, job = jsonb_set(jsonb_set(job, '{state}', '"running"'::jsonb), '{revision}', to_jsonb(revision + 1))
      WHERE tenant = ${tenant} AND id = ${id} AND state IN ('queued', 'running')
      AND COALESCE((job->>'notBefore')::bigint, 0) <= ${now}
      AND (lease_until IS NULL OR lease_until <= ${now}) RETURNING job`.execute(this.db);
    return result.rows[0] ? { token, job: preparationJobSchema.parse(result.rows[0].job) } : null;
  }

  /** Reserve the worst-case cost BEFORE calling a model or provider. Reservations survive crashes. */
  async reserve(
    tenant: string,
    id: string,
    token: string,
    now: number,
    modelUsd: number,
    requests: number,
  ): Promise<boolean> {
    scope(tenant);
    if (
      !Number.isFinite(modelUsd) ||
      modelUsd < 0 ||
      !Number.isSafeInteger(requests) ||
      requests < 0
    )
      throw new Error("Invalid preparation reservation.");
    const result = await sql<{
      id: string;
    }>`UPDATE dash_integration_job SET revision = revision + 1,
      job = jsonb_set(jsonb_set(jsonb_set(job, '{reservedModelUsd}', to_jsonb((job->>'reservedModelUsd')::numeric + ${modelUsd})),
        '{reservedApiRequests}', to_jsonb((job->>'reservedApiRequests')::integer + ${requests})), '{revision}', to_jsonb(revision + 1))
      WHERE tenant = ${tenant} AND id = ${id} AND lease_token = ${token} AND lease_until > ${now} AND state = 'running'
      AND (job->>'reservedModelUsd')::numeric + ${modelUsd} <= (job->'estimate'->>'maxModelUsd')::numeric
      AND (job->>'reservedApiRequests')::integer + ${requests} <= (job->'estimate'->>'maxApiRequests')::integer RETURNING id`.execute(
      this.db,
    );
    return result.rows.length === 1;
  }

  async checkpoint(
    tenant: string,
    id: string,
    token: string,
    now: number,
    completed: string[],
    state: "running" | "paused" | "complete" | "failed" = "running",
    notBefore = 0,
  ): Promise<void> {
    scope(tenant);
    if (!Number.isSafeInteger(notBefore) || notBefore < 0)
      throw new Error("Invalid preparation cooldown.");
    // Union checkpoints in SQL: a stale worker snapshot cannot erase completed work.
    const result = await sql<{
      id: string;
    }>`UPDATE dash_integration_job SET revision = revision + 1, state = ${state},
      lease_token = CASE WHEN ${state} = 'running' THEN lease_token ELSE NULL END,
      lease_until = CASE WHEN ${state} = 'running' THEN lease_until ELSE NULL END,
      job = jsonb_set(jsonb_set(jsonb_set(jsonb_set(job, '{notBefore}', to_jsonb(${notBefore}::bigint)), '{completed}',
        (SELECT COALESCE(jsonb_agg(DISTINCT item), '[]'::jsonb) FROM jsonb_array_elements((job->'completed') || ${JSON.stringify(completed)}::jsonb) item)),
        '{state}', to_jsonb(${state}::text)), '{revision}', to_jsonb(revision + 1))
      WHERE tenant = ${tenant} AND id = ${id} AND lease_token = ${token} AND lease_until > ${now} AND state = 'running' RETURNING id`.execute(
      this.db,
    );
    if (!result.rows.length) throw new IntegrationConflict("Preparation lease expired or changed.");
  }

  async resumeJob(tenant: string, id: string, revision: number): Promise<PreparationJob> {
    scope(tenant);
    const result = await sql<{
      job: unknown;
    }>`UPDATE dash_integration_job SET state = 'queued', revision = revision + 1,
      job = jsonb_set(jsonb_set(job, '{state}', '"queued"'::jsonb), '{revision}', to_jsonb(revision + 1))
      WHERE tenant = ${tenant} AND id = ${id} AND revision = ${revision} AND state = 'paused'
      AND job ? 'approvedAt' RETURNING job`.execute(this.db);
    if (!result.rows[0])
      throw new IntegrationConflict("Preparation changed or has not been approved.");
    return preparationJobSchema.parse(result.rows[0].job);
  }

  async renewLease(tenant: string, id: string, token: string, now: number): Promise<void> {
    scope(tenant);
    const result = await sql`UPDATE dash_integration_job SET lease_until = ${now + 300000}
      WHERE tenant = ${tenant} AND id = ${id} AND lease_token = ${token} AND lease_until > ${now} AND state = 'running'
      RETURNING id`.execute(this.db);
    if (!result.rows.length) throw new IntegrationConflict("Preparation lease expired or changed.");
  }

  async checks(tenant: string, id: string): Promise<PreparationCheck[]> {
    scope(tenant);
    const result = await sql<{
      capability: string;
      attempts: number;
      result: unknown;
    }>`SELECT capability, attempts, result
      FROM dash_integration_check WHERE tenant = ${tenant} AND job_id = ${id} ORDER BY capability`.execute(
      this.db,
    );
    return result.rows.map((row) => preparationCheckSchema.parse(row));
  }

  /** Persist attempts before work; a restart cannot reset the three-attempt cap. */
  async beginCheck(
    tenant: string,
    id: string,
    token: string,
    now: number,
    capability: string,
  ): Promise<boolean> {
    scope(tenant);
    return this.db.transaction().execute(async (trx) => {
      const lease =
        await sql`SELECT id FROM dash_integration_job WHERE tenant = ${tenant} AND id = ${id}
        AND lease_token = ${token} AND lease_until > ${now} AND state = 'running' FOR UPDATE`.execute(
          trx,
        );
      if (!lease.rows.length)
        throw new IntegrationConflict("Preparation lease expired or changed.");
      const result =
        await sql`INSERT INTO dash_integration_check (tenant, job_id, capability, attempts)
        VALUES (${tenant}, ${id}, ${capability}, 1)
        ON CONFLICT (tenant, job_id, capability) DO UPDATE SET attempts = dash_integration_check.attempts + 1
        WHERE dash_integration_check.attempts < 3 AND dash_integration_check.result IS NULL RETURNING capability`.execute(
          trx,
        );
      return result.rows.length === 1;
    });
  }

  async finishCheck(
    tenant: string,
    id: string,
    token: string,
    now: number,
    capability: string,
    evidence: NonNullable<PreparationCheck["result"]>,
  ): Promise<void> {
    scope(tenant);
    const result = z.array(capabilityEvidenceSchema).min(1).parse(evidence);
    await this.db.transaction().execute(async (trx) => {
      const lease =
        await sql`SELECT id FROM dash_integration_job WHERE tenant = ${tenant} AND id = ${id}
        AND lease_token = ${token} AND lease_until > ${now} AND state = 'running' FOR UPDATE`.execute(
          trx,
        );
      if (!lease.rows.length)
        throw new IntegrationConflict("Preparation lease expired or changed.");
      const changed =
        await sql`UPDATE dash_integration_check SET result = ${JSON.stringify(result)}::jsonb
        WHERE tenant = ${tenant} AND job_id = ${id} AND capability = ${capability} AND result IS NULL RETURNING capability`.execute(
          trx,
        );
      if (!changed.rows.length) throw new IntegrationConflict("Preparation check changed.");
    });
  }

  /** The new version and completed job commit together. Existing bindings stay pinned. */
  async publishJobVersion(
    tenant: string,
    id: string,
    token: string,
    now: number,
    input: IntegrationDefinition,
  ): Promise<void> {
    scope(tenant);
    const definition = integrationDefinitionSchema.parse(input);
    const fingerprint = integrationFingerprint(definition);
    await this.db.transaction().execute(async (trx) => {
      const lease = await sql<{
        job: unknown;
      }>`SELECT job FROM dash_integration_job WHERE tenant = ${tenant} AND id = ${id}
        AND lease_token = ${token} AND lease_until > ${now} AND state = 'running' FOR UPDATE`.execute(
        trx,
      );
      if (!lease.rows[0]) throw new IntegrationConflict("Preparation lease expired or changed.");
      const job = preparationJobSchema.parse(lease.rows[0].job);
      if (job.integration !== definition.id)
        throw new IntegrationConflict("The prepared integration changed.");
      await sql`INSERT INTO dash_integration_version (owner, integration, version, fingerprint, definition)
        VALUES (${tenant}, ${definition.id}, ${definition.version}, ${fingerprint}, ${JSON.stringify(definition)}::jsonb)
        ON CONFLICT DO NOTHING`.execute(trx);
      const stored = await sql<{
        fingerprint: string;
      }>`SELECT fingerprint FROM dash_integration_version
        WHERE owner = ${tenant} AND integration = ${definition.id} AND version = ${definition.version}`.execute(
        trx,
      );
      if (stored.rows[0]?.fingerprint !== fingerprint)
        throw new IntegrationConflict("The published version already has different contents.");
      const next = preparationJobSchema.parse({
        ...job,
        revision: job.revision + 1,
        state: "complete",
        resultVersion: definition.version,
      });
      await sql`UPDATE dash_integration_job SET state = 'complete', revision = ${next.revision}, job = ${JSON.stringify(next)}::jsonb,
        lease_token = NULL, lease_until = NULL WHERE tenant = ${tenant} AND id = ${id}`.execute(
        trx,
      );
    });
  }
}
