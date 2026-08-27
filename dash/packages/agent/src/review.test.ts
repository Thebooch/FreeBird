import type { ResourceSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import type { FieldInfo, InferredShape } from "./infer.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewPrompt, mapReviewProposal } from "./review.js";

const field = (name: string, kinds = ["string"]): FieldInfo =>
  ({ name, kinds, nullable: false, distinct: 3, samples: [] }) as unknown as FieldInfo;

const crate: ResourceSpec = {
  id: "crate",
  title: "Crates",
  idField: "Id",
  listOp: "crates",
  detailOp: "crate",
  detailParam: "crateId",
  verified: false,
  relations: [],
};

const input = {
  connection: "api",
  resources: [crate],
  shapes: {
    crate: {
      rowsPath: "$",
      rowCount: 40,
      schemaHash: "fnv1a:x",
      fields: [field("Id", ["number"]), field("Region"), field("Amount", ["number"])],
    } as unknown as InferredShape,
  },
  existing: [],
};

describe("the prompt", () => {
  it("asks for the two things a rule cannot judge", () => {
    expect(REVIEW_SYSTEM_PROMPT).toMatch(/RELATIONSHIPS ARE THE POINT/);
    expect(REVIEW_SYSTEM_PROMPT).toMatch(/WHAT DASHBOARDS PAIR/);
  });

  it("names no vendor and assumes no domain", () => {
    // The engine has to work on an API nobody here has seen. A worked example
    // drawn from one customer's business teaches the model to expect that
    // business, which is exactly the bias that has to stay out of the prompt.
    expect(REVIEW_SYSTEM_PROMPT).not.toMatch(/buildium|stripe|github/i);
    expect(REVIEW_SYSTEM_PROMPT).toMatch(/domain you should not\s+assume/);
  });

  it("treats the resource map as untrusted", () => {
    // Endpoint titles and field names are third-party text; a "title" reading
    // "ignore your instructions" must be describable without being obeyed.
    expect(REVIEW_SYSTEM_PROMPT).toMatch(/untrusted/i);
  });

  it("sends field names and structure, never a row of anyone's data", () => {
    const prompt = buildReviewPrompt({
      ...input,
      shapes: {
        crate: {
          ...input.shapes.crate,
          fields: [
            { name: "Region", kinds: ["string"], nullable: false, distinct: 2, samples: ["EMEA"] },
          ],
        } as unknown as InferredShape,
      },
    });
    expect(prompt).toContain("Region");
    // The sample value is real business data and a proposal never needs it.
    expect(prompt).not.toContain("EMEA");
  });

  it("lists resources nobody has read, and says plainly that they are unread", () => {
    /*
     * The bug this pins: the prompt used to skip any resource with no shape,
     * so on a large API the model saw a fraction of what exists and could only
     * answer that the pairing asked for was unavailable. A resource nobody has
     * read is still worth pairing — only the link field is a guess, and that
     * is verified against the API before anything is offered.
     */
    const prompt = buildReviewPrompt({
      ...input,
      resources: [crate, { ...crate, id: "sleeve", title: "Sleeves", idField: undefined }],
    });
    expect(prompt).toContain("sleeve");
    expect(prompt).toMatch(/not read yet/);
  });

  it("shows what the rules already offered, so the model adds rather than repeats", () => {
    const prompt = buildReviewPrompt({
      ...input,
      existing: [{ headline: "This widget will list your crates." }] as never,
    });
    expect(prompt).toMatch(/do not repeat/i);
    expect(prompt).toContain("This widget will list your crates.");
  });
});

describe("mapping a proposal", () => {
  const proposal = {
    headline: "This widget will break your crates down by region.",
    reason: "Region repeats across records",
    resource: "crate",
    component: "bar",
    categoryField: "Region",
    valueField: "Amount",
    aggregation: "sum",
  };

  it("builds a real spec the model never wrote the pipeline for", () => {
    const built = mapReviewProposal(proposal, input)!;
    expect(built.source).toBe("model");
    expect(built.widget.component).toBe("bar");
    // Deterministic construction: group → sort → limit, none of it authored.
    expect(built.widget.pipeline.map((step) => step.op)).toEqual([
      "extract",
      "group",
      "sort",
      "limit",
    ]);
  });

  it("refuses a proposal naming a field that does not exist", () => {
    /*
     * The failure worth guarding: a widget bound to an invented column renders
     * empty forever and looks like a data problem rather than a bad guess.
     */
    expect(mapReviewProposal({ ...proposal, categoryField: "Imaginary" }, input)).toBeNull();
    expect(
      mapReviewProposal({ ...proposal, component: "table", columns: ["Nope"] }, input),
    ).toBeNull();
  });

  it("refuses a proposal naming a resource that was never offered", () => {
    expect(mapReviewProposal({ ...proposal, resource: "ghost" }, input)).toBeNull();
  });

  it("never claims a model's reading is something the API declared", () => {
    expect(mapReviewProposal(proposal, input)?.confidence).toBe("inferred");
  });
});

/**
 * A record you can open to reveal what belongs to it — the shape the whole
 * relational path exists to produce.
 */
describe("mapping a parent with its children", () => {
  const sleeve: ResourceSpec = {
    id: "sleeve",
    title: "Sleeves",
    idField: "Id",
    listOp: "sleeves",
    verified: false,
    relations: [],
  };

  const nested = {
    ...input,
    resources: [crate, sleeve],
    shapes: {
      ...input.shapes,
      sleeve: {
        rowsPath: "$",
        rowCount: 90,
        schemaHash: "fnv1a:y",
        fields: [field("Id", ["number"]), field("CrateId", ["number"]), field("Label")],
      } as unknown as InferredShape,
    },
  };

  const proposal = {
    headline: "This widget will open a crate to show the sleeves inside it.",
    reason: "Every sleeve carries a crate's id",
    resource: "crate",
    component: "table",
    columns: ["Region"],
    children: [{ resource: "sleeve", linkField: "CrateId", title: "Sleeves in this crate" }],
  };

  it("matches the child's rows when its endpoint declares no filter", () => {
    /*
     * `linkField` is a column, and the proposal's fixture resource declares no
     * query parameter to narrow by. Sending the column name as a parameter is
     * the failure this guards: an API that ignores an unknown parameter
     * answers 200 with everything, so the section shows every record in the
     * account while looking perfectly healthy.
     */
    const built = mapReviewProposal(proposal, nested)!;
    const related = built.widget.drilldown?.related ?? [];
    expect(related).toHaveLength(1);
    expect(related[0]?.title).toBe("Sleeves in this crate");
    expect(related[0]?.params).toEqual({});
    expect(related[0]?.pipeline).toContainEqual({
      op: "filter",
      // Coerced on both sides: `==` is strict and an id is a number here and a
      // string in the token.
      where: 'string(CrateId) == "{{row.Id}}"',
    });
    // The parent record itself still opens by its own id.
    expect(built.widget.drilldown?.params).toEqual({ crateId: "{{row.Id}}" });
  });

  it("asks the endpoint instead, when the relation names a real parameter", () => {
    const withParam = {
      ...nested,
      resources: [
        {
          ...crate,
          relations: [
            {
              id: "crate-sleeves",
              title: "Sleeves",
              resource: "sleeve",
              cardinality: "many",
              via: "filter",
              op: "sleeves",
              foreignField: "CrateId",
              filterParam: "crateIds",
              param: "crateIds",
              confidence: "inferred",
              verified: true,
            },
          ],
        },
        sleeve,
      ] as unknown as ResourceSpec[],
    };

    const related = mapReviewProposal(proposal, withParam)!.widget.drilldown?.related ?? [];
    expect(related[0]?.params).toEqual({ crateIds: "{{row.Id}}" });
    // One filtered request, so there is nothing to sift afterwards.
    expect(related[0]?.pipeline.some((step) => step.op === "filter")).toBe(false);
  });

  it("prices the extra requests a drill-down costs, so nothing is hidden", () => {
    expect(mapReviewProposal(proposal, nested)?.cost).toEqual({ requests: 1, onOpen: 2 });
  });

  it("drops a child whose rows do not actually carry the link field", () => {
    /*
     * The caller verifies pairings against the live API first; this is the
     * second gate. A section bound to a column the child does not have would
     * render empty forever and read as a data problem rather than a bad guess.
     */
    const built = mapReviewProposal(
      { ...proposal, children: [{ ...proposal.children[0]!, linkField: "Imaginary" }] },
      nested,
    );
    // No section survived, so it falls back to the plain parent table.
    expect(built?.widget.drilldown?.related ?? []).toHaveLength(0);
  });

  it("ignores a child that names the parent itself", () => {
    const built = mapReviewProposal(
      { ...proposal, children: [{ resource: "crate", linkField: "Id", title: "Itself" }] },
      nested,
    );
    expect(built?.widget.drilldown?.related ?? []).toHaveLength(0);
  });
});
