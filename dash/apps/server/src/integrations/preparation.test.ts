import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationDefinitionSchema } from "@freebirdai/dash-spec";
import { openIntegrationDb } from "./db.js";
import { IntegrationPreparation } from "./preparation.js";
import { IntegrationReadError, type IntegrationReadDeps } from "./read.js";

const definition = () =>
  integrationDefinitionSchema.parse({
    id: "warehouse",
    version: "candidate",
    title: "Warehouse",
    protocol: "rest",
    schemaFingerprint: "contract",
    origin: "manual",
    operations: ["items", "owners", "owner"].map((id) => ({ id, title: id, path: `/${id}` })),
    entities: [
      {
        id: "item",
        title: "Items",
        listOp: "items",
        identity: [{ name: "id", field: "id" }],
        fields: [
          { id: "id", name: "id", kinds: ["string"] },
          { id: "owner", name: "owner", kinds: ["string"] },
        ],
      },
      {
        id: "owner",
        title: "Owners",
        listOp: "owners",
        detail: { op: "owner", inputs: [{ param: "id", field: "id" }] },
        identity: [{ name: "id", field: "id" }],
        fields: [{ id: "id", name: "id", kinds: ["string"] }],
      },
    ],
    relationships: [
      {
        id: "owned",
        role: "owned",
        source: "item",
        target: "owner",
        forward: {
          title: "Owner",
          cardinality: "one",
          plan: {
            kind: "request",
            op: "owner",
            inputs: [{ param: "id", field: "owner" }],
            matches: [{ source: "owner", target: "id" }],
          },
        },
        reverse: {
          title: "Owned items",
          cardinality: "many",
          plan: {
            kind: "request",
            op: "items",
            inputs: [{ param: "owner", field: "id" }],
            matches: [{ source: "id", target: "owner" }],
          },
        },
      },
    ],
  });
const owners = [
  { id: "private-owner-1", name: "Private customer name" },
  { id: "private-owner-2" },
];
const items = owners.map((owner, i) => ({ id: `private-item-${i}`, owner: owner.id }));
const complete = { status: "complete" as const, scope: "query" as const, reason: "Exhausted." };

