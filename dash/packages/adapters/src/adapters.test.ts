import type { ConnectionSpec, OpSpec, ResolvedParams } from "@freebirdai/dash-spec";
import { connectionSchema, getOp, resolveRange } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { InlineAdapter } from "./inline.js";
import { AdapterRegistry } from "./registry.js";
import { AdapterError, type FetchContext } from "./types.js";

const NOW = Date.UTC(2026, 7, 4);

const params: ResolvedParams = {
  range: resolveRange({ preset: "7d", now: NOW }),
  filters: { region: "emea" },
};

const ctx: FetchContext = { params, now: NOW };

const connection: ConnectionSpec = connectionSchema.parse({
  id: "demo",
  title: "Demo",
  kind: "inline",
  ops: [{ id: "charges", title: "Charges", path: "/charges" }],
});

/** Adapters always receive a resolved op; `getOp` is what resolves it. */
const resolvedOp: OpSpec = getOp(connection, "charges")!;

describe("InlineAdapter", () => {
  it("serves a registered fixture", async () => {
    const adapter = new InlineAdapter({ "demo.charges": { data: [1, 2] } });
    const result = await adapter.fetch(connection, resolvedOp, {}, ctx);

    expect(result.body).toEqual({ data: [1, 2] });
    expect(result.meta).toMatchObject({ url: "inline:demo.charges", status: 200, pages: 1 });
    expect(result.meta.fetchedAt).toBe(NOW);
  });

  it("lets a fixture depend on params, so range changes are observable offline", async () => {
    const adapter = new InlineAdapter().register("demo", "charges", (context) => ({
      grain: context.params.range.grain,
      region: context.params.filters.region,
    }));

    const result = await adapter.fetch(connection, resolvedOp, {}, ctx);
    expect(result.body).toEqual({ grain: "1d", region: "emea" });
  });

  it("fails with a message a non-technical user can act on", async () => {
    const adapter = new InlineAdapter();
    await expect(adapter.fetch(connection, resolvedOp, {}, ctx)).rejects.toThrow(
      AdapterError,
    );
    await expect(
      adapter.fetch(connection, resolvedOp, {}, ctx).catch((e: AdapterError) => e.userMessage),
    ).resolves.toMatch(/expects sample data for "Charges"/);
  });

  it("declares itself safe to run in the browser", () => {
    expect(new InlineAdapter().transport).toBe("direct");
  });

  it("honours an abort signal while simulating latency", async () => {
    const adapter = new InlineAdapter({ "demo.charges": 1 }, { delayMs: 5_000 });
    const controller = new AbortController();
    const pending = adapter.fetch(connection, resolvedOp, {}, {
      ...ctx,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});

describe("AdapterRegistry", () => {
  const registry = new AdapterRegistry()
    .register(new InlineAdapter({ "demo.charges": { ok: true } }))
    .addConnection(connection);

  it("routes a widget source to the adapter for that connection kind", async () => {
    const result = await registry.fetch("demo", "charges", {}, ctx);
    expect(result.body).toEqual({ ok: true });
  });

  it("names the missing piece when a widget outlives its connection", () => {
    expect(() => registry.resolve("gone", "charges")).toThrow(/unknown connection "gone"/);
    expect(() => registry.resolve("demo", "gone")).toThrow(/has no op "gone"/);
  });

  it("reports an unregistered adapter kind rather than failing silently", () => {
    const bare = new AdapterRegistry().addConnection(
      connectionSchema.parse({
        id: "api",
        title: "API",
        kind: "rest",
        baseUrl: "https://api.example.com",
        ops: [{ id: "o", title: "O", path: "/o" }],
      }),
    );
    expect(() => bare.resolve("api", "o")).toThrow(/no adapter registered for kind "rest"/);
  });
});
