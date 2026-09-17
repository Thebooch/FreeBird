import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { integrationRoutes, type IntegrationScope } from "./routes.js";
import type { IntegrationReadSession } from "./read.js";
import type { IntegrationRepository } from "./repository.js";

describe("integration route authorization", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  const setup = (
    scope: IntegrationScope | null = {
      tenant: "tenant-a",
      authorizationRevision: "permissions-1",
      connections: ["allowed"],
    },
  ) => {
    const app = Fastify();
    apps.push(app);
    const list = vi.fn(async () => ({ records: [], completeness: { status: "unknown" } }));
    const describeEntity = vi.fn(async () => ({ entity: {}, relationships: [] }));
    const discover = vi.fn(async () => [{ id: "items", title: "Items", browsable: true }]);
    const page = vi.fn(async () => ({ title: "Item", relationships: [], references: [] }));
    const browse = vi.fn(async () => ({ title: "Items", records: [] }));
    const related = vi.fn(async () => ({ status: "ok", records: [] }));
    const session = vi.fn(
      () =>
        ({
          list,
          describe: describeEntity,
          discover,
          page,
          browse,
          related,
        }) as unknown as IntegrationReadSession,
    );
    const getJob = vi.fn(async () => null as unknown);
    const approveJob = vi.fn();
    const getBinding = vi.fn(async () => ({
      owner: "tenant-a",
      binding: { context: { secretAccountValue: "private" } },
    }));
    const connectionJobs = vi.fn(async () => []);
    integrationRoutes(app, {
      repository: {
        getJob,
        approveJob,
        getBinding,
        connectionJobs,
      } as unknown as IntegrationRepository,
      scope: async () => scope,
      session,
    });
    return {
      app,
      list,
      describeEntity,
      session,
      getJob,
      approveJob,
      discover,
      page,
      browse,
      related,
      getBinding,
      connectionJobs,
    };
  };
  it("requires host authentication before reading or describing records", async () => {
    const { app, session } = setup(null);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/integrations/read",
          payload: { action: "list", connection: "allowed", entity: "items" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject("/api/integrations/connections/allowed/entities/items")).statusCode,
    ).toBe(401);
    expect(session).not.toHaveBeenCalled();
  });

  it("scopes preparation recovery and activation routes before accessing private state", async () => {
    const anonymous = setup(null);
    const path = "/api/integrations/preparations/12345678-1234-4234-8234-123456789abc";
    expect((await anonymous.app.inject(`${path}/activation`)).statusCode).toBe(401);
    expect(
      (
        await anonymous.app.inject({
          method: "POST",
          url: `${path}/activate`,
          payload: { revision: 1, fingerprint: "review" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await anonymous.app.inject("/api/integrations/connections/allowed/preparations")).statusCode,
    ).toBe(401);
    expect(anonymous.getJob).not.toHaveBeenCalled();
    expect(anonymous.getBinding).not.toHaveBeenCalled();
    const authorized = setup();
    expect(
      (await authorized.app.inject("/api/integrations/connections/other/preparations")).statusCode,
    ).toBe(404);
    expect(authorized.connectionJobs).not.toHaveBeenCalled();
    const response = await authorized.app.inject(
      "/api/integrations/connections/allowed/preparations",
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, jobs: [] });
    expect(response.body).not.toContain("secretAccountValue");
    expect(authorized.connectionJobs).toHaveBeenCalledWith("tenant-a", "allowed");
    expect(
      (
        await authorized.app.inject({
          method: "POST",
          url: `${path}/activate`,
          payload: { revision: 1, fingerprint: "review", tenant: "other" },
        })
      ).statusCode,
    ).toBe(400);
    expect(authorized.getJob).not.toHaveBeenCalled();
    authorized.getJob.mockResolvedValue({ target: { connection: "revoked" } });
    expect((await authorized.app.inject(`${path}/activation`)).statusCode).toBe(409);
    expect(
      (
        await authorized.app.inject({
          method: "POST",
          url: `${path}/activate`,
          payload: { revision: 1, fingerprint: "review" },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("refuses caller-supplied tenant scope and connections outside the host grant", async () => {
    const { app, session } = setup();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/integrations/read",
          payload: { action: "list", connection: "allowed", entity: "items", tenant: "tenant-b" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/integrations/read",
          payload: {
            action: "read",
            ref: { connection: "other", entity: "items", keys: { id: "same" } },
          },
        })
      ).statusCode,
    ).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/integrations/read",
          payload: { action: "list", connection: "allowed", entity: "items" },
        })
      ).statusCode,
    ).toBe(200);
    expect(session).toHaveBeenCalledWith({
      tenant: "tenant-a",
      authorizationRevision: "permissions-1",
      connections: ["allowed"],
    });
  });
  it("does not expose or approve a job for a revoked connection", async () => {
    const { app, getJob, approveJob } = setup();
    getJob.mockResolvedValue({ target: { connection: "revoked" } });
    const path = "/api/integrations/preparations/12345678-1234-4234-8234-123456789abc";
    expect((await app.inject(path)).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${path}/approve`,
          payload: { revision: 1, contractFingerprint: "a" },
        })
      ).statusCode,
    ).toBe(404);
    expect(approveJob).not.toHaveBeenCalled();
  });

  it("routes record-browser reads through the same authorized session", async () => {
    const { app, discover, page, browse, related } = setup();
    expect((await app.inject("/api/integrations/connections/other/entities")).statusCode).toBe(404);
    expect(discover).not.toHaveBeenCalled();
    expect((await app.inject("/api/integrations/connections/allowed/entities")).statusCode).toBe(
      200,
    );
    expect(discover).toHaveBeenCalledWith("allowed");
    const ref = { connection: "allowed", entity: "items", keys: { id: "same" }, context: {} };
    for (const action of ["page", "related"] as const) {
      const payload = {
        action,
        ref,
        ...(action === "related" ? { relationship: "owner", direction: "forward" } : {}),
      };
      expect(
        (await app.inject({ method: "POST", url: "/api/integrations/read", payload })).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/integrations/read",
            payload: { ...payload, tenant: "another" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/integrations/read",
            payload: { ...payload, ref: { ...ref, connection: "other" } },
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(page).toHaveBeenCalledOnce();
    expect(page).toHaveBeenCalledWith(ref);
    expect(related).toHaveBeenCalledWith(ref, "owner", "forward");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/integrations/read",
          payload: { action: "browse", connection: "allowed", entity: "items" },
        })
      ).statusCode,
    ).toBe(200);
    expect(browse).toHaveBeenCalledWith("allowed", "items");
  });
});
