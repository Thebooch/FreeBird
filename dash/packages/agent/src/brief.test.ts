import { compileBrief, entitySchema, resourceSchema, type EntitySpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import {
  BRIEF_SYSTEM_PROMPT,
  briefCandidates,
  briefSchema,
  buildBriefPrompt,
  resolveCandidate,
  writeBrief,
} from "./brief.js";
import { fakeLlm } from "./llm.js";

/**
 * Turning a request into a brief, over record types rather than endpoints.
 *
 * The test this file exists for is the intent one: a request to *see* records
 * narrowed by something must not become a chart that counts them. Everything
 * else guards the same boundary from another side — a record type the model
 * invented is refused, and the roster it chooses from carries no more than it
 * needs to choose.
 */

const entity = (input: Record<string, unknown>): EntitySpec =>
  entitySchema.parse({
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    kind: "work",
    description: "Something that needs doing.",
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      { path: "Status", label: "Status", visibility: "primary" },
      { path: "Category.Name", label: "Category", visibility: "detail" },
      { path: "Cost", label: "Cost", semantic: "currency", visibility: "detail" },
    ],
    ...input,
  });

const glossary = entity({
  id: "category",
  resource: "category",
  name: { one: "Category", many: "Categories" },
  kind: "lookup",
  description: "A word other records are filed under.",
  fields: [{ path: "Name", label: "Name", visibility: "primary" }],
});

describe("briefCandidates", () => {
  it("offers the few fields worth naming, not the whole dictionary", () => {
    /*
     * A brief names what somebody asked to narrow or total by. The full field
     * dictionary for a real API is twelve hundred entries, which would put the
     * prompt back where the endpoint list had it.
     */
    const [candidate] = briefCandidates([{ connection: "api", title: "The API", entities: [entity({})] }]);
    expect(candidate?.fields.map((field) => field.path)).toEqual([
      "Status",
      "Category.Name",
      "Cost",
    ]);
    expect(candidate?.fields.find((field) => field.path === "Cost")?.role).toBe("total");
    expect(candidate?.fields.find((field) => field.path === "Status")?.role).toBe("narrow");
  });

  it("carries the label a person reads beside the path a model copies", () => {
    const [candidate] = briefCandidates([{ connection: "api", title: "The API", entities: [entity({})] }]);
    expect(candidate?.fields.find((field) => field.path === "Category.Name")?.label).toBe(
      "Category",
    );
  });

  /* Unscripted benchmark, 2026-09-28: a VIP flag and an untagged total were never offered, so neither could be asked for. */
  it("offers flags to narrow by, and untagged numbers to add up, but never an identity", () => {
    const [candidate] = briefCandidates([
      {
        connection: "api",
        title: "The API",
        entities: [
          entity({
            fields: [
              { path: "Id", visibility: "hidden" },
              { path: "Status", label: "Status", visibility: "primary" },
              { path: "vip", label: "VIP", kinds: ["boolean"], visibility: "detail" },
              { path: "total", label: "Order total", kinds: ["number"], visibility: "detail" },
              { path: "customer_id", label: "Customer", kinds: ["number"], visibility: "detail" },
            ],
          }),
        ],
      },
    ]);
    expect(candidate?.fields.find((field) => field.path === "vip")?.role).toBe("narrow");
    expect(candidate?.fields.find((field) => field.path === "total")?.role).toBe("total");
    expect(candidate?.fields.some((field) => field.path === "customer_id")).toBe(false);
  });

  it("offers what dates the records, so a request can say when", () => {
    const [candidate] = briefCandidates([
      {
        connection: "api",
        title: "The API",
        entities: [
          entity({
            fields: [
              { path: "Id", visibility: "hidden" },
              { path: "Status", label: "Status", visibility: "primary" },
              { path: "booked", label: "Booked", kinds: ["string"], visibility: "detail" },
              { path: "DueDate", label: "Due", semantic: "timestamp", visibility: "detail" },
            ],
          }),
        ],
      },
    ]);
    expect(candidate?.fields.filter((field) => field.role === "when").map((field) => field.path).sort()).toEqual([
      "DueDate",
      "booked",
    ]);
    const prompt = buildBriefPrompt({ intent: "debits in July", candidates: [candidate!], today: "2026-09-01" });
    expect(prompt).toContain("dated by:");
    expect(prompt).toContain("TODAY: 2026-09-01");
  });

  it("carries a range the request named through to the brief", async () => {
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "measure",
          filters: [{ field: "Cost", above: 100 }],
          reason: "Costly tasks.",
        },
      },
    ]);
    const result = await writeBrief(llm, {
      intent: "how many tasks cost more than 100",
      candidates: briefCandidates([{ connection: "api", title: "The API", entities: [entity({})] }]),
    });
    expect(result.brief?.filters).toEqual([{ field: "Cost", above: 100 }]);
  });

  it("marks a reference list as not something to start from", () => {
    expect(briefCandidates([{ connection: "api", title: "The API", entities: [glossary] }])[0]?.starting).toBe(false);
    expect(briefCandidates([{ connection: "api", title: "The API", entities: [entity({})] }])[0]?.starting).toBe(true);
  });
});

