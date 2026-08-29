import { describe, expect, it } from "vitest";
import type { ChildCollection } from "@freebirdai/dash-agent";
import type { Focus } from "./focus.js";
import { readRelated } from "./related.js";
import type { OpReader } from "./types.js";

/**
 * The two shapes a relation comes in, and the honesty each one needs.
 *
 * An API either exposes a collection *under* the record — one request each —
 * or exposes one flat collection whose rows point back, matched here for a
 * single request. Only the relation graph knows which; nothing here does.
 */

const focus = (over: Partial<Focus> = {}): Focus => ({
  question: "any dishwasher work orders?",
  source: "maintenance",
  sourceTitle: "Maintenance Tasks",
  connection: "acme",
  op: "list_workorders",
  idField: "Id",
  records: [{ Id: 1661188, Title: "Dishwasher" }],
  savedAt: new Date().toISOString(),
  ...over,
});

const child = (over: Partial<ChildCollection> = {}): ChildCollection =>
  ({
    id: "bill-under-workorder",
    parentOp: "list_workorders",
    title: "Retrieve all bills",
    op: "list_bills",
    ...over,
  }) as ChildCollection;

const reader = (
  body: unknown,
  opts: { truncated?: boolean; calls?: string[] } = {},
): OpReader =>
  (async (input) => {
    opts.calls?.push(`${input.op}:${JSON.stringify(input.params)}`);
    return { ok: true as const, body, requests: 1, truncated: opts.truncated ?? false };
  }) as OpReader;

const rowsOf = (body: unknown) => (Array.isArray(body) ? (body as Record<string, unknown>[]) : []);
const resolved = {
  range: { start: 0, end: 1, grain: "1d" as const, preset: "30d" as const },
  filters: {},
};

describe("readRelated — under the record", () => {
  it("asks for each record by its id", async () => {
    const calls: string[] = [];
    const result = await readRelated({
      focus: focus(),
      child: child({ param: "taskId" } as Partial<ChildCollection>),
      read: reader([{ Note: "Randy to repair" }], { calls }),
      resolved,
      rowsOf,
      rowsPath: "$",
    });
    expect(calls).toEqual(['list_bills:{"taskId":"1661188"}']);
    expect(result.evidence?.rows[0]).toMatchObject({ Note: "Randy to repair", Id: "1661188" });
    expect(result.note).toContain("Opened");
  });

  it("caps the fan-out and says it did", async () => {
    const many = focus({ records: [{ Id: 1 }, { Id: 2 }, { Id: 3 }, { Id: 4 }, { Id: 5 }] });
    const calls: string[] = [];
    const result = await readRelated({
      focus: many,
      child: child({ param: "taskId" } as Partial<ChildCollection>),
      read: reader([], { calls }),
      resolved,
      rowsOf,
      rowsPath: "$",
    });
    expect(calls).toHaveLength(3);
    expect(result.note).toContain("3 of the 5 records");
  });
});

describe("readRelated — the record's id carried on the child", () => {
  /*
   * The shape that regressed: the collection takes no input, its rows carry
   * the parent's id, and the first version refused it outright.
   */
  it("reads the collection once and matches here", async () => {
    const calls: string[] = [];
    const result = await readRelated({
      focus: focus(),
      child: child({ linkField: "WorkOrderId", linkKind: "scalar" } as Partial<ChildCollection>),
      read: reader(
        [
          { Id: 9, WorkOrderId: 1661188, Amount: 150 },
          { Id: 10, WorkOrderId: 999, Amount: 20 },
        ],
        { calls },
      ),
      resolved,
      rowsOf,
      rowsPath: "$",
    });
    expect(calls).toEqual(['list_bills:{}']);
    expect(result.requests).toBe(1);
    expect(result.evidence?.rows).toHaveLength(1);
    expect(result.evidence?.rows[0]).toMatchObject({ Id: "1661188", Amount: 150 });
  });

  it("matches a numeric id against a string one", async () => {
    const result = await readRelated({
      focus: focus({ records: [{ Id: "1661188" }] }),
      child: child({ linkField: "WorkOrderId", linkKind: "scalar" } as Partial<ChildCollection>),
      read: reader([{ WorkOrderId: 1661188 }]),
      resolved,
      rowsOf,
      rowsPath: "$",
    });
    expect(result.evidence?.rows).toHaveLength(1);
  });

  it("handles a list-valued foreign key", async () => {
    const result = await readRelated({
      focus: focus(),
      child: child({ linkField: "WorkOrderIds", linkKind: "array" } as Partial<ChildCollection>),
      read: reader([{ WorkOrderIds: [42, 1661188] }, { WorkOrderIds: [7] }]),
      resolved,
      rowsOf,
      rowsPath: "$",
    });
    expect(result.evidence?.rows).toHaveLength(1);
  });

  /*
   * A match against a collection the page cap stopped early finds nothing and
   * looks exactly like a record with nothing attached.
   */
  it("refuses to call an empty match proof of nothing when the read was cut short", async () => {
    const result = await readRelated({
      focus: focus(),
      child: child({ linkField: "WorkOrderId", linkKind: "scalar" } as Partial<ChildCollection>),
      read: reader([{ WorkOrderId: 999 }], { truncated: true }),
      resolved,
      rowsOf,
      rowsPath: "$",
    });
    expect(result.evidence?.rows).toHaveLength(0);
    expect(result.evidence?.warnings.join(" ")).toContain("not proof");
    expect(result.note).toContain("part that was read");
  });
});

describe("readRelated — when it cannot be done", () => {
  /*
   * A 403 says the key works and lacks a scope, which is the one part of this
   * somebody can act on. Reporting it as "could not be read" throws that away.
   */
  it("passes the API's own reason through when it refuses", async () => {
    const refusing = (async () => ({
      ok: false as const,
      reason: "Buildium accepted the key but will not allow access to this endpoint.",
    })) as OpReader;
    const result = await readRelated({
      focus: focus(),
      child: child({ linkField: "WorkOrderId", linkKind: "scalar" } as Partial<ChildCollection>),
      read: refusing,
      resolved,
      rowsOf,
      rowsPath: "$",
    });
    expect(result.note).toContain("will not allow access");
    expect(result.requests).toBe(0);
  });

  it("says so when no identity was established", async () => {
    const result = await readRelated({
      focus: focus({ idField: null }),
      child: child({ param: "taskId" } as Partial<ChildCollection>),
      read: reader([]),
      resolved,
      rowsOf,
      rowsPath: "$",
    });
    expect(result.requests).toBe(0);
    expect(result.note).toContain("No identifier");
  });

  it("says so when the collection neither takes the id nor carries it", async () => {
    const result = await readRelated({
      focus: focus(),
      child: child(),
      read: reader([]),
      resolved,
      rowsOf,
      rowsPath: "$",
    });
    expect(result.requests).toBe(0);
    expect(result.note).toContain("no way to ask for it");
  });
});
