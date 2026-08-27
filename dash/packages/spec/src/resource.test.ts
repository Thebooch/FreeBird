import { describe, expect, it } from "vitest";
import {
  type ShapeOp,
  deriveResourceGraph,
  nounFromPathParam,
  commonPathPrefix,
  relationSchema,
  resolveSameNoun,
  sharedPathPrefix,
  singularNoun,
} from "./resource.js";

/**
 * Every fixture here is an invented API.
 *
 * These rules exist to read a structure nobody has described to us, so testing
 * them against a real vendor's shapes would only prove they work on that
 * vendor. "Crate Co" has the shapes that matter — a collection, a record, a
 * collection inside a record, and a record inside that — wearing words no API
 * actually uses.
 */
const op = (id: string, path: string, title = id, archetype?: string): ShapeOp => ({
  id,
  title,
  path,
  ...(archetype ? { archetype } : {}),
});

const crateCo: ShapeOp[] = [
  op("crates", "/v1/crates", "Crates"),
  op("crate", "/v1/crates/{{param.crateId}}", "Crate"),
  op("crateItems", "/v1/crates/{{param.crateId}}/items", "Items in a crate"),
  op("crateItem", "/v1/crates/{{param.crateId}}/items/{{param.itemId}}", "Item"),
  op("crateLabel", "/v1/crates/{{param.crateId}}/label", "Crate label", "summary"),
  op("crateNotes", "/v1/crates/{{param.crateId}}/notes", "Crate notes"),
  op("boxes", "/v1/boxes", "Boxes"),
  op("box", "/v1/boxes/{{param.boxId}}", "Box"),
  op("boxNotes", "/v1/boxes/{{param.boxId}}/notes", "Box notes"),
];

const graph = (ops: ShapeOp[]) => deriveResourceGraph(ops);
const find = (ops: ShapeOp[], id: string) =>
  graph(ops).resources.find((resource) => resource.id === id);

describe("singularNoun", () => {
  it("leaves an ambiguous -ses alone rather than producing a stump", () => {
    // `leases` → `leas` is the failure this narrow rule exists to avoid.
    expect(singularNoun("leases")).toBe("lease");
    expect(singularNoun("addresses")).toBe("address");
    expect(singularNoun("boxes")).toBe("box");
    expect(singularNoun("policies")).toBe("policy");
    expect(singularNoun("address")).toBe("address");
    expect(singularNoun("items")).toBe("item");
  });
});

describe("nounFromPathParam", () => {
  it("reads the noun a parameter names", () => {
    expect(nounFromPathParam("crateId")).toBe("crate");
    expect(nounFromPathParam("crate_id")).toBe("crate");
    expect(nounFromPathParam("unitIds")).toBe("unit");
  });

  it("reports nothing when the name is not an id at all", () => {
    // No suffix to strip means the parameter is naming something else, and
    // guessing a noun from it would invent a relation.
    expect(nounFromPathParam("since")).toBeUndefined();
    expect(nounFromPathParam("id")).toBeUndefined();
  });
});

describe("deriveResourceGraph — top-level shapes", () => {
  it("pairs a collection with its record", () => {
    expect(find(crateCo, "crate")).toMatchObject({
      listOp: "crates",
      detailOp: "crate",
      detailParam: "crateId",
    });
  });

  it("leaves identity unknown until a real response is seen", () => {
    for (const resource of graph(crateCo).resources) {
      expect(resource.idField).toBeUndefined();
      expect(resource.verified).toBe(false);
    }
  });
});

describe("deriveResourceGraph — collections inside a record", () => {
  it("finds a child collection the API declares in its own URL", () => {
    const items = find(crateCo, "crate-item");
    expect(items).toMatchObject({ listOp: "crateItems", detailOp: "crateItem" });
  });

  it("records the link on the parent, with the endpoint that fetches it", () => {
    const crate = find(crateCo, "crate")!;
    expect(crate.relations).toContainEqual(
      expect.objectContaining({
        resource: "crate-item",
        cardinality: "many",
        via: "path",
        op: "crateItems",
        param: "crateId",
        // The URL said so. Nothing was inferred from a name.
        confidence: "declared",
      }),
    );
  });

  it("does not claim the child points back at the parent", () => {
    /*
     * The URL proves a crate HAS items. It proves nothing about whether an
     * item row carries a CrateId — plenty of APIs omit the back-pointer
     * because the parent was already in the path. Writing that link anyway
     * puts a field in the spec that no row has.
     */
    const item = find(crateCo, "crate-item")!;
    expect(item.relations).toEqual([]);
  });

  it("reads a scoped endpoint returning one object as a has-one", () => {
    const crate = find(crateCo, "crate")!;
    const label = crate.relations.find((relation) => relation.resource === "crate-label");
    expect(label?.cardinality).toBe("one");
  });

  it("does not mistake a deeper record for a child collection", () => {
    // `/crates/{crateId}/items/{itemId}` is a record, and belongs to the
    // items collection rather than being a collection of its own.
    const ids = graph(crateCo).resources.map((resource) => resource.id);
    expect(ids).not.toContain("crate-item-item");
  });
});

