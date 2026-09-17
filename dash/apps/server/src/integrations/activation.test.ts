import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationDefinitionSchema, type IntegrationDefinition } from "@freebirdai/dash-spec";
import { openIntegrationDb } from "./db.js";
import { IntegrationActivation } from "./activation.js";

describe("reviewed integration activation", () => {
  let database: Awaited<ReturnType<typeof openIntegrationDb>>;
  beforeAll(async () => {
    database = await openIntegrationDb({ inMemory: true });
  });
  afterAll(async () => {
    await database?.close();
  });
  const setup = async (tenant: string, alter?: (value: IntegrationDefinition) => void) => {
    const repo = database.repository;
    const before = integrationDefinitionSchema.parse({
      id: "service",
      version: "one",
      title: "Service",
      origin: "manual",
      protocol: "rest",
      schemaFingerprint: "contract",
      operations: [{ id: "records", path: "/records", title: "Records" }],
      entities: ["item", "owner"].map((id) => ({
        id,
        title: id,
        listOp: "records",
        identity: [{ name: "id", field: "id" }],
        fields: [{ id: "id", name: "id", kinds: ["string"] }],
      })),
      relationships: [
        {
          id: "owner",
          role: "assigned",
          source: "item",
          target: "owner",
          forward: {
            title: "Assigned owner",
            cardinality: "one",
            plan: {
              kind: "request",
              op: "records",
              inputs: [{ param: "id", field: "id" }],
              matches: [{ source: "id", target: "id" }],
            },
          },
          reverse: {
            title: "Associated items",
            cardinality: "many",
            plan: { kind: "unavailable", reason: "No supported reverse query." },
          },
        },
      ],
    });
    await repo.putVersion(tenant, before);
    const binding = await repo.bind(
      tenant,
      tenant,
      {
        connection: "account",
        integration: before.id,
        version: before.version,
        context: { region: "private-region" },
        disabledRelationships: [],
      },
      0,
    );
    const after = structuredClone(before);
    after.version = "two";
    after.origin = "prepared";
    after.evidence = [
      {
        id: "proof",
        subject: "owner:forward",
        claim: "relationship",
        status: "passed",
        source: "probe",
        contractFingerprint: "contract",
        distinctCases: 2,
        code: "keys-match",
      },
    ];
    after.relationships[0]!.forward.status = "verified";
    after.relationships[0]!.forward.evidence = ["proof"];
    alter?.(after);
    const job = await repo.createJob(
      tenant,
      before.id,
      { maxModelUsd: 0, maxApiRequests: 3, expectedSeconds: 6, contractFingerprint: "approval" },
      { connection: "account", version: "one", bindingRevision: binding.revision },
    );
    await repo.approveJob(tenant, job.id, job.revision, job.estimate.contractFingerprint, 100);
    const lease = (await repo.claimJob(tenant, job.id, 100, 1000))!;
    await repo.publishJobVersion(tenant, job.id, lease.token, 101, after);
    return {
      repo,
      before,
      after,
      binding,
      job,
      scope: { tenant, authorizationRevision: "auth", connections: ["account"] },
      activation: new IntegrationActivation(repo),
    };
  };

  it("reviews sanitized capability changes and activates only the exact reviewed version", async () => {
    const { activation, scope, job, repo, before } = await setup("review");
    const review = await activation.review(scope, job.id);
    expect(review.compatible).toBe(true);
    expect(review.relationships).toContainEqual({
      title: "Assigned owner",
      direction: "forward",
      before: "unverified",
      after: "verified",
    });
    expect(JSON.stringify(review)).not.toContain("private-region");
    await expect(
      activation.activate(scope, job.id, review.bindingRevision, "stale"),
    ).rejects.toThrow("review changed");
    expect((await repo.getBinding(scope.tenant, "account"))?.binding.version).toBe("one");
    const active = await activation.activate(
      scope,
      job.id,
      review.bindingRevision,
      review.fingerprint,
    );
    expect(active.alreadyActive).toBe(true);
    expect((await repo.getBinding(scope.tenant, "account"))?.binding).toMatchObject({
      version: "two",
      revision: 2,
      context: { region: "private-region" },
    });
    expect(await repo.getVersion(scope.tenant, "service", "one")).toEqual(before);
    // Repeating a freshly reviewed already-active result is harmless.
    expect(
      (await activation.activate(scope, job.id, active.bindingRevision, active.fingerprint))
        .alreadyActive,
    ).toBe(true);
  });

  it.each(["request", "identity", "role", "view"] as const)(
    "blocks %s changes until dependency-aware migration exists",
    async (change) => {
      const { activation, scope, job, repo } = await setup(`changed-${change}`, (after) => {
        if (change === "request") after.operations[0]!.path = "/different";
        if (change === "identity") after.entities[0]!.identity[0]!.name = "new_key";
        if (change === "role") after.relationships[0]!.role = "billing";
        if (change === "view") after.entities[0]!.view.fields = ["id"];
      });
      const review = await activation.review(scope, job.id);
      expect(review.compatible).toBe(false);
      await expect(
        activation.activate(scope, job.id, review.bindingRevision, review.fingerprint),
      ).rejects.toThrow("migration review");
      expect((await repo.getBinding(scope.tenant, "account"))?.binding.version).toBe("one");
    },
  );

  it("isolates jobs by tenant and account, and rejects changed connection context", async () => {
    const { activation, scope, job, repo, binding } = await setup("scope");
    await expect(activation.review({ ...scope, tenant: "other" }, job.id)).rejects.toThrow(
      "unavailable",
    );
    await expect(activation.review({ ...scope, connections: [] }, job.id)).rejects.toThrow(
      "unavailable",
    );
    expect(await repo.connectionJobs("other", "account")).toEqual([]);
    expect(await repo.connectionJobs(scope.tenant, "another-account")).toEqual([]);
    expect((await repo.connectionJobs(scope.tenant, "account"))[0]?.id).toBe(job.id);
    await repo.bind(
      scope.tenant,
      scope.tenant,
      { ...binding, context: { region: "changed" } },
      binding.revision,
    );
    const review = await activation.review(scope, job.id);
    expect(review.compatible).toBe(false);
    expect(review.blockers.join(" ")).toContain("connection changed");
  });

  it("fences concurrent activation attempts", async () => {
    const { activation, scope, job, repo } = await setup("concurrent");
    const review = await activation.review(scope, job.id);
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        activation.activate(scope, job.id, review.bindingRevision, review.fingerprint),
      ),
    );
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await repo.getBinding(scope.tenant, "account"))?.binding.revision).toBe(2);
  });
});