describe("buildBriefPrompt", () => {
  const prompt = () =>
    buildBriefPrompt({
      intent: "tasks with a filter by category",
      candidates: briefCandidates([{ connection: "api", title: "The API", entities: [entity({}), glossary] }]),
    });

  it("prints ids verbatim, with the paths a brief has to copy", () => {
    expect(prompt()).toContain("task  Tasks");
    expect(prompt()).toContain("Category (Category.Name)");
    expect(prompt()).toContain("tasks with a filter by category");
  });

  it("puts reference lists last, under their own heading", () => {
    const text = prompt();
    expect(text).toContain("REFERENCE LISTS");
    expect(text.indexOf("task  Tasks")).toBeLessThan(text.indexOf("REFERENCE LISTS"));
    expect(text.indexOf("REFERENCE LISTS")).toBeLessThan(text.indexOf("category  Categories"));
  });
});

describe("writeBrief", () => {
  const candidates = briefCandidates([{ connection: "api", title: "The API", entities: [entity({}), glossary] }]);

  it("reads a request to see records narrowed by something as records", async () => {
    /*
     * The failure this whole layer exists to stop. Asked for records "with a
     * filter by category", the old flow built a chart of counts — because a
     * grouping was the only vocabulary it had for "by category".
     */
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          filters: [{ field: "Category.Name" }],
          reason: "Your tasks, with a filter for category.",
        },
      },
    ]);
    const result = await writeBrief(llm, {
      intent: "tasks with a filter by category",
      candidates,
    });

    expect(result.error).toBeNull();
    expect(result.brief).toEqual({
      entity: "task",
      intent: "records",
      filters: [{ field: "Category.Name" }],
    });
    expect(result.reason).toBe("Your tasks, with a filter for category.");
  });

  it("carries a comparison's grouping and measure", async () => {
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "compare",
          groupBy: "Status",
          measureAgg: "sum",
          measureField: "Cost",
          reason: "What the work costs, by state.",
        },
      },
    ]);
    const result = await writeBrief(llm, { intent: "cost by status", candidates });
    expect(result.brief).toMatchObject({
      intent: "compare",
      groupBy: "Status",
      measure: { agg: "sum", field: "Cost" },
    });
  });

  /* Unscripted benchmark, 2026-09-28: a sum with nothing to add up compiled into no widget at all. */
  it("sends back a sum that does not say what to add up, once", async () => {
    const llm = fakeLlm([
      { args: { entity: "task", intent: "measure", measureAgg: "sum", reason: "Total cost." } },
      { args: { entity: "task", intent: "measure", measureAgg: "sum", measureField: "Cost", reason: "Total cost." } },
    ]);
    const result = await writeBrief(llm, { intent: "what does the work cost", candidates });
    expect(result.brief).toMatchObject({ intent: "measure", measure: { agg: "sum", field: "Cost" } });
    expect(llm.calls).toHaveLength(2);
    expect(String(llm.calls[1]!.messages.at(-1)!.content)).toMatch(/measureField is missing/);
  });

  it("takes a field named by its label as that field, and sends back one named by a description", async () => {
    const byLabel = fakeLlm([{ args: { entity: "task", intent: "compare", groupBy: "category", reason: "By category." } }]);
    expect((await writeBrief(byLabel, { intent: "tasks per category", candidates })).brief?.groupBy).toBe("Category.Name");
    const described = fakeLlm([
      { args: { entity: "task", intent: "measure", measureAgg: "sum", measureField: "total cost", reason: "Cost." } },
      { args: { entity: "task", intent: "measure", measureAgg: "sum", measureField: "Cost", reason: "Cost." } },
    ]);
    const result = await writeBrief(described, { intent: "what does it all cost", candidates });
    expect(result.brief?.measure).toEqual({ agg: "sum", field: "Cost" });
    expect(String(described.calls[1]!.messages.at(-1)!.content)).toMatch(/"total cost" is not a field/);
  });

  /* Regression: "delivered kilograms" named the field `kilograms`, which no record has. */
  describe("a unit written where a field was meant", () => {
    const deliveries = briefCandidates([
      {
        connection: "api",
        title: "The API",
        entities: [
          entity({
            id: "delivery",
            resource: "delivery",
            name: { one: "Delivery", many: "Deliveries" },
            kind: "event",
            fields: [
              { path: "id", visibility: "hidden" },
              { path: "status", label: "Status", visibility: "primary", values: ["delivered", "returned"] },
              { path: "weight_kg", label: "Weight", semantic: "number", visibility: "primary" },
              { path: "distanceMiles", label: "Distance", semantic: "number", visibility: "detail" },
              { path: "internal_ref", visibility: "hidden" },
            ],
          }),
        ],
      },
    ]);
    const sum = (measureField: string) => ({
      args: { entity: "delivery", intent: "measure", measureAgg: "sum", measureField, reason: "Weight." },
    });

    it("is the one field that carries it, with nothing sent back", async () => {
      const llm = fakeLlm([sum("kilograms")]);
      const result = await writeBrief(llm, { intent: "kilograms carried", candidates: deliveries });
      expect(result.brief?.measure).toEqual({ agg: "sum", field: "weight_kg" });
      expect(llm.calls).toHaveLength(1);
      const miles = fakeLlm([sum("miles")]);
      expect((await writeBrief(miles, { intent: "miles driven", candidates: deliveries })).brief?.measure).toEqual({
        agg: "sum",
        field: "distanceMiles",
      });
    });

    /* Seen with the trackwell mock API. */
    it("sends back, once, a word of the request that a field holds and nothing narrows by", async () => {
      const llm = fakeLlm([sum("weight_kg"), { args: { ...sum("weight_kg").args, filters: [{ field: "status", values: ["delivered"] }] } }]);
      const result = await writeBrief(llm, { intent: "delivered kilograms", candidates: deliveries });
      expect(String(llm.calls[1]!.messages.at(-1)!.content)).toMatch(/the request says "delivered", which status holds as delivered/);
      expect(result.brief?.filters).toEqual([{ field: "status", values: ["delivered"] }]);
    });

    it("sends back, once, a name no record has, even one word long", async () => {
      const llm = fakeLlm([sum("mass"), sum("weight_kg")]);
      const result = await writeBrief(llm, { intent: "total mass delivered", candidates: deliveries });
      expect(result.brief?.measure).toEqual({ agg: "sum", field: "weight_kg" });
      expect(String(llm.calls[1]!.messages.at(-1)!.content)).toMatch(/"mass" is not a field/);
    });

    it("never sends back a field the record type has but the list left out", async () => {
      const llm = fakeLlm([
        { args: { entity: "delivery", intent: "records", columns: ["internal_ref"], reason: "Refs." } },
      ]);
      await writeBrief(llm, { intent: "delivery refs", candidates: deliveries });
      expect(llm.calls).toHaveLength(1);
    });

    it("asks again, naming the fields, where two carry the unit equally", async () => {
      const two = briefCandidates([
        {
          connection: "api",
          title: "The API",
          entities: [
            entity({
              id: "delivery",
              resource: "delivery",
              name: { one: "Delivery", many: "Deliveries" },
              kind: "event",
              fields: [
                { path: "delivered_kg", label: "Delivered weight", semantic: "number", visibility: "primary" },
                { path: "returned_kg", label: "Returned weight", semantic: "number", visibility: "primary" },
              ],
            }),
          ],
        },
      ]);
      /* The request's other words choose between them. */
      const chosen = fakeLlm([sum("delivered kilograms")]);
      expect((await writeBrief(chosen, { intent: "delivered kilograms", candidates: two })).brief?.measure).toEqual({
        agg: "sum",
        field: "delivered_kg",
      });
      const unsure = fakeLlm([sum("kilograms"), sum("delivered_kg")]);
      await writeBrief(unsure, { intent: "kilograms", candidates: two });
      expect(String(unsure.calls[1]!.messages.at(-1)!.content)).toMatch(
        /"kilograms" is a unit, not a field \(delivered_kg or returned_kg hold it\)/,
      );
    });
  });

  /* "revenue" invoiced or collected is the same records added up differently. */
  it("says which reading of a business word it built, and offers the other", async () => {
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "measure",
          measureAgg: "sum",
          measureField: "Cost",
          reading: { term: "spend", as: "the cost of every task" },
          alternative: {
            label: "cost of open tasks only",
            intent: "measure",
            measureAgg: "sum",
            measureField: "Cost",
            filters: [{ field: "Status", values: ["Open"] }],
          },
          reason: "Total cost.",
        },
      },
    ]);
    const result = await writeBrief(llm, { intent: "what is our spend", candidates });
    expect(result.brief?.reading).toEqual({ term: "spend", as: "the cost of every task" });
    /* Same records and intent, narrowed differently: still another reading. */
    expect(result.alternative?.brief.filters).toEqual([{ field: "Status", values: ["Open"] }]);
    /* A list's records speak for themselves: no reading on one. */
    const list = fakeLlm([
      { args: { entity: "task", intent: "records", reading: { term: "work", as: "tasks" }, reason: "Tasks." } },
    ]);
    expect((await writeBrief(list, { intent: "my work", candidates })).brief?.reading).toBeUndefined();
  });

  /* Regression: "leave out cancelled orders" was dropped while the reason said it was done. */
  it("carries whether a field holds anything, and what it could not express", async () => {
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "measure",
          measureAgg: "sum",
          measureField: "Cost",
          filters: [{ field: "Status", empty: false }],
          unmet: ["leave out archived tasks", "  "],
          reason: "Cost of tasks with a status.",
        },
      },
    ]);
    const result = await writeBrief(llm, { intent: "cost of tasks with a status, not archived", candidates });
    expect(result.brief?.filters).toEqual([{ field: "Status", empty: false }]);
    expect(result.brief?.unmet).toEqual(["leave out archived tasks"]);
  });

  /* Regression: "more than $250" compared 250 cents. The roster now says which numbers are in cents. */
  it("says which numbers the documentation puts in the smallest currency unit", () => {
    const [candidate] = briefCandidates([
      {
        connection: "api",
        title: "The API",
        entities: [
          entity({
            fields: [
              { path: "Id", visibility: "hidden" },
              { path: "Status", label: "Status", visibility: "primary" },
              { path: "amount", label: "Amount", semantic: "currency", format: "minor_units", visibility: "detail" },
              { path: "Cost", label: "Cost", semantic: "currency", visibility: "detail" },
            ],
          }),
        ],
      },
    ]);
    const prompt = buildBriefPrompt({ intent: "x", candidates: [candidate!] });
    expect(prompt).toContain("Amount (amount, in the smallest currency unit)");
    expect(prompt).toContain("Cost (Cost)");
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/More than \$250 is above 25000/);
  });

  it("carries a narrowing phrase as values on a filter", async () => {
    // Not as a hidden filtering step: a reader who cannot see what was
    // narrowed cannot widen it, and believes they see everything there is.
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          filters: [{ field: "Status", values: ["Open"] }],
          reason: "The open work.",
        },
      },
    ]);
    const result = await writeBrief(llm, { intent: "open tasks", candidates });
    expect(result.brief?.filters).toEqual([{ field: "Status", values: ["Open"] }]);
  });

  /* Regression: with no such record type, "how many Pokémon" counted evolution chains, and "episodes" counted characters. */
  it("says when no record type is what was asked about, and builds nothing", async () => {
    const llm = fakeLlm([{ args: { entity: "none", intent: "measure", reason: "There are no invoices here, only tasks." } }]);
    const result = await writeBrief(llm, { intent: "how many invoices", candidates });
    expect(result.brief).toBeNull();
    expect(result.error).toBeNull();
    expect(result.unmatched).toBe("There are no invoices here, only tasks.");
    expect(llm.calls).toHaveLength(1);
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/answer entity\s+"none"/);
  });

  /* Measurement 1: "in US dollars" on records holding USD, and "money out" on records holding debit, were never narrowed. */
  describe("what the records were seen to hold", () => {
    const payments = entity({
      id: "payment",
      resource: "payment",
      name: { one: "Payment", many: "Payments" },
      kind: "money",
      fields: [
        { path: "id", visibility: "hidden" },
        { path: "currency", label: "Currency", kinds: ["string"], visibility: "detail" },
        { path: "state", label: "State", kinds: ["string"], values: ["settled", "pending"], visibility: "detail" },
        { path: "amount", label: "Amount", kinds: ["number"], visibility: "primary" },
      ],
    });
    const seenRoster = briefCandidates([
      {
        connection: "api",
        title: "The API",
        entities: [payments],
        seen: { payment: { fields: { currency: ["USD", "EUR"], state: ["settled"] }, everyRecord: true } },
      },
    ]);
    /* The same, from a read that did not reach every record: a first page. */
    const partRoster = briefCandidates([
      {
        connection: "api",
        title: "The API",
        entities: [payments],
        seen: { payment: { fields: { currency: ["USD", "EUR"] }, everyRecord: false } },
      },
    ]);

    it("offers a field the records hold a small set of, with those values, marked as seen", () => {
      const currency = seenRoster[0]?.fields.find((field) => field.path === "currency");
      expect(currency).toMatchObject({ role: "narrow", values: ["USD", "EUR"], seen: "all" });
      const prompt = buildBriefPrompt({ intent: "payments in dollars", candidates: seenRoster });
      expect(prompt).toContain("Currency (currency) in the records: USD / EUR");
    });

    it("keeps a declared set over what was seen, since the declared one is complete", () => {
      const state = seenRoster[0]?.fields.find((field) => field.path === "state");
      expect(state).toMatchObject({ values: ["settled", "pending"] });
      expect(state?.seen).toBeUndefined();
      expect(buildBriefPrompt({ intent: "x", candidates: seenRoster })).toContain("State (state) one of: settled / pending");
    });

    it("offers a field without a set to narrow by only by name, with no values", () => {
      const [plain] = briefCandidates([{ connection: "api", title: "The API", entities: [payments] }]);
      expect(plain?.fields.find((field) => field.path === "currency")).toEqual({ path: "currency", label: "Currency", role: "other" });
    });

    it("sends back a value the field lists none of, once, with the values", async () => {
      const llm = fakeLlm([
        { args: { entity: "payment", intent: "measure", measureAgg: "sum", measureField: "amount", filters: [{ field: "currency", values: ["US dollars"] }], reason: "Dollars." } },
        { args: { entity: "payment", intent: "measure", measureAgg: "sum", measureField: "amount", filters: [{ field: "currency", values: ["USD"] }], reason: "Dollars." } },
      ]);
      const result = await writeBrief(llm, { intent: "how much in US dollars", candidates: seenRoster });
      expect(result.brief?.filters).toEqual([{ field: "currency", values: ["USD"] }]);
      expect(String(llm.calls[1]!.messages.at(-1)!.content)).toMatch(/"US dollars" for currency, which the records hold as USD \/ EUR/);
    });

    it("takes a second answer as meant for a declared set, which may be out of date", async () => {
      const llm = fakeLlm([
        { args: { entity: "payment", intent: "measure", filters: [{ field: "state", values: ["refunded"] }], reason: "Refunds." } },
        { args: { entity: "payment", intent: "measure", filters: [{ field: "state", values: ["refunded"] }], reason: "Refunds." } },
      ]);
      const result = await writeBrief(llm, { intent: "how many were refunded", candidates: seenRoster });
      expect(result.brief?.filters).toEqual([{ field: "state", values: ["refunded"] }]);
      expect(llm.calls).toHaveLength(2);
    });

    /* Measurement 1, real split: a first page of a catalogue sorted by category listed four of twenty-four. */
    it("says when the values came from only some records, and never sends a value back for missing from them", async () => {
      expect(buildBriefPrompt({ intent: "x", candidates: partRoster })).toContain("Currency (currency) in some records: USD / EUR");
      const llm = fakeLlm([
        { args: { entity: "payment", intent: "measure", filters: [{ field: "currency", values: ["GBP"] }], reason: "Pounds." } },
      ]);
      const result = await writeBrief(llm, { intent: "how many in pounds", candidates: partRoster });
      expect(result.brief?.filters).toEqual([{ field: "currency", values: ["GBP"] }]);
      expect(llm.calls).toHaveLength(1);
    });

    /* Regression: "breeds from the United States" narrowed `origin`, which never holds that, and counted 0. */
    it("says so when a value is still one no record holds, rather than counting nothing", async () => {
      const llm = fakeLlm([
        { args: { entity: "payment", intent: "measure", filters: [{ field: "currency", values: ["GBP"] }], reason: "Pounds." } },
        { args: { entity: "payment", intent: "measure", filters: [{ field: "currency", values: ["GBP"] }], reason: "Pounds." } },
      ]);
      const result = await writeBrief(llm, { intent: "how many in pounds", candidates: seenRoster });
      expect(result.brief).toBeNull();
      expect(result.unmatched).toBe('No payments have Currency "GBP": every one holds USD, EUR.');
    });

    it("names the other plain fields, so a request about one can reach it", () => {
      const withCountry = entity({
        id: "payment",
        resource: "payment",
        name: { one: "Payment", many: "Payments" },
        kind: "money",
        fields: [
          { path: "id", visibility: "hidden" },
          { path: "currency", label: "Currency", kinds: ["string"], visibility: "detail" },
          { path: "country", label: "Country", kinds: ["string"], visibility: "detail" },
          { path: "payer_id", label: "Payer", kinds: ["number"], visibility: "detail" },
          { path: "lines", label: "Lines", kinds: ["array"], visibility: "detail" },
        ],
      });
      const [candidate] = briefCandidates([{ connection: "api", title: "The API", entities: [withCountry] }]);
      expect(candidate?.fields.filter((field) => field.role === "other").map((field) => field.path)).toEqual(["currency", "country"]);
      expect(buildBriefPrompt({ intent: "x", candidates: [candidate!] })).toContain("also: Currency (currency), Country (country)");
    });

    it("writes a listed value in its listed spelling, without asking again", async () => {
      const llm = fakeLlm([
        { args: { entity: "payment", intent: "measure", filters: [{ field: "currency", values: ["usd"] }], reason: "Dollars." } },
      ]);
      const result = await writeBrief(llm, { intent: "how many in dollars", candidates: seenRoster });
      expect(result.brief?.filters).toEqual([{ field: "currency", values: ["USD"] }]);
      expect(llm.calls).toHaveLength(1);
    });
  });

  it("never turns a list of records into a number nobody asked for", async () => {
    // A count is the default for every intent, so carrying one onto a plain
    // list would quietly aggregate the records away.
    const llm = fakeLlm([
      { args: { entity: "task", intent: "records", measureAgg: "count", reason: "Your tasks." } },
    ]);
    const result = await writeBrief(llm, { intent: "show my tasks", candidates });
    expect(result.brief?.measure).toBeUndefined();
  });

  it("offers the other reading, rather than asking which was meant", async () => {
    /*
     * "Tasks by category" genuinely reads two ways. Blocking on "did you mean
     * the records or a count of them?" makes every request an interrogation;
     * building the better reading and offering the other is one click instead.
     */
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          filters: [{ field: "Category.Name" }],
          reason: "Your tasks, with a filter for category.",
          alternative: {
            label: "how many per category",
            intent: "compare",
            groupBy: "Category.Name",
          },
        },
      },
    ]);
    const result = await writeBrief(llm, { intent: "tasks by category", candidates });
    expect(result.brief?.intent).toBe("records");
    expect(result.alternative).toEqual({
      label: "how many per category",
      brief: { entity: "task", intent: "compare", groupBy: "Category.Name" },
    });
  });

  it("drops an alternative that would build the very same widget", async () => {
    // A question with one answer is not a question.
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          reason: "Your tasks.",
          alternative: { label: "the tasks", intent: "records" },
        },
      },
    ]);
    expect((await writeBrief(llm, { intent: "tasks", candidates })).alternative).toBeNull();
  });

  it("drops an alternative naming a record type that is not on the roster", async () => {
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          reason: "Your tasks.",
          alternative: { label: "something else", intent: "compare", entity: "nope", groupBy: "Status" },
        },
      },
    ]);
    expect((await writeBrief(llm, { intent: "tasks", candidates })).alternative).toBeNull();
  });

  it("carries no alternative on a request that reads one way", async () => {
    // It has to stay absent on almost everything: an alternative on every
    // request is a question on every request wearing different clothes.
    const llm = fakeLlm([{ args: { entity: "task", intent: "records", reason: "Your tasks." } }]);
    expect((await writeBrief(llm, { intent: "show my tasks", candidates })).alternative).toBeNull();
  });

  it("carries a second kind of record, by the record type's own id", async () => {
    /*
     * A request naming two collections used to fall through to a planner that
     * hunted endpoints, which threw away everything the record types had
     * already settled about which records were meant.
     */
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          alongsideEntity: "category",
          reason: "Your work, with the kind of work beside it.",
        },
      },
    ]);
    const result = await writeBrief(llm, { intent: "tasks with their categories", candidates });

    expect(result.brief).toMatchObject({ entity: "task", alongside: { entity: "category" } });
  });

  it("passes a second record type nobody has heard of through to be refused by name", async () => {
    // Rather than dropped here. The compiler holds the record types and says
    // there is no such thing; dropping it silently answers half a request and
    // says nothing about the other half.
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          alongsideEntity: "invented",
          reason: "Your work.",
        },
      },
    ]);
    const result = await writeBrief(llm, { intent: "tasks with their sprockets", candidates });

    expect(result.brief?.alongside).toEqual({ entity: "invented" });
  });

  it("carries separate things asked for together as more widgets", async () => {
    /*
     * Two collections named in one request are two widgets seen together —
     * which is a different thing from one widget carrying a second record's
     * fields, and different again from two readings of the same words.
     */
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          plus: [{ entity: "category", intent: "records", title: "Categories" }],
          reason: "Your work and the kinds of work, side by side.",
        },
      },
    ]);
    const result = await writeBrief(llm, { intent: "my tasks and my categories", candidates });

    expect(result.brief).toMatchObject({ entity: "task" });
    expect(result.plus).toEqual([
      { entity: "category", intent: "records", title: "Categories" },
    ]);
  });

  it("carries none on an ordinary request, which is nearly every request", async () => {
    // A set on everything would turn "show me my tasks" into a dashboard
    // nobody asked for.
    const llm = fakeLlm([{ args: { entity: "task", intent: "records", reason: "Your tasks." } }]);
    expect((await writeBrief(llm, { intent: "my tasks", candidates })).plus).toEqual([]);
  });

  it("drops an extra that is the same request written twice", async () => {
    /*
     * The same record type read the same way is not a second widget; it is
     * padding, and building it would put two identical tiles on the board.
     */
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          plus: [{ entity: "task", intent: "records" }],
          reason: "Your tasks.",
        },
      },
    ]);
    expect((await writeBrief(llm, { intent: "my tasks", candidates })).plus).toEqual([]);
  });

  it("drops an extra naming a record type that is not on the roster", async () => {
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          plus: [{ entity: "invented", intent: "records" }],
          reason: "Your tasks.",
        },
      },
    ]);
    expect((await writeBrief(llm, { intent: "tasks and sprockets", candidates })).plus).toEqual([]);
  });

  it("keeps a second reading of the same record type, which is a real second widget", async () => {
    // Tasks listed and tasks counted per category are two different answers,
    // so naming the same record type twice is only padding when the reading
    // is the same too.
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          plus: [{ entity: "task", intent: "compare", groupBy: "Status" }],
          reason: "Your work, and how it breaks down.",
        },
      },
    ]);
    const result = await writeBrief(llm, { intent: "my tasks and a breakdown", candidates });
    expect(result.plus).toEqual([{ entity: "task", intent: "compare", groupBy: "Status" }]);
  });

  it("refuses a record type that is not on the roster", async () => {
    const llm = fakeLlm([
      { args: { entity: "invented", intent: "records", reason: "Here you go." } },
    ]);
    const result = await writeBrief(llm, { intent: "anything", candidates });
    expect(result.brief).toBeNull();
    expect(result.error).toContain("not a record type here");
  });

  it("says so when the API has no record types described yet", async () => {
    const result = await writeBrief(fakeLlm([]), { intent: "tasks", candidates: [] });
    expect(result.brief).toBeNull();
    expect(result.error).toContain("no record types described");
  });
});

