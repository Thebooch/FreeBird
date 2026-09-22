import { describe, expect, it } from "vitest";
import type { BriefCandidate } from "./brief.js";
import {
  buildCategoryPrompt,
  categoriesFromProposal,
  categoriseApi,
  categoryId,
} from "./categories.js";
import { fakeLlm } from "./llm.js";

const candidate = (input: Partial<BriefCandidate> & { entity: string }): BriefCandidate => ({
  connection: "acme",
  recordType: input.entity,
  source: "Acme",
  many: `${input.entity}s`,
  kind: "work",
  starting: true,
  fields: [],
  ...input,
});

const ROSTER: BriefCandidate[] = [
  candidate({ entity: "lease", many: "Leases", description: "An agreement on a unit." }),
  candidate({ entity: "applicant", many: "Applicants", kind: "party" }),
  candidate({ entity: "workorder", many: "Work orders" }),
  candidate({ entity: "vendor", many: "Vendors", kind: "party" }),
  candidate({ entity: "taskcategory", many: "Task categories", kind: "lookup", starting: false }),
];

const DIVISION = {
  product: "Property management software for residential rentals.",
  domain: "property management",
  categories: [
    {
      title: "Leasing",
      description: "Agreements on units and the people applying for them.",
      entities: ["lease", "applicant"],
    },
    { title: "Maintenance", entities: ["workorder", "vendor", "taskcategory"] },
  ],
};

describe("buildCategoryPrompt", () => {
  it("lists record types with their descriptions, reference lists apart", () => {
    const prompt = buildCategoryPrompt({ apiTitle: "Acme", candidates: ROSTER });
    expect(prompt).toContain("API: Acme");
    expect(prompt).toContain("lease  Leases  — An agreement on a unit.");
    expect(prompt).toContain("REFERENCE LISTS");
    expect(prompt.indexOf("taskcategory")).toBeGreaterThan(prompt.indexOf("REFERENCE LISTS"));
  });

  it("shows how many endpoints sit behind a record type, where more than one does", () => {
    const prompt = buildCategoryPrompt({
      apiTitle: "Acme",
      candidates: ROSTER,
      endpointCounts: { lease: 6, applicant: 1 },
    });
    expect(prompt).toContain("[6 endpoints]");
    expect(prompt).not.toContain("[1 endpoints]");
  });

  /* Field lists are most of the brief prompt and say nothing about which part
   * of a business a record belongs to. Keeping them out is what makes the
   * undivided single call affordable. */
  it("leaves field lists out", () => {
    const prompt = buildCategoryPrompt({
      apiTitle: "Acme",
      candidates: [
        candidate({
          entity: "lease",
          fields: [{ path: "LeaseStatus", label: "Status", role: "narrow" }],
        }),
      ],
    });
    expect(prompt).not.toContain("LeaseStatus");
    expect(prompt).not.toContain("narrow by");
  });
});

describe("categoryId", () => {
  it("slugs a title", () => {
    expect(categoryId("Accounts Receivable", new Set())).toBe("accounts-receivable");
  });

  it("dedupes rather than losing the second part", () => {
    expect(categoryId("Leasing", new Set(["leasing"]))).toBe("leasing-2");
  });

  it("falls back rather than producing an empty id", () => {
    expect(categoryId("—", new Set())).toBe("part");
  });
});

