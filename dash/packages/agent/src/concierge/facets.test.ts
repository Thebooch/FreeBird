import { COMPONENT_CONTRACTS, FACET_MAX_VALUES } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import type { FieldInfo } from "../infer.js";
import { deriveFacet } from "./facets.js";

const field = (input: Partial<FieldInfo> & { name: string }): FieldInfo => ({
  kinds: ["string"],
  nullable: false,
  distinct: 4,
  samples: [],
  ...input,
});

const derive = (input: {
  facetField?: string | undefined;
  fields?: readonly FieldInfo[];
  component?: keyof typeof COMPONENT_CONTRACTS;
  aggregated?: boolean;
}): string | null =>
  deriveFacet({
    facetField: input.facetField,
    fields: input.fields ?? [field({ name: "Status" })],
    contract: COMPONENT_CONTRACTS[input.component ?? "table"],
    aggregated: input.aggregated ?? false,
  });

describe("deriveFacet", () => {
  it("takes the field the map already recorded", () => {
    // The whole economy of this: the answer was bought when the API was
    // mapped, so offering a strip costs no model call at all.
    expect(derive({ facetField: "Status" })).toBe("Status");
  });

  it("declines when the map recorded none", () => {
    expect(derive({ facetField: undefined })).toBeNull();
  });

  it("declines over an aggregate", () => {
    // After a group step there are no records left, only buckets — the same
    // reason charts ignore highlights.
    expect(derive({ facetField: "Status", aggregated: true })).toBeNull();
  });

  it("declines for a component whose marks are not records", () => {
    expect(derive({ facetField: "Status", component: "bar" })).toBeNull();
    expect(derive({ facetField: "Status", component: "timeseries" })).toBeNull();
  });

  it("offers one for every collection component that shows records", () => {
    for (const component of ["table", "cards", "list", "board", "feed"] as const) {
      expect(derive({ facetField: "Status", component })).toBe("Status");
    }
  });

  it("declines a field the endpoint was never seen to return", () => {
    expect(derive({ facetField: "Status", fields: [field({ name: "Other" })] })).toBeNull();
  });

  it("declines an object or array field", () => {
    // These stringify to "[object Object]", which makes one tile standing in
    // for everything.
    for (const kind of ["object", "array"] as const) {
      expect(
        derive({ facetField: "Status", fields: [field({ name: "Status", kinds: [kind] })] }),
      ).toBeNull();
    }
  });

  it("declines a date wearing a string kind", () => {
    expect(
      derive({
        facetField: "Created",
        fields: [field({ name: "Created", format: "iso8601" })],
      }),
    ).toBeNull();
  });

  it("declines a single-valued field", () => {
    // A strip with one tile offers a filter that removes nothing, which reads
    // as broken rather than as complete.
    expect(
      derive({ facetField: "Status", fields: [field({ name: "Status", distinct: 1 })] }),
    ).toBeNull();
  });

  it("declines a field with too many values to tile", () => {
    expect(
      derive({
        facetField: "Status",
        fields: [field({ name: "Status", distinct: FACET_MAX_VALUES + 1 })],
      }),
    ).toBeNull();
    expect(
      derive({
        facetField: "Status",
        fields: [field({ name: "Status", distinct: FACET_MAX_VALUES })],
      }),
    ).toBe("Status");
  });

  it("allows a nullable categorical, which is an ordinary empty bucket", () => {
    expect(
      derive({
        facetField: "Status",
        fields: [field({ name: "Status", kinds: ["string", "null"], nullable: true })],
      }),
    ).toBe("Status");
  });
});
