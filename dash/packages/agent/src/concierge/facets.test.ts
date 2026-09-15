import { COMPONENT_CONTRACTS, FACET_MAX_PER_WIDGET, FACET_MAX_VALUES } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import type { FieldInfo } from "../infer.js";
import { facetFields } from "./facets.js";

const field = (input: Partial<FieldInfo> & { name: string }): FieldInfo => ({
  kinds: ["string"],
  nullable: false,
  distinct: 4,
  samples: [],
  ...input,
});

describe("facetFields", () => {
  const choose = (input: {
    requested?: readonly string[];
    fields?: readonly FieldInfo[];
    component?: keyof typeof COMPONENT_CONTRACTS;
    aggregated?: boolean;
  }): readonly string[] =>
    facetFields({
      requested: input.requested ?? [],
      fields: input.fields ?? [field({ name: "Status" })],
      contract: COMPONENT_CONTRACTS[input.component ?? "table"],
      aggregated: input.aggregated ?? false,
    });

  it("takes the fields that were asked for, in the order asked", () => {
    expect(
      choose({
        requested: ["Priority", "Status"],
        fields: [field({ name: "Status" }), field({ name: "Priority" })],
      }),
    ).toEqual(["Priority", "Status"]);
  });

  it("gives none when nobody asked", () => {
    /*
     * There used to be a second source here — a field recorded per endpoint by
     * the mapping pass — which was populated on none of a real API's endpoints
     * and so only ever meant this. What a widget filters by is now decided
     * from the record type and arrives already asked for.
     */
    expect(choose({})).toEqual([]);
  });

  it("drops a requested field the rows do not carry", () => {
    expect(choose({ requested: ["Nope"] })).toEqual([]);
  });

  it("caps what one widget wears and de-duplicates", () => {
    const many = ["Status", "Priority", "Kind", "Stage"].map((name) => field({ name }));
    expect(choose({ requested: ["Status", "Status"], fields: many })).toEqual(["Status"]);
    expect(
      choose({ requested: ["Status", "Priority", "Kind", "Stage"], fields: many }),
    ).toHaveLength(FACET_MAX_PER_WIDGET);
  });

  it("takes a requested field on an API nobody has read yet", () => {
    /*
     * The case this whole split exists for. An endpoint described only by its
     * specification reports `distinct: 0` — not "few", not "many" — and
     * refusing on that would refuse every filter on every unread API, which is
     * most of them.
     */
    expect(choose({ requested: ["Status"], fields: [field({ name: "Status", distinct: 0 })] })).toEqual([
      "Status",
    ]);
  });

  it("refuses an unmeasured number, which could be an id or an amount", () => {
    expect(
      choose({ requested: ["Code"], fields: [field({ name: "Code", kinds: ["number"], distinct: 0 })] }),
    ).toEqual([]);
  });

  it("refuses an identifier or a link by name, even nested", () => {
    for (const name of ["TaskId", "Href", "Property.Href", "Property.Id"]) {
      expect(choose({ requested: [name], fields: [field({ name, distinct: 0 })] })).toEqual([]);
    }
  });

  it("keeps the readable half of a nested reference", () => {
    expect(
      choose({ requested: ["Category.Name"], fields: [field({ name: "Category.Name", distinct: 0 })] }),
    ).toEqual(["Category.Name"]);
  });

  it("keeps a requested field with more values than tile well", () => {
    /*
     * Deliberately not refused here. `validateFacets` drops the strip at render
     * time and says why, which is recoverable; refusing at build time would
     * silently ignore what somebody asked for.
     */
    expect(
      choose({
        requested: ["Status"],
        fields: [field({ name: "Status", distinct: FACET_MAX_VALUES + 5 })],
      }),
    ).toEqual(["Status"]);
  });

  it("gives no strip to a chart or an aggregate, however it was asked for", () => {
    expect(choose({ requested: ["Status"], aggregated: true })).toEqual([]);
    expect(choose({ requested: ["Status"], component: "bar" })).toEqual([]);
  });
});