describe("a request, from words to a widget", () => {
  /**
   * The request this whole layer was built for.
   *
   * "A widget that showed tasks with a filter by category" produced a bar
   * graph of task counts. The two halves that replace that path agree by
   * design — the model writes a brief, the compiler turns it into a widget —
   * and this is the only test that holds them to it together. Each half
   * passing its own tests while the pair disagreed is exactly how the original
   * bug survived.
   */
  it("gives a table with a filter strip, and no chart anywhere", async () => {
    const spec = entity({});
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "records",
          filters: [{ field: "Category.Name" }],
          reason: "Your tasks, with a filter for category.",
        },
      },
    ]);

    const written = await writeBrief(llm, {
      intent: "a widget that shows tasks with a filter by category",
      candidates: briefCandidates([{ connection: "api", title: "The API", entities: [spec] }]),
    });
    expect(written.error).toBeNull();

    const compiled = compileBrief({
      brief: written.brief!,
      entity: spec,
      resource: resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list" }),
      connection: "api",
      id: "tasks",
    });

    expect(compiled.errors).toEqual([]);
    expect(compiled.widget?.component).toBe("table");
    expect(compiled.widget?.facets?.map((facet) => facet.field)).toEqual(["Category_Name"]);
    // The records stay records: nothing is counted, grouped or charted.
    expect(compiled.widget?.pipeline.some((step) => step.op === "group")).toBe(false);
    // And the nested filter field is a real column by the time a strip binds it.
    expect(compiled.widget?.pipeline).toContainEqual({
      op: "derive",
      fields: { Category_Name: "Category.Name" },
    });
  });

  it("still charts when a chart is what was asked for", async () => {
    const spec = entity({});
    const llm = fakeLlm([
      {
        args: {
          entity: "task",
          intent: "compare",
          groupBy: "Category.Name",
          reason: "How much work sits in each category.",
        },
      },
    ]);
    const written = await writeBrief(llm, {
      intent: "how many tasks per category",
      candidates: briefCandidates([{ connection: "api", title: "The API", entities: [spec] }]),
    });
    const compiled = compileBrief({
      brief: written.brief!,
      entity: spec,
      resource: resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list" }),
      connection: "api",
      id: "tasks",
    });

    expect(compiled.widget?.component).toBe("bar");
    expect(compiled.widget?.roles).toEqual({ category: "Category_Name", value: "value" });
  });
});

