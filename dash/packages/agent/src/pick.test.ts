import { describe, expect, it } from "vitest";
import { fakeLlm } from "./llm.js";
import { PICK_SYSTEM_PROMPT, type PickCandidate, buildPickPrompt, pickEndpoints } from "./pick.js";

const candidates: PickCandidate[] = [
  {
    id: "rentals_getunits",
    title: "Retrieve all units",
    path: "/v1/rentals/units",
    resource: "unit",
    description: "Every rental unit on the account.",
  },
  {
    id: "associations_getunits",
    title: "Retrieve all units",
    path: "/v1/associations/units",
    resource: "associationUnit",
    description: "Units belonging to an association.",
  },
  {
    id: "leases_getleases",
    title: "Retrieve all leases",
    path: "/v1/leases",
    resource: "lease",
  },
];

describe("buildPickPrompt", () => {
  it("groups by resource and prints ids verbatim", () => {
    const prompt = buildPickPrompt({ intent: "show my units", candidates });
    expect(prompt).toContain("unit:");
    expect(prompt).toContain("rentals_getunits  /v1/rentals/units");
    expect(prompt).toContain("show my units");
  });

  it("keeps the path, which is the only thing separating same-titled endpoints", () => {
    const prompt = buildPickPrompt({ intent: "units", candidates });
    expect(prompt).toContain("/v1/rentals/units");
    expect(prompt).toContain("/v1/associations/units");
  });

  it("carries no field names — that is the next call's job", () => {
    const prompt = buildPickPrompt({ intent: "units", candidates });
    expect(prompt).not.toContain("fields:");
  });
});

describe("pickEndpoints", () => {
  it("returns the chosen endpoint and the reason", async () => {
    const llm = fakeLlm([
      { args: { primary: "leases_getleases", reason: "Your leases." } },
    ]);
    const result = await pickEndpoints(llm, { intent: "expiring leases", candidates });
    expect(result.primary).toBe("leases_getleases");
    expect(result.secondary).toBeNull();
    expect(result.reason).toBe("Your leases.");
    expect(result.error).toBeNull();
  });

  it("refuses an id that is not on the list", async () => {
    const llm = fakeLlm([{ args: { primary: "invented_endpoint", reason: "here you go" } }]);
    const result = await pickEndpoints(llm, { intent: "anything", candidates });
    expect(result.primary).toBeNull();
    expect(result.error).toContain("invented_endpoint");
  });

  it("drops a bad second choice without losing the first", async () => {
    const llm = fakeLlm([
      { args: { primary: "leases_getleases", secondary: "nope", reason: "leases" } },
    ]);
    const result = await pickEndpoints(llm, { intent: "leases and units", candidates });
    expect(result.primary).toBe("leases_getleases");
    expect(result.secondary).toBeNull();
  });

  it("ignores a second choice identical to the first", async () => {
    const llm = fakeLlm([
      {
        args: {
          primary: "leases_getleases",
          secondary: "leases_getleases",
          reason: "leases",
        },
      },
    ]);
    const result = await pickEndpoints(llm, { intent: "leases", candidates });
    expect(result.secondary).toBeNull();
  });

  it("keeps a real second choice", async () => {
    const llm = fakeLlm([
      {
        args: {
          primary: "leases_getleases",
          secondary: "rentals_getunits",
          reason: "leases with their units",
        },
      },
    ]);
    const result = await pickEndpoints(llm, { intent: "leases with unit names", candidates });
    expect(result.secondary).toBe("rentals_getunits");
  });

  it("says so when there is nothing to choose from, without calling the model", async () => {
    const llm = fakeLlm([{ args: { primary: "x", reason: "y" } }]);
    const result = await pickEndpoints(llm, { intent: "anything", candidates: [] });
    expect(result.primary).toBeNull();
    expect(result.error).toContain("no readable endpoints");
    expect(llm.calls).toHaveLength(0);
  });

  it("reports a model failure instead of throwing", async () => {
    const llm: Parameters<typeof pickEndpoints>[0] = {
      defaultModel: "boom",
      generate: async () => {
        throw new Error("upstream is down");
      },
      stream: async function* () {},
    };
    const result = await pickEndpoints(llm, { intent: "units", candidates });
    expect(result.primary).toBeNull();
    expect(result.error).toBe("upstream is down");
  });

  it("forces the tool call, so there is always an answer to parse", async () => {
    const llm = fakeLlm([{ args: { primary: "rentals_getunits", reason: "units" } }]);
    await pickEndpoints(llm, { intent: "units", candidates });
    expect(llm.calls[0]?.toolChoice).toEqual({ name: "pick_endpoints" });
  });
});

