import type { EntitySpec } from "@freebirdai/dash-spec";
import { entitySchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { fakeLlm } from "./llm.js";
import {
  REFERENCE_SYSTEM_PROMPT,
  buildReferencePrompt,
  classifyReferences,
  referenceCandidates,
} from "./references.js";

/**
 * Which fields point at other records, asked as a closed question.
 *
 * The enumeration is deterministic and the answer set is closed, so both
 * halves are testable without a model: nothing depends on the model *noticing*
 * a field, which is what cost the previous pass most of its coverage.
 */

const entity = (input: Record<string, unknown>): EntitySpec => entitySchema.parse(input);

const TASK = entity({
  id: "task",
  resource: "task",
  name: { one: "Task", many: "Tasks" },
  identity: { field: "Id", observed: true },
  fields: [
    { path: "Id", kinds: ["number"], description: "Task unique identifier." },
    { path: "Title", kinds: ["string"] },
    { path: "VendorId", kinds: ["number"] },
    { path: "PropertyIds", kinds: ["array"] },
    { path: "Property", kinds: ["object"] },
    { path: "Property.Id", kinds: ["number"] },
    { path: "Property.Type", kinds: ["string"] },
    { path: "Property.Name", kinds: ["string"] },
    { path: "Property.Href", kinds: ["string"] },
    { path: "InvoiceNumber", kinds: ["string"] },
    { path: "Owner", kinds: ["number"], description: "The identifier of the owning user." },
  ],
});

const VENDOR = entity({
  id: "vendor",
  resource: "vendor",
  name: { one: "Vendor", many: "Vendors" },
  description: "Somebody paid to do work.",
});

const RENTAL = entity({
  id: "rental",
  resource: "rental",
  name: { one: "Property", many: "Properties" },
});

describe("referenceCandidates", () => {
  const found = referenceCandidates(TASK);
  const byPath = new Map(found.map((candidate) => [candidate.path, candidate]));

  it("offers every field that could hold another record's id", () => {
    expect([...byPath.keys()].sort()).toEqual(
      ["Owner", "Property.Id", "PropertyIds", "VendorId"].sort(),
    );
  });

  it("never offers the record's own identity", () => {
    // It points at itself, and offering it invites a self-link on every
    // record type in the API.
    expect(byPath.has("Id")).toBe(false);
  });

  it("reaches an object's id, once, with what sits beside it", () => {
    /*
     * `Property.Id` is reachable two ways — inside the object, and as a plain
     * field whose own leaf is `Id`. Offered twice it would be asked about
     * twice and paid for twice, and the object reading is the better one: it
     * is the only one that knows about the type field and the name.
     */
    const candidate = byPath.get("Property.Id");
    expect(candidate?.holds).toBe("objectRef");
    expect(candidate?.typeField).toBe("Property.Type");
    expect(candidate?.embedded).toEqual(["Property.Name"]);
    expect(found.filter((one) => one.path === "Property.Id")).toHaveLength(1);
  });

  it("marks a list of ids as one", () => {
    // An id never equals a list, so a consumer that does not know this
    // compares them and matches nothing, silently.
    expect(byPath.get("PropertyIds")?.holds).toBe("array");
  });

  it("takes the spec at its word when a name gives nothing away", () => {
    // `Owner` follows no convention at all; the specification says outright
    // that it is an identifier, and no name test would ever catch it.
    expect(byPath.get("Owner")?.description).toMatch(/identifier/);
  });

  it("leaves a number that is printed on something rather than pointing at it", () => {
    expect(byPath.has("InvoiceNumber")).toBe(false);
    expect(byPath.has("Title")).toBe(false);
  });

  it("does not re-offer a field that already has a link", () => {
    const linked = entity({
      ...TASK,
      fields: TASK.fields.map((field) =>
        field.path === "VendorId" ? { ...field, reference: { entity: "vendor" } } : field,
      ),
    });
    expect(referenceCandidates(linked).some((one) => one.path === "VendorId")).toBe(false);
  });

  it("offers nothing for a record type nobody has described yet", () => {
    expect(referenceCandidates(VENDOR)).toEqual([]);
  });
});

describe("buildReferencePrompt", () => {
  const prompt = buildReferencePrompt(
    { apiTitle: "The API", entities: [TASK, VENDOR, RENTAL], pathOf: () => "/v1/vendors" },
    referenceCandidates(TASK),
  );

  it("hands over the closed set of record types to choose from", () => {
    expect(prompt).toContain("RECORD TYPES");
    for (const id of ["task", "vendor", "rental"]) expect(prompt, id).toContain(id);
    expect(prompt).toContain("Somebody paid to do work.");
  });

  it("says what shape each candidate holds, and names its type field", () => {
    expect(prompt).toContain("holds several ids");
    expect(prompt).toContain("the id inside a nested record");
    expect(prompt).toContain('a sibling field "Property.Type" says which kind');
  });
});

describe("the prompt keeps to shapes, not vendors", () => {
  it("names no vendor", () => {
    for (const word of ["buildium", "stripe", "github"]) {
      expect(REFERENCE_SYSTEM_PROMPT.toLowerCase(), word).not.toContain(word);
    }
  });

  it("tells the model to refuse rather than guess between two same-named types", () => {
    // A missing link costs one question; a wrong one silently pairs unrelated
    // records and looks exactly like a right one.
    expect(REFERENCE_SYSTEM_PROMPT).toMatch(/answer "none"/);
    expect(REFERENCE_SYSTEM_PROMPT).toMatch(/looks exactly like a right one/);
  });
});

describe("classifyReferences", () => {
  const input = { apiTitle: "The API", entities: [TASK, VENDOR, RENTAL] };

  const linkOn = (entities: readonly EntitySpec[], path: string) =>
    entities.find((one) => one.id === "task")?.fields.find((one) => one.path === path)?.reference;

  it("writes the link onto the field it belongs to", async () => {
    const llm = fakeLlm([
      {
        args: {
          links: [
            { entity: "task", path: "VendorId", points_at: "vendor", reason: "names a vendor" },
            { entity: "task", path: "InvoiceNumber", points_at: "none" },
          ],
        },
      },
    ]);

    const result = await classifyReferences(llm, input);
    expect(result.errors).toEqual([]);
    expect(linkOn(result.entities, "VendorId")).toMatchObject({
      entity: "vendor",
      holds: "scalar",
      verified: false,
    });
    expect(result.linked).toBe(1);
    expect(result.considered).toBe(4);
  });

  it("records nothing for a field the model says points nowhere", async () => {
    const llm = fakeLlm([
      { args: { links: [{ entity: "task", path: "InvoiceNumber", points_at: "none" }] } },
    ]);
    const result = await classifyReferences(llm, input);
    expect(linkOn(result.entities, "InvoiceNumber")).toBeUndefined();
    expect(result.linked).toBe(0);
  });

  it("refuses a target this API does not have, and says why", async () => {
    const llm = fakeLlm([
      { args: { links: [{ entity: "task", path: "VendorId", points_at: "supplier" }] } },
    ]);
    const result = await classifyReferences(llm, input);
    expect(linkOn(result.entities, "VendorId")).toBeUndefined();
    expect(result.skipped.join(" ")).toMatch(/not a record type on this API/);
  });

  it("refuses a classification of a field it was not offered", async () => {
    const llm = fakeLlm([
      { args: { links: [{ entity: "task", path: "Invented", points_at: "vendor" }] } },
    ]);
    const result = await classifyReferences(llm, input);
    expect(result.skipped.join(" ")).toMatch(/was classified and was not offered/);
  });

  it("carries the id inside an object, and what the row already shows", async () => {
    const llm = fakeLlm([
      { args: { links: [{ entity: "task", path: "Property.Id", points_at: "rental" }] } },
    ]);
    const result = await classifyReferences(llm, input);
    expect(linkOn(result.entities, "Property.Id")).toMatchObject({
      entity: "rental",
      holds: "objectRef",
      // Free: the name is already on the row, so nothing has to be fetched.
      embedded: ["Property.Name"],
    });
  });

  it("records a link that points at two kinds of record as conditional", async () => {
    const llm = fakeLlm([
      {
        args: {
          links: [
            {
              entity: "task",
              path: "Property.Id",
              points_at: "rental",
              also: ["vendor"],
            },
          ],
        },
      },
    ]);
    const result = await classifyReferences(llm, input);
    expect(linkOn(result.entities, "Property.Id")?.typeField).toEqual({
      field: "Property.Type",
      map: { rental: "rental", vendor: "vendor" },
    });
  });

  it("ignores an alternative that is not a record type either", async () => {
    const llm = fakeLlm([
      {
        args: {
          links: [
            { entity: "task", path: "Property.Id", points_at: "rental", also: ["nonsense"] },
          ],
        },
      },
    ]);
    const result = await classifyReferences(llm, input);
    // One real target left, so there is nothing conditional about it.
    expect(linkOn(result.entities, "Property.Id")?.typeField).toBeUndefined();
  });

  it("changes nothing but the links", async () => {
    const llm = fakeLlm([
      { args: { links: [{ entity: "task", path: "VendorId", points_at: "vendor" }] } },
    ]);
    const result = await classifyReferences(llm, input);
    const task = result.entities.find((one) => one.id === "task")!;
    expect(task.name).toEqual(TASK.name);
    expect(task.fields.map((one) => one.path)).toEqual(TASK.fields.map((one) => one.path));
  });

  it("skips a batch a previous run finished", async () => {
    const first = await classifyReferences(
      fakeLlm([{ args: { links: [{ entity: "task", path: "VendorId", points_at: "vendor" }] } }]),
      input,
    );
    const again = fakeLlm([{ args: { links: [] } }]);
    await classifyReferences(again, input, { completedBatches: first.completedBatches });
    expect(again.calls).toHaveLength(0);
  });

  it("reports a call that answered without the tool", async () => {
    const llm = fakeLlm([{ text: "no thanks" }]);
    const result = await classifyReferences(llm, input);
    expect(result.errors[0]).toMatch(/without calling the tool/);
    expect(result.completedBatches).toEqual([]);
  });
});

/**
 * The same rules, on an API that spells everything differently.
 *
 * Every fixture above is PascalCase, which is one API's house style and not a
 * fact about anything. With only those, a rule that quietly assumed the style
 * still passed — and two did: `first_name` and `company_name` were not
 * recognised as names, so a link whose row already carried the target's name
 * was not seen to and fell back to fetching it; and `vendor-id` was not
 * recognised as an identifier at all.
 *
 * This is the guard against that. Nothing here is about any API in
 * particular — it is the *convention* that differs.
 */
describe("a snake_case API gets the same reading", () => {
  const post = entity({
    id: "post",
    resource: "post",
    name: { one: "Post", many: "Posts" },
    identity: { field: "id" },
    fields: [
      { path: "id", kinds: ["number"] },
      { path: "title", kinds: ["string"] },
      { path: "user_id", kinds: ["number"] },
      { path: "tag_ids", kinds: ["array"] },
      { path: "author", kinds: ["object"] },
      { path: "author.id", kinds: ["number"] },
      { path: "author.type", kinds: ["string"] },
      { path: "author.first_name", kinds: ["string"] },
      { path: "author.company_name", kinds: ["string"] },
      { path: "author.href", kinds: ["string"] },
      { path: "word_count", kinds: ["number"] },
    ],
  });

  const found = referenceCandidates(post);
  const at = (path: string) => found.find((candidate) => candidate.path === path);

  it("finds a snake_case foreign key", () => {
    expect(at("user_id")).toMatchObject({ holds: "scalar" });
  });

  it("reads a plural snake_case key as a list of them", () => {
    expect(at("tag_ids")).toMatchObject({ holds: "array" });
  });

  it("offers an object reference once, keyed at the id it holds", () => {
    // The object itself is never the candidate — `[object Object]` compares
    // to nothing. The id one level in is, and only once.
    expect(at("author.id")).toMatchObject({ holds: "objectRef" });
    expect(at("author")).toBeUndefined();
  });

  it("carries the names sitting beside the id, whatever the convention", () => {
    /*
     * The bug this exists for. Matched against the raw leaf, `first_name` and
     * `company_name` missed — so the name was fetched again, or the cell read
     * "Author 41" with the author's name in the next column.
     */
    expect(at("author.id")?.embedded).toEqual(["author.first_name", "author.company_name"]);
  });

  it("still spots the sibling type field, and still ignores the self-link", () => {
    expect(at("author.id")?.typeField).toBe("author.type");
    expect(at("author.id")?.embedded).not.toContain("author.href");
  });

  it("offers neither the record's own id nor an ordinary number", () => {
    expect(at("id")).toBeUndefined();
    expect(at("word_count")).toBeUndefined();
  });

  it("finds a kebab-case key too", () => {
    const kebab = entity({
      id: "note",
      resource: "note",
      name: { one: "Note", many: "Notes" },
      identity: { field: "id" },
      fields: [
        { path: "id", kinds: ["number"] },
        { path: "vendor-id", kinds: ["number"] },
      ],
    });
    expect(referenceCandidates(kebab).map((one) => one.path)).toEqual(["vendor-id"]);
  });

  it("does not read an ordinary word ending in those letters as a key", () => {
    // The guard that makes the suffix rule safe: `is_paid` ends in "id".
    const guarded = entity({
      id: "charge",
      resource: "charge",
      name: { one: "Charge", many: "Charges" },
      identity: { field: "id" },
      fields: [
        { path: "id", kinds: ["number"] },
        { path: "is_paid", kinds: ["boolean"] },
        { path: "is_valid", kinds: ["boolean"] },
      ],
    });
    expect(referenceCandidates(guarded)).toEqual([]);
  });
});