/**
 * A vendor may be used to find a bug and never to shape a rule.
 *
 * A prompt that illustrates itself with one API's nouns teaches the model that
 * API, and the lesson quietly stops applying on the next one.
 *
 * Matched on whole words rather than as substrings, unlike the older guards
 * here: "rent" inside "different" and "order" inside "sorted" are ordinary
 * English, and a check that fails on those pushes the next person to reword
 * around it rather than to fix anything real.
 */
describe("the brief prompt names no vendor and no domain", () => {
  const BANNED = [
    "fabrikam",
    "stripe",
    "github",
    "lease",
    "tenant",
    "landlord",
    "invoice",
    "applicant",
    "rent",
    "property",
    "listing",
    "vendor",
    "repo",
    "customer",
  ];

  const clean = (text: string, where: string): void => {
    for (const word of BANNED) {
      expect(new RegExp(`\\b${word}s?\\b`, "i").test(text), `${where} mentions "${word}"`).toBe(
        false,
      );
    }
  };

  it("says nothing about any particular API", () => {
    clean(BRIEF_SYSTEM_PROMPT, "the system prompt");
  });

  it("says nothing about one either in the tool's own descriptions", () => {
    // These reach the model exactly as the system prompt does, so they are
    // held to the same rule.
    const described: string[] = [];
    const shape = briefSchema.shape as Record<string, { description?: string }>;
    for (const [name, field] of Object.entries(shape)) {
      if (field.description) described.push(`${name}: ${field.description}`);
    }
    expect(described.length).toBeGreaterThan(5);
    clean(described.join("\n"), "a tool description");
  });
});