describe("the prompt belongs to no particular API", () => {
  it("names no vendor and no vendor's paths", () => {
    const prompt = buildPickPrompt({ intent: "anything", candidates });
    const everything = `${prompt}\n${PICK_SYSTEM_PROMPT}`;

    /*
     * The same standard the review prompt is held to. An example drawn from
     * one API is a small thing that biases the model's vocabulary toward that
     * API's domain, and the rule it illustrates — that the path separates
     * identically-titled endpoints — is true everywhere and can be stated
     * without borrowing anyone's URLs.
     */
    expect(everything).not.toMatch(/buildium|stripe|github|shopify|salesforce/i);
    expect(PICK_SYSTEM_PROMPT).not.toMatch(/\/v1\//);
    expect(PICK_SYSTEM_PROMPT).not.toMatch(/rentals|associations|leases|tenants/i);
  });
});

describe("an answer named at the wrong level", () => {
  /*
   * Models differ here, reliably enough to matter: one returns the endpoint
   * id, another returns the group heading it was printed under. The second is
   * not a wrong choice, it is a correct one named imprecisely — and rejecting
   * it sends the user back to a list of fifty-nine endpoints for nothing.
   */
  it("accepts a resource name when the group holds exactly one endpoint", async () => {
    const llm = fakeLlm([{ args: { primary: "lease", reason: "your leases" } }]);
    const result = await pickEndpoints(llm, { intent: "leases", candidates });

    expect(result.primary).toBe("leases_getleases");
    expect(result.error).toBeNull();
  });

  it("refuses a resource name covering more than one", async () => {
    // Two endpoints titled the same under one heading is exactly the case
    // that must not be resolved by picking the first.
    const twoUnits = [
      ...candidates,
      { id: "rentals_getunits_v2", title: "Retrieve all units", path: "/v2/rentals/units", resource: "unit" },
    ];
    const llm = fakeLlm([{ args: { primary: "unit", reason: "units" } }]);
    const result = await pickEndpoints(llm, { intent: "units", candidates: twoUnits });

    expect(result.primary).toBeNull();
    expect(result.error).toContain("unit");
  });

  it("accepts an endpoint title when only one carries it", async () => {
    const llm = fakeLlm([{ args: { primary: "Retrieve all leases", reason: "leases" } }]);
    const result = await pickEndpoints(llm, { intent: "leases", candidates });
    expect(result.primary).toBe("leases_getleases");
  });

  it("refuses a title two endpoints share", async () => {
    const llm = fakeLlm([{ args: { primary: "Retrieve all units", reason: "units" } }]);
    const result = await pickEndpoints(llm, { intent: "units", candidates });
    // Both units endpoints answer to it, and picking either would be a guess.
    expect(result.primary).toBeNull();
  });

  it("resolves a second choice the same way, without duplicating the first", async () => {
    const llm = fakeLlm([
      { args: { primary: "leases_getleases", secondary: "lease", reason: "both" } },
    ]);
    const result = await pickEndpoints(llm, { intent: "leases", candidates });
    // "lease" resolves to the endpoint already chosen, so there is no second.
    expect(result.secondary).toBeNull();
  });
});

/**
 * The alternative, and the guards on it.
 *
 * The schema had no vocabulary for a second reading, so a model looking at two
 * defensible ones had to commit. Now it can say so — and everything it says is
 * checked as hard as the picks are, because an alternative naming nothing is
 * a question about an endpoint that does not exist.
 */
describe("a second reading of the request", () => {
  const candidates = [
    { id: "list_things", title: "Retrieve all things", path: "/things" },
    { id: "list_owners", title: "Retrieve all owners", path: "/owners" },
    { id: "list_notes", title: "Retrieve all notes", path: "/notes" },
  ];

  const pick = async (args: Record<string, unknown>) =>
    pickEndpoints(fakeLlm([{ args }]), { intent: "how many per month", candidates });

  it("carries an alternative through, in the model's own words", async () => {
    const result = await pick({
      primary: "list_things",
      reason: "these are the things",
      alternatives: [
        { id: "list_owners", role: "primary", whatItIs: "The people the things belong to." },
      ],
    });
    expect(result.alternatives).toEqual([
      { id: "list_owners", role: "primary", whatItIs: "The people the things belong to." },
    ]);
  });

  it("is empty when the model simply committed, which is the ordinary case", async () => {
    const result = await pick({ primary: "list_things", reason: "these are the things" });
    expect(result.alternatives).toEqual([]);
  });

  it("drops an alternative naming an endpoint that does not exist", async () => {
    const result = await pick({
      primary: "list_things",
      reason: "r",
      alternatives: [{ id: "invented", role: "primary", whatItIs: "Nothing." }],
    });
    expect(result.alternatives).toEqual([]);
  });

  it("drops one naming something already picked, which is no alternative at all", async () => {
    const result = await pick({
      primary: "list_things",
      secondary: "list_owners",
      relationship: "compare",
      reason: "r",
      alternatives: [
        { id: "list_things", role: "primary", whatItIs: "The same thing." },
        { id: "list_owners", role: "secondary", whatItIs: "Also the same." },
      ],
    });
    expect(result.alternatives).toEqual([]);
  });

  /* An alternative to a second endpoint that was never named has nothing to be
     an alternative to. */
  it("drops a secondary alternative when no second endpoint was picked", async () => {
    const result = await pick({
      primary: "list_things",
      reason: "r",
      alternatives: [{ id: "list_owners", role: "secondary", whatItIs: "The owners." }],
    });
    expect(result.alternatives).toEqual([]);
  });

  it("tells the model to commit rather than hedge", () => {
    expect(PICK_SYSTEM_PROMPT).toContain("Commit when the request is clear");
    expect(PICK_SYSTEM_PROMPT).toContain("Do NOT use alternatives to hedge");
  });
});
