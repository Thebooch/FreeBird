import { describe, expect, it } from "vitest";
import {
  buildAll,
  buildFromDraft,
  draftPatchSchema,
  emptyContext,
  fakeLlm,
  inferShape,
  newDraft,
  readiness,
  revise,
} from "@freebirdai/dash-agent";
import {
  capabilityReportSchema,
  catalogEntrySchema,
  connectionSchema,
  fingerprintConnection,
  fingerprintOps,
  getOp,
  isStale,
  parseWidget,
  resolveRange,
} from "@freebirdai/dash-spec";
import { executeWidget } from "@freebirdai/dash-runtime";
import { connectionFromCatalog, refreshCatalogConnection } from "../catalog.js";
import { parseOpenApi } from "../discovery/openapi.js";
import { MemoryCacheStore } from "../cache/memory.js";
import { buildConciergeContext } from "./context.js";
import { proposeSetup } from "./propose.js";
import { SetupPreviews } from "./preview.js";

const entry = catalogEntrySchema.parse({
  id: "vendor",
  title: "Vendor",
  baseUrl: "https://api.example.com",
  dialect: {
    rowsPath: "$.data",
    auth: {
      type: "headers",
      parts: [
        { header: "X-Client", keyRef: "shared-client" },
        { header: "X-Secret", keyRef: "shared-secret" },
      ],
    },
  },
  ops: [
    {
      id: "items",
      title: "Items",
      path: "/items",
      description: "Amounts are in minor currency units.",
      params: [{ name: "status", in: "query", required: true }],
      fields: [{ name: "amount", kinds: ["number"], description: "US cents" }],
    },
  ],
});
const connection = connectionFromCatalog(entry, { id: "first" });

