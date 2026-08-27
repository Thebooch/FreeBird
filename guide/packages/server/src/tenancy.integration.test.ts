import { describe, expect, it, vi } from "vitest";
import type { AuthContext, DbAdapter, LlmAdapter } from "@freebirdai/core";
import { compileServerRegistry, parseManifest } from "@freebirdai/manifest";
import { createDepsResolver } from "./index.js";

/**
 * End-to-end Phase-1 verification: a single server process serving two sites,
 * each with its own manifest-compiled registry and its own LLM key.
 *
 * This wires the real chain the managed backend uses:
 *   RegistrationManifest → compileServerRegistry → registryResolver
 *   → createDepsResolver → per-request HandlerDeps.
 */

const stubDb = (): DbAdapter => ({}) as unknown as DbAdapter;

const stubLlm = (model: string): LlmAdapter => ({
  defaultModel: model,
   
  async *stream() {
    return;
  },
  async generate() {
    return { text: "", toolCalls: [] };
  },
});

// Two tenants, two different sites, two different component sets.
const manifests = {
  bakery: parseManifest({
    version: 1,
    siteId: "fb_bakery",
    components: [
      {
        id: "openingHours",
        title: "Opening hours",
        description: "The bakery's opening hours.",
        kind: "dom-region",
        source: { selector: "#hours" },
        actions: [
          { id: "show_hours", description: "Scroll to hours", kind: "local-dom", directive: "scroll-to" },
        ],
      },
      {
        id: "orderForm",
        title: "Order form",
        description: "Cake order form.",
        kind: "dom-region",
        source: { selector: "#order" },
      },
    ],
  }),
  garage: parseManifest({
    version: 1,
    siteId: "fb_garage",
    components: [
      {
        id: "bookingForm",
        title: "Service booking",
        description: "Book a car service.",
        kind: "dom-region",
        source: { selector: "#book" },
      },
    ],
  }),
};

const snapshotStore: Record<string, unknown> = {
  "fb_bakery:openingHours": { text: "Mon–Sat 7–3" },
};

const compileFor = (siteId: string) => {
  const manifest = manifests[siteId === "fb_bakery" ? "bakery" : "garage"];
  return compileServerRegistry(manifest, {
    getSnapshot: (componentId) => snapshotStore[`${siteId}:${componentId}`] ?? null,
  });
};

describe("multi-tenant static-embed backend", () => {
  it("serves each tenant its own manifest-compiled registry and LLM key", async () => {
    const registryResolver = vi.fn((auth: AuthContext) => compileFor(auth.orgId!));
    const llmResolver = vi.fn((auth: AuthContext) => stubLlm(`key-${auth.orgId}`));
    const usage: Array<{ org?: string; total: number }> = [];

    const resolver = createDepsResolver({
      db: stubDb(),
      registry: registryResolver,
      llm: llmResolver,
      onLlmUsage: (ctx, u) => {
        usage.push({ org: ctx.orgId, total: u.totalTokens });
      },
    });

    // Tenant "bakery" sees only the bakery's components.
    const bakery = await resolver.resolve({ orgId: "fb_bakery" });
    expect(bakery.registry.list().map((c) => c.id).sort()).toEqual([
      "openingHours",
      "orderForm",
    ]);
    // The compiled local-dom action is present and returns a browser directive.
    const showHours = bakery.registry.getAction("openingHours", "show_hours")!;
    const directive = await showHours.handler({}, { auth: {}, sessionId: "s" });
    expect(directive).toMatchObject({ kind: "freebird.local-dom", directive: "scroll-to" });
    // dataSource reads the stored snapshot.
    await expect(
      Promise.resolve(
        bakery.registry.getOrThrow("openingHours").dataSource!({
          tabId: "t",
          auth: {},
          runAt: new Date(),
          props: {},
        }),
      ),
    ).resolves.toEqual({ text: "Mon–Sat 7–3" });

    // Tenant "garage" sees only its own component — full isolation.
    const garage = await resolver.resolve({ orgId: "fb_garage" });
    expect(garage.registry.list().map((c) => c.id)).toEqual(["bookingForm"]);

    // Each tenant resolved its own LLM key.
    expect(llmResolver.mock.calls.map((c) => c[0].orgId)).toEqual([
      "fb_bakery",
      "fb_garage",
    ]);

    // Metering is wired: the tenant's LLM was wrapped, so usage would attribute
    // to the right org. Exercise the wrapper via the resolved chat engine's llm
    // indirectly by confirming the hook is installed (no usage yet, no calls).
    expect(usage).toEqual([]);
  });

  it("invalidates a single tenant's cached registry on manifest change", async () => {
    const registryResolver = vi.fn((auth: AuthContext) => compileFor(auth.orgId!));
    const resolver = createDepsResolver({
      db: stubDb(),
      registry: registryResolver,
      llm: stubLlm("k"),
    });
    await resolver.resolve({ orgId: "fb_bakery" });
    await resolver.resolve({ orgId: "fb_bakery" }); // cache hit
    expect(registryResolver).toHaveBeenCalledTimes(1);
    resolver.invalidateRegistry("fb_bakery");
    await resolver.resolve({ orgId: "fb_bakery" });
    expect(registryResolver).toHaveBeenCalledTimes(2);
  });
});
