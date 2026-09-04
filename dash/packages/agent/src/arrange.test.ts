import { describe, expect, it } from "vitest";
import { buildAll } from "./concierge/build.js";
import { newDraft, partCount, partsOf } from "./concierge/draft.js";
import { applyArrangement, feasibleArrangements, pairEndpoints } from "./concierge/arrange.js";
import { emptyContext, type ConciergeContext } from "./concierge/steps.js";
import { revise } from "./concierge/revise.js";
import { inferShape } from "./infer.js";

/**
 * Which ways two endpoints could be shown together, and what each costs.
 *
 * The picker's whole job is to offer only arrangements that would really work.
 * Offering one that cannot be built is the failure this area started with — a
 * widget confidently described as showing two things while showing one — so
 * every option here is derived from the endpoints rather than assumed.
 */

const THINGS = {
  data: [
    { id: 1, name: "Alpha", status: "active", ownerId: 77 },
    { id: 2, name: "Beta", status: "overdue", ownerId: 78 },
  ],
};

const OWNERS = {
  data: [
    { ownerId: 77, ownerName: "North", region: "west" },
    { ownerId: 78, ownerName: "South", region: "east" },
  ],
};

const contextFor = (
  shapes: Record<string, unknown>,
  extra: Partial<ConciergeContext> = {},
): ConciergeContext => ({
  ...emptyContext,
  connections: [{ id: "api", title: "The API" }],
  ops: Object.keys(shapes).map((op) => ({
    id: op,
    title: op,
    connection: "api",
    path: `/${op}`,
  })),
  shapes: Object.fromEntries(Object.entries(shapes).map(([op, body]) => [op, inferShape(body)])),
  ...extra,
});

const context = () => contextFor({ things: THINGS, owners: OWNERS }, { joins: [] });

const twoParts = (ctx: ConciergeContext) =>
  revise(
    newDraft("d", "things and owners", "assisted"),
    {
      endpoint: "things",
      component: "table",
      roles: { columns: ["name"] },
      title: "Things",
      parts: [
        {
          endpoint: "owners",
          component: "table",
          roles: { columns: ["ownerName"] },
          title: "Owners",
        },
      ],
      group: { title: "Things and Owners", display: "tabs" },
    },
    ctx,
  ).draft;

describe("feasibleArrangements", () => {
  it("offers nothing for a setup of one widget", () => {
    const ctx = context();
    const one = revise(newDraft("d", "", "assisted"), { endpoint: "things" }, ctx).draft;
    // A picker on every build is the endpoint list this whole flow replaced.
    expect(feasibleArrangements(one, ctx)).toEqual([]);
  });

  it("always offers the three frames, which read the same data either way", () => {
    const ctx = context();
    const ids = feasibleArrangements(twoParts(ctx), ctx).map((option) => option.id);
    expect(ids).toEqual(expect.arrayContaining(["tabs", "row", "stack"]));
  });

  it("marks the one currently applied", () => {
    const ctx = context();
    const applied = feasibleArrangements(twoParts(ctx), ctx).filter((option) => option.applied);
    expect(applied.map((option) => option.id)).toEqual(["tabs"]);
  });

  it("prices a frame at nothing, because it reads the same endpoints", () => {
    const ctx = context();
    const options = feasibleArrangements(twoParts(ctx), ctx);
    for (const option of options.filter((entry) => entry.id !== "merged")) {
      expect(option.extraRequests).toBe(0);
    }
  });

  /*
   * The naming convention, ported from the proposal path so the two agree.
   * They were about to disagree: the proposal falls back to it when the map is
   * silent, so a merge it would build was one a map-only picker would refuse.
   */
  it("offers a merge found by field names alone, with no declared relation", () => {
    const ctx = context();
    expect(ctx.joins).toEqual([]);
    const merged = feasibleArrangements(twoParts(ctx), ctx).find(
      (option) => option.id === "merged",
    );
    expect(merged).toBeDefined();
    expect(merged?.description).toContain("ownerId");
    // And says the match was inferred rather than declared.
    expect(merged?.description).toContain("field names");
  });

  it("does not offer a merge when nothing carries the identity of the other", () => {
    const ctx = contextFor({ things: THINGS, notes: { data: [{ body: "x" }] } }, { joins: [] });
    const draft = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "things",
        component: "table",
        roles: { columns: ["name"] },
        parts: [{ endpoint: "notes", component: "table", roles: { columns: ["body"] } }],
      },
      ctx,
    ).draft;
    expect(feasibleArrangements(draft, ctx).map((option) => option.id)).not.toContain("merged");
  });

  it("offers one list when every endpoint could fill the title a list needs", () => {
    const ctx = context();
    expect(feasibleArrangements(twoParts(ctx), ctx).map((option) => option.id)).toContain("list");
  });
});