describe("Dash reliability boundaries", () => {
  it("refreshes imported contracts while preserving deliberate local overrides", () => {
    const fresh = catalogEntrySchema.parse({
      ...entry,
      ops: entry.ops.map((op) => ({
        ...op,
        path: "/new-items",
        fields: [{ name: "total", kinds: ["number"] }],
      })),
    });
    const refreshed = refreshCatalogConnection(connection, entry, fresh);
    expect(refreshed.ops[0]?.path).toBe("/new-items");
    expect(refreshed.ops[0]?.fields?.[0]?.name).toBe("total");
    const custom = connectionSchema.parse({
      ...connection,
      ops: connection.ops.map((op) => ({ ...op, path: "/my-items" })),
    });
    expect(refreshCatalogConnection(custom, entry, fresh).ops[0]?.path).toBe("/my-items");
  });

  it("asks for required query inputs before declaring the widget configured", () => {
    const context = buildConciergeContext({ connections: [connection], reports: [] });
    const first = revise(newDraft("d", "items", "assisted"), { endpoint: "items" }, context);
    expect(readiness(first.draft, context).missing[0]?.stepId).toBe("input:status");
    const second = revise(
      first.draft,
      { inputs: { status: "open" }, component: "stat", roles: { value: ["amount"] } },
      context,
    );
    expect(second.rejected).toEqual([]);
    expect(buildFromDraft(second.draft, context).widget?.source?.params).toEqual({
      status: "open",
    });
  });

  it("selects between duplicate endpoint ids using connection-qualified planner candidates", async () => {
    const other = connectionSchema.parse({
      ...connection,
      id: "other",
      ops: [
        {
          id: "items",
          title: "Other",
          path: "/items",
          fields: [{ name: "name", kinds: ["string"] }],
        },
      ],
    });
    const context = buildConciergeContext({ connections: [connection, other], reports: [] });
    const llm = fakeLlm([
      { args: { primary: "c1-op0", reason: "the other account" } },
      { args: { title: "Other names", component: "list", rowsPath: "$.data", titleField: "name" } },
    ]);
    const proposal = await proposeSetup({ llm, context, intent: "the other account's names" });
    expect(proposal.patch).toMatchObject({
      connection: "other",
      endpoint: "items",
      roles: { title: ["name"] },
    });
  });
  it("preserves executable endpoint metadata and gives each account its own secrets", () => {
    const other = connectionFromCatalog(entry, { id: "second" });
    expect(getOp(connection, "items")).toMatchObject({
      rowsPath: "$.data",
      params: [{ name: "status", required: true }],
      fields: [{ name: "amount", description: "US cents" }],
    });
    expect(connection.auth).not.toEqual(other.auth);
    expect(JSON.stringify(connection.auth)).not.toContain("shared-");
  });

  it("keeps duplicate endpoint ids scoped through revise and build", () => {
    const second = connectionSchema.parse({
      ...connection,
      id: "second",
      ops: [
        {
          id: "items",
          title: "Other items",
          path: "/other",
          rowsPath: "$.results",
          fields: [{ name: "name", kinds: ["string"] }],
        },
      ],
    });
    const context = buildConciergeContext({ connections: [connection, second], reports: [] });
    expect(context.shapes.items).toBeUndefined();
    const revised = revise(
      newDraft("draft", "other items", "assisted"),
      { connection: "second", endpoint: "items", component: "list", roles: { title: ["name"] } },
      context,
    );
    expect(revised.rejected).toEqual([]);
    const built = buildFromDraft(revised.draft, context);
    expect(built.widget?.source).toMatchObject({ connection: "second", op: "items" });
    expect(built.widget?.pipeline[0]).toEqual({ op: "extract", path: "$.results" });
  });

  it("applies a measurement after a connection switch and retains unit conversions", async () => {
    const cents = connectionSchema.parse({
      id: "money",
      title: "Money",
      kind: "rest",
      baseUrl: "https://money.example.com",
      ops: [
        {
          id: "charges",
          title: "Charges",
          path: "/charges",
          rowsPath: "$.data",
          fields: [
            { name: "amount", kinds: ["number"], format: "minor_units", description: "US cents" },
          ],
        },
      ],
    });
    const context = buildConciergeContext({ connections: [cents], reports: [] });
    const llm = fakeLlm([
      { args: { primary: "charges", reason: "charges" } },
      {
        args: {
          title: "Revenue",
          component: "stat",
          rowsPath: "$.data",
          valueField: "amount",
          aggregation: "sum",
          coercions: [{ field: "amount", coercion: "money:cents->major" }],
          semantics: [{ field: "amount", semantic: "currency" }],
          currency: "USD",
        },
      },
    ]);
    // The conversion spelling is validated by the real proposal pipeline.
    const proposed = await proposeSetup({ llm, intent: "revenue in dollars", context });
    expect(proposed.patch.endpoint).toBe("charges");
    const multiple = {
      ...context,
      connections: [...context.connections, { id: "other", title: "Other" }],
    };
    expect(proposed.patch.coercions).toEqual({ amount: "money:cents->major" });
    const revised = revise(newDraft("d", "revenue", "assisted"), proposed.patch, multiple);
    expect(revised.rejected).toEqual([]);
    const built = buildAll(revised.draft, multiple);
    expect(built.errors).toEqual([]);
    const result = executeWidget(
      built.widgets[0]!,
      { data: [{ amount: 12345 }] },
      {
        now: 0,
        params: { range: resolveRange({ preset: "30d", now: 0 }), filters: {} },
        timeZone: "UTC",
      },
    );
    expect(JSON.stringify(result.rows)).toContain("123.45");
    expect(Object.values(built.widgets[0]!.format)).toContainEqual(
      expect.objectContaining({ semantic: "currency", currency: "USD" }),
    );
  });

  it("uses the full patch contract for every widget and refuses unknown fields", () => {
    const patch = {
      parts: [
        {
          measure: "count:",
          groupBy: "status",
          controls: [],
          skip: ["groupBy"],
          coercions: {},
          format: {},
        },
      ],
    };
    expect(draftPatchSchema.parse(patch)).toEqual(patch);
    expect(draftPatchSchema.safeParse({ parts: [{ unsupported: true }] }).success).toBe(false);
  });

  it("does not call an API without endpoints ready", () => {
    const draft = { ...newDraft("d"), connection: "api" };
    expect(
      readiness(draft, { ...emptyContext, connections: [{ id: "api", title: "API" }] }).ready,
    ).toBe(false);
  });

  it("invalidates reports for execution changes and ignores title changes", () => {
    const report = capabilityReportSchema.parse({
      connection: connection.id,
      generatedAt: new Date(0).toISOString(),
      opsFingerprint: fingerprintOps(connection.ops),
      connectionFingerprint: fingerprintConnection(connection),
    });
    expect(isStale(report, { ...connection, title: "Renamed" })).toBe(false);
    expect(isStale(report, { ...connection, baseUrl: "https://another.example.com" })).toBe(true);
    expect(
      isStale(report, {
        ...connection,
        ops: connection.ops.map((op) => ({ ...op, query: { size: 50 } })),
      }),
    ).toBe(true);
    const context = buildConciergeContext({
      connections: [{ ...connection, baseUrl: "https://another.example.com" }],
      reports: [{ ...report, shapes: { item: { ...inferShape([{ invented: 1 }]), fields: [] } } }],
    });
    expect(context.readPlans[0]?.stale).toBe(true);
    expect(context.shapes.items?.evidence).toBe("declared");
  });

  it("respects public security and preserves AND authentication requirements", () => {
    const doc = {
      openapi: "3.0.3",
      info: { title: "Test" },
      servers: [{ url: "https://example.com" }],
      components: {
        securitySchemes: {
          client: { type: "apiKey", in: "header", name: "X-Client" },
          secret: { type: "apiKey", in: "header", name: "X-Secret" },
        },
      },
      paths: {
        "/items": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": { schema: { type: "array", items: { type: "object" } } },
                },
              },
            },
          },
        },
      },
    };
    expect(
      parseOpenApi({ ...doc, security: [] }, "https://example.com/openapi.json")?.entry,
    ).toMatchObject({ authRequired: false, dialect: { auth: { type: "none" } } });
    const secured = parseOpenApi(
      { ...doc, security: [{ client: [], secret: [] }] },
      "https://example.com/openapi.json",
    );
    expect(secured?.entry.dialect.auth).toMatchObject({
      type: "headers",
      parts: [{ header: "X-Client" }, { header: "X-Secret" }],
    });
  });

  it("checks actual cached data and invalidates preview evidence after edits or account changes", () => {
    const cache = new MemoryCacheStore();
    let current = connection;
    const previews = new SetupPreviews(
      cache,
      () => current,
      () => 100,
    );
    const widget = parseWidget({
      id: "amount",
      title: "Amount",
      component: "stat",
      source: { connection: "first", op: "items" },
      pipeline: [{ op: "extract", path: "$.data" }],
      roles: { value: "amount" },
    });
    expect(widget.ok).toBe(true);
    if (!widget.ok || !widget.value) return;
    cache.set({
      key: "query",
      body: { data: [{ amount: 123 }] },
      storedAt: 100,
      bytes: 40,
      meta: {
        url: "https://example.com",
        status: 200,
        pages: 1,
        truncated: false,
        warnings: [],
        fetchedAt: 100,
        durationMs: 1,
      },
    });
    const receipt = previews.record("query", current, "items", {
      range: resolveRange({ preset: "30d", now: 100 }),
      filters: {},
    });
    expect(previews.status(widget.value).status).toBe("unchecked");
    expect(previews.validate(widget.value, [{ as: "main", receipt }], "UTC").status).toBe(
      "checked",
    );
    expect(previews.status({ ...widget.value, roles: { value: "missing" } }).status).toBe(
      "unchecked",
    );
    current = { ...current, credentialsRevision: 1 };
    expect(previews.status(widget.value).status).toBe("unchecked");
  });
});
