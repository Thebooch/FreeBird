import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIntegrationDb } from "./db.js";
import { IntegrationConflict } from "./repository.js";
import { integrationDefinitionSchema } from "@freebirdai/dash-spec";

describe("integration database", () => {
  let database: Awaited<ReturnType<typeof openIntegrationDb>>;
  beforeAll(async () => { database = await openIntegrationDb({ inMemory: true }); });
  afterAll(async () => { await database?.close(); });
  const definition = () => integrationDefinitionSchema.parse({
    id: "api", version: "one", title: "API", protocol: "rest", schemaFingerprint: "abc", origin: "manual", entities: [], relationships: [],
  });

  it("stores immutable versions idempotently and isolates tenants", async () => {
    const repo = database.repository;
    await repo.putVersion("a", definition());
    await repo.putVersion("a", definition());
    await expect(repo.putVersion("a", { ...definition(), title: "Changed" })).rejects.toBeInstanceOf(IntegrationConflict);
    expect((await repo.getVersion("a", "api", "one"))?.title).toBe("API");
    expect(await repo.getVersion("b", "api", "one")).toBeNull();
    await expect(repo.listVersions("")).rejects.toThrow("scope");
  });

  it("uses optimistic binding updates and blocks private cross-tenant access", async () => {
    const repo = database.repository;
    await repo.putVersion("a", definition());
    const binding = { connection: "account", integration: "api", version: "one", context: {}, disabledRelationships: [] };
    const first = await repo.bind("a", "a", binding, 0);
    await expect(repo.bind("b", "a", binding, 0)).rejects.toThrow("another tenant");
    const outcomes = await Promise.allSettled([repo.bind("a", "a", binding, first.revision), repo.bind("a", "a", binding, first.revision)]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await repo.getBinding("b", "account")).toBeNull();
    await expect(repo.unbind("a", "account", 1)).rejects.toBeInstanceOf(IntegrationConflict);
    await repo.unbind("a", "account", 2);
    expect(await repo.getBinding("a", "account")).toBeNull();
  });

  it("requires exact estimate approval, fences workers and reserves costs atomically", async () => {
    const repo = database.repository;
    const job = await repo.createJob("a", "api", { maxModelUsd: 1, maxApiRequests: 2, expectedSeconds: 10, contractFingerprint: "abc" });
    expect(await repo.claimJob("a", job.id, 100, 100)).toBeNull();
    await expect(repo.approveJob("a", job.id, 1, "changed", 100)).rejects.toThrow("estimate changed");
    await repo.approveJob("a", job.id, 1, "abc", 100);
    const lease = (await repo.claimJob("a", job.id, 100, 100))!;
    expect(await repo.claimJob("a", job.id, 101, 100)).toBeNull();
    const reservations = await Promise.all([repo.reserve("a", job.id, lease.token, 101, 0.6, 1), repo.reserve("a", job.id, lease.token, 101, 0.6, 1)]);
    expect(reservations.filter(Boolean)).toHaveLength(1);
    await repo.checkpoint("a", job.id, lease.token, 102, ["entities"]);
    const replacement = (await repo.claimJob("a", job.id, 201, 100))!;
    await expect(repo.checkpoint("a", job.id, lease.token, 202, ["bad"])).rejects.toThrow("lease");
    expect(await repo.reserve("a", job.id, replacement.token, 202, 0.4, 1)).toBe(true);
    expect(await repo.reserve("a", job.id, replacement.token, 203, 0, 1)).toBe(false);
    await repo.checkpoint("a", job.id, replacement.token, 204, ["relations"], "paused");
    const saved = await repo.getJob("a", job.id);
    expect(saved?.completed.sort()).toEqual(["entities", "relations"]);
    expect(saved?.reservedApiRequests).toBe(2);
    expect(await repo.getJob("b", job.id)).toBeNull();
  });
});