describe("approved integration verification", () => {
  let database: Awaited<ReturnType<typeof openIntegrationDb>>;
  beforeAll(async () => {
    database = await openIntegrationDb({ inMemory: true });
  });
  afterAll(async () => {
    await database?.close();
  });
  const setup = async (tenant: string) => {
    const repo = database.repository;
    const candidate = definition();
    await repo.putVersion(tenant, candidate);
    const binding = await repo.bind(
      tenant,
      tenant,
      {
        connection: "account",
        integration: candidate.id,
        version: candidate.version,
        context: {},
        disabledRelationships: [],
      },
      0,
    );
    const scope = { tenant, authorizationRevision: "auth-1", connections: ["account"] };
    const fetch = vi.fn<IntegrationReadDeps["fetch"]>(async (_ctx, _connection, op, inputs) => ({
      rows:
        op === "owners"
          ? owners
          : op === "owner"
            ? owners.filter((owner) => owner.id === inputs.id)
            : items.filter((item) => !inputs.owner || item.owner === inputs.owner),
      completeness: complete,
    }));
    const deps: IntegrationReadDeps = {
      load: async () => ({ definition: candidate, binding }),
      authorize: async () => true,
      fetch,
    };
    const service = new IntegrationPreparation(
      repo,
      () => deps,
      () => 1000,
    );
    const job = await service.estimate(scope, "account");
    const approve = () =>
      repo.approveJob(tenant, job.id, job.revision, job.estimate.contractFingerprint, 1000);
    return { repo, scope, fetch, service, job, approve };
  };

  it("makes no requests before exact approval and publishes evidence without private samples or rebinding", async () => {
    const { repo, scope, fetch, service, job, approve } = await setup("publish");
    expect((await service.run(scope, job.id))?.state).toBe("awaiting-approval");
    expect(fetch).not.toHaveBeenCalled();
    await approve();
    const result = await service.run(scope, job.id);
    expect(result?.state).toBe("complete");
    const published = (await repo.getVersion(scope.tenant, "warehouse", result!.resultVersion!))!;
    expect(published.relationships[0]?.forward.status).toBe("verified");
    expect(published.relationships[0]?.reverse.status).toBe("verified");
    expect(published.evidence.find((e) => e.subject === "owned:round-trip")?.status).toBe("passed");
    expect(published.evidence.every((e) => e.distinctCases === 2)).toBe(true);
    expect(JSON.stringify(published)).not.toContain("private-owner");
    expect(JSON.stringify(published)).not.toContain("Private customer");
    expect((await repo.getBinding(scope.tenant, "account"))?.binding.version).toBe("candidate");
    const calls = fetch.mock.calls.length;
    await service.run(scope, job.id);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("quarantines ignored reverse filters independently of a working forward link", async () => {
    const { repo, scope, fetch, service, job, approve } = await setup("ignored-filter");
    fetch.mockImplementation(async (_ctx, _connection, op, inputs) => ({
      rows:
        op === "owners"
          ? owners
          : op === "owner"
            ? owners.filter((owner) => owner.id === inputs.id)
            : items,
      completeness: complete,
    }));
    await approve();
    const result = await service.run(scope, job.id);
    const published = (await repo.getVersion(scope.tenant, "warehouse", result!.resultVersion!))!;
    expect(published.relationships[0]?.forward.status).toBe("verified");
    expect(published.relationships[0]?.reverse.status).toBe("contradicted");
    expect(
      published.evidence.find((e) => e.subject === "owned:reverse" && e.claim === "relationship")
        ?.status,
    ).toBe("failed");
  });

  it("does not verify an empty dataset or repeat a source request for its inverse", async () => {
    const { repo, scope, fetch, service, job, approve } = await setup("empty");
    fetch.mockResolvedValue({ rows: [], completeness: complete });
    await approve();
    const result = await service.run(scope, job.id);
    const published = (await repo.getVersion(scope.tenant, "warehouse", result!.resultVersion!))!;
    expect(published.relationships[0]?.forward.status).toBe("unverified");
    expect(published.relationships[0]?.reverse.status).toBe("unverified");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("resumes saved checks after provider failure without repeating successful directions", async () => {
    const { repo, scope, fetch, service, job, approve } = await setup("resume");
    const normal = fetch.getMockImplementation()!;
    let fail = true;
    fetch.mockImplementation(async (...args) => {
      if (args[2] === "owners" && fail) {
        fail = false;
        throw new Error("Sensitive provider error");
      }
      return normal(...args);
    });
    await approve();
    const paused = (await service.run(scope, job.id))!;
    expect(paused.state).toBe("paused");
    expect(paused.completed).toEqual(["owned:forward"]);
    await repo.resumeJob(scope.tenant, job.id, paused.revision);
    expect((await service.run(scope, job.id))?.state).toBe("complete");
    // The completed direction stays checkpointed; the separate round-trip
    // check re-reads its representative targets after the resumed session.
    expect(fetch.mock.calls.filter((call) => call[2] === "owner")).toHaveLength(4);
    expect(
      (await repo.checks(scope.tenant, job.id)).find(
        (check) => check.capability === "owned:forward",
      )?.attempts,
    ).toBe(1);
    expect(
      (await repo.checks(scope.tenant, job.id)).find(
        (check) => check.capability === "owned:reverse",
      )?.attempts,
    ).toBe(2);
  });

  it("rejects account changes and tenant access before any work", async () => {
    const { repo, scope, fetch, service, job, approve } = await setup("changed");
    await expect(service.run({ ...scope, tenant: "another" }, job.id)).rejects.toThrow("target");
    await approve();
    const binding = (await repo.getBinding(scope.tenant, "account"))!.binding;
    await repo.bind(
      scope.tenant,
      scope.tenant,
      { ...binding, disabledRelationships: ["owned"] },
      binding.revision,
    );
    await expect(service.run(scope, job.id)).rejects.toThrow("changed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps an absent round trip inconclusive even when returned children match their parent", async () => {
    const { repo, scope, fetch, service, job, approve } = await setup("round-trip-absence");
    const normal = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (...args) => {
      const result = await normal(...args);
      return args[2] === "items" && args[3].owner
        ? { ...result, rows: result.rows.map((row) => ({ ...row, id: `${row.id}-different` })) }
        : result;
    });
    await approve();
    const result = await service.run(scope, job.id);
    const published = (await repo.getVersion(scope.tenant, "warehouse", result!.resultVersion!))!;
    expect(published.evidence.find((e) => e.subject === "owned:round-trip")).toMatchObject({
      status: "inconclusive",
      code: "round-trip-not-established",
    });
    expect(published.relationships[0]?.reverse.status).toBe("verified");
    expect(JSON.stringify(published)).not.toContain("private-item");
  });

  it("does not pause unrelated verification when a referenced record was deleted", async () => {
    const { repo, scope, fetch, service, job, approve } = await setup("deleted-record");
    const normal = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (...args) => {
      if (args[2] === "owner" && args[3].id === owners[0]!.id)
        throw new IntegrationReadError("missing", "Record removed.");
      return normal(...args);
    });
    await approve();
    const result = await service.run(scope, job.id);
    expect(result?.state).toBe("complete");
    const published = (await repo.getVersion(scope.tenant, "warehouse", result!.resultVersion!))!;
    expect(published.relationships[0]?.forward.status).toBe("unverified");
    expect(published.relationships[0]?.reverse.status).toBe("verified");
  });
});