describe("deriveResourceGraph — ids", () => {
  it("qualifies a child by its parent so two of the same noun stay readable", () => {
    const ids = graph(crateCo).resources.map((resource) => resource.id);
    // Both crates and boxes have notes. "note" and "note-2" would be unusable
    // in a sentence; the parent is what distinguishes them.
    expect(ids).toContain("crate-note");
    expect(ids).toContain("box-note");
    expect(ids).not.toContain("note-2");
  });

  it("keeps top-level ids unqualified, and reserves them first", () => {
    const ids = graph(crateCo).resources.map((resource) => resource.id);
    expect(ids).toContain("crate");
    expect(ids).toContain("box");
  });

  it("falls back to a numeric suffix only when a real collision remains", () => {
    const collide: ShapeOp[] = [
      op("a", "/v1/boxes", "A"),
      op("a1", "/v1/boxes/{{param.id}}", "A1"),
      op("b", "/v2/boxes", "B"),
      op("b1", "/v2/boxes/{{param.id}}", "B1"),
    ];
    expect(graph(collide).resources.map((resource) => resource.id)).toEqual(["box", "box-2"]);
  });
});

describe("deriveResourceGraph — uncertain readings", () => {
  it("falls back to the parameter's noun when the parent path is absent", () => {
    /*
     * `/v1/things/{crateId}/items` has no `/v1/things` collection, but the
     * parameter still names a crate. That is a weaker signal than the path,
     * and is marked as such rather than being treated as fact.
     */
    const ops = [...crateCo, op("orphan", "/v1/things/{{param.crateId}}/parts", "Parts")];
    const crate = find(ops, "crate")!;
    const parts = crate.relations.find((relation) => relation.op === "orphan");
    expect(parts?.confidence).toBe("inferred");
  });

  it("warns when the named resource is reached from a different endpoint", () => {
    /*
     * The hazard worth catching: a parameter names "crate", but the path it
     * came from is not the crates collection. Those may be two different kinds
     * of crate, and binding them silently would produce a confidently wrong
     * join.
     */
    const ops = [...crateCo, op("odd", "/v9/depot/{{param.crateId}}/parts", "Depot parts")];
    expect(graph(ops).notes.join(" ")).toMatch(/same kind of crate/);
  });

  it("keeps an unreachable child rather than dropping it, and says why", () => {
    const ops = [op("lost", "/v1/mystery/{{param.mysteryId}}/parts", "Mystery parts")];
    const result = graph(ops);
    // Dropping it is what used to happen, and it is how nine endpoints went
    // missing. It is usable the moment any id arrives.
    expect(result.resources.map((resource) => resource.id)).toContain("part");
    expect(result.notes.join(" ")).toMatch(/only be opened from a record/);
  });

  it("finds nothing in a flat API rather than inventing structure", () => {
    expect(graph([op("totals", "/v1/totals", "Totals", "summary")]).resources).toEqual([]);
  });
});

describe("relationSchema", () => {
  it("defaults a legacy relation to the weakest claim", () => {
    const parsed = relationSchema.parse({
      id: "x",
      title: "X",
      resource: "y",
      cardinality: "many",
    });
    // An old record says nothing about how it was found or how to fetch it,
    // so it must not read as declared-and-filtered.
    expect(parsed.confidence).toBe("inferred");
    expect(parsed.via).toBe("fanOut");
    expect(parsed.verified).toBe(false);
  });
});

/* ── telling two same-named collections apart ──────────────────────────── */

