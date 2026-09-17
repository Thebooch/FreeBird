import type {
  CapabilityEvidence,
  IntegrationDefinition,
  IntegrationRelationship,
} from "@freebirdai/dash-spec";
import { IntegrationReadError, readEntityField, type IntegrationReadSession } from "./read.js";
import { integrationFingerprint } from "./repository.js";

export type Direction = "forward" | "reverse";
export const traversalSubject = (relationship: string, direction: Direction | "round-trip") =>
  `${relationship}:${direction}`;

/** Probe the saved execution plan. Model confidence and HTTP success are not evidence. */
export const verifyTraversal = async (input: {
  session: IntegrationReadSession;
  definition: IntegrationDefinition;
  connection: string;
  relationship: IntegrationRelationship;
  direction: Direction;
  now: number;
}): Promise<CapabilityEvidence[]> => {
  const { session, definition, connection, relationship, direction } = input;
  const subject = traversalSubject(relationship.id, direction);
  const plan = relationship[direction].plan;
  const evidence = (
    claim: CapabilityEvidence["claim"],
    status: CapabilityEvidence["status"],
    code: string,
    distinctCases = 0,
  ): CapabilityEvidence => ({
    id: `check-${integrationFingerprint([subject, claim]).slice(0, 24)}`,
    claim,
    subject,
    status,
    source: "probe",
    contractFingerprint: definition.schemaFingerprint,
    checkedAt: new Date(input.now).toISOString(),
    distinctCases,
    code,
  });
  if (plan.kind === "unavailable")
    return [evidence("relationship", "inconclusive", "no-retrieval-contract")];
  // Embedded data needs an independently described key correspondence before it can
  // establish a relationship; a plausible-looking nested object is insufficient.
  if (plan.kind === "embedded")
    return [evidence("relationship", "inconclusive", "embedded-identity-proof-required")];
  const source = direction === "forward" ? relationship.source : relationship.target;
  const seen = new Set<string>();
  let passed = 0;
  let limited = false;
  let unavailable = false;
  try {
    const samples = await session.list(connection, source);
    for (const record of samples.records) {
      if (!record.ref) continue;
      if (
        direction === "forward" &&
        relationship.discriminator &&
        readEntityField(record.values, relationship.discriminator.field) !==
          relationship.discriminator.value
      )
        continue;
      const values = plan.matches.map((match) => readEntityField(record.values, match.source));
      if (values.some((value) => value == null || (Array.isArray(value) && value.length === 0)))
        continue;
      const key = integrationFingerprint(values);
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await session.probeRelationship(
        connection,
        source,
        record.values,
        relationship.id,
        direction,
      );
      if (result.status === "invalid" || result.status === "ambiguous")
        return [
          evidence(
            "relationship",
            "failed",
            result.status === "ambiguous"
              ? "cardinality-contradicted"
              : "key-correspondence-contradicted",
            seen.size,
          ),
          evidence(
            result.status === "ambiguous" ? "cardinality" : "identity",
            "failed",
            "contradicted",
            seen.size,
          ),
        ];
      if (
        result.status === "ok" &&
        result.data.records.length &&
        result.data.records.every((item) => item.ref)
      ) {
        if (
          result.data.completeness.status === "partial" ||
          (plan.kind === "bounded-match" && result.data.completeness.status !== "complete")
        )
          limited = true;
        else passed++;
      } else if (result.status === "limit") limited = true;
      else unavailable = true;
      if (seen.size >= 3) break;
    }
    // Two distinct reference values prevent one coincidental match from approving
    // a filter that ignores its input. Sparse data remains explicitly unverified.
    if (passed >= 2 && !limited && !unavailable)
      return [
        evidence("relationship", "passed", "distinct-keys-match", passed),
        evidence("identity", "passed", "returned-identities-match", passed),
        ...(relationship[direction].cardinality === "one"
          ? [evidence("cardinality", "passed", "single-target-per-key", passed)]
          : []),
        ...(plan.kind === "request"
          ? [evidence("filter", "passed", "returned-records-match-source", passed)]
          : []),
      ];
    return [
      evidence(
        "relationship",
        "inconclusive",
        limited
          ? "bounded-results-incomplete"
          : unavailable
            ? "records-unavailable"
            : "insufficient-distinct-keys",
        passed,
      ),
    ];
  } catch (error) {
    // Budget/lease failures are handled by the worker and must not become terminal
    // evidence; all other provider details remain outside publication metadata.
    if (!(error instanceof IntegrationReadError)) throw error;
    return [
      evidence(
        "relationship",
        "inconclusive",
        error.code === "denied" ? "access-denied" : "source-unavailable",
        passed,
      ),
    ];
  }
};