/**
 * Two APIs on one board.
 *
 * A brief that could only ever see one roster meant a second connection sent
 * the assistant straight back to picking endpoints by hand — not harder, just
 * useless. What it needs is every described API at once, and a way to say
 * which one it meant when both call something the same thing.
 */
describe("choosing across APIs", () => {
  const crm = entitySchema.parse({
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    kind: "work",
    fields: [{ path: "Id" }, { path: "Status" }],
  });
  const helpdesk = entitySchema.parse({
    id: "task",
    resource: "task",
    name: { one: "Ticket", many: "Tickets" },
    kind: "work",
    fields: [{ path: "Id" }, { path: "State" }],
  });
  const only = entitySchema.parse({
    id: "invoice",
    resource: "invoice",
    name: { one: "Invoice", many: "Invoices" },
    kind: "money",
    fields: [{ path: "Id" }],
  });

  const sources = [
    { connection: "acme", title: "Acme CRM", entities: [crm, only] },
    { connection: "help", title: "Helpdesk", entities: [helpdesk] },
  ];

  it("qualifies a name only where two APIs both have it", () => {
    const candidates = briefCandidates(sources);
    const ids = candidates.map((one) => one.entity).sort();
    // "invoice" is unambiguous and stays plain; "task" is not and does not.
    expect(ids).toEqual(["invoice", "task--acme", "task--help"]);
  });

  it("carries which API each came from, and its own id there", () => {
    const candidates = briefCandidates(sources);
    const ticket = candidates.find((one) => one.entity === "task--help");
    expect(ticket).toMatchObject({ connection: "help", recordType: "task", source: "Helpdesk" });
  });

  it("resolves what the model wrote back to one API, and refuses what it did not", () => {
    const candidates = briefCandidates(sources);
    expect(resolveCandidate(candidates, "task--acme")?.connection).toBe("acme");
    // Never approximated — the same boundary every other pass here draws.
    expect(resolveCandidate(candidates, "task")).toBeNull();
    expect(resolveCandidate(candidates, "invented")).toBeNull();
  });

  it("tells the model which API each record type belongs to", () => {
    const prompt = buildBriefPrompt({ intent: "x", candidates: briefCandidates(sources) });
    expect(prompt).toContain("from Acme CRM:");
    expect(prompt).toContain("from Helpdesk:");
  });

  it("says nothing about sources when there is only one", () => {
    // A single-connection workspace should not read like a multi-API one.
    const prompt = buildBriefPrompt({
      intent: "x",
      candidates: briefCandidates([sources[0]!]),
    });
    expect(prompt).not.toContain("from Acme CRM:");
  });
});

