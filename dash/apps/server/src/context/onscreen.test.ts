import { type DashboardSpec, dashboardSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { workspaceHandles } from "../chat/handles.js";
import { describeScreen, focusFromScreen, parseView } from "./onscreen.js";
import type { OpReader } from "./types.js";

/**
 * Talking about what somebody is looking at.
 *
 * Clicking into a record is a good way to work, and the conversation should
 * keep up with wherever it lands them — but never by buying data to find out
 * where that is. The rows were drawn a moment ago; if they are not in hand,
 * the honest answer is that the fields are not known.
 */

const widget = (id: string, title: string) => ({
  id,
  title,
  component: "table",
  source: { connection: "acme", op: "list_tasks" },
  pipeline: [{ op: "extract", path: "$" }],
  roles: { columns: ["Title"] },
});

const board = (id: string, title: string, widgets: unknown[]): DashboardSpec =>
  dashboardSchema.parse({ id, title, widgets, layout: { cells: [] } });

const boards = [board("ops", "Ops", [widget("all-tasks", "All Tasks")])];
const handles = workspaceHandles(boards, "ops");

const context = {
  connections: [],
  ops: [],
  shapes: {},
  joins: [],
  drillDowns: [{ resource: "task", title: "Task", listOp: "list_tasks", detailOp: "get_task", idField: "Id", detailParam: "taskId" }],
  children: [],
  searchable: [],
  rangeFilterable: [],
  readPlans: [],
} as never;

const resolved = {
  range: { start: 0, end: 1, grain: "1d" as const, preset: "30d" as const },
  filters: {},
};

const reading = (body: unknown, calls: string[] = []): OpReader =>
  (async (input) => {
    calls.push(`cacheOnly=${input.cacheOnly}`);
    return { ok: true as const, body, requests: 0, truncated: false };
  }) as OpReader;

const load = (open: { widgetId: string; recordId: string }, read: OpReader) =>
  focusFromScreen({
    open: { kind: "record", ...open },
    handles,
    context,
    resolved,
    read,
    now: () => 0,
    timeZone: "UTC",
    rowsOf: (body) =>
      Array.isArray(body)
        ? (body as Record<string, unknown>[])
        : body && typeof body === "object"
          ? [body as Record<string, unknown>]
          : [],
  });

describe("parseView", () => {
  it("reads an open record", () => {
    expect(parseView("record:all-tasks:5216612")).toEqual({
      kind: "record",
      widgetId: "all-tasks",
      recordId: "5216612",
    });
  });

  it("decodes ids that needed escaping", () => {
    expect(parseView("record:my%3Awidget:a%2Fb")).toEqual({
      kind: "record",
      widgetId: "my:widget",
      recordId: "a/b",
    });
  });

  it("reads a record opened by what it is", () => {
    /*
     * The address of a record page names the API, the record type and the id —
     * no widget, because the same vendor is the same page however somebody
     * reached it.
     */
    expect(parseView("entity:buildium:vendor:350113")).toEqual({
      kind: "entity",
      connectionId: "buildium",
      entityId: "vendor",
      recordId: "350113",
    });
  });

  it("keeps an entity record id containing a colon whole", () => {
    expect(parseView("entity:api:thing:urn:x:7")?.recordId).toBe("urn:x:7");
  });

  it("treats a half-written entity view as no record open", () => {
    for (const value of ["entity", "entity:api", "entity:api:vendor", "entity:::"]) {
      expect(parseView(value), value).toBeNull();
    }
  });

  it("keeps a record id containing a colon whole", () => {
    expect(parseView("record:w:urn:thing:7")?.recordId).toBe("urn:thing:7");
  });

  /*
   * A newer client, a hand-edited header or a stale tab should cost the
   * conversation nothing more than this extra context.
   */
  it("treats anything else as no record open", () => {
    for (const value of ["board", "", "record:", "record:only-one", null, 7, undefined]) {
      expect(parseView(value)).toBeNull();
    }
  });
});

describe("focusFromScreen", () => {
  it("turns the record on screen into a focus", async () => {
    const focus = await load(
      { widgetId: "all-tasks", recordId: "5216612" },
      reading([
        { Id: 1, Title: "Turn" },
        { Id: 5216612, Title: "Dishwasher", Description: "Not draining" },
      ]),
    );
    expect(focus?.records).toEqual([
      { Id: 5216612, Title: "Dishwasher", Description: "Not draining" },
    ]);
    expect(focus?.sourceTitle).toBe("All Tasks");
    expect(focus?.idField).toBe("Id");
  });

  it("matches a numeric identifier against the id from the address bar", async () => {
    const focus = await load(
      { widgetId: "all-tasks", recordId: "5216612" },
      reading([{ Id: 5216612, Title: "Dishwasher" }]),
    );
    expect(focus?.records).toHaveLength(1);
  });

  /*
   * Never a request. The browser has just drawn this record; buying it again
   * to work out what somebody is looking at is exactly the invisible cost this
   * codebase refuses elsewhere.
   */
  it("reads cache-only", async () => {
    const calls: string[] = [];
    await load({ widgetId: "all-tasks", recordId: "1" }, reading([{ Id: 1 }], calls));
    expect(calls).toEqual(["cacheOnly=true"]);
  });

  /*
   * The regression this caught: a record page does not read the list, it calls
   * the endpoint for that one record. Scanning the widget's rows missed every
   * time somebody arrived by link, while the record sat in the cache under the
   * drill-down's key.
   */
  it("asks for the record the way the page did, by its drill-down", async () => {
    const withDrilldown = [
      board("ops", "Ops", [
        {
          ...widget("all-tasks", "All Tasks"),
          drilldown: {
            op: "get_task",
            params: { taskId: "{{row.Id}}" },
            component: "record",
            pipeline: [{ op: "extract", path: "$" }],
            roles: { fields: ["Title"] },
          },
        },
      ]),
    ];
    const asked: string[] = [];
    const focus = await focusFromScreen({
      open: { kind: "record", widgetId: "all-tasks", recordId: "5216612" },
      handles: workspaceHandles(withDrilldown, "ops"),
      context,
      resolved,
      read: (async (input) => {
        asked.push(`${input.op}:${JSON.stringify(input.params)}`);
        return {
          ok: true as const,
          body: { Id: 5216612, Title: "Dishwasher", Description: "Not draining" },
          requests: 0,
          truncated: false,
        };
      }) as OpReader,
      now: () => 0,
      timeZone: "UTC",
      rowsOf: (body) => (body && typeof body === "object" ? [body as Record<string, unknown>] : []),
    });

    // The id from the address bar fills the `{{row.…}}` input, and the list is
    // never touched.
    expect(asked).toEqual(['get_task:{"taskId":"5216612"}']);
    expect(focus?.records[0]).toMatchObject({ Title: "Dishwasher", Description: "Not draining" });
  });

  it("gives up rather than guessing when the rows are not held", async () => {
    const cold = (async () => null) as OpReader;
    expect(await load({ widgetId: "all-tasks", recordId: "1" }, cold)).toBeNull();
  });

  it("gives up when the record is not among the rows", async () => {
    const focus = await load(
      { widgetId: "all-tasks", recordId: "does-not-exist" },
      reading([{ Id: 1 }]),
    );
    expect(focus).toBeNull();
  });

  it("gives up on a widget that is not in the workspace", async () => {
    expect(await load({ widgetId: "ghost", recordId: "1" }, reading([{ Id: 1 }]))).toBeNull();
  });

  it("resolves a record opened on its own page, through its record type", async () => {
    /*
     * No widget is involved, so there is no drill-down to follow. The page
     * called the record type's own detail endpoint, which is exactly why that
     * request is the one already in the cache.
     */
    const asked: string[] = [];
    const focus = await focusFromScreen({
      open: { kind: "entity", connectionId: "acme", entityId: "vendor", recordId: "350113" },
      entityDetail: () => ({
        op: "get_vendor",
        idParam: "vendorId",
        idField: "Id",
        title: "Supplier",
      }),
      handles,
      context,
      resolved,
      read: (async (input) => {
        asked.push(`${input.op}:${JSON.stringify(input.params)}:cacheOnly=${input.cacheOnly}`);
        return {
          ok: true as const,
          body: { Id: 350113, CompanyName: "McKinney Strategic" },
          requests: 0,
          truncated: false,
        };
      }) as OpReader,
      now: () => 0,
      timeZone: "UTC",
      rowsOf: (body) => (body && typeof body === "object" ? [body as Record<string, unknown>] : []),
    });

    expect(asked).toEqual(['get_vendor:{"vendorId":"350113"}:cacheOnly=true']);
    expect(focus?.sourceTitle).toBe("Supplier");
    expect(focus?.idField).toBe("Id");
    expect(focus?.records[0]).toMatchObject({ CompanyName: "McKinney Strategic" });
  });

  it("gives up on a record page when nothing can say where its records live", async () => {
    // An older deployment supplies no resolver at all, and a record type the
    // catalog does not describe resolves to nothing. Both are "not known"
    // rather than a guessed endpoint.
    expect(
      await focusFromScreen({
        open: { kind: "entity", connectionId: "acme", entityId: "ghost", recordId: "1" },
        handles,
        context,
        resolved,
        read: (async () => null) as OpReader,
        now: () => 0,
        timeZone: "UTC",
        rowsOf: () => [],
      }),
    ).toBeNull();
  });
});

describe("describeScreen", () => {
  it("says which tab when nothing finer is open", () => {
    expect(describeScreen({ tab: "Ops", open: null, record: null })).toContain('"Ops" tab');
  });

  it("says the record is in hand when it could be resolved", () => {
    const line = describeScreen({
      tab: "Ops",
      open: { kind: "record", widgetId: "all-tasks", recordId: "1" },
      record: {
        question: "the record they have open",
        source: "all-tasks",
        sourceTitle: "All Tasks",
        connection: "acme",
        op: "list_tasks",
        idField: "Id",
        records: [{ Id: 1 }],
        savedAt: "",
      },
    });
    expect(line).toContain("All Tasks");
    expect(line).toContain('"this"');
  });

  /*
   * Knowing a record is open but not what it says is a real state, and saying
   * so is what stops the assistant describing fields it never saw.
   */
  it("admits when a record is open but its fields are not held", () => {
    const line = describeScreen({
      tab: "Ops",
      open: { kind: "record", widgetId: "all-tasks", recordId: "77" },
      record: null,
    });
    expect(line).toContain("77");
    expect(line).toContain("not in hand");
  });

  it("names a record open on its own page by what it is", () => {
    // "from a widget" would be a small lie about a page no widget opened, and
    // small lies are what make an assistant sound like it is guessing.
    const line = describeScreen({
      tab: "Ops",
      open: { kind: "entity", connectionId: "acme", entityId: "vendor", recordId: "350113" },
      record: {
        question: "the record they have open",
        source: "vendor",
        sourceTitle: "Supplier",
        connection: "acme",
        op: "get_vendor",
        idField: "Id",
        records: [{ Id: 350113 }],
        savedAt: "",
      },
    });
    expect(line).toContain("one supplier open");
    expect(line).not.toContain("from a widget");
  });

  it("says a record page is open even when its fields are not held", () => {
    const line = describeScreen({
      tab: "Ops",
      open: { kind: "entity", connectionId: "acme", entityId: "vendor", recordId: "350113" },
      record: null,
    });
    expect(line).toContain("its own page");
    expect(line).toContain("not in hand");
  });
});
