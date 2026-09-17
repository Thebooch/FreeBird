import { integrationDefinitionSchema, type IntegrationDefinition } from "@freebirdai/dash-spec";
import { IntegrationReadError, IntegrationReadSession, type IntegrationReadDeps } from "./read.js";
import {
  IntegrationConflict,
  integrationFingerprint,
  type IntegrationRepository,
  type PreparationJob,
} from "./repository.js";
import {
  applyTraversalEvidence,
  traversalSubject,
  verifyTraversal,
  verifyRoundTrip,
} from "./verification.js";
import type { IntegrationScope } from "./routes.js";
import { parseRetryAfter } from "../cache/cooldown.js";

class PreparationPaused extends Error {}

/** Verification is a bounded stage of preparation. Discovery/model repair can add
 * candidate versions beforehand; this stage never invokes a model or guesses keys.
 */
export class IntegrationPreparation {
  constructor(
    private readonly repository: IntegrationRepository,
    private readonly dependencies: (scope: IntegrationScope) => IntegrationReadDeps,
    private readonly clock = () => Date.now(),
  ) {}

  private async target(scope: IntegrationScope, connection: string) {
    if (!scope.connections.includes(connection))
      throw new IntegrationConflict("Connection unavailable.");
    const saved = await this.repository.getBinding(scope.tenant, connection);
    if (!saved || saved.owner !== scope.tenant)
      throw new IntegrationConflict("Connection has no private integration version.");
    const definition = await this.repository.getVersion(
      saved.owner,
      saved.binding.integration,
      saved.binding.version,
    );
    if (!definition) throw new IntegrationConflict("Integration unavailable.");
    return { definition, binding: saved.binding };
  }

  async estimate(scope: IntegrationScope, connection: string): Promise<PreparationJob> {
    const { definition, binding } = await this.target(scope, connection);
    // At most three distinct sample keys per direction and round trip, plus
    // one bounded source collection per entity. Cache reuse may lower usage.
    const requests =
      definition.entities.length +
      definition.relationships.reduce(
        (sum, relationship) =>
          sum +
          [relationship.forward, relationship.reverse].reduce(
            (count, direction) =>
              count +
              (direction.plan.kind === "request"
                ? 6 * direction.plan.maxRequests
                : direction.plan.kind === "bounded-match"
                  ? 2
                  : 0),
            0,
          ),
        0,
      );
    return this.repository.createJob(
      scope.tenant,
      definition.id,
      {
        maxModelUsd: 0,
        maxApiRequests: Math.min(requests, 2000),
        expectedSeconds: Math.ceil(Math.min(requests, 2000) * 2),
        contractFingerprint: integrationFingerprint({ definition, binding }),
      },
      { connection, version: definition.version, bindingRevision: binding.revision },
    );
  }

  async run(scope: IntegrationScope, id: string): Promise<PreparationJob | null> {
    const original = await this.repository.getJob(scope.tenant, id);
    if (!original?.target) throw new IntegrationConflict("This job has no verification target.");
    const { definition, binding } = await this.target(scope, original.target.connection);
    if (original.estimate.contractFingerprint !== integrationFingerprint({ definition, binding }))
      throw new IntegrationConflict(
        "The connection or integration changed; prepare a new estimate.",
      );
    const lease = await this.repository.claimJob(scope.tenant, id, this.clock(), 300000);
    if (!lease) return this.repository.getJob(scope.tenant, id);
    const connection = original.target.connection;
    const base = this.dependencies(scope);
    let paused = false;
    let notBefore = 0;
    const session = new IntegrationReadSession(
      {
        ...base,
        // Frozen metadata for the job; a binding edit stops requests below.
        load: async (tenant, requested) =>
          tenant === scope.tenant && requested === connection ? { definition, binding } : null,
        fetch: async (...args) => {
          const current = await this.repository.getBinding(scope.tenant, connection);
          if (
            !current ||
            integrationFingerprint(current.binding) !== integrationFingerprint(binding)
          ) {
            paused = true;
            throw new PreparationPaused("Connection changed.");
          }
          await this.repository.renewLease(scope.tenant, id, lease.token, this.clock());
          if (!(await this.repository.reserve(scope.tenant, id, lease.token, this.clock(), 0, 1))) {
            paused = true;
            throw new PreparationPaused("The approved request budget was reached.");
          }
          try {
            return await base.fetch(...args);
          } catch (error) {
            // Do not retry throttled or unavailable providers in a tight loop. An
            // explicit resume retains reservations, checkpoints and attempt counts.
            if (!(error instanceof IntegrationReadError)) paused = true;
            if (error && typeof error === "object" && "status" in error && error.status === 429) {
              const retryAfter =
                "retryAfter" in error && typeof error.retryAfter === "string"
                  ? error.retryAfter
                  : undefined;
              notBefore = Math.min(
                Number.MAX_SAFE_INTEGER,
                Math.ceil(this.clock() + (parseRetryAfter(retryAfter, this.clock()) ?? 60000)),
              );
            }
            throw error;
          }
        },
      },
      {
        tenant: scope.tenant,
        authorizationRevision: scope.authorizationRevision,
        maxRequests: Math.max(1, original.estimate.maxApiRequests),
        maxRows: 100,
      },
    );
    try {
      const prior = new Map(
        (await this.repository.checks(scope.tenant, id)).map((check) => [check.capability, check]),
      );
      for (const relationship of definition.relationships)
        for (const direction of ["forward", "reverse", "round-trip"] as const) {
          const capability = traversalSubject(relationship.id, direction);
          if (prior.get(capability)?.result) continue;
          await this.repository.renewLease(scope.tenant, id, lease.token, this.clock());
          if (
            !(await this.repository.beginCheck(
              scope.tenant,
              id,
              lease.token,
              this.clock(),
              capability,
            ))
          )
            throw new PreparationPaused("This capability reached its repair limit.");
          const checkInput = {
            session,
            definition,
            connection,
            relationship,
            now: this.clock(),
          };
          const evidence =
            direction === "round-trip"
              ? await verifyRoundTrip({
                  ...checkInput,
                  directionalEvidence: (await this.repository.checks(scope.tenant, id)).flatMap(
                    (check) => check.result ?? [],
                  ),
                })
              : await verifyTraversal({ ...checkInput, direction });
          if (paused)
            throw new PreparationPaused(
              "Preparation paused before exceeding its budget or retrying unavailable data.",
            );
          await this.repository.finishCheck(
            scope.tenant,
            id,
            lease.token,
            this.clock(),
            capability,
            evidence,
          );
          await this.repository.checkpoint(scope.tenant, id, lease.token, this.clock(), [
            capability,
          ]);
        }
      const checks = await this.repository.checks(scope.tenant, id);
      const candidate: IntegrationDefinition = applyTraversalEvidence(
        definition,
        checks.flatMap((check) => check.result ?? []),
      );
      candidate.origin = "prepared";
      candidate.version = `prepared-${integrationFingerprint(candidate).slice(0, 24)}`;
      await this.repository.publishJobVersion(
        scope.tenant,
        id,
        lease.token,
        this.clock(),
        integrationDefinitionSchema.parse(candidate),
      );
    } catch (error) {
      if (error instanceof IntegrationConflict) throw error;
      await this.repository.checkpoint(
        scope.tenant,
        id,
        lease.token,
        this.clock(),
        [],
        paused || error instanceof PreparationPaused ? "paused" : "failed",
        notBefore,
      );
    }
    return this.repository.getJob(scope.tenant, id);
  }
}
