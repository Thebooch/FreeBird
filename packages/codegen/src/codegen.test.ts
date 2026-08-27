import { describe, expect, it } from "vitest";
import { parseManifest, type RegistrationManifest } from "@freebirdai/manifest";
import {
  checkDrift,
  generateIntegration,
  relativeImport,
} from "./index.js";

const frameworkManifest: RegistrationManifest = parseManifest({
  version: 1,
  components: [
    {
      id: "heroSection",
      title: "Hero",
      description: "Landing hero.",
      tags: ["marketing"],
      kind: "framework-component",
      source: { file: "src/components/Hero.vue" },
      knowledge: ["Above the fold."],
    },
    {
      id: "pricingTable",
      title: "Pricing",
      description: "Plan pricing.",
      kind: "framework-component",
      source: { file: "src/components/Pricing.tsx", exportName: "PricingTable" },
      actions: [
        {
          id: "start_trial",
          description: "Start a free trial",
          kind: "server",
          server: { type: "webhook", webhook: "billing" },
        },
      ],
    },
  ],
});

describe("relativeImport", () => {
  it("computes a bundler-friendly relative specifier", () => {
    expect(relativeImport("src/freebird", "src/components/Hero.vue")).toBe(
      "../components/Hero.vue",
    );
    expect(relativeImport("src/freebird", "src/freebird/ids.ts")).toBe("./ids");
  });
});

describe("generateIntegration — vue", () => {
  const result = generateIntegration(frameworkManifest, { framework: "vue" });

  it("emits ids, client, server, and mount files", () => {
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "src/freebird/client-registry.ts",
      "src/freebird/ids.ts",
      "src/freebird/server-registry.ts",
      "src/freebird/server.ts",
    ]);
  });

  it("ids.ts carries every canonical id exactly once", () => {
    const ids = result.files.find((f) => f.path.endsWith("ids.ts"))!.contents;
    expect(ids).toContain("heroSection:");
    expect(ids).toContain("pricingTable:");
    expect(result.ids).toEqual(["heroSection", "pricingTable"]);
  });

  it("client registry imports component sources and uses Vue's h()", () => {
    const client = result.files.find((f) => f.path.endsWith("client-registry.ts"))!.contents;
    expect(client).toContain('import heroSection from "../components/Hero.vue"');
    expect(client).toContain('import { PricingTable as pricingTable } from "../components/Pricing"');
    expect(client).toContain("h(heroSection, props");
    expect(client).toContain("FREEBIRD_IDS.heroSection");
  });

  it("server registry references FREEBIRD_IDS and stubs dataSource", () => {
    const server = result.files.find((f) => f.path.endsWith("server-registry.ts"))!.contents;
    expect(server).toContain("FREEBIRD_IDS.pricingTable");
    expect(server).toContain("dataSource: async () => ({})");
  });

  it("includes an implement-actions step because the manifest declares actions", () => {
    expect(result.steps.map((s) => s.id)).toContain("implement-actions");
    expect(result.warnings).toEqual([]);
  });
});

describe("generateIntegration — next", () => {
  it("emits a route handler under app/freebird", () => {
    const result = generateIntegration(frameworkManifest, { framework: "next" });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("app/freebird/[...route]/route.ts");
    const client = result.files.find((f) => f.path.includes("client-registry"))!;
    expect(client.path.endsWith(".tsx")).toBe(true);
    expect(client.contents).toContain("createElement(");
  });
});

describe("generateIntegration — static", () => {
  it("emits no files and warns to use the embed", () => {
    const domManifest = parseManifest({
      version: 1,
      components: [
        { id: "hours", title: "Hours", description: "d", kind: "dom-region", source: { selector: "#hours" } },
      ],
    });
    const result = generateIntegration(domManifest, { framework: "static" });
    expect(result.files).toHaveLength(0);
    expect(result.warnings[0]).toContain("@freebirdai/embed");
    expect(result.steps.map((s) => s.id)).toContain("add-embed-script");
  });
});

describe("generateIntegration — mixed kinds warn", () => {
  it("warns when a non-framework component is generated for a framework target", () => {
    const mixed = parseManifest({
      version: 1,
      components: [
        { id: "hero", title: "Hero", description: "d", kind: "framework-component", source: { file: "src/Hero.tsx" } },
        { id: "hours", title: "Hours", description: "d", kind: "dom-region", source: { selector: "#hours" } },
      ],
    });
    const result = generateIntegration(mixed, { framework: "react" });
    expect(result.warnings.some((w) => w.includes("hours"))).toBe(true);
  });
});

describe("checkDrift", () => {
  it("passes when every source matches the manifest", () => {
    const report = checkDrift(frameworkManifest, {
      client: ["heroSection", "pricingTable"],
      server: ["pricingTable", "heroSection"],
    });
    expect(report.ok).toBe(true);
    expect(report.messages[0]).toContain("in sync");
  });

  it("reports missing and unexpected ids per source", () => {
    const report = checkDrift(frameworkManifest, {
      client: ["heroSection"], // missing pricingTable
      server: ["heroSection", "pricingTable", "ghost"], // extra ghost
    });
    expect(report.ok).toBe(false);
    expect(report.bySource.client!.missing).toEqual(["pricingTable"]);
    expect(report.bySource.server!.extra).toEqual(["ghost"]);
    expect(report.messages.join(" ")).toContain("missing pricingTable");
    expect(report.messages.join(" ")).toContain("unexpected ghost");
  });
});
