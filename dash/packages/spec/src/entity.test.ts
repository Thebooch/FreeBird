import { describe, expect, it } from "vitest";
import {
  displayFields,
  displayName,
  entityById,
  entityForResource,
  entitySchema,
  inferTitleMode,
  referenceFields,
  type EntitySpec,
} from "./entity.js";
import { RECIPES, facetsFromRecipe, recipeFor } from "./recipes.js";

/**
 * The record type, and the boundary that keeps a model's inventions out of it.
 *
 * Entities are written by model-driven passes and then shared with everybody
 * who connects the same API, so a wrong one is not one person's local mistake.
 * These tests are that boundary: a name nothing declares is refused here rather
 * than rendering as an empty column three layers later.
 */

const entity = (input: Record<string, unknown>): EntitySpec =>
  entitySchema.parse({
    id: "vendor",
    resource: "vendor",
    name: { one: "Vendor", many: "Vendors" },
    ...input,
  });

const field = (path: string, extra: Record<string, unknown> = {}) => ({ path, ...extra });

describe("entitySchema", () => {
  it("takes a stub with nothing described yet", () => {
    // The intermediate state a pass writes before it has read any fields. A
    // schema that refused this would make the passes all-or-nothing.
    const parsed = entity({});
    expect(parsed.kind).toBe("other");
    expect(parsed.fields).toEqual([]);
    expect(parsed.views.columns).toEqual([]);
    expect(parsed.views.record).toEqual({ facts: [], groups: [] });
    expect(parsed.verified).toBe(false);
  });

  it("lets a stub mention fields it has not described", () => {
    // Validating against an empty field list would reject every stub for
    // naming something it has not got round to.
    expect(() => entity({ display: { title: ["CompanyName"] } })).not.toThrow();
  });

  it("refuses a display, column or filter naming a field it does not have", () => {
    const fields = [field("CompanyName")];
    for (const invalid of [
      { display: { title: ["Invented"] } },
      { views: { columns: ["Invented"] } },
      { views: { facets: ["Invented"] } },
      { views: { sort: { field: "Invented" } } },
      { views: { record: { facts: ["Invented"] } } },
      { views: { record: { groups: [{ title: "Contact", fields: ["Invented"] }] } } },
      { identity: { field: "Invented" } },
    ]) {
      expect(() => entity({ fields, ...invalid }), JSON.stringify(invalid)).toThrow(
        /is not a field this record has/,
      );
    }
  });

  it("accepts the same names once they are described", () => {
    const parsed = entity({
      fields: [field("CompanyName"), field("Status"), field("Id")],
      identity: { field: "Id", observed: true },
      display: { title: ["CompanyName"], status: "Status" },
      views: { columns: ["CompanyName", "Status"], facets: ["Status"] },
    });
    expect(parsed.identity).toEqual({ field: "Id", observed: true });
    expect(parsed.views.facets).toEqual(["Status"]);
  });

  it("refuses the same field described twice", () => {
    expect(() => entity({ fields: [field("Status"), field("Status")] })).toThrow(
      /described twice/,
    );
  });

  it("defaults a field to detail rather than hidden", () => {
    /*
     * The honest default. A field nobody has classified is still real, and
     * defaulting to hidden would lose data silently — which is the failure
     * this codebase refuses everywhere else.
     */
    expect(entity({ fields: [field("Notes")] }).fields[0]?.visibility).toBe("detail");
  });

  it("defaults a reference to a scalar with nothing embedded", () => {
    const parsed = entity({
      fields: [field("VendorId", { reference: { entity: "vendor" } })],
    });
    expect(parsed.fields[0]?.reference).toEqual({
      entity: "vendor",
      holds: "scalar",
      embedded: [],
      verified: false,
    });
  });

  it("checks a reference's type selector and embedded names against the fields", () => {
    const good = {
      fields: [
        field("Property.Id", {
          reference: {
            entity: "rental",
            typeField: { field: "Property.Type", map: { Rental: "rental" } },
            embedded: ["Property.Name"],
          },
        }),
        field("Property.Type"),
        field("Property.Name"),
      ],
    };
    expect(() => entity(good)).not.toThrow();

    expect(() =>
      entity({
        fields: [
          field("Property.Id", {
            reference: { entity: "rental", typeField: { field: "Absent", map: {} } },
          }),
          field("Property.Type"),
        ],
      }),
    ).toThrow(/is not a field this record has/);
  });

  it("refuses a stat that adds something up without saying what", () => {
    // A sum over nothing returns zero, which renders as a confident answer.
    expect(() =>
      entity({
        fields: [field("Amount")],
        views: { stats: [{ label: "Billed", backref: "bills", agg: "sum" }] },
      }),
    ).toThrow(/needs a field to work on/);

    expect(() =>
      entity({ views: { stats: [{ label: "Open", backref: "tasks", agg: "count" }] } }),
    ).not.toThrow();
  });

  it("keeps an id readable as a name, and refuses a malformed one", () => {
    expect(entity({ id: "association-tenant" }).id).toBe("association-tenant");
    expect(() => entity({ id: "not an id" })).toThrow();
  });
});

