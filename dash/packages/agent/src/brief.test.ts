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
    "buildium",
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
