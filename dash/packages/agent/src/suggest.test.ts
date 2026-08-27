import type { HighlightSpec, ResourceSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import type { FieldInfo, InferredShape } from "./infer.js";
import { highlightCandidates, nounFromTitle, suggestWidgets } from "./suggest.js";

/**
 * Invented fixtures throughout. These rules exist to read an API nobody has
 * described, so proving them against a real vendor's shapes would only prove
 * they work on that vendor.
 */

/** The real status vocabulary, injected exactly as the server does. */
const GOOD = /^(succeed|success|active|ok|healthy|pass|complete|done|paid|live|open|available)/;
const CRITICAL = /^(fail|error|critical|cancel|denied|rejected|expired|closed)/;
const SERIOUS = /^(overdue|late|blocked|expiring|suspend)/;
const toneOf = (value: unknown): HighlightSpec["tone"] => {
  if (typeof value === "boolean") return value ? "good" : "critical";
  const text = String(value).trim().toLowerCase();
  if (CRITICAL.test(text)) return "critical";
  if (SERIOUS.test(text)) return "serious";
  if (GOOD.test(text)) return "good";
  return "neutral";
};

const field = (
  name: string,
  options: { kinds?: string[]; distinct?: number; samples?: unknown[] } = {},
): FieldInfo =>
  ({
    name,
    kinds: options.kinds ?? ["string"],
    nullable: false,
    distinct: options.distinct ?? 1,
    samples: options.samples ?? [],
  }) as unknown as FieldInfo;

const shape = (fields: FieldInfo[], rowCount = 3): InferredShape =>
  ({ rowsPath: "$", rowCount, fields, schemaHash: "fnv1a:x" }) as unknown as InferredShape;

describe("nounFromTitle", () => {
  it("strips the verb phrase titles actually ship with", () => {
    expect(nounFromTitle("Retrieve all leases")).toBe("leases");
    expect(nounFromTitle("Get the crates")).toBe("crates");
    expect(nounFromTitle("Retrieve a property")).toBe("property");
    expect(nounFromTitle("List all listing contacts")).toBe("listing contacts");
  });

  it("leaves a title that is already a noun alone", () => {
    expect(nounFromTitle("Posts")).toBe("posts");
    expect(nounFromTitle("Repository issues")).toBe("repository issues");
  });

  it("drops a trailing qualifier that would clutter a sentence", () => {
    expect(nounFromTitle("Retrieve all leases by status")).toBe("leases");
  });

  it("gives up rather than producing something unreadable", () => {
    expect(nounFromTitle("Retrieve all")).toBeUndefined();
    expect(nounFromTitle("A very long endpoint title that rambles on")).toBeUndefined();
  });
});

describe("highlightCandidates", () => {
  it("offers a boolean flag, named as a person would say it", () => {
    const [first] = highlightCandidates([field("isListed", { kinds: ["boolean"] })], toneOf);
    expect(first?.highlight).toMatchObject({ when: "isListed == true", label: "Listed" });
    expect(first?.confident).toBe(true);
  });

  it("offers a value the status vocabulary recognises, with its tone", () => {
    const found = highlightCandidates(
      [field("status", { distinct: 3, samples: ["overdue", "paid"] })],
      toneOf,
    );
    const overdue = found.find((item) => item.highlight.label === "overdue");
    expect(overdue?.highlight.tone).toBe("serious");
    expect(overdue?.confident).toBe(true);
  });

  /*
   * The correction that matters. `listed`, `vacant` and `delinquent` are all
   * unknown to the status vocabulary, and all three are exactly what someone
   * wants marked. Gating candidacy on a recognised word would offer none of
   * them — so the shape decides, and the vocabulary only ranks.
   */
  it("still offers a value the vocabulary has never heard of", () => {
    const found = highlightCandidates(
      [field("state", { distinct: 3, samples: ["listed", "vacant"] })],
      toneOf,
    );
    const listed = found.find((item) => item.highlight.label === "listed");
    expect(listed).toBeDefined();
    expect(listed?.highlight.tone).toBe("neutral");
    // Offered, but flagged as a guess so it is asked about rather than assumed.
    expect(listed?.confident).toBe(false);
  });

  it("ranks recognised words above guesses", () => {
    const found = highlightCandidates(
      [
        field("state", { distinct: 2, samples: ["listed"] }),
        field("status", { distinct: 2, samples: ["failed"] }),
      ],
      toneOf,
    );
    expect(found[0]?.highlight.label).toBe("failed");
  });

  /*
   * Found by running it against a live endpoint. With a two-row sample every
   * column has two distinct values, so a person's *name* looked exactly like a
   * status and "Ada" was offered as something to highlight. A closed set has
   * to repeat before it can be believed.
   */
  it("does not mistake a column of unique values for a status", () => {
    const fields = [field("name", { distinct: 3, samples: ["Ada", "Grace"] })];
    expect(highlightCandidates(fields, toneOf, { rowCount: 3 })).toEqual([]);
    // The same column repeats once in a larger sample: now it is a closed set.
    expect(
      highlightCandidates([field("name", { distinct: 3, samples: ["Ada"] })], toneOf, {
        rowCount: 9,
      }),
    ).toHaveLength(1);
  });

  it("never offers a resource's own id or label", () => {
    const fields = [field("Name", { distinct: 2, samples: ["Ada"] })];
    expect(highlightCandidates(fields, toneOf, { rowCount: 9, exclude: ["Name"] })).toEqual([]);
  });

  it("ignores a column with too many values to be a status", () => {
    // 40 distinct strings is an identifier or free text; highlighting one
    // arbitrary value of it tells the reader nothing.
    expect(
      highlightCandidates([field("email", { distinct: 40, samples: ["a@b.com"] })], toneOf),
    ).toEqual([]);
  });

  it("ignores nested fields, which cannot be named in a predicate", () => {
    expect(
      highlightCandidates([field("owner.status", { distinct: 2, samples: ["paid"] })], toneOf),
    ).toEqual([]);
  });
});

describe("suggestWidgets", () => {
  const crate: ResourceSpec = {
    id: "crate",
    title: "Retrieve all crates",
    idField: "Id",
    labelField: "Name",
    listOp: "crates",
    detailOp: "crate",
    detailParam: "crateId",
    verified: false,
    relations: [
      {
        id: "crate-items",
        title: "Items in a crate",
        resource: "crate-item",
        cardinality: "many",
        via: "path",
        op: "crateItems",
        param: "crateId",
        confidence: "declared",
        verified: true,
      },
    ],
  };

  const item: ResourceSpec = {
    id: "crate-item",
    title: "Items in a crate",
    idField: "Id",
    labelField: "Sku",
    listOp: "crateItems",
    verified: false,
    relations: [],
  };

  const input = {
    connection: "api",
    resources: [crate, item],
    shapes: {
      crate: shape([field("Id", { kinds: ["number"] }), field("Name")]),
      "crate-item": shape([
        field("Id", { kinds: ["number"] }),
        field("Sku"),
        field("state", { distinct: 2, samples: ["listed"] }),
      ]),
    },
    toneOf,
  };

  it("writes the sentence the owner asked for", () => {
    const [first] = suggestWidgets(input);
    expect(first?.headline).toBe(
      "This widget will show your crates and the items within them.",
    );
  });

  it("includes the highlight clause when there is something to mark", () => {
    const withMark = suggestWidgets({
      ...input,
      shapes: {
        ...input.shapes,
        crate: shape([
          field("Id", { kinds: ["number"] }),
          field("Name"),
          field("state", { distinct: 2, samples: ["listed"] }),
        ]),
      },
    });
    expect(withMark[0]?.headline).toContain('we\'ll highlight “listed”');
  });

  it("asks about a mark it is not sure of instead of assuming", () => {
    const withMark = suggestWidgets({
      ...input,
      shapes: {
        ...input.shapes,
        crate: shape([
          field("Id", { kinds: ["number"] }),
          field("Name"),
          field("state", { distinct: 2, samples: ["listed"] }),
        ]),
      },
    });
    expect(withMark[0]?.confirm[0]?.question).toContain("listed");
    expect(withMark[0]?.confirm[0]?.options).toContain("Urgent");
  });

  it("says why, citing the URL when the URL is the evidence", () => {
    const [first] = suggestWidgets(input);
    expect(first?.why.join(" ")).toContain("declares");
    expect(first?.confidence).toBe("declared");
  });

  it("builds a record drill-down with the children underneath", () => {
    const [first] = suggestWidgets(input);
    expect(first?.widget.drilldown?.component).toBe("record");
    expect(first?.widget.drilldown?.related.map((section) => section.op)).toEqual(["crateItems"]);
  });

  it("matches the child's rows when the endpoint declares no filter", () => {
    /*
     * The relation names the column that links back, but nothing on the
     * child's endpoint narrows by it. Sending the column name as a query
     * parameter is the failure this guards: an API is free to ignore an
     * unknown parameter, and answering 200 with the whole collection means
     * every drill-down opens on every record while looking healthy.
     */
    const unfiltered = suggestWidgets({
      ...input,
      resources: [
        {
          ...crate,
          relations: [
            {
              ...crate.relations[0]!,
              via: "filter" as const,
              op: "crateItems",
              foreignField: "CrateRef",
              param: undefined,
              filterParam: undefined,
            },
          ],
        },
        item,
      ] as ResourceSpec[],
      shapes: {
        ...input.shapes,
        "crate-item": shape([field("Id", { kinds: ["number"] }), field("CrateRef"), field("Sku")]),
      },
    });

    const [section] = unfiltered[0]?.widget.drilldown?.related ?? [];
    expect(section?.params).toEqual({});
    expect(section?.pipeline).toContainEqual({
      op: "filter",
      where: 'string(CrateRef) == "{{row.Id}}"',
    });
  });

  it("asks the endpoint when the relation names a real parameter", () => {
    const [first] = suggestWidgets(input);
    const [section] = first?.widget.drilldown?.related ?? [];
    // A path relation carries a real parameter, so there is nothing to sift.
    expect(section?.params).toEqual({ crateId: "{{row.Id}}" });
    expect(section?.pipeline.some((step) => step.op === "filter")).toBe(false);
  });

  it("reports what it costs to run, now and on a click", () => {
    const [first] = suggestWidgets(input);
    expect(first?.cost).toEqual({ requests: 1, onOpen: 2 });
  });

  it("caps the sections it can build, not the children it considers", () => {
    /*
     * The cap used to be applied before the "can this child be bound?" check,
     * so a parent declaring several unread children spent the whole quota on
     * them and the one child whose columns were actually known never got a
     * look. A learned link is appended after the declared ones, which put it
     * last in exactly the case where it mattered most — the API had been read,
     * the link had been verified, and the drill-down still opened without it.
     */
    const unread = (index: number) => ({
      id: `crate-scrap-${index}`,
      title: `Scraps ${index}`,
      resource: `crate-scrap-${index}`,
      cardinality: "many" as const,
      via: "path" as const,
      op: `crateScraps${index}`,
      param: "crateId",
      confidence: "declared" as const,
      verified: false,
    });

    const crowded = suggestWidgets({
      ...input,
      resources: [
        {
          ...crate,
          // Four children nobody has read, then the one that works.
          relations: [...[1, 2, 3, 4].map(unread), ...crate.relations],
        },
        item,
        // The unread children exist as resources; they simply have no shape.
        ...[1, 2, 3, 4].map((index) => ({
          id: `crate-scrap-${index}`,
          title: `Scraps ${index}`,
          listOp: `crateScraps${index}`,
          verified: false,
          relations: [],
        })),
      ] as ResourceSpec[],
    });

    expect(crowded[0]?.widget.drilldown?.related.map((section) => section.op)).toEqual([
      "crateItems",
    ]);
  });

  it("still stops at four sections when more than four can be built", () => {
    const extra = (index: number) => ({
      id: `crate-part-${index}`,
      title: `Parts ${index}`,
      resource: `crate-part-${index}`,
      cardinality: "many" as const,
      via: "path" as const,
      op: `crateParts${index}`,
      param: "crateId",
      confidence: "declared" as const,
      verified: true,
    });

    const many = [1, 2, 3, 4, 5];
    const wide = suggestWidgets({
      ...input,
      resources: [
        { ...crate, relations: [...crate.relations, ...many.map(extra)] },
        item,
        ...many.map((index) => ({
          id: `crate-part-${index}`,
          title: `Parts ${index}`,
          listOp: `crateParts${index}`,
          verified: false,
          relations: [],
        })),
      ] as ResourceSpec[],
      shapes: {
        ...input.shapes,
        ...Object.fromEntries(
          many.map((index) => [`crate-part-${index}`, shape([field("Id"), field("Label")])]),
        ),
      },
    });

    // A drill-down that opens six requests deep is a different cost class.
    expect(wide[0]?.widget.drilldown?.related).toHaveLength(4);
  });

  it("is deterministic — same input, same list, same order", () => {
    expect(suggestWidgets(input)).toEqual(suggestWidgets(input));
    const reversed = { ...input, resources: [item, crate] };
    expect(suggestWidgets(reversed).map((entry) => entry.id)).toEqual(
      suggestWidgets(input).map((entry) => entry.id),
    );
  });

  it("emits only widgets that actually execute", () => {
    // A suggestion that cannot render is worse than none, so every one has to
    // survive the same parse a hand-written spec would.
    for (const entry of suggestWidgets(input)) {
      expect(entry.widget.roles.columns).toBeDefined();
      expect(entry.widget.source?.connection).toBe("api");
    }
  });

  it("skips a resource nothing was learned about", () => {
    const blind = { ...input, shapes: {} };
    expect(suggestWidgets(blind)).toEqual([]);
  });

  it("still offers a plain list when there are no children", () => {
    const alone = { ...input, resources: [{ ...crate, relations: [] }] };
    const [first] = suggestWidgets(alone);
    expect(first?.headline).toBe("This widget will list your crates.");
    expect(first?.cost).toEqual({ requests: 1, onOpen: 1 });
  });
});

describe("what is not offered", () => {
  it("never offers a collection that cannot be called on its own", () => {
    /*
     * `/crates/{crateId}/items` needs a crate id. Offering it as a standalone
     * list would produce a widget that can never load — it belongs under its
     * parent, which is where the parent-child suggestion already puts it.
     */
    const crate: ResourceSpec = {
      id: "crate",
      title: "Crates",
      idField: "Id",
      listOp: "crates",
      detailOp: "crate",
      detailParam: "crateId",
      verified: false,
      relations: [
        {
          id: "crate-items",
          title: "Items in a crate",
          resource: "crate-item",
          cardinality: "many",
          via: "path",
          op: "crateItems",
          param: "crateId",
          confidence: "declared",
          verified: true,
        },
      ],
    };
    const item: ResourceSpec = {
      id: "crate-item",
      title: "Items in a crate",
      idField: "Id",
      listOp: "crateItems",
      verified: false,
      relations: [],
    };

    const out = suggestWidgets({
      connection: "api",
      resources: [crate, item],
      shapes: {
        crate: shape([field("Id", { kinds: ["number"] })]),
        "crate-item": shape([field("Id", { kinds: ["number"] })]),
      },
      toneOf,
    });

    expect(out.map((entry) => entry.widget.source?.op)).not.toContain("crateItems");
  });

  it("drops the relationship phrase from a child's name", () => {
    // "Comments on a post" inside a headline gives "the comments on a post
    // within them", which reads like a machine wrote it.
    expect(nounFromTitle("Comments on a post")).toBe("comments");
    expect(nounFromTitle("Todos for a user")).toBe("todos");
  });
});

describe("the sentence matches the widget", () => {
  const parent: ResourceSpec = {
    id: "crate",
    title: "Crates",
    idField: "Id",
    listOp: "crates",
    detailOp: "crate",
    detailParam: "crateId",
    verified: false,
    relations: [
      {
        id: "crate-items",
        title: "Items",
        resource: "crate-item",
        cardinality: "many",
        via: "path",
        op: "crateItems",
        param: "crateId",
        confidence: "declared",
        verified: true,
      },
      {
        id: "crate-labels",
        title: "Labels",
        resource: "crate-label",
        cardinality: "many",
        via: "path",
        op: "crateLabels",
        param: "crateId",
        confidence: "declared",
        verified: true,
      },
    ],
  };
  const item: ResourceSpec = {
    id: "crate-item", title: "Items", idField: "Id", listOp: "crateItems",
    verified: false, relations: [],
  };
  const label: ResourceSpec = {
    id: "crate-label", title: "Labels", idField: "Id", listOp: "crateLabels",
    verified: false, relations: [],
  };

  /** Only `items` was ever opened; `labels` has no shape. */
  const partial = {
    connection: "api",
    resources: [parent, item, label],
    shapes: {
      crate: shape([field("Id", { kinds: ["number"] })]),
      "crate-item": shape([field("Id", { kinds: ["number"] }), field("Sku")]),
    },
    toneOf,
  };

  it("names only the children the widget actually shows", () => {
    const [first] = suggestWidgets(partial);
    /*
     * The API declares two children; one could not be opened, so only one
     * section exists. Saying "and the items and labels within them" would be
     * a promise the widget does not keep.
     */
    expect(first?.headline).toBe("This widget will show your crates and the items within them.");
    expect(first?.widget.drilldown?.related).toHaveLength(1);
  });

  it("says a collection was left out rather than quietly dropping it", () => {
    const [first] = suggestWidgets(partial);
    expect(first?.why.join(" ")).toMatch(/could not be opened/);
  });

  it("does not cite evidence for a child it left out", () => {
    const [first] = suggestWidgets(partial);
    expect(first?.why.filter((line) => line.includes("declares"))).toHaveLength(1);
  });
});

describe("a highlight names a state, not a value", () => {
  /*
   * Found live: a listing-contacts endpoint returned 5 records, so a phone
   * number column had low enough cardinality to look like a closed set, and
   * "(559) 617-7966" was offered as something to highlight.
   */
  it("refuses a contact detail that merely repeated in a small sample", () => {
    for (const value of ["(559) 617-7966", "ada@example.com", "https://x.example", "94103-1234"]) {
      expect(
        highlightCandidates([field("value", { distinct: 2, samples: [value] })], toneOf, {
          rowCount: 9,
        }),
        value,
      ).toEqual([]);
    }
  });

  it("still accepts a state that happens to carry a digit", () => {
    const found = highlightCandidates([field("tier", { distinct: 2, samples: ["Tier 1"] })], toneOf, {
      rowCount: 9,
    });
    expect(found).toHaveLength(1);
  });

  it("skips a column whose values were recognised as a format", () => {
    const dated = {
      name: "createdAt", kinds: ["string"], nullable: false, distinct: 2,
      samples: ["2026-08-12"], format: "iso8601",
    } as unknown as FieldInfo;
    expect(highlightCandidates([dated], toneOf, { rowCount: 9 })).toEqual([]);
  });
});