describe("resolveSameNoun", () => {
  /** Buildium's real shape: two "units" collections in different modules. */
  const rentalUnits = { id: "unit-2", path: "/v1/rentals/units" };
  const associationUnits = { id: "unit", path: "/v1/associations/units" };
  const both = [associationUnits, rentalUnits];

  it("returns the only candidate without needing a path", () => {
    expect(resolveSameNoun([rentalUnits], undefined, 1)).toBe(rentalUnits);
  });

  it("picks the one sharing a section with the source", () => {
    // An ownership account is an HOA concept and its UnitId means an HOA unit.
    expect(resolveSameNoun(both, "/v1/associations/ownershipaccounts", 1)).toBe(associationUnits);
    // A rental unit's notes obviously mean the rental units.
    expect(resolveSameNoun(both, "/v1/rentals/units/{{param.unitId}}/notes", 1)).toBe(rentalUnits);
  });

  it("refuses when the source is equidistant from both", () => {
    /*
     * The bug this exists for. A lease at /v1/leases is one segment from each,
     * and the arbitrary winner was the HOA units — wrong for every lease.
     */
    expect(resolveSameNoun(both, "/v1/leases", 1)).toBeNull();
    expect(resolveSameNoun(both, "/v1/applicants", 1)).toBeNull();
  });

  it("does not count the version prefix as affinity", () => {
    // `/v1` is shared by every path in the API and proves nothing.
    expect(resolveSameNoun(both, "/v1/anything", 1)).toBeNull();
  });

  it("refuses when there is no source path to judge by", () => {
    expect(resolveSameNoun(both, undefined, 1)).toBeNull();
  });

  it("refuses when the best candidates tie above the floor", () => {
    const a = { id: "a", path: "/v1/rentals/units" };
    const b = { id: "b", path: "/v1/rentals/units-archived" };
    expect(resolveSameNoun([a, b], "/v1/rentals/leases", 1)).toBeNull();
  });

  it("ignores a candidate that has no path at all", () => {
    const pathless = { id: "unit-3", path: undefined };
    expect(resolveSameNoun([associationUnits, pathless], "/v1/associations/owners", 1)).toBe(
      associationUnits,
    );
  });

  it("does not need a version prefix to exist", () => {
    /*
     * The floor is read off the API, not fixed at a number. On an API with no
     * version in its paths, a single shared section is the whole of the
     * evidence and is decisive — the same rule that makes `/v1` count for
     * nothing on a versioned one. Fixing the floor at two would have refused
     * every disambiguation here, which is how a rule calibrated to one
     * vendor's URLs fails on everybody else's.
     */
    const rentals = { id: "unit-2", path: "/rentals/units" };
    const associations = { id: "unit", path: "/associations/units" };
    const pair = [associations, rentals];

    expect(resolveSameNoun(pair, "/associations/ownershipaccounts", 0)).toBe(associations);
    expect(resolveSameNoun(pair, "/rentals/leases", 0)).toBe(rentals);
    // Still equidistant, still refused.
    expect(resolveSameNoun(pair, "/leases", 0)).toBeNull();
  });

  it("discounts however long the shared mount actually is", () => {
    const a = { id: "a", path: "/api/v2/rentals/units" };
    const b = { id: "b", path: "/api/v2/associations/units" };
    // `/api/v2` is shared by everything, so sharing it is not evidence.
    expect(resolveSameNoun([a, b], "/api/v2/leases", 2)).toBeNull();
    expect(resolveSameNoun([a, b], "/api/v2/rentals/owners", 2)).toBe(a);
  });
});

describe("commonPathPrefix", () => {
  it("finds the version every path shares", () => {
    expect(commonPathPrefix(["/v1/leases", "/v1/rentals/units", "/v1/associations"])).toBe(1);
  });

  it("returns zero when paths share nothing", () => {
    expect(commonPathPrefix(["/leases", "/rentals/units"])).toBe(0);
  });

  it("finds a longer shared mount", () => {
    expect(commonPathPrefix(["/api/v2/leases", "/api/v2/units"])).toBe(2);
  });

  it("claims no shared prefix from a single path", () => {
    // One path shares its whole self with itself, which would discount
    // everything. Nothing to compare means nothing to discount.
    expect(commonPathPrefix(["/v1/leases"])).toBe(0);
    expect(commonPathPrefix([])).toBe(0);
  });
});

describe("sharedPathPrefix", () => {
  it("counts segments from the left and stops at the first difference", () => {
    expect(sharedPathPrefix("/v1/a/b", "/v1/a/c")).toBe(2);
    expect(sharedPathPrefix("/v1/rentals/units", "/v1/associations/units")).toBe(1);
    expect(sharedPathPrefix("/v1/a", "/v1/a")).toBe(2);
    expect(sharedPathPrefix("/x", "/y")).toBe(0);
  });
});
