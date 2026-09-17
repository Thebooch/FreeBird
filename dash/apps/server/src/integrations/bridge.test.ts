import { describe, expect, it, vi } from "vitest";
import { connectionSchema, integrationDefinitionSchema } from "@freebirdai/dash-spec";
import { extractIntegrationRows, integrationReadDependencies } from "./bridge.js";
import { IntegrationReadSession } from "./read.js";
import type { IntegrationRepository } from "./repository.js";
import type { SpecStore } from "../store.js";
import type { KeyStore } from "../vault.js";

describe("pinned integration adapter bridge", () => {
  it("distinguishes empty collections from broken extraction contracts", () => {
    expect(extractIntegrationRows({ data: [] }, "$.data")).toEqual([]);
    expect(extractIntegrationRows({ data: [] }, "$.data[*].record")).toEqual([]);
    expect(extractIntegrationRows({ data: [{ record: { id: 1 } }] }, "$.data[*].record")).toEqual([
      { id: 1 },
    ]);
    expect(() => extractIntegrationRows({ results: [] }, "$.data")).toThrow("record path");
    expect(() => extractIntegrationRows({ data: [{ other: 1 }] }, "$.data[*].record")).toThrow(
      "record path",
    );
    expect(() =>
      extractIntegrationRows({ data: [{ id: 1 }, null, "not a record"] }, "$.data"),
    ).toThrow("requires records");
  });
  it("reuses reads only within the same tenant, authorization and pinned binding", async () => {
    const connection = connectionSchema.parse({
      id: "account",
      title: "Account",
      kind: "rest",
      baseUrl: "https://example.com",
      ops: [{ id: "items", title: "Items", path: "/items", rowsPath: "$" }],
    });
    let integration = "first";
    let revision = 1;
    const definition = () =>
      integrationDefinitionSchema.parse({
        id: integration,
        version: "one",
        title: "Service",
        protocol: "rest",
        origin: "manual",
        schemaFingerprint: integration,
        operations: [
          {
            id: "items",
            title: "Items",
            path: `/${integration}`,
            rowsPath: "$",
            pagination: { kind: "none" },
          },
        ],
        entities: [
          {
            id: "item",
            title: "Items",
            identity: [{ name: "id", field: "id" }],
            fields: [{ id: "id", name: "id", kinds: ["string"] }],
            listOp: "items",
          },
        ],
        relationships: [],
      });
    const repository = {
      getBinding: async (tenant: string) => ({
        owner: tenant,
        binding: {
          connection: "account",
          integration,
          version: "one",
          revision,
          context: {},
          disabledRelationships: [],
        },
      }),
      getVersion: async () => definition(),
    } as unknown as IntegrationRepository;
    const http = vi.fn(async (url: string) => ({
      url,
      status: 200,
      text: JSON.stringify([{ id: integration }]),
      header: () => null,
    }));
    const dependencies = integrationReadDependencies({
      repository,
      store: { getConnection: () => connection } as unknown as SpecStore,
      keys: { get: vi.fn() } as unknown as KeyStore,
      http,
      graphqlHttp: vi.fn(),
    });
    const read = (tenant = "tenant", authorizationRevision = "auth-1") =>
      new IntegrationReadSession(
        dependencies({ tenant, authorizationRevision, connections: ["account"] }),
        { tenant, authorizationRevision, maxRequests: 3, maxRows: 10 },
      ).list("account", "item");
    await read();
    await read();
    expect(http).toHaveBeenCalledTimes(1);
    integration = "second";
    expect((await read()).records[0]?.values.id).toBe("second");
    expect(http).toHaveBeenCalledTimes(2);
    revision++;
    await read();
    await read("another-tenant");
    await read("tenant", "auth-2");
    expect(http).toHaveBeenCalledTimes(5);
    http.mockResolvedValue({
      url: "https://example.com/items",
      status: 404,
      text: "Gone",
      header: () => null,
    });
    await expect(read("tenant", "auth-3")).rejects.toMatchObject({ code: "missing" });
    http.mockResolvedValue({
      url: "https://example.com/items",
      status: 403,
      text: "Denied",
      header: () => null,
    });
    await expect(read("tenant", "auth-4")).rejects.toMatchObject({ code: "denied" });
    http.mockResolvedValue({
      url: "https://example.com/items",
      status: 503,
      text: "Unavailable",
      header: () => null,
    });
    await expect(read("tenant", "auth-5")).rejects.toMatchObject({
      status: 502,
      upstreamStatus: 503,
    });
  });

  it("rejects a binding revision change between planning and fetching without network access", async () => {
    const connection = connectionSchema.parse({
      id: "account",
      title: "Account",
      kind: "rest",
      baseUrl: "https://example.com",
      ops: [{ id: "items", title: "Items", path: "/items" }],
    });
    const definition = integrationDefinitionSchema.parse({
      id: "service",
      version: "one",
      title: "Service",
      protocol: "rest",
      origin: "manual",
      schemaFingerprint: "s",
      operations: [{ id: "items", title: "Items", path: "/items" }],
      entities: [
        {
          id: "item",
          title: "Items",
          identity: [{ name: "id", field: "id" }],
          fields: [{ id: "id", name: "id", kinds: ["string"] }],
          listOp: "items",
        },
      ],
      relationships: [],
    });
    const binding = {
      owner: "tenant",
      binding: {
        connection: "account",
        integration: "service",
        version: "one",
        revision: 1,
        context: {},
        disabledRelationships: [],
      },
    };
    const repository = {
      getVersion: vi.fn(async () => definition),
      getBinding: vi
        .fn()
        .mockResolvedValueOnce(binding)
        .mockResolvedValue({ ...binding, binding: { ...binding.binding, revision: 2 } }),
    } as unknown as IntegrationRepository;
    const http = vi.fn();
    const deps = integrationReadDependencies({
      repository,
      store: { getConnection: () => connection } as unknown as SpecStore,
      keys: { get: vi.fn() } as unknown as KeyStore,
      http,
      graphqlHttp: vi.fn(),
    })({ tenant: "tenant", authorizationRevision: "auth-1", connections: ["account"] });
    const session = new IntegrationReadSession(deps, {
      tenant: "tenant",
      authorizationRevision: "auth-1",
      maxRequests: 3,
      maxRows: 10,
    });
    await expect(session.list("account", "item")).rejects.toThrow("changed during this read");
    expect(http).not.toHaveBeenCalled();
  });
});