describe("applyArrangement", () => {
  it("changes the display of a frame and nothing else", () => {
    const ctx = context();
    const { draft } = applyArrangement(twoParts(ctx), "row", ctx);
    expect(draft.group?.display).toBe("row");
    expect(partCount(draft)).toBe(2);
    expect(draft.interleave).toBe(false);
  });

  it("turns a pair of tables into one list, clearing the old bindings", () => {
    const ctx = context();
    const { draft } = applyArrangement(twoParts(ctx), "list", ctx);
    expect(draft.interleave).toBe(true);
    /*
     * `columns` means nothing to a list, so it is cleared rather than
     * half-translated — the re-bind gets a clean slate.
     */
    expect(partsOf(draft).every((part) => part.component === "list")).toBe(true);
    expect(partsOf(draft).every((part) => Object.keys(part.roles).length === 0)).toBe(true);
  });

  it("collapses a merge into one joined widget", () => {
    const ctx = context();
    const { draft, error } = applyArrangement(twoParts(ctx), "merged", ctx);
    expect(error).toBeUndefined();
    expect(partCount(draft)).toBe(1);
    expect(draft.join).toMatchObject({
      op: "owners",
      leftField: "ownerId",
      rightField: "ownerId",
    });
    // One widget now, so there is no frame to put it in.
    expect(draft.group).toBeUndefined();
  });

  it("refuses a merge it cannot find a key for, without changing anything", () => {
    const ctx = contextFor({ things: THINGS, notes: { data: [{ body: "x" }] } }, { joins: [] });
    const draft = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "things",
        component: "table",
        roles: { columns: ["name"] },
        parts: [{ endpoint: "notes", component: "table", roles: { columns: ["body"] } }],
      },
      ctx,
    ).draft;
    const result = applyArrangement(draft, "merged", ctx);
    expect(result.error).toContain("cannot be merged");
    expect(partCount(result.draft)).toBe(2);
  });

  it("refuses to arrange a setup of one", () => {
    const ctx = context();
    const one = revise(newDraft("d", "", "assisted"), { endpoint: "things" }, ctx).draft;
    expect(applyArrangement(one, "row", ctx).error).toContain("only one widget");
  });

  /*
   * The round trip that matters: every arrangement the picker offers has to
   * produce something the build accepts. An option that cannot be built is
   * exactly what this file exists to prevent.
   */
  it("produces a buildable draft for every frame it offers", () => {
    const ctx = context();
    const start = twoParts(ctx);
    const frames = ["tabs", "row", "stack"] as const;
    for (const option of feasibleArrangements(start, ctx)) {
      const { draft, error } = applyArrangement(start, option.id, ctx);
      expect(error, `${option.id} could not be applied`).toBeUndefined();
      /*
       * A merge and a list re-bind through the model, so a deterministic build
       * of those is allowed to still want roles. The frames change nothing
       * about any widget, so they must build exactly as they were.
       */
      if ((frames as readonly string[]).includes(option.id)) {
        expect(buildAll(draft, ctx).errors, `${option.id} did not build`).toEqual([]);
      }
    }
  });
});

describe("pairEndpoints", () => {
  it("prefers a relation the map declared", () => {
    const ctx = contextFor({ things: THINGS, owners: OWNERS }, {
      joins: [
        {
          id: "j1",
          fromOp: "things",
          toOp: "owners",
          title: "Thing to Owner",
          leftField: "id",
          rightField: "ownerId",
          fetch: { mode: "filtered" },
        },
      ],
    } as Partial<ConciergeContext>);
    const pairing = pairEndpoints(ctx, "things", "owners");
    expect(pairing).toMatchObject({ leftField: "id", declared: true, perRow: false });
  });

  it("falls back to the field names when the map is silent", () => {
    const pairing = pairEndpoints(context(), "things", "owners");
    expect(pairing).toMatchObject({
      leftField: "ownerId",
      rightField: "ownerId",
      declared: false,
    });
  });

  it("reports nothing rather than reaching for a plausible pair", () => {
    const ctx = contextFor({ things: THINGS, notes: { data: [{ body: "x" }] } }, { joins: [] });
    expect(pairEndpoints(ctx, "things", "notes")).toBeNull();
  });
});
