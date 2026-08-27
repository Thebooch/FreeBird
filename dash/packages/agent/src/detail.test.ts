import { describe, expect, it } from "vitest";
import { buildDetailPrompt, planDetail, type ChildOption } from "./detail.js";
import type { FieldInfo } from "./infer.js";
import { fakeLlm } from "./llm.js";

/**
 * What a record shows, and the guards on the model that chooses it.
 *
 * The fixture is a real Buildium task, because it is a good example of the
 * problem: roughly half of what the endpoint returns exists for the API rather
 * than for the person reading it — links back to the API, ids nobody can read,
 * and columns that are null on every record.
 */
const field = (name: string, kinds: string[], samples: unknown[] = []): FieldInfo =>
  ({ name, kinds, nullable: false, distinct: samples.length, samples }) as unknown as FieldInfo;

const taskFields: FieldInfo[] = [
  field("Id", ["number"], [5074917, 5074918]),
  field("TaskType", ["string"], ["Todo", "Request"]),
  field("Category.Name", ["string"], ["General Inquiry", "Maintenance Request"]),
  field("Category.Href", ["string"], ["https://api.buildium.com/v1/tasks/categories/1687"]),
  field("Title", ["string"], ["Rent Increase Evaluation"]),
  field("Description", ["string"], []),
  field("Property.Href", ["string"], ["https://api.buildium.com/v1/rentals/218831"]),
  field("UnitId", ["number"], [637370]),
  field("UnitAgreement", ["null"], []),
  field("AssignedToUserId", ["number"], [2482651]),
  field("TaskStatus", ["string"], ["New", "Completed"]),
  field("Priority", ["string"], ["High", "Low"]),
  field("DueDate", ["number"], [1780704000000]),
  field("CreatedDateTime", ["string"], ["2026-06-01T07:23:03Z"]),
];

const notes: ChildOption = {
  id: "notes-of-task",
  title: "Notes",
  op: "list_task_notes",
  linkField: "TaskId",
  exact: true,
  fields: [field("Id", ["number"]), field("Note", ["string"]), field("CreatedDateTime", ["string"])],
};

const files: ChildOption = {
  id: "files-of-task",
  title: "Files",
  op: "list_task_files",
  linkField: "TaskId",
  exact: true,
  fields: [field("Id", ["number"]), field("FileName", ["string"])],
};

const chose = (fields: string[], children?: string[]) => [
  { args: { fields, children, reason: "The things somebody opens a task to see." } },
];

describe("buildDetailPrompt", () => {
  it("shows example values, which is what makes noise recognisable", () => {
    const prompt = buildDetailPrompt({ recordTitle: "Task", fields: taskFields, children: [] });

    // `Href` is obvious from its value and invisible from its name.
    expect(prompt).toContain('Category.Href: string — e.g. "https://api.buildium.com');
    expect(prompt).toContain('Priority: string — e.g. "High", "Low"');
  });

  it("marks a field that is empty on every record", () => {
    const prompt = buildDetailPrompt({ recordTitle: "Task", fields: taskFields, children: [] });
    // Only visible by looking, and usually the reason a record row is blank.
    expect(prompt).toContain("UnitAgreement: null — always empty");
  });

  it("lists related collections with what their rows carry", () => {
    const prompt = buildDetailPrompt({
      recordTitle: "Task",
      fields: taskFields,
      children: [notes, files],
    });
    expect(prompt).toContain("notes-of-task — Notes (Id, Note, CreatedDateTime)");
    expect(prompt).toContain("files-of-task — Files");
  });

  it("says nothing about related collections when there are none", () => {
    const prompt = buildDetailPrompt({ recordTitle: "Task", fields: taskFields, children: [] });
    expect(prompt).not.toContain("RELATED COLLECTIONS");
  });
});

