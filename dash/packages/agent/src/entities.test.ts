import type { MappedField, ResourceSpec } from "@freebirdai/dash-spec";
import { resourceSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import {
  ENTITY_SYSTEM_PROMPT,
  acceptEntityLabel,
  buildEntityPrompt,
  describeEntities,
  entityFromProposal,
  fieldsOfResource,
  scopeOf,
  type DescribedEntity,
} from "./entities.js";
import { fakeLlm } from "./llm.js";

/**
 * Describing what an API's records are, with no model and no network.
 *
 * The pass itself is one call per batch; everything that decides whether its
 * answer is usable is deterministic and lives here — which is the point, since
 * the artifact it writes is shared with everybody who connects the API.
 */

const field = (name: string, extra: Partial<MappedField> = {}): MappedField => ({
  name,
  kinds: ["string"],
  nullable: false,
  ...extra,
});

const resource = (input: Record<string, unknown>): ResourceSpec => resourceSchema.parse(input);

const THING = resource({
  id: "thing",
  title: "Things",
  listOp: "things_list",
  detailOp: "things_byid",
  detailParam: "thingId",
});

const OPS = [
  {
    id: "things_list",
    title: "Retrieve all things",
    path: "/v1/things",
    description: "Every thing on the account.",
    fields: [
      field("Id", { kinds: ["number"], description: "Thing unique identifier." }),
      field("Name"),
      field("Status"),
      field("Href", { description: "A link to the thing resource." }),
    ],
  },
  {
    id: "things_byid",
    title: "Retrieve a thing",
    path: "/v1/things/{{param.thingId}}",
    fields: [field("Id", { kinds: ["number"] }), field("Name"), field("Notes")],
  },
];

const proposal = (input: Partial<DescribedEntity> = {}): DescribedEntity => ({
  resource: "thing",
  name: "Thing",
  plural: "Things",
  fields: [],
  ...input,
});

describe("fieldsOfResource", () => {
  it("reads the collection and the record together", () => {
    // A detail response routinely carries fields the collection omits, and
    // those are exactly the ones a record page exists to show.
    expect(fieldsOfResource(THING, OPS).map((entry) => entry.name)).toContain("Notes");
  });

  it("puts the API's own plumbing last rather than dropping it", () => {
    /*
     * A `Href` still deserves to be *marked* hidden — which needs it
     * described — so the clip only ever bites the tail.
     */
    const names = fieldsOfResource(THING, OPS).map((entry) => entry.name);
    expect(names[names.length - 1]).toBe("Href");
  });

  it("reports nothing for a resource whose endpoints declared no fields", () => {
    expect(fieldsOfResource(resource({ id: "blank", title: "Blank" }), OPS)).toEqual([]);
  });
});

describe("buildEntityPrompt", () => {
  const prompt = buildEntityPrompt({ apiTitle: "The API", resources: [THING], ops: OPS }, [THING]);

  it("shows every field, which is the whole point of the batch being small", () => {
    /*
     * The regression this pass exists to fix: the relation pass showed the
     * model fourteen field names per endpoint, and on a real API the
     * references sit past that.
     */
    for (const name of ["Id", "Name", "Status", "Href", "Notes"]) {
      expect(prompt, name).toContain(name);
    }
  });

  it("hands over the spec's own words as evidence", () => {
    expect(prompt).toContain("the spec says: Thing unique identifier.");
    expect(prompt).toContain("Every thing on the account.");
  });

  it("says which endpoint lists them and which returns one", () => {
    expect(prompt).toContain("(lists them)");
    expect(prompt).toContain("(returns one)");
  });
});

describe("the prompt keeps to shapes, not vendors", () => {
  it("names no vendor and no vendor's endpoint", () => {
    // The guard `pick.test.ts` and `review.test.ts` already carry. A prompt
    // that teaches one API's vocabulary works worse on every other one.
    for (const word of ["buildium", "stripe", "github", "rentals", "lease", "tenant"]) {
      expect(ENTITY_SYSTEM_PROMPT.toLowerCase(), word).not.toContain(word);
    }
  });

  it("asks for the four things a schema cannot state", () => {
    expect(ENTITY_SYSTEM_PROMPT).toMatch(/WHAT IT IS CALLED/);
    expect(ENTITY_SYSTEM_PROMPT).toMatch(/WHAT IDENTIFIES ONE/);
    expect(ENTITY_SYSTEM_PROMPT).toMatch(/WHAT EACH FIELD MEANS/);
  });
});

describe("acceptEntityLabel", () => {
  it("refuses a label that says nothing the mechanical name does not", () => {
    // An entry equal to the fallback occupies a shared artifact to say nothing.
    expect(acceptEntityLabel("DueDate", "Due date")).toBeUndefined();
    expect(acceptEntityLabel("DueDate", "Wanted by")).toBe("Wanted by");
  });

  it("refuses a sentence, markup and an empty answer", () => {
    expect(acceptEntityLabel("X", "a".repeat(61))).toBeUndefined();
    expect(acceptEntityLabel("X", "<b>X</b>")).toBeUndefined();
    expect(acceptEntityLabel("X", "   ")).toBeUndefined();
  });
});

describe("entityFromProposal", () => {
  const fields = fieldsOfResource(THING, OPS);

  it("describes the fields it was told about and keeps the rest", () => {
    /*
     * A field the pass skipped is still real. Dropping it would lose data
     * silently and would also make the schema's own guard nonsense — a column
     * naming it would then be refused for naming something the records "do
     * not have", when they do.
     */
    const { entity } = entityFromProposal({
      proposal: proposal({
        identity: "Id",
        title: ["Name"],
        fields: [{ path: "Name", label: "What it is called", description: "The thing's name." }],
      }),
      resource: THING,
      fields,
    });

    expect(entity?.fields.map((one) => one.path)).toEqual(fields.map((one) => one.name));
    expect(entity?.fields.find((one) => one.path === "Name")?.label).toBe("What it is called");
    expect(entity?.fields.find((one) => one.path === "Status")?.label).toBeUndefined();
  });

  it("hides the API's own plumbing without being asked", () => {
    const { entity } = entityFromProposal({ proposal: proposal(), resource: THING, fields });
    expect(entity?.fields.find((one) => one.path === "Href")?.visibility).toBe("hidden");
    expect(entity?.fields.find((one) => one.path === "Name")?.visibility).toBe("detail");
  });

  it("carries the declared kinds rather than asking for them", () => {
    const { entity } = entityFromProposal({ proposal: proposal(), resource: THING, fields });
    expect(entity?.fields.find((one) => one.path === "Id")?.kinds).toEqual(["number"]);
  });

  it("refuses a field that does not exist, and says so", () => {
    const { entity, skipped } = entityFromProposal({
      proposal: proposal({ title: ["Invented"], fields: [{ path: "AlsoInvented" }] }),
      resource: THING,
      fields,
    });
    // The record type survives; only the invented names are dropped.
    expect(entity).not.toBeNull();
    expect(entity?.display).toBeUndefined();
    expect(skipped.join(" ")).toMatch(/Invented/);
    expect(skipped.join(" ")).toMatch(/AlsoInvented/);
  });

  it("falls back to the identity a real response established", () => {
    const sampled = resource({ ...THING, idField: "Id" });
    const { entity } = entityFromProposal({
      proposal: proposal(),
      resource: sampled,
      fields,
    });
    expect(entity?.identity).toEqual({ field: "Id", observed: true });
  });

  it("marks an identity the model guessed as unobserved", () => {
    const { entity } = entityFromProposal({
      proposal: proposal({ identity: "Id" }),
      resource: THING,
      fields,
    });
    expect(entity?.identity).toEqual({ field: "Id", observed: false });
  });

  it("records which model wrote it", () => {
    const { entity } = entityFromProposal({
      proposal: proposal(),
      resource: THING,
      fields,
      model: "test-model",
      now: () => new Date("2026-09-12T00:00:00Z"),
    });
    expect(entity?.provenance).toEqual({
      model: "test-model",
      at: "2026-09-12T00:00:00.000Z",
      version: 1,
    });
  });
});

describe("scopeOf", () => {
  const parent = resource({ id: "thing", title: "Things", listOp: "things_list" });
  const child = resource({ id: "thing-note", title: "Notes", listOp: "notes_list" });
  const ops = [
    { id: "things_list", title: "Things", path: "/v1/things" },
    { id: "notes_list", title: "Notes", path: "/v1/things/{{param.thingId}}/notes" },
  ];

  it("reads the parent out of the path the API published", () => {
    // Certain rather than inferred: nothing else could that URL mean.
    expect(scopeOf(child, [parent, child], ops)).toEqual({ parent: "thing", param: "thingId" });
  });

  it("leaves a plain collection unscoped", () => {
    expect(scopeOf(parent, [parent, child], ops)).toBeUndefined();
  });
});

describe("describeEntities", () => {
  const input = { apiTitle: "The API", resources: [THING], ops: OPS };

  it("turns one call into a described record type", async () => {
    const llm = fakeLlm([
      {
        args: {
          entities: [
            {
              resource: "thing",
              name: "Thing",
              plural: "Things",
              description: "Something on the account.",
              kind: "asset",
              identity: "Id",
              title: ["Name"],
              status: "Status",
              fields: [{ path: "Status", label: "Where it is up to" }],
            },
          ],
        },
      },
    ]);

    const result = await describeEntities(llm, input);
    expect(result.errors).toEqual([]);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      id: "thing",
      name: { one: "Thing", many: "Things" },
      kind: "asset",
      display: { title: ["Name"], status: "Status" },
    });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.toolChoice).toEqual({ name: "describe_records" });
  });

  it("salvages a batch whose other entry is malformed", async () => {
    /*
     * A list validated as a unit is all-or-nothing, and one bad row should not
     * cost the good ones. The same salvage the mapping and labelling passes do.
     */
    const llm = fakeLlm([
      {
        args: {
          entities: [
            { resource: "thing", name: "Thing", plural: "Things", fields: [] },
            { resource: "thing", plural: "Missing a name" },
          ],
        },
      },
    ]);
    const result = await describeEntities(llm, input);
    expect(result.entities).toHaveLength(1);
    expect(result.skipped.join(" ")).toMatch(/malformed/);
  });

  it("refuses a description of a record type it was not shown", async () => {
    const llm = fakeLlm([
      { args: { entities: [{ resource: "elsewhere", name: "X", plural: "Xs", fields: [] }] } },
    ]);
    const result = await describeEntities(llm, input);
    expect(result.entities).toEqual([]);
    expect(result.skipped.join(" ")).toMatch(/was not one of the records offered/);
  });

  it("reports a call that answered without the tool, and keeps going", async () => {
    const llm = fakeLlm([{ text: "I would rather chat." }]);
    const result = await describeEntities(llm, input);
    expect(result.errors[0]).toMatch(/without calling the tool/);
    expect(result.completedBatches).toEqual([]);
  });

  it("skips a batch a previous run finished", async () => {
    const first = await describeEntities(
      fakeLlm([{ args: { entities: [proposal()] } }]),
      input,
    );
    const again = fakeLlm([{ args: { entities: [proposal()] } }]);
    const second = await describeEntities(again, input, {
      completedBatches: first.completedBatches,
      existing: first.entities,
    });
    // Nothing re-asked, and nothing lost.
    expect(again.calls).toHaveLength(0);
    expect(second.entities).toHaveLength(1);
  });

  it("checkpoints after a batch, so a later failure cannot cost it", async () => {
    const seen: number[] = [];
    await describeEntities(fakeLlm([{ args: { entities: [proposal()] } }]), input, {
      onCheckpoint: (result) => seen.push(result.entities.length),
    });
    expect(seen).toEqual([1]);
  });
});