describe("reading an entity", () => {
  const vendor = entity({
    fields: [
      field("Id"),
      field("FirstName"),
      field("LastName"),
      field("Status"),
      field("CategoryId", { reference: { entity: "vendor-category" } }),
      field("PropertyId", { reference: { entity: "rental" } }),
    ],
    identity: { field: "Id", observed: true },
    display: { title: ["FirstName", "LastName"], status: "Status" },
  });

  it("finds one by resource or by id", () => {
    expect(entityForResource([vendor], "vendor")?.id).toBe("vendor");
    expect(entityForResource([vendor], "nothing")).toBeUndefined();
    expect(entityById([vendor], "vendor")?.name.one).toBe("Vendor");
    expect(entityById([vendor], undefined)).toBeUndefined();
  });

  it("lists every field that points at another record", () => {
    expect(referenceFields(vendor).map((entry) => entry.field.path)).toEqual([
      "CategoryId",
      "PropertyId",
    ]);
    expect(referenceFields(undefined)).toEqual([]);
  });

  it("reports the fields a name is built from, in order", () => {
    expect(displayFields(vendor)).toEqual(["FirstName", "LastName", "Status"]);
  });

  it("says a record's name from whatever the row carries", () => {
    expect(displayName(vendor, { FirstName: "Ada", LastName: "Byron" })).toBe("Ada Byron");
    // Half a name is better than none.
    expect(displayName(vendor, { FirstName: "Ada" })).toBe("Ada");
  });

  it("reads a flattened row, because that is what a pipeline produces", () => {
    const nested = entity({
      fields: [field("Id"), field("Contact.Name")],
      identity: { field: "Id" },
      display: { title: ["Contact.Name"] },
    });
    // `Contact.Name` is not a column until a derive step makes `Contact_Name`.
    expect(displayName(nested, { Contact_Name: "Acme Plumbing" })).toBe("Acme Plumbing");
  });

  it("reads a row still nested the way the API sent it", () => {
    const property = entity({
      fields: [field("property.propertyID"), field("property.name")],
      identity: { field: "property.propertyID" },
      display: { title: ["property.name"] },
    });
    expect(displayName(property, { property: { propertyID: 12, name: "Maple Court" } })).toBe(
      "Maple Court",
    );
    /* And named by its id when the name is missing. */
    expect(displayName(property, { property: { propertyID: 12 } })).toMatch(/ 12$/);
  });

  it("chooses between alternatives rather than joining them", () => {
    /*
     * Measured on a real API: a supplier carries a company name *or* a
     * person's, and joining all three produced "McKinney Strategic Greg
     * McKinney" — a name nobody has.
     */
    const supplier = entity({
      fields: [field("CompanyName"), field("FirstName"), field("LastName")],
      display: { title: ["CompanyName", "FirstName", "LastName"] },
    });
    expect(
      displayName(supplier, { CompanyName: "McKinney Strategic", FirstName: "Greg", LastName: "McKinney" }),
    ).toBe("McKinney Strategic");
    // And the person's name when there is no company on the row.
    expect(displayName(supplier, { FirstName: "Greg", LastName: "McKinney" })).toBe("Greg");
  });

  it("still joins the parts of one name", () => {
    const person = entity({
      fields: [field("FirstName"), field("LastName")],
      display: { title: ["FirstName", "LastName"] },
    });
    expect(displayName(person, { FirstName: "Ada", LastName: "Byron" })).toBe("Ada Byron");
  });

  it("falls back to the identity, which is when an id is the useful answer", () => {
    expect(displayName(vendor, { Id: 41 })).toBe("Vendor 41");
    expect(displayName(vendor, {})).toBeNull();
    expect(displayName(undefined, { Id: 1 })).toBeNull();
  });
});

