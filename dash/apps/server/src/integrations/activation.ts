import type { IntegrationActivationReview, IntegrationDefinition } from "@freebirdai/dash-spec";
import {
  IntegrationConflict,
  integrationFingerprint,
  type IntegrationRepository,
} from "./repository.js";
import type { IntegrationScope } from "./routes.js";

/** Verification may change evidence and capability availability, never the
 * executable contract. Structural migrations need saved-view dependency checks.
 */
export const verificationContract = (definition: IntegrationDefinition) => {
  const { version: _version, origin: _origin, evidence: _evidence, ...contract } = definition;
  return {
    ...contract,
    relationships: contract.relationships.map((relationship) => {
      const {
        status: _forwardStatus,
        evidence: _forwardEvidence,
        ...forward
      } = relationship.forward;
      const {
        status: _reverseStatus,
        evidence: _reverseEvidence,
        ...reverse
      } = relationship.reverse;
      return { ...relationship, forward, reverse };
    }),
  };
};

export class IntegrationActivation {
  constructor(private readonly repository: IntegrationRepository) {}

  private async candidate(scope: IntegrationScope, id: string) {
    const job = await this.repository.getJob(scope.tenant, id);
    if (!job?.target || !scope.connections.includes(job.target.connection))
      throw new IntegrationConflict("Preparation unavailable.");
    if (job.state !== "complete" || !job.resultVersion)
      throw new IntegrationConflict("Finish verification before reviewing its results.");
    const saved = await this.repository.getBinding(scope.tenant, job.target.connection);
    if (!saved || saved.owner !== scope.tenant || saved.binding.integration !== job.integration)
      throw new IntegrationConflict("The connection changed. Prepare a new estimate.");
    const [before, after] = await Promise.all([
      this.repository.getVersion(saved.owner, job.integration, saved.binding.version),
      this.repository.getVersion(saved.owner, job.integration, job.resultVersion),
    ]);
    if (!before || !after) throw new IntegrationConflict("Integration version unavailable.");
    return { job, saved, before, after };
  }

  async review(scope: IntegrationScope, id: string): Promise<IntegrationActivationReview> {
    const { job, saved, before, after } = await this.candidate(scope, id);
    const alreadyActive = saved.binding.version === after.version;
    const blockers: string[] = [];
    if (
      !alreadyActive &&
      (saved.binding.revision !== job.target!.bindingRevision ||
        saved.binding.version !== job.target!.version)
    )
      blockers.push("The connection changed since verification started. Prepare a new estimate.");
    if (
      integrationFingerprint(verificationContract(before)) !==
      integrationFingerprint(verificationContract(after))
    )
      blockers.push(
        "This version changes record definitions or request contracts. It needs a saved-view migration review before activation.",
      );
    return {
      connection: saved.binding.connection,
      currentVersion: before.version,
      targetVersion: after.version,
      bindingRevision: saved.binding.revision,
      fingerprint: integrationFingerprint({ binding: saved.binding, job: job.id, before, after }),
      alreadyActive,
      compatible: blockers.length === 0,
      blockers,
      relationships: after.relationships.flatMap((relation) =>
        (["forward", "reverse"] as const).map((direction) => ({
          title: relation[direction].title,
          direction,
          before:
            before.relationships.find((item) => item.id === relation.id)?.[direction].status ??
            "unverified",
          after: relation[direction].status,
        })),
      ),
    };
  }

  async activate(scope: IntegrationScope, id: string, revision: number, fingerprint: string) {
    const review = await this.review(scope, id);
    if (review.bindingRevision !== revision || review.fingerprint !== fingerprint)
      throw new IntegrationConflict("The activation review changed. Review it again.");
    if (!review.compatible) throw new IntegrationConflict(review.blockers.join(" "));
    if (review.alreadyActive) return review;
    // The CAS also catches edits between review and commit. Definitions are immutable.
    const saved = await this.repository.getBinding(scope.tenant, review.connection);
    if (!saved || saved.binding.revision !== revision)
      throw new IntegrationConflict("Connection binding changed.");
    await this.repository.bind(
      scope.tenant,
      saved.owner,
      {
        ...saved.binding,
        version: review.targetVersion,
      },
      revision,
    );
    return this.review(scope, id);
  }
}