describe("categoriesFromProposal", () => {
  it("keeps what the roster supports", () => {
    const built = categoriesFromProposal({ proposal: DIVISION, candidates: ROSTER });
    expect(built.skipped).toEqual([]);
    expect(built.categories.map((one) => one.id)).toEqual(["leasing", "maintenance"]);
    expect(built.categories[0]?.entities).toEqual(["lease", "applicant"]);
    expect(built.profile).toEqual({
      summary: "Property management software for residential rentals.",
      domain: "property management",
    });
    expect(built.uncategorised).toEqual([]);
  });

  it("refuses a record type this API does not have", () => {
    const built = categoriesFromProposal({
      proposal: {
        categories: [{ title: "Leasing", entities: ["lease", "tenantscreening"] }],
      },
      candidates: ROSTER,
    });
    expect(built.categories[0]?.entities).toEqual(["lease"]);
    expect(built.skipped.join(" ")).toMatch(/"tenantscreening", which is not a record type/);
  });

  /* The same records under two headings is the same board twice, and the
   * second one always looks like a mistake somebody else made. */
  it("leaves a record type claimed twice in the first part that claimed it", () => {
    const built = categoriesFromProposal({
      proposal: {
        categories: [
          { title: "Leasing", entities: ["lease", "applicant"] },
          { title: "Accounting", entities: ["lease"] },
        ],
      },
      candidates: ROSTER,
    });
    expect(built.categories).toHaveLength(1);
    expect(built.skipped.join(" ")).toMatch(/already belong to an earlier part/);
  });

  it("drops a part left with nothing behind it", () => {
    const built = categoriesFromProposal({
      proposal: { categories: [{ title: "Ghosts", entities: ["nothing"] }] },
      candidates: ROSTER,
    });
    expect(built.categories).toEqual([]);
    expect(built.skipped.join(" ")).toMatch(/"Ghosts" was dropped/);
  });

  /* Unplaced is honest; filed under a part it does not belong to is not. A
   * reference list nobody placed is not reported — it is not a starting point
   * in the first place. */
  it("reports the record types nobody placed", () => {
    const built = categoriesFromProposal({
      proposal: { categories: [{ title: "Leasing", entities: ["lease"] }] },
      candidates: ROSTER,
    });
    expect(built.uncategorised).toEqual(["applicant", "workorder", "vendor"]);
  });

  it("keeps the categories when no profile was written", () => {
    const built = categoriesFromProposal({
      proposal: { categories: [{ title: "Leasing", entities: ["lease"] }] },
      candidates: ROSTER,
    });
    expect(built.profile).toBeNull();
    expect(built.categories).toHaveLength(1);
  });
});

describe("categoriseApi", () => {
  const input = { apiTitle: "Acme", candidates: ROSTER };

  it("turns one call into the API's parts", async () => {
    const llm = fakeLlm([{ args: DIVISION }]);
    const result = await categoriseApi(llm, input);
    expect(result.errors).toEqual([]);
    expect(result.categories).toHaveLength(2);
    expect(result.profile?.domain).toBe("property management");
    expect(llm.calls[0]?.toolChoice).toEqual({ name: "divide_api" });
  });

  /* One call, never batched: a model can only relate what it was shown
   * together, and which records belong together is the whole question. */
  it("asks once however long the roster is", async () => {
    const llm = fakeLlm([{ args: DIVISION }]);
    await categoriseApi(llm, {
      apiTitle: "Acme",
      candidates: [
        ...ROSTER,
        ...Array.from({ length: 200 }, (_, index) => candidate({ entity: `thing${index}` })),
      ],
    });
    expect(llm.calls).toHaveLength(1);
  });

  it("reports a call that answered without the tool", async () => {
    const llm = fakeLlm([{ text: "I would rather chat." }]);
    const result = await categoriseApi(llm, input);
    expect(result.errors[0]).toMatch(/without calling the tool/);
    expect(result.categories).toEqual([]);
  });

  it("says so rather than dividing an API nobody has described", async () => {
    const llm = fakeLlm([{ args: DIVISION }]);
    const result = await categoriseApi(llm, { apiTitle: "Acme", candidates: [] });
    expect(result.errors[0]).toMatch(/no record types described/);
    expect(llm.calls).toEqual([]);
  });

  it("reports a proposal that produced nothing usable", async () => {
    const llm = fakeLlm([{ args: { categories: [{ title: "Ghosts", entities: ["nope"] }] } }]);
    const result = await categoriseApi(llm, input);
    expect(result.categories).toEqual([]);
    expect(result.errors[0]).toMatch(/nothing usable/);
    expect(result.skipped.length).toBeGreaterThan(0);
  });
});
