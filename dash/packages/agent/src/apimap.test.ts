import { resourceSchema, type ResourceSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { buildMapPrompt, mapApi, pruneAmbiguousRelations, type MapInput } from "./apimap.js";
import { fakeLlm } from "./llm.js";

/**
 * Understanding an API once, so nobody has to understand it again.
 *
 * This is the only expensive part of mapping — the schemas come out of the
 * spec for nothing — and it runs once per API, ever. What it produces is
 * shared, so a bad guess here is a bad guess for every install that downloads
 * the map. Hence most of what follows is about what it *refuses* to record.
 */

const resource = (input: Partial<ResourceSpec> & { id: string }): ResourceSpec =>
  resourceSchema.parse({ title: input.id, ...input });

const input: MapInput = {
  apiTitle: "Property API",
  resources: [
    resource({ id: "lease", listOp: "list_leases", idField: "Id" }),
    resource({ id: "property", listOp: "list_properties", idField: "Id" }),
    resource({
      id: "unit",
      listOp: "list_units",
      idField: "Id",
      // Already proven by the URL, so the pass must not repeat it.
      relations: [
        {
          id: "unit-property",
          title: "Units of a property",
          resource: "property",
          cardinality: "one",
          via: "path",
          confidence: "declared",
          verified: false,
        },
      ],
    }),
  ],
  ops: [
    {
      id: "list_leases",
      title: "Retrieve all leases",
      path: "/v1/leases",
      fields: [
        { name: "Id", kinds: ["number"], nullable: false },
        { name: "PropertyId", kinds: ["number"], nullable: false },
        { name: "Status", kinds: ["string"], nullable: false },
      ],
    },
    {
      id: "list_properties",
      title: "Retrieve all properties",
      path: "/v1/rentals",
      description: "Every rental property on the account.",
      fields: [
        { name: "Id", kinds: ["number"], nullable: false },
        { name: "Name", kinds: ["string"], nullable: false },
      ],
    },
    {
      id: "list_units",
      title: "Retrieve all units",
      path: "/v1/rentals/units",
      fields: [{ name: "Id", kinds: ["number"], nullable: false }],
    },
  ],
};

const answer = (args: unknown) => fakeLlm([{ args }]);

describe("what the mapping pass records", () => {
  it("writes a description only where the spec supplied none", async () => {
    const llm = answer({
      descriptions: [
        { op: "list_leases", description: "Every lease, current and past." },
        // The API author already described this one.
        { op: "list_properties", description: "Something the model made up." },
      ],
    });

    const result = await mapApi(llm, input);
    expect(result.descriptions["list_leases"]).toBe("Every lease, current and past.");
    // Never over an author's own words.
    expect(result.descriptions["list_properties"]).toBeUndefined();
  });

  it("records a relation the URL never showed, marked as a guess", async () => {
    const llm = answer({
      relations: [
        {
          from: "lease",
          to: "property",
          localField: "PropertyId",
          foreignField: "Id",
          title: "The property a lease is on",
        },
      ],
    });

    const result = await mapApi(llm, input);
    const [relation] = result.relations["lease"] ?? [];
    expect(relation).toMatchObject({
      resource: "property",
      localField: "PropertyId",
      foreignField: "Id",
      // A name match is a guess however plausible, and the schema has a word
      // for that. It is promoted only when a join actually matches rows.
      confidence: "inferred",
      verified: false,
    });
  });

  it("does not claim a route it has not checked", async () => {
    // Whether the target's collection can be filtered by this key is a
    // property of its declared parameters. Taking the model's word for it
    // would turn one request into twenty-five.
    const llm = answer({
      relations: [
        { from: "lease", to: "property", localField: "PropertyId", foreignField: "Id", title: "x" },
      ],
    });
    const result = await mapApi(llm, input);
    expect(result.relations["lease"]?.[0]?.via).toBe("fanOut");
  });
});

describe("what it refuses", () => {
  const rejects = async (args: unknown) => {
    const result = await mapApi(answer(args), input);
    return result;
  };

  it("drops a description for an endpoint that does not exist", async () => {
    const result = await rejects({
      descriptions: [{ op: "list_invoices", description: "Invented." }],
    });
    expect(result.descriptions).toEqual({});
  });

  it("drops a relation naming a field neither side has", async () => {
    const result = await rejects({
      relations: [
        { from: "lease", to: "property", localField: "RentalId", foreignField: "Id", title: "x" },
      ],
    });
    expect(result.relations).toEqual({});
  });

  it("drops a relation between resources that do not exist", async () => {
    const result = await rejects({
      relations: [
        { from: "lease", to: "invoice", localField: "PropertyId", foreignField: "Id", title: "x" },
      ],
    });
    expect(result.relations).toEqual({});
  });

  it("does not repeat a link the URL already proved", async () => {
    // `unit → property` is declared by the path. A guess cannot improve on
    // that, and recording it twice would let an inferred one shadow a fact.
    const result = await rejects({
      relations: [
        { from: "unit", to: "property", localField: "Id", foreignField: "Id", title: "x" },
      ],
    });
    expect(result.relations["unit"]).toBeUndefined();
  });

  it("drops a resource linked to itself", async () => {
    const result = await rejects({
      relations: [
        { from: "lease", to: "lease", localField: "PropertyId", foreignField: "Id", title: "x" },
      ],
    });
    expect(result.relations).toEqual({});
  });
});

describe("running it over a real API", () => {
  it("keeps a completed batch when a later one fails", async () => {
    /*
     * Batches fail independently on purpose. A map covering most of an API is
     * worth keeping and worth re-running for the rest; one that throws away a
     * finished pass because the last call timed out is not.
     */
    const many: MapInput = {
      ...input,
      resources: Array.from({ length: 30 }, (_, index) =>
        resource({ id: `r${index}`, listOp: "list_leases" }),
      ),
    };
    const llm = fakeLlm([
      { args: { descriptions: [{ op: "list_leases", description: "Kept." }] } },
      { text: "not a tool call" },
    ]);

    const result = await mapApi(llm, many);
    expect(result.descriptions["list_leases"]).toBe("Kept.");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("did not parse");
  });

  it("tells the model which descriptions are missing and which are not", async () => {
    const prompt = buildMapPrompt(input, input.resources);
    expect(prompt).toContain("description: MISSING");
    expect(prompt).toContain("[HAS ONE]");
    // The path is in there because it usually says more than the title.
    expect(prompt).toContain("/v1/rentals/units");
  });

  it("names links it already knows, so the model does not spend effort on them", () => {
    const prompt = buildMapPrompt(input, input.resources);
    expect(prompt).toContain("already linked (do not repeat): property");
  });
});

/* ── two collections with the same noun ────────────────────────────────── */

/**
 * Buildium's real shape, reduced.
 *
 * Two endpoints titled "Retrieve all units" in different modules — one under
 * /v1/rentals, one under /v1/associations. A lease's `UnitId` means the
 * rentals one; an ownership account's means the associations one; and nothing
 * in either field name says so. This is the case that shipped wrong: leases,
 * applicants and applicant groups were all recorded as linking to the HOA
 * units, because the model was shown one units collection and named it.
 */
const ambiguous: MapInput = {
  apiTitle: "Property API",
  resources: [
    resource({ id: "lease", listOp: "list_leases", idField: "Id" }),
    resource({ id: "ownershipaccount", listOp: "list_ownership", idField: "Id" }),
    resource({ id: "unit", listOp: "list_assoc_units", idField: "Id" }),
    resource({ id: "unit-2", listOp: "list_rental_units", idField: "Id" }),
  ],
  ops: [
    {
      id: "list_leases",
      title: "Retrieve all leases",
      path: "/v1/leases",
      fields: [
        { name: "Id", kinds: ["number"], nullable: false },
        { name: "UnitId", kinds: ["number"], nullable: false },
      ],
    },
    {
      id: "list_ownership",
      title: "Retrieve all ownership accounts",
      path: "/v1/associations/ownershipaccounts",
      fields: [
        { name: "Id", kinds: ["number"], nullable: false },
        { name: "UnitId", kinds: ["number"], nullable: false },
      ],
    },
    {
      id: "list_assoc_units",
      title: "Retrieve all units",
      path: "/v1/associations/units",
      fields: [{ name: "Id", kinds: ["number"], nullable: false }],
    },
    {
      id: "list_rental_units",
      title: "Retrieve all units",
      path: "/v1/rentals/units",
      fields: [{ name: "Id", kinds: ["number"], nullable: false }],
    },
  ],
};

const linkTo = (from: string, to: string) => ({
  relations: [
    { from, to, localField: "UnitId", foreignField: "Id", title: `${from} → ${to}` },
  ],
});

describe("two collections sharing a noun", () => {
  it("refuses the link when the source sits in neither module", async () => {
    const result = await mapApi(answer(linkTo("lease", "unit")), ambiguous);

    // A lease at /v1/leases is one segment from both, so there is nothing to
    // decide on. Recording either would be a coin toss shipped to everyone.
    expect(result.relations.lease).toBeUndefined();
    expect(result.skipped.join(" ")).toContain("2 different unit collections");
    // Refusing is not an error: the pass worked.
    expect(result.errors).toEqual([]);
  });

  it("refuses the same link named the other way round", async () => {
    const result = await mapApi(answer(linkTo("lease", "unit-2")), ambiguous);
    expect(result.relations.lease).toBeUndefined();
  });

  it("keeps the link when the path settles it", async () => {
    // /v1/associations/ownershipaccounts shares two segments with the
    // association units and one with the rental units.
    const result = await mapApi(answer(linkTo("ownershipaccount", "unit")), ambiguous);

    expect(result.relations.ownershipaccount).toHaveLength(1);
    expect(result.relations.ownershipaccount?.[0]?.resource).toBe("unit");
    expect(result.skipped).toEqual([]);
  });

  it("still refuses the wrong one when the path settles it the other way", async () => {
    const result = await mapApi(answer(linkTo("ownershipaccount", "unit-2")), ambiguous);
    expect(result.relations.ownershipaccount).toBeUndefined();
  });

  it("warns the model in the prompt, naming the rival and its path", () => {
    const prompt = buildMapPrompt(ambiguous, ambiguous.resources);

    expect(prompt).toContain("2 different \"unit\" collections");
    expect(prompt).toContain("/v1/rentals/units");
    expect(prompt).toContain("/v1/associations/units");
  });

  it("says nothing about rivals when a noun is unique", () => {
    const prompt = buildMapPrompt(input, input.resources);
    expect(prompt).not.toContain("CAUTION");
  });

  it("does not count a collection you cannot list on its own", async () => {
    /*
     * Buildium has three collections ending in /vendors, but two need an id
     * you do not have — `/v1/rentals/{propertyId}/vendors`. A VendorId cannot
     * mean either, so the link is unambiguous and must survive. Counting them
     * as rivals refused a perfectly good link.
     */
    const scoped: MapInput = {
      apiTitle: "Property API",
      resources: [
        resource({ id: "bill", listOp: "list_bills", idField: "Id" }),
        resource({ id: "vendor", listOp: "list_vendors", idField: "Id" }),
        resource({ id: "rental-vendor", listOp: "list_rental_vendors", idField: "Id" }),
      ],
      ops: [
        {
          id: "list_bills",
          title: "Retrieve all bills",
          path: "/v1/bills",
          fields: [
            { name: "Id", kinds: ["number"], nullable: false },
            { name: "VendorId", kinds: ["number"], nullable: false },
          ],
        },
        {
          id: "list_vendors",
          title: "Retrieve all vendors",
          path: "/v1/vendors",
          fields: [{ name: "Id", kinds: ["number"], nullable: false }],
        },
        {
          id: "list_rental_vendors",
          title: "Retrieve all vendors",
          path: "/v1/rentals/{{param.propertyId}}/vendors",
          fields: [{ name: "Id", kinds: ["number"], nullable: false }],
        },
      ],
    };

    const result = await mapApi(
      answer({
        relations: [
          {
            from: "bill",
            to: "vendor",
            localField: "VendorId",
            foreignField: "Id",
            title: "Bill → Vendor",
          },
        ],
      }),
      scoped,
    );

    expect(result.relations.bill).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("leaves unambiguous links alone", async () => {
    const result = await mapApi(
      answer({
        relations: [
          {
            from: "lease",
            to: "property",
            localField: "PropertyId",
            foreignField: "Id",
            title: "Lease → Property",
          },
        ],
      }),
      input,
    );

    expect(result.relations.lease).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });
});

/* ── retracting what a previous pass got wrong ─────────────────────────── */

describe("pruneAmbiguousRelations", () => {
  /** The entry as it was actually stored, with the bad link in it. */
  const stored = (): MapInput => ({
    ...ambiguous,
    resources: ambiguous.resources.map((item) =>
      item.id === "lease" || item.id === "ownershipaccount"
        ? {
            ...item,
            relations: [
              {
                id: `${item.id}-unit`,
                title: "Units",
                resource: "unit",
                cardinality: "one" as const,
                localField: "UnitId",
                foreignField: "Id",
                via: "fanOut" as const,
                confidence: "inferred" as const,
                verified: false,
              },
            ],
          }
        : item,
    ),
  });

  const relationsOf = (resources: readonly ResourceSpec[], id: string) =>
    resources.find((resource) => resource.id === id)?.relations ?? [];

  it("retracts a link nothing can justify", () => {
    const { resources, removed } = pruneAmbiguousRelations(stored());

    // Merging can add a link but never withdraw one, so without this the bad
    // link survives its own fix: the corrected pass just stops proposing it.
    expect(relationsOf(resources, "lease")).toHaveLength(0);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("2 different unit collections");
  });

  it("keeps the one the path justifies", () => {
    const { resources } = pruneAmbiguousRelations(stored());
    expect(relationsOf(resources, "ownershipaccount")).toHaveLength(1);
  });

  it("never touches what the URL declared or a request proved", () => {
    const base = stored();
    const withFacts: MapInput = {
      ...base,
      resources: base.resources.map((item) =>
        item.id === "lease"
          ? {
              ...item,
              relations: [
                { ...item.relations[0]!, id: "a", confidence: "declared" as const },
                { ...item.relations[0]!, id: "b", verified: true },
              ],
            }
          : item,
      ),
    };

    // Neither came from a guess, so neither is this pass's to retract.
    const { resources, removed } = pruneAmbiguousRelations(withFacts);
    expect(relationsOf(resources, "lease")).toHaveLength(2);
    expect(removed).toEqual([]);
  });

  it("leaves an entry with nothing to retract exactly as it was", () => {
    const untouched = pruneAmbiguousRelations(input);
    expect(untouched.removed).toEqual([]);
    expect(untouched.resources).toEqual(input.resources);
  });
});

/* ── the rule is about URL shape, not about one vendor ─────────────────── */

describe("an API shaped nothing like the one this was found on", () => {
  /**
   * No version segment, different vocabulary, different casing convention.
   *
   * The ambiguity rule reads its floor off the API instead of assuming a `/v1`
   * prefix, so a single shared section is decisive here where it counts for
   * nothing on a versioned API. Fixing that floor at a number would have made
   * this a rule about one vendor's URLs.
   */
  const shop: MapInput = {
    apiTitle: "Shop API",
    resources: [
      resource({ id: "order", listOp: "orders", idField: "id" }),
      resource({ id: "review", listOp: "reviews", idField: "id" }),
      resource({ id: "item", listOp: "catalog_items", idField: "id" }),
      resource({ id: "item-2", listOp: "warehouse_items", idField: "id" }),
    ],
    ops: [
      {
        id: "orders",
        title: "List orders",
        path: "/catalog/orders",
        fields: [
          { name: "id", kinds: ["number"], nullable: false },
          { name: "item_id", kinds: ["number"], nullable: false },
        ],
      },
      {
        id: "reviews",
        title: "List reviews",
        path: "/reviews",
        fields: [
          { name: "id", kinds: ["number"], nullable: false },
          { name: "item_id", kinds: ["number"], nullable: false },
        ],
      },
      {
        id: "catalog_items",
        title: "List items",
        path: "/catalog/items",
        fields: [{ name: "id", kinds: ["number"], nullable: false }],
      },
      {
        id: "warehouse_items",
        title: "List items",
        path: "/warehouse/items",
        fields: [{ name: "id", kinds: ["number"], nullable: false }],
      },
    ],
  };

  const link = (from: string, to: string) => ({
    relations: [
      { from, to, localField: "item_id", foreignField: "id", title: `${from} → ${to}` },
    ],
  });

  it("resolves on one shared section when the API has no version prefix", async () => {
    // /catalog/orders shares `catalog` with /catalog/items and nothing with
    // /warehouse/items. One segment is the whole of the evidence here.
    const result = await mapApi(answer(link("order", "item")), shop);
    expect(result.relations.order).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("still refuses the wrong one on the same API", async () => {
    const result = await mapApi(answer(link("order", "item-2")), shop);
    expect(result.relations.order).toBeUndefined();
  });

  it("refuses when an unversioned source is equidistant too", async () => {
    // /reviews sits in neither section.
    const result = await mapApi(answer(link("review", "item")), shop);
    expect(result.relations.review).toBeUndefined();
    expect(result.skipped.join(" ")).toContain("2 different item collections");
  });

  it("matches snake_case foreign keys, not just PascalCase", async () => {
    const result = await mapApi(answer(link("order", "item")), shop);
    expect(result.relations.order?.[0]?.localField).toBe("item_id");
  });
});


const vocab: MapInput = {
  apiTitle: "Property API",
  resources: [
    resource({ id: "rental", title: "Retrieve all properties", listOp: "list_rentals", idField: "Id" }),
    resource({
      id: "propertygroup",
      title: "Retrieve all property groups",
      listOp: "list_groups",
      idField: "Id",
    }),
    resource({ id: "unit-2", title: "Retrieve all units", listOp: "list_units", idField: "Id" }),
  ],
  ops: [
    {
      id: "list_rentals",
      title: "Retrieve all properties",
      path: "/v1/rentals",
      fields: [{ name: "Id", kinds: ["number"], nullable: false }],
    },
    {
      id: "list_groups",
      title: "Retrieve all property groups",
      path: "/v1/propertygroups",
      fields: [{ name: "Id", kinds: ["number"], nullable: false }],
    },
    {
      id: "list_units",
      title: "Retrieve all units",
      path: "/v1/rentals/units",
      fields: [
        { name: "Id", kinds: ["number"], nullable: false },
        { name: "PropertyId", kinds: ["number"], nullable: false },
      ],
    },
  ],
};

describe("the API's own vocabulary", () => {
  /**
   * The case that made this necessary. Buildium lists properties at
   * `/v1/rentals` and titles it "Retrieve all properties", so a `PropertyId`
   * on a unit matches nothing about the path — and the nearest thing that
   * *does* look right is `propertygroup`, a different concept entirely. That
   * is exactly the link the map recorded, and it is why clicking a property
   * showed no units.
   */

  it("tells the model what a collection's records are called", () => {
    const prompt = buildMapPrompt(vocab, vocab.resources);

    // The path says "rentals"; the title says "properties". A `PropertyId`
    // only lines up with the second.
    expect(prompt).toContain("its records are called: rental, property");
    expect(prompt).toContain("its records are called: propertygroup");
  });

  it("does not conflate a property with a property group", () => {
    const prompt = buildMapPrompt(vocab, vocab.resources);
    const groupLine = prompt
      .split("\n")
      .find((line) => line.includes("propertygroup") && line.includes("called"));
    // "propertygroup" is its own noun, not a kind of "property".
    expect(groupLine).not.toMatch(/called:.*\bproperty\b(?!group)/);
  });
});

describe("linking across batches", () => {
  /**
   * Batching describes 25 resources per call, and until the full index existed
   * the model could only relate what it happened to be shown together. That
   * silently biased every answer toward batch-mates: Buildium's `rental` sat
   * in batch 0 and its units in batch 1, so the only property-shaped thing in
   * view was `propertygroup` — and that is the link the map recorded.
   */
  it("lists every collection as a link target, not only the batch", () => {
    const batch = [vocab.resources[2]!];
    const prompt = buildMapPrompt(vocab, batch);

    // Only units is described in detail...
    expect(prompt).toContain("RESOURCE unit-2");
    expect(prompt).not.toContain("RESOURCE rental —");
    // ...but every collection is nameable, with the noun that matches
    // `PropertyId`.
    expect(prompt).toContain("ALL COLLECTIONS IN THIS API");
    expect(prompt).toContain("rental — Retrieve all properties (rental, property)");
    // The whole phrase, so a property group is not mistaken for a "group".
    expect(prompt).toContain("propertygroup — Retrieve all property groups (propertygroup)");
  });

  it("accepts a relation to a collection outside the batch", async () => {
    const llm = fakeLlm([
      {
        args: {
          relations: [
            {
              from: "unit-2",
              to: "rental",
              localField: "PropertyId",
              foreignField: "Id",
              title: "Unit → Property",
            },
          ],
        },
      },
    ]);
    const result = await mapApi(llm, vocab);

    // The whole point: `rental` is not in the batch being described and the
    // link is still valid, because validation is against the whole API.
    expect(result.relations["unit-2"]).toHaveLength(1);
    expect(result.relations["unit-2"]?.[0]?.resource).toBe("rental");
  });
});

/**
 * The shape of a linking field, which is checkable and therefore not asked.
 *
 * Every case here produced a link in the real Buildium map that read
 * perfectly and matched nothing. None of them needs a model to catch: the
 * kinds are already in the schemas the import wrote.
 */
describe("what a linking field actually holds", () => {
  const shaped: MapInput = {
    apiTitle: "Property API",
    resources: [
      resource({ id: "owner", listOp: "list_owners", idField: "Id" }),
      resource({ id: "property", listOp: "list_properties", idField: "Id" }),
    ],
    ops: [
      {
        id: "list_owners",
        title: "Retrieve all owners",
        path: "/v1/owners",
        fields: [
          { name: "Id", kinds: ["number"], nullable: false },
          { name: "PropertyIds", kinds: ["array"], nullable: false },
          { name: "Manager", kinds: ["object"], nullable: false },
          { name: "Manager.Id", kinds: ["number"], nullable: false },
          { name: "Region", kinds: ["object"], nullable: false },
          { name: "Region.Href", kinds: ["string"], nullable: false },
        ],
      },
      {
        id: "list_properties",
        title: "Retrieve all properties",
        path: "/v1/rentals",
        fields: [{ name: "Id", kinds: ["number"], nullable: false }],
      },
    ],
  };

  const propose = (localField: string, reason?: string) =>
    answer({
      relations: [
        {
          from: "owner",
          to: "property",
          localField,
          foreignField: "Id",
          title: "An owner owns properties.",
          ...(reason ? { reason } : {}),
        },
      ],
    });

  it("records a list of ids as a list, not as a value", async () => {
    const result = await mapApi(propose("PropertyIds"), shaped);
    expect(result.relations.owner?.[0]).toMatchObject({
      localField: "PropertyIds",
      linkKind: "array",
    });
  });

  it("reaches into an object reference and stores the field that can be compared", async () => {
    const result = await mapApi(propose("Manager"), shaped);
    // The model named the reference; what a comparison needs is the id inside
    // it. Storing `Manager` would compare against `[object Object]`.
    expect(result.relations.owner?.[0]).toMatchObject({
      localField: "Manager.Id",
      linkKind: "objectRef",
    });
  });

  it("refuses an object with no id inside it, and says so", async () => {
    const result = await mapApi(propose("Region"), shaped);
    expect(result.relations.owner).toBeUndefined();
    expect(result.skipped.join(" ")).toContain("Region");
  });

  it("keeps the model's reasoning, because the next person inherits it", async () => {
    const result = await mapApi(
      propose("PropertyIds", "Owner rows list the ids of the properties they hold."),
      shaped,
    );
    expect(result.relations.owner?.[0]?.notes).toBe(
      "Owner rows list the ids of the properties they hold.",
    );
  });

  it("marks non-scalar fields in the prompt so the model can tell them apart", () => {
    const prompt = buildMapPrompt(shaped, shaped.resources);
    // `PropertyIds` and `PropertyId` are one character apart and behave
    // nothing alike. Nothing but the kind says which is which.
    expect(prompt).toContain("PropertyIds (list)");
    expect(prompt).toContain("Manager (object)");
    expect(prompt).toContain("Id, ");
  });
});