describe("inferTitleMode", () => {
  /*
   * The fallback for the 108 record types described before `display.mode`
   * existed, so they read correctly without paying for the pass again.
   */
  it("reads a company-or-person title as alternatives", () => {
    expect(inferTitleMode(["CompanyName", "FirstName", "LastName"])).toBe("first");
    expect(inferTitleMode(["BusinessName", "Surname"])).toBe("first");
  });

  it("reads everything else as parts, which is the common case", () => {
    // Measured at 34 of 38 multi-field titles on a real API. Guessing "first"
    // for these would silently drop half of every name.
    for (const title of [
      ["FirstName", "LastName"],
      ["BuildingName", "UnitNumber"],
      ["AccountNumber", "Name"],
      ["Date", "TransactionType", "TotalAmount"],
    ]) {
      expect(inferTitleMode(title), title.join("+")).toBe("join");
    }
  });

  it("treats a single field as nothing to decide", () => {
    expect(inferTitleMode(["CompanyName"])).toBe("join");
    expect(inferTitleMode([])).toBe("join");
  });
});

describe("recipes", () => {
  it("covers every kind, so nothing falls through to a guess", () => {
    for (const [kind, recipe] of Object.entries(RECIPES)) {
      expect(recipe.kind, kind).toBe(kind);
      expect(recipe.description.length, kind).toBeGreaterThan(10);
    }
  });

  it("treats an unknown or absent kind as the neutral one", () => {
    expect(recipeFor(undefined).kind).toBe("other");
    expect(recipeFor("work").component).toBe("table");
  });

  it("reads work soonest-first and money newest-first", () => {
    // The two orderings people actually want, and they are opposites.
    expect(recipeFor("work").sortDir).toBe("asc");
    expect(recipeFor("money").sortDir).toBe("desc");
    expect(recipeFor("money").measure).toBe("sum");
  });

  it("never offers a glossary as a starting widget", () => {
    expect(recipeFor("lookup").starting).toBe(false);
    expect(recipeFor("note").starting).toBe(false);
    expect(recipeFor("work").starting).toBe(true);
  });

  it("ranks filter fallbacks by what the hint means, not by field order", () => {
    // A status leads a type wherever both exist, whichever order they arrive.
    expect(
      facetsFromRecipe(recipeFor("work"), ["Category.Name", "Priority", "Status", "Title"]),
    ).toEqual(["Status", "Category.Name", "Priority"]);
  });

  it("offers nothing when nothing matches, rather than everything", () => {
    expect(facetsFromRecipe(recipeFor("work"), ["Title", "Amount", "Notes"])).toEqual([]);
    expect(facetsFromRecipe(recipeFor("lookup"), ["Status"])).toEqual([]);
  });

  it("reads a leaf through its separators, so snake_case matches too", () => {
    expect(facetsFromRecipe(recipeFor("work"), ["task.assigned_to"])).toEqual([
      "task.assigned_to",
    ]);
  });
});

/**
 * A collection whose link is a nested field.
 *
 * A back-reference is identified by `<record type>-by-<field path>`, and a
 * field holding a link is nested about as often as not — on a real API 64 of
 * 130 were. Validated as an id, every one of those was unstorable: no stat
 * could count them and no widget could order the sections they produce, and
 * the only symptom was a record type quietly keeping its defaults.
 */
describe("a related collection's id", () => {
  const entity = (views: unknown) =>
    entitySchema.safeParse({
      id: "vendor",
      resource: "vendor",
      name: { one: "Vendor", many: "Vendors" },
      fields: [{ path: "Id" }],
      views,
    });

  it("accepts the dots a nested field path puts in it", () => {
    const parsed = entity({
      stats: [{ label: "Sent", backref: "announcement-by-Sender.Id", agg: "count" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts one longer than an id may be", () => {
    const parsed = entity({
      stats: [
        {
          label: "Updated",
          backref: "association-committee-by-LastUpdatedByUser.Id",
          agg: "count",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("still refuses something that is not an id at all", () => {
    expect(entity({ stats: [{ label: "No", backref: "a/b c", agg: "count" }] }).success).toBe(
      false,
    );
  });
});