/* Regression (trackwell mock API): "Platform" written on a project's key, where only its name holds it. */
describe("a value written on a field that does not hold it", () => {
  const issues = briefCandidates([
    {
      connection: "api",
      title: "The API",
      entities: [
        entity({
          id: "issue",
          resource: "issue",
          name: { one: "Issue", many: "Issues" },
          kind: "event",
          fields: [
            { path: "id", visibility: "hidden" },
            { path: "fields.project.key", label: "Project key", visibility: "detail" },
            { path: "fields.project.name", label: "Project name", visibility: "primary", values: ["Platform", "Storefront"] },
            { path: "fields.issuetype.name", label: "Type name", visibility: "primary", values: ["Bug", "Task", "Story"] },
          ],
        }),
      ],
    },
  ]);
  const count = (filters: unknown[]) => ({ args: { entity: "issue", intent: "measure", measureAgg: "count", filters, reason: "Bugs." } });

  it("is sent back once, naming the field that holds it", async () => {
    const llm = fakeLlm([
      count([{ field: "fields.project.key", values: ["Platform"] }, { field: "fields.issuetype.name", values: ["Bug"] }]),
      count([{ field: "fields.project.name", values: ["Platform"] }, { field: "fields.issuetype.name", values: ["Bug"] }]),
    ]);
    const result = await writeBrief(llm, { intent: "How many bugs are in the Platform project?", candidates: issues });
    expect(String(llm.calls[1]!.messages.at(-1)!.content)).toMatch(/"Platform" is not a value fields\.project\.key shows; fields\.project\.name holds it/);
    expect(result.brief?.filters).toEqual([
      { field: "fields.project.name", values: ["Platform"] },
      { field: "fields.issuetype.name", values: ["Bug"] },
    ]);
  });
});