describe("planDetail", () => {
  it("keeps the model's order, which is the point of asking", async () => {
    const llm = fakeLlm(chose(["Title", "TaskStatus", "Priority", "DueDate", "Category.Name"]));
    const plan = await planDetail(llm, {
      recordTitle: "Task",
      fields: taskFields,
      children: [],
    });

    // What identifies the record first, then what somebody opened it to find.
    expect(plan.fields).toEqual(["Title", "TaskStatus", "Priority", "DueDate", "Category.Name"]);
    expect(plan.error).toBeNull();
  });

  it("drops a field the record does not carry", async () => {
    const llm = fakeLlm(chose(["Title", "AssignedToName", "TaskStatus"]));
    const plan = await planDetail(llm, { recordTitle: "Task", fields: taskFields, children: [] });

    /*
     * `AssignedToName` is exactly the kind of thing a model invents — it is
     * what the record *should* have, next to an `AssignedToUserId` that no
     * person can read. Bound anyway it renders a blank row rather than
     * failing, which is the kind of wrong that survives review.
     */
    expect(plan.fields).toEqual(["Title", "TaskStatus"]);
  });

  it("reports it when nothing the model named is real", async () => {
    const llm = fakeLlm(chose(["Name", "Owner", "Status"]));
    const plan = await planDetail(llm, { recordTitle: "Task", fields: taskFields, children: [] });

    // Distinct from a thin choice: the caller should fall back rather than
    // build a record showing nothing.
    expect(plan.fields).toEqual([]);
    expect(plan.error).toContain("none of the fields");
  });

  it("de-duplicates a field named twice", async () => {
    const llm = fakeLlm(chose(["Title", "Title", "Priority"]));
    const plan = await planDetail(llm, { recordTitle: "Task", fields: taskFields, children: [] });
    expect(plan.fields).toEqual(["Title", "Priority"]);
  });

  it("returns the chosen collections, resolved to real ones", async () => {
    const llm = fakeLlm(chose(["Title"], ["notes-of-task"]));
    const plan = await planDetail(llm, {
      recordTitle: "Task",
      fields: taskFields,
      children: [notes, files],
    });

    expect(plan.children).toHaveLength(1);
    expect(plan.children[0]?.op).toBe("list_task_notes");
    // The link field travels with it — a section keyed on nothing renders
    // every record's notes under every record.
    expect(plan.children[0]?.linkField).toBe("TaskId");
  });

  it("ignores a collection that was never offered", async () => {
    const llm = fakeLlm(chose(["Title"], ["notes-of-task", "invoices-of-task"]));
    const plan = await planDetail(llm, {
      recordTitle: "Task",
      fields: taskFields,
      children: [notes, files],
    });
    expect(plan.children.map((child) => child.id)).toEqual(["notes-of-task"]);
  });

  it("caps sections at what the spec allows", async () => {
    const many: ChildOption[] = Array.from({ length: 7 }, (_, index) => ({
      ...notes,
      id: `child-${index}`,
      title: `Child ${index}`,
    }));
    const llm = fakeLlm(chose(["Title"], many.map((child) => child.id)));
    const plan = await planDetail(llm, {
      recordTitle: "Task",
      fields: taskFields,
      children: many,
    });
    expect(plan.children).toHaveLength(4);
  });

  it("accepts a record with no related collections at all", async () => {
    const llm = fakeLlm(chose(["Title", "TaskStatus"]));
    const plan = await planDetail(llm, { recordTitle: "Task", fields: taskFields, children: [] });
    expect(plan.children).toEqual([]);
    expect(plan.fields).toHaveLength(2);
  });

  it("calls no model when the record has no fields", async () => {
    const llm = fakeLlm(chose(["Title"]));
    const plan = await planDetail(llm, { recordTitle: "Task", fields: [], children: [] });

    expect(plan.error).toContain("no fields");
    expect(llm.calls).toHaveLength(0);
  });

  it("reports a model failure rather than throwing", async () => {
    const broken: Parameters<typeof planDetail>[0] = {
      defaultModel: "x",
      generate: async () => {
        throw new Error("upstream is down");
      },
      stream: async function* () {},
    };
    const plan = await planDetail(broken, {
      recordTitle: "Task",
      fields: taskFields,
      children: [],
    });
    expect(plan.error).toBe("upstream is down");
  });
});