/** Check representative A → B → A paths without recursively exploring the graph.
 * An absent return path can reflect access, deletion or scoped endpoints; it is
 * inconclusive, never evidence that unrelated directional checks were false.
 */
export const verifyRoundTrip = async (input: {
  session: IntegrationReadSession;
  definition: IntegrationDefinition;
  connection: string;
  relationship: IntegrationRelationship;
  directionalEvidence: readonly CapabilityEvidence[];
  now: number;
}): Promise<CapabilityEvidence[]> => {
  const { session, definition, connection, relationship } = input;
  const subject = traversalSubject(relationship.id, "round-trip");
  const proof = (
    status: CapabilityEvidence["status"],
    code: string,
    distinctCases = 0,
  ): CapabilityEvidence[] => [
    {
      id: `check-${integrationFingerprint([subject, "relationship"]).slice(0, 24)}`,
      claim: "relationship",
      subject,
      status,
      code,
      distinctCases,
      source: "probe",
      contractFingerprint: definition.schemaFingerprint,
      checkedAt: new Date(input.now).toISOString(),
    },
  ];
  if (
    !["forward", "reverse"].every((direction) =>
      input.directionalEvidence.some(
        (e) =>
          e.subject === `${relationship.id}:${direction}` &&
          e.claim === "relationship" &&
          e.status === "passed" &&
          e.contractFingerprint === definition.schemaFingerprint,
      ),
    )
  )
    return proof("inconclusive", "directions-not-both-verified");
  if (!("matches" in relationship.forward.plan))
    return proof("inconclusive", "no-key-correspondence");
  let passed = 0;
  let unavailable = false;
  const seen = new Set<string>();
  try {
    const samples = await session.list(connection, relationship.source);
    for (const source of samples.records) {
      if (!source.ref) continue;
      if (
        relationship.discriminator &&
        readEntityField(source.values, relationship.discriminator.field) !==
          relationship.discriminator.value
      )
        continue;
      const values = relationship.forward.plan.matches.map((match) =>
        readEntityField(source.values, match.source),
      );
      if (values.some((value) => value == null || (Array.isArray(value) && !value.length)))
        continue;
      const key = integrationFingerprint(values);
      if (seen.has(key)) continue;
      seen.add(key);
      const outbound = await session.probeRelationship(
        connection,
        relationship.source,
        source.values,
        relationship.id,
        "forward",
      );
      if (
        outbound.status !== "ok" ||
        !outbound.data.records.length ||
        outbound.data.completeness.status === "partial"
      )
        unavailable = true;
      else {
        // One representative target per source; wide reference arrays do not
        // turn verification into a graph crawl.
        const target = outbound.data.records[0]!;
        const returned = target.ref
          ? await session.probeRelationship(
              connection,
              relationship.target,
              target.values,
              relationship.id,
              "reverse",
            )
          : null;
        if (
          returned?.status === "ok" &&
          returned.data.records.some(
            (record) =>
              record.ref &&
              integrationFingerprint(record.ref) === integrationFingerprint(source.ref),
          )
        )
          passed++;
        else unavailable = true;
      }
      if (seen.size >= 3) break;
    }
    return passed >= 2 && !unavailable
      ? proof("passed", "round-trip-identities-match", passed)
      : proof("inconclusive", "round-trip-not-established", passed);
  } catch (error) {
    if (!(error instanceof IntegrationReadError)) throw error;
    return proof(
      "inconclusive",
      error.code === "denied" ? "access-denied" : "round-trip-unavailable",
      passed,
    );
  }
};

export const applyTraversalEvidence = (
  definition: IntegrationDefinition,
  evidence: readonly CapabilityEvidence[],
): IntegrationDefinition => {
  const result = structuredClone(definition);
  const replacements = new Set(evidence.map((item) => item.id));
  result.evidence = [...result.evidence.filter((item) => !replacements.has(item.id)), ...evidence];
  for (const relationship of result.relationships)
    for (const direction of ["forward", "reverse"] as const) {
      const proofs = evidence.filter(
        (item) => item.subject === traversalSubject(relationship.id, direction),
      );
      if (!proofs.length) continue;
      relationship[direction].evidence = proofs.map((item) => item.id);
      const claim = proofs.find((item) => item.claim === "relationship");
      relationship[direction].status =
        claim?.status === "passed"
          ? "verified"
          : claim?.status === "failed"
            ? "contradicted"
            : "unverified";
    }
  return result;
};
