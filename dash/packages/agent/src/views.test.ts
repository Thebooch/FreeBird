import { entitySchema, resourceSchema } from "@freebirdai/dash-spec";
import type { EntitySpec, GraphOp, ResourceSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { fakeLlm } from "./llm.js";
import { VIEWS_SYSTEM_PROMPT, chooseViews } from "./views.js";

/**
 * Choosing how each record type is listed and shown.
 *
 * The optional pass, and what it must never do is more interesting than what
 * it does: every slot it fills already has a working default, so the failure
 * that matters is not "it chose badly" but "it chose something that does not
 * exist". A view naming a field the records do not carry renders as "this view
 * no longer matches its data" — which blames the reader's data for a bad write
 * here — so an invented name is dropped with a reason rather than approximated.
 */

const TASK: EntitySpec = entitySchema.parse({
  id: "task",
  resource: "task",
  name: { one: "Task", many: "Tasks" },
  kind: "work",
  identity: { field: "Id" },
  display: { title: ["Title"] },
  fields: [
    { path: "Id", visibility: "hidden" },
    { path: "Title", label: "Summary", visibility: "primary" },
    { path: "Bucket", label: "Bucket", visibility: "detail" },
    { path: "DueDate", semantic: "timestamp", visibility: "detail" },
    { path: "Cost", semantic: "currency", visibility: "detail" },
    { path: "VendorId", reference: { entity: "vendor" } },
  ],
});

const VENDOR: EntitySpec = entitySchema.parse({
  id: "vendor",
  resource: "vendor",
  name: { one: "Vendor", many: "Vendors" },
  kind: "party",
  identity: { field: "Id" },
  display: { title: ["CompanyName"] },
  fields: [
    { path: "Id", visibility: "hidden" },
    { path: "CompanyName", visibility: "primary" },
  ],
});

const RESOURCES: ResourceSpec[] = [
  resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks" }),
  resourceSchema.parse({
    id: "vendor",
    title: "Vendors",
    listOp: "vendors",
    detailOp: "vendor",
    detailParam: "vendorId",
  }),
];

const OPS: GraphOp[] = [
  { id: "tasks", path: "/v1/tasks", params: [{ name: "vendorids", in: "query" }] },
  { id: "vendors", path: "/v1/vendors", params: [] },
  { id: "vendor", path: "/v1/vendors/{{param.vendorId}}", params: [] },
];

const run = (views: unknown[]) =>
  chooseViews(fakeLlm([{ args: { views } }]), {
    apiTitle: "Works API",
    entities: [TASK, VENDOR],
    resources: RESOURCES,
    ops: OPS,
  });

const viewsOf = (entities: readonly EntitySpec[], id: string) =>
  entities.find((entity) => entity.id === id)?.views;

describe("chooseViews", () => {
  it("writes the choices onto the record type and touches nothing else", async () => {
    const result = await run([
      {
        entity: "task",
        columns: ["Title", "Bucket", "DueDate"],
        sort: { field: "DueDate", dir: "asc" },
        facets: ["Bucket"],
        time_field: "DueDate",
      },
    ]);

    expect(viewsOf(result.entities, "task")).toMatchObject({
      columns: ["Title", "Bucket", "DueDate"],
      sort: { field: "DueDate", dir: "asc" },
      facets: ["Bucket"],
      timeField: "DueDate",
    });
    // The descriptions and links two earlier passes paid for are untouched.
    const task = result.entities.find((entity) => entity.id === "task");
    expect(task?.fields.find((field) => field.path === "VendorId")?.reference?.entity).toBe(
      "vendor",
    );
    expect(task?.name).toEqual({ one: "Task", many: "Tasks" });
  });

  it("finds a category no naming rule would recognise", async () => {
    /*
     * The case this pass exists for. `Bucket` holds exactly the values a
     * status holds, and the kind's own hints match `status`, `type`,
     * `priority` and `assignee` — so without being asked, nothing offers it.
     */
    const result = await run([{ entity: "task", facets: ["Bucket"] }]);
    expect(viewsOf(result.entities, "task")?.facets).toEqual(["Bucket"]);
  });

  it("drops a field the records do not carry, and says why", async () => {
    const result = await run([
      { entity: "task", columns: ["Title", "Invented"], sort: { field: "AlsoInvented" } },
    ]);

    expect(viewsOf(result.entities, "task")?.columns).toEqual(["Title"]);
    expect(viewsOf(result.entities, "task")?.sort).toBeUndefined();
    expect(result.skipped.join(" ")).toContain("Invented");
  });

  it("never offers a strip over a field the describing pass hid", async () => {
    // `Id` is on the record and marked hidden, so a strip over it is a control
    // whose effect nobody can see.
    const result = await run([{ entity: "task", facets: ["Id"] }]);
    expect(viewsOf(result.entities, "task")?.facets).toEqual([]);
  });

  it("keeps a count over a real collection", async () => {
    const result = await run([
      {
        entity: "vendor",
        stats: [{ label: "Open work", collection: "task-by-VendorId", agg: "count" }],
      },
    ]);
    expect(viewsOf(result.entities, "vendor")?.stats).toEqual([
      { label: "Open work", backref: "task-by-VendorId", agg: "count" },
    ]);
  });

  it("refuses a total over a field the far records do not have", async () => {
    /*
     * A sum names a field on the *other* record type, so checking it against
     * this one would pass and then produce a number that is always zero.
     */
    const result = await run([
      {
        entity: "vendor",
        stats: [
          { label: "Billed", collection: "task-by-VendorId", agg: "sum", field: "NotOnATask" },
        ],
      },
    ]);
    expect(viewsOf(result.entities, "vendor")?.stats).toEqual([]);
    expect(result.skipped.join(" ")).toContain("Billed");
  });

  it("keeps a total over a field they do have", async () => {
    const result = await run([
      {
        entity: "vendor",
        stats: [{ label: "Billed", collection: "task-by-VendorId", agg: "sum", field: "Cost" }],
      },
    ]);
    expect(viewsOf(result.entities, "vendor")?.stats).toEqual([
      { label: "Billed", backref: "task-by-VendorId", agg: "sum", field: "Cost" },
    ]);
  });

  it("drops a stat over a collection that does not hang off this record", async () => {
    const result = await run([
      { entity: "vendor", stats: [{ label: "Ghosts", collection: "nothing", agg: "count" }] },
    ]);
    expect(viewsOf(result.entities, "vendor")?.stats).toEqual([]);
    expect(result.skipped.join(" ")).toContain("Ghosts");
  });

  it("reads an explicit null as nothing chosen, rather than losing the batch", async () => {
    /*
     * Measured on a real API: three of eighteen batches failed because the
     * answer set a slot to `null` instead of omitting it, and a rejected batch
     * costs all six record types in it — eighteen lost to a punctuation
     * preference. A model declining a slot means the same thing either way.
     */
    const result = await run([
      {
        entity: "task",
        columns: ["Title"],
        sort: null,
        facets: null,
        time_field: null,
        stats: null,
      },
    ]);

    expect(result.errors).toEqual([]);
    expect(viewsOf(result.entities, "task")?.columns).toEqual(["Title"]);
    expect(viewsOf(result.entities, "task")?.sort).toBeUndefined();
  });

  it("trims an over-long answer rather than losing the batch for it", async () => {
    /*
     * The failure this actually hit: a record type offered seven candidate
     * filter fields where six fit, and a schema enforcing the cap by rejection
     * threw away all six record types in the batch. Two of eighteen batches on
     * a real API went that way. A list that is merely too long is an answer.
     */
    const result = await run([
      {
        entity: "task",
        columns: ["Title", "Bucket", "DueDate", "Cost", "VendorId", "Title", "Bucket"],
        facets: ["Bucket", "Title", "DueDate", "Cost", "VendorId", "Bucket", "Title"],
      },
    ]);

    expect(result.errors).toEqual([]);
    expect(viewsOf(result.entities, "task")?.columns?.length).toBeLessThanOrEqual(6);
    expect(viewsOf(result.entities, "task")?.facets?.length).toBeLessThanOrEqual(3);
  });

  it("counts what it stored, never what it accepted", async () => {
    /*
     * A view can pass this file's checks and still fail the record type's own
     * schema. Reporting proposals rather than survivors said "90 chosen" on a
     * run that stored 80 — a confidently wrong number, and the kind that hides
     * a real defect behind a healthy-looking summary.
     */
    const result = await run([
      // `Id` is hidden, so every column is dropped and the view is empty —
      // accepted here, and nothing to store.
      { entity: "task", columns: ["Id"] },
    ]);
    expect(result.chosen).toBe(1);
    expect(viewsOf(result.entities, "task")?.columns).toEqual([]);
  });

  it("ignores an answer for a record type it was not asked about", async () => {
    const result = await run([{ entity: "invented", columns: ["Title"] }]);
    expect(result.skipped.join(" ")).toContain("was answered for and was not offered");
    expect(result.chosen).toBe(0);
  });

  it("leaves everything as it was when the model does not call the tool", async () => {
    const result = await chooseViews(fakeLlm([{ text: "I would rather not" }]), {
      apiTitle: "Works API",
      entities: [TASK, VENDOR],
      resources: RESOURCES,
      ops: OPS,
    });

    // A working API, not a broken one: every slot falls back to a default.
    expect(result.entities).toEqual([TASK, VENDOR]);
    expect(result.errors).toHaveLength(1);
  });

  it("does not ask twice for a batch that already ran", async () => {
    const first = await run([{ entity: "task", columns: ["Title"] }]);
    const llm = fakeLlm([{ args: { views: [] } }]);
    await chooseViews(
      llm,
      { apiTitle: "Works API", entities: [TASK, VENDOR], resources: RESOURCES, ops: OPS },
      { completedBatches: first.completedBatches },
    );
    expect(llm.calls).toHaveLength(0);
  });
});

describe("the views prompt names no vendor and no domain", () => {
  const BANNED = [
    "buildium",
    "stripe",
    "github",
    "lease",
    "tenant",
    "landlord",
    "invoice",
    "applicant",
    "property",
    "listing",
    "vendor",
    "customer",
  ];

  it("describes shapes and English, never somebody's business", () => {
    for (const word of BANNED) {
      expect(
        new RegExp(`\\b${word}s?\\b`, "i").test(VIEWS_SYSTEM_PROMPT),
        `the prompt mentions "${word}"`,
      ).toBe(false);
    }
  });
});
