import { describe, expect, it } from "vitest";
import { resolveRange, viewIntentSchema } from "@freebirdai/dash-spec";
import { executeWidget } from "@freebirdai/dash-runtime";
import { mapProposal } from "./map.js";
import { inferShape } from "./infer.js";
import { proposalSchema } from "./tool.js";
import { buildFromDraft } from "./concierge/build.js";
import { applyAnswer, conciergeDraftSchema, newDraft } from "./concierge/draft.js";
import { emptyContext } from "./concierge/steps.js";
import { draftPatchSchema } from "./concierge/patch.js";
import { revise } from "./concierge/revise.js";

const rows = [
  { id: "a", title: "First", category: { name: "Repair" }, state: "Open" },
  { id: "b", title: "Second", category: { name: "Inspect" }, state: "Closed" },
];
const shape = inferShape(rows);
const context = {
  ...emptyContext,
  connections: [{ id: "api", title: "API" }],
  ops: [{ id: "items", title: "Items", connection: "api" }],
  shapes: { items: shape },
};
const execute = (widget: NonNullable<ReturnType<typeof mapProposal>["widget"]>) =>
  executeWidget(widget, rows, {
    now: 1000,
    params: { range: resolveRange({ preset: "30d", now: 1000 }), filters: {} },
  });

describe("intended view and controls", () => {
  it("keeps category filtering separate from grouping and preserves all records", () => {
    const result = mapProposal({
      connection: "api",
      op: "items",
      widgetId: "one",
      shape,
      purpose: "browse",
      proposal: proposalSchema.parse({
        title: "Items",
        component: "table",
        rowsPath: "$",
        columns: ["title"],
        availableFilters: ["category.name", "state"],
      }),
    });
    expect(result.errors).toEqual([]);
    expect(
      result.widget?.pipeline.some((step) => step.op === "group" || step.op === "filter"),
    ).toBe(false);
    expect(result.widget?.facets.map((facet) => facet.field)).toEqual(["category_name", "state"]);
    expect(result.widget?.facets.every((facet) => facet.default.length === 0)).toBe(true);
    expect(execute(result.widget!).rows).toHaveLength(2);
    expect(execute(result.widget!).rows[0]?.category_name).toBe("Repair");
  });

  it("refuses a chart when the preceding intent step selected browsing", () => {
    const result = mapProposal({
      connection: "api",
      op: "items",
      widgetId: "one",
      shape,
      purpose: "browse",
      proposal: proposalSchema.parse({
        title: "Items",
        purpose: "summarize",
        component: "bar",
        rowsPath: "$",
        categoryField: "state",
        aggregation: "count",
      }),
    });
    expect(result.widget).toBeNull();
    expect(result.errors.join(" ")).toContain("individual records");
  });

  it("preserves intent and nested filter fields through draft persistence and rebuilding", () => {
    const viewIntent = viewIntentSchema.parse({
      purpose: "browse",
      fields: ["title"],
      availableFilters: ["category.name", "state"],
      decisions: [{ key: "layout", value: "table", source: "user" }],
    });
    const patch = draftPatchSchema.parse({
      connection: "api",
      endpoint: "items",
      component: "table",
      roles: { columns: ["title"] },
      viewIntent,
    });
    const result = revise(
      newDraft("draft", "Items with category filters", "assisted"),
      patch,
      context,
    );
    expect(result.rejected).toEqual([]);
    const restored = conciergeDraftSchema.parse(JSON.parse(JSON.stringify(result.draft)));
    const built = buildFromDraft(restored, context);
    expect(built.errors).toEqual([]);
    expect(built.widget?.viewIntent?.decisions).toEqual(viewIntent.decisions);
    expect(execute(built.widget!).rows[0]?.category_name).toBe("Repair");
    expect(built.widget?.facets).toHaveLength(2);
  });

  it("does not let unavailable or object fields become filter controls", () => {
    for (const field of ["missing", "category"]) {
      const result = mapProposal({
        connection: "api",
        op: "items",
        widgetId: "one",
        shape,
        proposal: proposalSchema.parse({
          title: "Items",
          component: "table",
          rowsPath: "$",
          columns: ["title"],
          availableFilters: [field],
        }),
      });
      expect(result.widget).toBeNull();
      expect(result.errors.join(" ")).toContain("available scalar field");
    }
  });

  it("lets an explicit manual chart choice replace the browse default", () => {
    const draft = conciergeDraftSchema.parse({
      ...newDraft("manual"),
      component: "table",
      viewIntent: viewIntentSchema.parse({ purpose: "browse", availableFilters: ["state"] }),
    });
    const changed = applyAnswer(draft, "component", ["bar"]);
    expect(changed.viewIntent?.purpose).toBe("summarize");
    expect(changed.viewIntent?.availableFilters).toEqual([]);
  });
});