/* Cashloom, 2026-10-03: "refunded" is both a status and a flag; narrowed by the flag, it is not sent back over the status. */
describe("a word the answer narrows by in a field's own name", () => {
  const payments = briefCandidates([
    {
      connection: "api",
      title: "The API",
      entities: [
        entity({
          id: "payment",
          resource: "payment",
          name: { one: "Payment", many: "Payments" },
          kind: "event",
          fields: [
            { path: "id", visibility: "hidden" },
            { path: "amount", label: "Payment amount", semantic: "number", visibility: "primary" },
            { path: "status", label: "Status", visibility: "primary", values: ["succeeded", "refunded", "failed"] },
            { path: "refunded", label: "Refunded", visibility: "primary", kinds: ["boolean"] },
          ],
        }),
      ],
    },
  ]);

  it("is taken as said, whatever else holds it as a value", async () => {
    const llm = fakeLlm([
      { args: { entity: "payment", intent: "measure", measureAgg: "count", filters: [{ field: "refunded", values: ["true"] }], reason: "Refunded." } },
    ]);
    const result = await writeBrief(llm, { intent: "How many refunded payments were there?", candidates: payments });
    expect(llm.calls).toHaveLength(1);
    expect(result.brief?.filters).toEqual([{ field: "refunded", values: ["true"] }]);
  });
});
