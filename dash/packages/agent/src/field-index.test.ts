import { describe, expect, it } from "vitest";
import { resourceSchema } from "@freebirdai/dash-spec";
import { SchemaFieldIndex } from "./field-index.js";
import { buildMapPrompt, mapApi, planMapPages, type MapInput } from "./apimap.js";
import { fakeLlm } from "./llm.js";

const input = (): MapInput => ({
  apiTitle: "Unfamiliar inventory",
  resources: [resourceSchema.parse({ id: "parts", title: "Parts", listOp: "list_parts" })],
  ops: [
    {
      id: "list_parts",
      title: "Parts",
      path: "/parts",
      fields: Array.from({ length: 365 }, (_, i) => ({
        name: `f_${String(i).padStart(3, "0")}`,
        kinds: ["string"],
        nullable: false,
        description: i === 364 ? "Identity of the responsible organization" : "Declared value",
      })),
    },
  ],
});

describe("complete schema field index", () => {
  it("finds a field by its meaning beyond the old prompt boundary", () => {
    const index = new SchemaFieldIndex(input().ops);
    expect(index.search({ query: "responsible organization" }).fields[0]?.field.name).toBe("f_364");
    expect(index.search({ limit: 20 })).toMatchObject({ total: 365, nextOffset: 20 });
  });
  it("covers every field exactly once across bounded pages", () => {
    const declared = input();
    const pages = planMapPages(declared);
    expect(pages).toHaveLength(3);
    const names = pages.flatMap((page) => page.fields.fields.map((entry) => entry.field.name));
    expect(names).toHaveLength(365);
    expect(new Set(names).size).toBe(365);
    expect(buildMapPrompt(declared, pages[2]!.resources, pages[2]!.fields)).toContain(
      "responsible organization",
    );
    expect(buildMapPrompt(declared, declared.resources)).toContain("f_364");
  });
  it("requires call authorization before continuing wider schemas and resumes saved pages", async () => {
    const declared = input();
    const firstLlm = fakeLlm([{ args: {} }]);
    const first = await mapApi(firstLlm, declared);
    expect(firstLlm.calls).toHaveLength(1);
    expect(first.completedBatches).toHaveLength(1);
    expect(first.errors.join(" ")).toContain("budget");
    const nextLlm = fakeLlm([{ args: {} }]);
    const next = await mapApi(nextLlm, declared, {
      completedBatches: first.completedBatches,
      maxCalls: 2,
    });
    expect(nextLlm.calls).toHaveLength(2);
    expect(next.completedBatches).toHaveLength(3);
    expect(next.errors).toEqual([]);
  });
  it("does not call the model or lose later checkpoints when a budget refuses work", async () => {
    const declared = input();
    const pages = planMapPages(declared);
    const llm = fakeLlm([{ args: {} }]);
    const result = await mapApi(llm, declared, {
      completedBatches: [pages[2]!.key],
      maxCalls: 10,
      beforeCall: async () => false,
    });
    expect(llm.calls).toHaveLength(0);
    expect(result.completedBatches).toEqual([pages[2]!.key]);
    expect(result.errors.join(" ")).toContain("budget");
  });
  it("invalidates page checkpoints when field contracts change", () => {
    const original = input();
    const changed = structuredClone(original);
    changed.ops[0]!.fields![364]!.description = "A measurement, not an organization reference";
    expect(planMapPages(changed).map((page) => page.key)).not.toEqual(
      planMapPages(original).map((page) => page.key),
    );
  });
  it("keeps distinct reference roles while deduplicating proposals across pages", async () => {
    const wide = input();
    const declared: MapInput = {
      ...wide,
      resources: [
        ...wide.resources,
        resourceSchema.parse({
          id: "organization",
          title: "Organizations",
          listOp: "organizations",
          idField: "id",
        }),
      ],
      ops: [
        ...wide.ops,
        {
          id: "organizations",
          title: "Organizations",
          path: "/organizations",
          fields: [{ name: "id", kinds: ["string"], nullable: false }],
        },
      ],
    };
    const proposal = {
      relations: [
        {
          from: "parts",
          to: "organization",
          localField: "f_010",
          foreignField: "id",
          title: "Assigned organization",
        },
        {
          from: "parts",
          to: "organization",
          localField: "f_364",
          foreignField: "id",
          title: "Billing organization",
        },
      ],
    };
    const result = await mapApi(fakeLlm([{ args: proposal }]), declared, { maxCalls: 3 });
    expect(result.errors).toEqual([]);
    expect(result.relations.parts).toHaveLength(2);
    expect(new Set(result.relations.parts!.map((relation) => relation.id)).size).toBe(2);
    const resumed = await mapApi(
      fakeLlm([{ args: proposal }]),
      {
        ...declared,
        resources: declared.resources.map((resource) =>
          resource.id === "parts"
            ? { ...resource, relations: [result.relations.parts![0]!] }
            : resource,
        ),
      },
      { maxCalls: 3 },
    );
    expect(resumed.relations.parts?.map((relation) => relation.localField)).toEqual(["f_364"]);
  });
  it("does not let callers mutate indexed declarations", () => {
    const index = new SchemaFieldIndex(input().ops);
    index.search().fields[0]!.field.name = "modified";
    index.pages(["list_parts"])[0]!.fields[0]!.field.description = "modified";
    expect(index.search().fields[0]?.field.name).toBe("f_000");
    expect(index.search({ query: "modified" }).total).toBe(0);
  });
});