describe("collections that cannot be asked for directly", () => {
  /**
   * A section with no parameter is read a page at a time and matched here, so
   * a record's rows can sit past the last page fetched and the tab renders as
   * though the record has none. The model is told which are which so a tie
   * breaks toward the one that answers exactly.
   */
  const bestEffort: ChildOption = { ...files, id: "audits-of-task", title: "Audits", exact: false };

  it("marks a best-effort collection in the prompt", () => {
    const prompt = buildDetailPrompt({
      recordTitle: "Task",
      fields: taskFields,
      children: [notes, bestEffort],
    });

    expect(prompt).toContain("audits-of-task — Audits");
    expect(prompt.split("\n").find((line) => line.includes("audits-of-task"))).toContain(
      "best-effort",
    );
  });

  it("says nothing of the sort about one that can be asked for directly", () => {
    const prompt = buildDetailPrompt({
      recordTitle: "Task",
      fields: taskFields,
      children: [notes, bestEffort],
    });

    expect(prompt.split("\n").find((line) => line.includes("notes-of-task"))).not.toContain(
      "best-effort",
    );
  });
});

describe("the heading and the sections", () => {
  const planned = (args: Record<string, unknown>) =>
    planDetail(fakeLlm([{ args: { reason: "chosen", ...args } }]), {
      recordTitle: "Task",
      fields: taskFields,
      children: [],
    });

  it("promotes the heading fields and keeps them out of the body", async () => {
    const plan = await planned({
      title: "Title",
      subtitle: "Category.Name",
      status: "TaskStatus",
      facts: ["DueDate", "Priority"],
      fields: ["Title", "TaskStatus", "DueDate", "Description", "CreatedDateTime"],
    });

    expect(plan.header).toEqual({
      title: "Title",
      subtitle: "Category.Name",
      status: "TaskStatus",
      facts: ["DueDate", "Priority"],
    });
    // A field on screen in the heading must not also be a row below it.
    expect(plan.fields).toEqual(["Description", "CreatedDateTime"]);
  });

  it("drops heading fields the record does not carry", async () => {
    const plan = await planned({
      title: "Subject",
      status: "State",
      facts: ["DueDate", "Invented"],
      fields: ["Title", "Description"],
    });

    expect(plan.header).toEqual({ facts: ["DueDate"] });
    expect(plan.fields).toEqual(["Title", "Description"]);
  });

  it("does not draw the same field as both title and subtitle", async () => {
    const plan = await planned({ title: "Title", subtitle: "Title", fields: ["Description"] });
    expect(plan.header).toEqual({ title: "Title", facts: [] });
  });

  it("caps the facts at what the record view can draw", async () => {
    const plan = await planned({
      facts: ["Id", "UnitId", "DueDate", "Priority", "CreatedDateTime", "AssignedToUserId"],
      fields: ["Title"],
    });
    expect(plan.header?.facts).toHaveLength(4);
  });

  it("keeps only group members the body actually holds, and claims each once", async () => {
    const plan = await planned({
      title: "Title",
      fields: ["TaskStatus", "Priority", "DueDate", "CreatedDateTime"],
      groups: [
        { title: "Status", fields: ["TaskStatus", "Priority", "Title"] },
        // `Priority` is already claimed above; `Invented` does not exist.
        { title: "Dates", fields: ["DueDate", "Priority", "Invented"] },
        // Nothing real left, so this heading is dropped rather than rendered empty.
        { title: "Nothing", fields: ["Invented"] },
      ],
    });

    expect(plan.groups).toEqual([
      { title: "Status", fields: ["TaskStatus", "Priority"] },
      { title: "Dates", fields: ["DueDate"] },
    ]);
    // Ungrouped fields are not lost — the renderer shows them in a final
    // unnamed section, which is what makes grouping safe to get wrong.
    expect(plan.fields).toContain("CreatedDateTime");
  });

  it("plans no heading at all when the model offers none", async () => {
    const plan = await planned({ fields: ["Title", "Description"] });
    expect(plan.header).toBeUndefined();
    expect(plan.groups).toEqual([]);
  });
});
