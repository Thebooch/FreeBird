import { describe, expect, it } from "vitest";
import { every, fake, node, owner, run, source, workflowOf } from "./testing.js";

/**
 * A workflow's calendar entries follow their records: one entry per record
 * and step, moved when the record's date moves, closed when it stops
 * matching, and left alone once a person has pinned it.
 */

const ORDERS = () => [
  { id: 1, status: "open", due: "2026-10-14", unit: "1A" },
  { id: 2, status: "open", due: "2026-10-15", unit: "2B" },
];

const calendarWorkflow = (settings: Record<string, unknown> = {}) =>
  workflowOf({
    trigger: every,
    source,
    criteria: 'status == "open"',
    nodes: [node("book", "create.calendar", { title: "Inspect {{ unit }}", at: "{{ due }}", ...settings })],
  });

describe("calendar entries from a workflow", () => {
  it("makes one entry per record, tied to the record and keyed to the step", async () => {
    const f = fake();
    f.rows = ORDERS();
    const workflow = calendarWorkflow();
    await f.env.store.put(workflow);
    await run(f, workflow);

    const entries = await f.env.calendar.list({ workflow: "wf" });
    expect(entries.map((one) => [one.title, one.at, one.dedupeKey, one.rowKey])).toEqual([
      ["Inspect 1A", "2026-10-14", "wf:1:book", "1"],
      ["Inspect 2B", "2026-10-15", "wf:2:book", "2"],
    ]);
    expect(entries[0]).toMatchObject({ source: { connection: "pms", entity: "work_order", recordId: "1" }, allDay: true, status: "open", kind: "event" });
  });

  it("moves an entry when its record's date moves, without a second case or entry", async () => {
    const f = fake();
    f.rows = ORDERS();
    const workflow = calendarWorkflow();
    await f.env.store.put(workflow);
    await run(f, workflow);
    const [first] = await f.env.calendar.list({ workflow: "wf", rowKey: "1" });

    f.rows[0]!.due = "2026-10-20";
    const again = await run(f, workflow);
    expect(again.run.cases).toEqual([]);
    expect(again.run.summary).toMatch(/1 calendar entry moved/);
    const moved = await f.env.calendar.list({ workflow: "wf", rowKey: "1" });
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ id: first!.id, at: "2026-10-20", title: "Inspect 1A" });
  });

  it("closes an entry when its record stops matching, as the step says, and leaves records it did not reach", async () => {
    const f = fake();
    f.rows = ORDERS();
    const workflow = workflowOf({
      trigger: every,
      source,
      criteria: 'status == "open"',
      nodes: [node("book", "create.calendar", { title: "Inspect {{ unit }}", at: "{{ due }}" }), node("remind", "create.calendar", { title: "Remind {{ unit }}", at: "{{ due }}", onUnmatch: "cancel" })],
    });
    await f.env.store.put(workflow);
    await run(f, workflow);

    f.rows = [{ ...ORDERS()[0]!, status: "closed" }];
    const after = await run(f, workflow);
    expect(after.run.summary).toMatch(/2 calendar entries closed/);
    const one = await f.env.calendar.list({ workflow: "wf", rowKey: "1" });
    expect(Object.fromEntries(one.map((entry) => [entry.dedupeKey, entry.status]))).toEqual({ "wf:1:book": "done", "wf:1:remind": "cancelled" });
    /* Record 2 was not in this read: not reached is not "gone". */
    expect((await f.env.calendar.list({ workflow: "wf", rowKey: "2" })).every((entry) => entry.status === "open")).toBe(true);
  });

  it("leaves an entry a person pinned, however its record moves", async () => {
    const f = fake();
    f.rows = ORDERS();
    const workflow = calendarWorkflow();
    await f.env.store.put(workflow);
    await run(f, workflow);
    const [held] = await f.env.calendar.list({ workflow: "wf", rowKey: "1" });
    await f.env.calendar.put({ ...held!, pinned: true, at: "2026-10-16" });

    f.rows[0]!.due = "2026-10-30";
    await run(f, workflow);
    f.rows[0]!.status = "closed";
    await run(f, workflow);
    expect(await f.env.calendar.get(held!.id)).toMatchObject({ at: "2026-10-16", status: "open", pinned: true });
  });

  it("only closes an entry whose date comes from earlier steps, since it cannot be filled in again without its case", async () => {
    const f = fake();
    f.rows = ORDERS();
    const workflow = workflowOf({
      trigger: every,
      source,
      criteria: 'status == "open"',
      nodes: [node("note", "update.case", { name: "when", value: "{{ due }}" }), node("book", "create.calendar", { title: "Inspect", at: "{{ vars.when }}" })],
    });
    await f.env.store.put(workflow);
    await run(f, workflow);
    f.rows[0]!.due = "2026-10-21";
    await run(f, workflow);
    expect((await f.env.calendar.list({ workflow: "wf", rowKey: "1" }))[0]).toMatchObject({ at: "2026-10-14" });
  });

  it("moves the entry in place when a change opens a new case, and undoing puts it back", async () => {
    const f = fake();
    f.rows = ORDERS();
    const workflow = workflowOf({
      trigger: { kind: "record_changed", connection: "pms", record: "work_order", fields: ["due"] },
      nodes: [node("book", "create.calendar", { title: "Inspect {{ unit }}", at: "{{ due }}" })],
    });
    await f.env.store.put(workflow);
    await run(f, workflow); // takes note of what is there
    f.rows[0]!.due = "2026-10-18";
    await run(f, workflow);
    f.rows[0]!.due = "2026-10-22";
    await run(f, workflow);

    const entries = await f.env.calendar.list({ workflow: "wf" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ at: "2026-10-22" });
    const tasks = await f.env.tasks.list({ workflow: "wf" });
    const moved = tasks.find((task) => task.title.startsWith("Moved on the calendar"))!;
    expect(moved).toBeDefined();
    await f.tasks.reverse(owner, moved.id);
    expect((await f.env.calendar.list({ workflow: "wf" }))[0]).toMatchObject({ id: entries[0]!.id, at: "2026-10-18" });
  });
});
