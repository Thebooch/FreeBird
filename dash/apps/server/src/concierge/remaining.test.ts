import { describe, expect, it } from "vitest";
import {
  buildAll,
  fakeLlm,
  newDraft,
  revise,
  mapApi,
  labelFields,
  applyStepAcross,
} from "@freebirdai/dash-agent";
import {
  connectionSchema,
  resourceSchema,
  getOp,
  resolveRange,
  connectionKeyRefs,
} from "@freebirdai/dash-spec";
import { executeWidget } from "@freebirdai/dash-runtime";
import { RestAdapter } from "@freebirdai/dash-adapters";
import { buildConciergeContext } from "./context.js";
import { proposeSetup } from "./propose.js";
import { parseOpenApi } from "../discovery/openapi.js";
import { connectionFromCatalog } from "../catalog.js";
import { CatalogStore } from "../catalog.js";
import { mapRoutes } from "../routes/map.js";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogEntrySchema } from "@freebirdai/dash-spec";

describe("remaining guided setup contracts", () => {
  it("keeps a secondary ambiguity attached to its own widget and account", async () => {
    const connections = ["first", "second", "third"].map((id) =>
      connectionSchema.parse({
        id,
        title: id,
        kind: "rest",
        ops: [
          {
            id: "items",
            title: "Items",
            path: "/items",
            fields: [{ name: "name", kinds: ["string"] }],
          },
        ],
      }),
    );
    const context = buildConciergeContext({ connections, reports: [] });
    const binding = { component: "list", title: "Names", titleField: "name", rowsPath: "$" };
    const proposed = await proposeSetup({
      llm: fakeLlm([
        {
          args: {
            primary: "c0-op0",
            secondary: "c1-op0",
            relationship: "alongside",
            reason: "Two accounts",
            alternatives: [{ id: "c2-op0", role: "secondary", whatItIs: "The third account" }],
          },
        },
        { args: binding },
        { args: binding },
      ]),
      intent: "both lists",
      context,
    });
    const revised = revise(newDraft("d", "both lists", "assisted"), proposed.patch, context);
    expect(revised.rejected).toEqual([]);
    const other = revised.draft.parts[1]?.choice?.options.find(
      (option) => option.connection === "third",
    );
    expect(other, JSON.stringify({ proposed, draft: revised.draft })).toBeDefined();
    const selected = applyStepAcross(revised.draft, "p1:choice", [other!.value!], context);
    expect(selected.connection).toBe("first");
    expect(selected.parts[1]?.connection).toBe("third");
    expect(selected.parts[1]?.op).toBe("items");
  });

  it("persists batch checkpoints and resumes failed labels through the same map route", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dash-map-resume-"));
    const catalog = new CatalogStore(join(directory, "seed"), join(directory, "overlay"));
    catalog.put(
      catalogEntrySchema.parse({
        id: "api",
        title: "API",
        baseUrl: "https://example.com",
        dialect: {},
        resources: [{ id: "items", title: "Items", listOp: "items" }],
        ops: [
          {
            id: "items",
            title: "Items",
            path: "/items",
            fields: Array.from({ length: 151 }, (_, index) => ({
              name: `Field${index}`,
              kinds: ["string"],
            })),
          },
        ],
      }),
    );
    const mapper = fakeLlm([
      { args: { descriptions: [{ op: "items", description: "All the items." }] } },
    ]);
    const labeler = fakeLlm([
      { args: { labels: [{ name: "Field0", label: "First value" }] } },
      { text: "failed" },
      { args: { labels: [] } },
    ]);
    const app = Fastify();
    await app.register(
      mapRoutes({
        catalog,
        llm: (task) => (task === "map" ? mapper : labeler),
        fetchDocument: async (url) => ({
          status: 200,
          url,
          text: JSON.stringify({
            openapi: "3.0.3",
            info: { title: "API" },
            servers: [{ url: "https://example.com" }],
            security: [],
            paths: {
              "/items": {
                get: {
                  operationId: "items",
                  responses: {
                    "200": {
                      content: {
                        "application/json": {
                          schema: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                Field0: { type: "string" },
                                NewField: { type: "number" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          }),
        }),
      }),
    );
    try {
      const first = await app.inject({ method: "POST", url: "/api/catalog/api/map", payload: {} });
      expect(first.statusCode).toBe(200);
      expect(first.json().errors).toHaveLength(1);
      const saved = new CatalogStore(join(directory, "seed"), join(directory, "overlay")).get(
        "api",
      )!;
      expect(saved.mapVersion).toBeDefined();
      expect(saved.labelVersion).toBeUndefined();
      expect(saved.labelProgress?.batches).toHaveLength(1);
      const retry = await app.inject({ method: "POST", url: "/api/catalog/api/map", payload: {} });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().errors).toEqual([]);
      expect(mapper.calls).toHaveLength(1);
      expect(labeler.calls).toHaveLength(3);
      expect(catalog.get("api")?.labels.Field0).toBe("First value");
      expect(catalog.get("api")?.ops[0]?.description).toBe("All the items.");
      expect(catalog.get("api")?.labelVersion).toBeDefined();
      const refreshed = await app.inject({
        method: "POST",
        url: "/api/catalog/api/refresh",
        payload: { specUrl: "https://example.com/openapi.json" },
      });
      expect(refreshed.statusCode).toBe(200);
      expect(catalog.get("api")?.mapVersion).toBeUndefined();
      expect(catalog.get("api")?.labelVersion).toBeUndefined();
      expect(catalog.get("api")?.labels.Field0).toBe("First value");
      expect(mapper.calls).toHaveLength(1);
      expect(labeler.calls).toHaveLength(3);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps cents and date conversions on both comparison sources", async () => {
    const connection = connectionSchema.parse({
      id: "money",
      title: "Money",
      kind: "rest",
      ops: ["charges", "refunds"].map((id) => ({
        id,
        title: id,
        path: `/${id}`,
        rowsPath: "$.data",
        fields: [
          { name: "when", kinds: ["string"], format: "iso8601" },
          { name: "price.amount", kinds: ["number"] },
        ],
      })),
    });
    const context = buildConciergeContext({ connections: [connection], reports: [] });
    const binding = {
      component: "timeseries",
      title: "Money over time",
      rowsPath: "$.data",
      timeField: "when",
      valueField: "price.amount",
      aggregation: "sum",
      coercions: [
        { field: "price.amount", coercion: "money:cents->major" },
        { field: "when", coercion: "iso->datetime" },
      ],
      semantics: [{ field: "price.amount", semantic: "currency" }],
      currency: "USD",
    };
    const proposed = await proposeSetup({
      llm: fakeLlm([
        {
          args: {
            primary: "charges",
            secondary: "refunds",
            relationship: "compare",
            reason: "Both in dollars",
          },
        },
        { args: binding },
        { args: binding },
      ]),
      intent: "charges and refunds in dollars",
      context,
    });
    expect(proposed.patch.seriesWith).toHaveLength(1);
    const revised = revise(newDraft("d", "compare", "assisted"), proposed.patch, context);
    expect(revised.rejected).toEqual([]);
    const built = buildAll(revised.draft, context);
    expect(built.errors).toEqual([]);
    const widget = built.widgets[0]!;
    const body = { data: [{ when: "2026-09-01T00:00:00Z", price: { amount: 12345 } }] };
    const output = executeWidget(
      widget,
      Object.fromEntries(widget.sources.map((source) => [source.as, body])),
      {
        now: Date.UTC(2026, 8, 9),
        params: { range: resolveRange({ preset: "30d", now: Date.UTC(2026, 8, 9) }), filters: {} },
        timeZone: "UTC",
      },
    );
    expect(output.errors).toEqual([]);
    expect(output.rows).toHaveLength(2);
    expect(
      output.rows.every((row) => Object.values(row).includes(123.45)),
      JSON.stringify({ rows: output.rows, sources: widget.sources, patch: proposed.patch }),
    ).toBe(true);
    expect(Object.values(widget.format)).toContainEqual(
      expect.objectContaining({ semantic: "currency", currency: "USD" }),
    );
  });

  it("resolves a duplicate endpoint choice to the selected account in the actual step API", async () => {
    const connections = ["first", "second"].map((id) =>
      connectionSchema.parse({
        id,
        title: id,
        kind: "rest",
        ops: [
          {
            id: "items",
            title: "Items",
            path: "/items",
            fields: [{ name: "name", kinds: ["string"] }],
          },
        ],
      }),
    );
    const context = buildConciergeContext({ connections, reports: [] });
    const proposed = await proposeSetup({
      llm: fakeLlm([
        {
          args: {
            primary: "c0-op0",
            reason: "Names from either account",
            alternatives: [{ id: "c1-op0", role: "primary", whatItIs: "The other account" }],
          },
        },
        { args: { component: "list", title: "Names", titleField: "name", rowsPath: "$" } },
      ]),
      intent: "names",
      context,
    });
    const draft = revise(newDraft("d", "names", "assisted"), proposed.patch, context).draft;
    const other = draft.choice?.options.find((option) => option.connection === "second");
    expect(other, JSON.stringify({ proposed, draft })).toBeDefined();
    const selected = applyStepAcross(draft, "choice", [other!.value!], context);
    expect(selected.connection).toBe("second");
    expect(selected.op).toBe("items");
    expect(selected.coercions).toEqual({});
  });

  it("resumes only failed map and label batches and invalidates changed contracts", async () => {
    const ops = Array.from({ length: 26 }, (_, index) => ({
      id: `op${index}`,
      title: `Items ${index}`,
      path: `/items${index}`,
      fields: [],
    }));
    const input = {
      apiTitle: "API",
      ops,
      resources: ops.map((op) =>
        resourceSchema.parse({ id: op.id, title: op.title, listOp: op.id }),
      ),
    };
    const checkpoints: string[][] = [];
    const first = await mapApi(fakeLlm([{ args: {} }, { text: "failed" }]), input, {
      onCheckpoint: (result) => checkpoints.push([...result.completedBatches]),
    });
    expect(first.errors).toHaveLength(1);
    expect(checkpoints).toHaveLength(1);
    const retry = fakeLlm([{ args: {} }]);
    const resumed = await mapApi(retry, input, { completedBatches: first.completedBatches });
    expect(retry.calls).toHaveLength(1);
    expect(resumed.errors).toEqual([]);
    const changed = fakeLlm([{ args: {} }]);
    await mapApi(
      changed,
      { ...input, ops: ops.map((op) => ({ ...op, path: op.path + "/new" })) },
      { completedBatches: resumed.completedBatches },
    );
    expect(changed.calls).toHaveLength(2);
    const labelsInput = {
      apiTitle: "API",
      ops: [
        {
          id: "items",
          title: "Items",
          fields: Array.from({ length: 151 }, (_, index) => ({
            name: `Field${index}`,
            kinds: ["string" as const],
            nullable: false,
          })),
        },
      ],
    };
    const named = await labelFields(
      fakeLlm([{ args: { labels: [] } }, { text: "failed" }]),
      labelsInput,
    );
    const labelRetry = fakeLlm([{ args: { labels: [] } }]);
    expect(
      (await labelFields(labelRetry, labelsInput, { completedBatches: named.completedBatches }))
        .errors,
    ).toEqual([]);
    expect(labelRetry.calls).toHaveLength(1);
  });

  it("imports and executes endpoint auth overrides without leaking the default credential", async () => {
    const response = {
      responses: {
        "200": {
          content: { "application/json": { schema: { type: "array", items: { type: "object" } } } },
        },
      },
    };
    const doc = {
      openapi: "3.0.3",
      info: { title: "Mixed auth" },
      servers: [{ url: "https://example.com" }],
      security: [{ main: [] }],
      components: {
        securitySchemes: {
          main: { type: "http", scheme: "bearer" },
          admin: { type: "apiKey", in: "header", name: "X-Admin" },
        },
      },
      paths: {
        "/public": { get: { ...response, operationId: "public", security: [] } },
        "/admin": { get: { ...response, operationId: "admin", security: [{ admin: [] }] } },
        "/private": { get: { ...response, operationId: "private" } },
      },
    };
    const parsed = parseOpenApi(doc, "https://example.com/openapi.json");
    expect(parsed).not.toBeNull();
    const connection = connectionFromCatalog(parsed!.entry, { id: "account" });
    expect(connectionKeyRefs(connection)).toHaveLength(2);
    const calls: Record<string, string>[] = [];
    const adapter = new RestAdapter(async (url, init) => {
      calls.push(init.headers);
      return { status: 200, url, text: "[]", header: () => null };
    });
    const ctx = {
      now: 0,
      params: { range: resolveRange({ preset: "30d", now: 0 }), filters: {} },
      resolveSecret: async (ref: string) =>
        ref === connectionKeyRefs(connection)[0] ? "admin-secret" : "default-secret",
    };
    for (const path of ["/public", "/admin", "/private"])
      await adapter.fetch(
        connection,
        getOp(connection, connection.ops.find((op) => op.path === path)!.id)!,
        {},
        ctx,
      );
    expect(calls[0]).not.toHaveProperty("authorization");
    expect(calls[0]).not.toHaveProperty("x-admin");
    expect(calls[1]).toHaveProperty("x-admin", "admin-secret");
    expect(calls[1]).not.toHaveProperty("authorization");
    expect(calls[2]).toHaveProperty("authorization", "Bearer default-secret");
  });
});
