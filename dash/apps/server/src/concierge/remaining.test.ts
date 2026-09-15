import { describe, expect, it } from "vitest";
import type { DraftPatch } from "@freebirdai/dash-agent";
import {
  buildAll,
  fakeLlm,
  newDraft,
  revise,
  mapApi,
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
    /*
     * A two-part setup, written out rather than proposed.
     *
     * What is under test is downstream of whoever wrote the patch: a choice
     * offered on the *second* part has to stay attached to that part and to
     * its own account, rather than being answered against the first. Three
     * accounts all carrying an endpoint called `items` is the arrangement that
     * makes a mix-up invisible — every option reads the same.
     */
    const patch: DraftPatch = {
      connection: "first",
      endpoint: "items",
      component: "list",
      title: "Names",
      roles: { title: ["name"] },
      parts: [
        {
          connection: "second",
          endpoint: "items",
          component: "list",
          title: "Names",
          roles: { title: ["name"] },
          choiceBetween: {
            role: "primary",
            options: [
              {
                op: "items",
                label: "Items (second)",
                whatItIs: "What this is built from now.",
                value: "option-0",
                connection: "second",
              },
              {
                op: "items",
                label: "Items (third)",
                whatItIs: "The third account",
                value: "option-1",
                connection: "third",
              },
            ],
          },
        },
      ],
      group: { title: "Names and Names", display: "tabs" },
    };
    const revised = revise(newDraft("d", "both lists", "assisted"), patch, context);
    expect(revised.rejected).toEqual([]);
    const other = revised.draft.parts[1]?.choice?.options.find(
      (option) => option.connection === "third",
    );
    expect(other, JSON.stringify({ patch, draft: revised.draft })).toBeDefined();
    const selected = applyStepAcross(revised.draft, "p1:choice", [other!.value!], context);
    expect(selected.connection).toBe("first");
    expect(selected.parts[1]?.connection).toBe("third");
    expect(selected.parts[1]?.op).toBe("items");
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
    /*
     * Two measurements over one axis, stated rather than planned.
     *
     * The failure this guards is in the *building*: a conversion recorded for
     * the first source and forgotten for the second produces a chart where one
     * series is in dollars and the other in cents — two lines on one axis,
     * both plausible, a hundredfold apart.
     */
    const shape = {
      groupBy: [{ field: "when", bucket: "{{range.grain}}" }],
      measures: [{ as: "price_amount", agg: "sum" as const, field: "price.amount" }],
      sort: [{ field: "when", dir: "asc" as const }],
    };
    const conversions = {
      coercions: {
        "price.amount": "money:cents->major" as const,
        when: "iso->datetime" as const,
      },
      format: { "price.amount": { semantic: "currency" as const, currency: "USD" } },
    };
    const patch: DraftPatch = {
      connection: "money",
      endpoint: "charges",
      component: "timeseries",
      title: "Money over time",
      ...conversions,
      shape,
      seriesWith: [{ endpoint: "refunds", label: "refunds", shape, ...conversions }],
    };
    expect(patch.seriesWith).toHaveLength(1);
    const revised = revise(newDraft("d", "compare", "assisted"), patch, context);
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
      JSON.stringify({ rows: output.rows, sources: widget.sources, patch }),
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
    /*
     * Two accounts, one endpoint id, and a choice between them. The step API
     * is what has to resolve the answer to an *account*, since the option's
     * own label is all that distinguishes them.
     */
    const patch: DraftPatch = {
      connection: "first",
      endpoint: "items",
      component: "list",
      title: "Names",
      roles: { title: ["name"] },
      choiceBetween: {
        role: "primary",
        options: [
          {
            op: "items",
            label: "Items (first)",
            whatItIs: "What this is built from now.",
            value: "option-0",
            connection: "first",
          },
          {
            op: "items",
            label: "Items (second)",
            whatItIs: "The other account",
            value: "option-1",
            connection: "second",
          },
        ],
      },
    };
    const draft = revise(newDraft("d", "names", "assisted"), patch, context).draft;
    const other = draft.choice?.options.find((option) => option.connection === "second");
    expect(other, JSON.stringify({ patch, draft })).toBeDefined();
    const selected = applyStepAcross(draft, "choice", [other!.value!], context);
    expect(selected.connection).toBe("second");
    expect(selected.op).toBe("items");
    expect(selected.coercions).toEqual({});
  });

  it("resumes only failed map batches and invalidates changed contracts", async () => {
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
