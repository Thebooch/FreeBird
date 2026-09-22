import type {
  CategorySpec,
  ConnectionSpec,
  DashboardSpec,
  EntitySpec,
  StarterSpec,
} from "@freebirdai/dash-spec";
import {
  categorySchema,
  connectionSchema,
  dashboardSchema,
  entitySchema,
} from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { COMBINED_WIDGET_MAX, interleave, materialise } from "./materialise.js";

/**
 * A shared starter set, compiled against one account.
 *
 * The boundary where an artifact describing an API meets a connection holding
 * some of it. Two failures are being guarded against, and neither announces
 * itself: a widget over an endpoint this connection does not carry, saved and
 * discovered by whoever opens the board; and a board quietly shorter than the
 * one that was designed, with nothing saying which widget went missing.
 */

const entity = (id: string, many: string, resource = id): EntitySpec =>
  entitySchema.parse({
    id,
    resource,
    name: { one: many.replace(/s$/, ""), many },
    kind: "work",
    identity: { field: "Id", observed: true },
    display: { title: ["Title"], status: "Status" },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      { path: "Status", label: "Status", visibility: "primary" },
      { path: "DueDate", label: "Due date", semantic: "timestamp", visibility: "detail" },
    ],
  });

const ENTITIES = [entity("task", "Tasks"), entity("lease", "Leases")];

const connection: ConnectionSpec = connectionSchema.parse({
  id: "acme",
  title: "Acme",
  kind: "rest",
  baseUrl: "https://api.example.com",
  ops: [
    { id: "tasks_list", title: "Tasks", path: "/v1/tasks" },
    { id: "leases_list", title: "Leases", path: "/v1/leases" },
  ],
  resources: [
    { id: "task", title: "Tasks", listOp: "tasks_list" },
    { id: "lease", title: "Leases", listOp: "leases_list" },
  ],
});

const starter = (input: Partial<StarterSpec> & { brief: StarterSpec["brief"] }): StarterSpec => ({
  importance: 3,
  ...input,
});

const category = (input: Partial<CategorySpec> = {}): CategorySpec =>
  categorySchema.parse({
    id: "maintenance",
    title: "Maintenance",
    entities: ["task"],
    starters: [
      starter({
        brief: { entity: "task", intent: "measure", title: "Open work" },
        importance: 5,
        size: "sm",
      }),
      starter({ brief: { entity: "task", intent: "compare", groupBy: "Status" }, importance: 4 }),
      starter({ brief: { entity: "task", intent: "records" }, importance: 2, size: "lg" }),
    ],
    ...input,
  });

const LEASING = category({
  id: "leasing",
  title: "Leasing",
  entities: ["lease"],
  starters: [
    starter({ brief: { entity: "lease", intent: "measure" }, importance: 5 }),
    starter({ brief: { entity: "lease", intent: "records" }, importance: 2 }),
  ],
});

/** A board maker with the same uniqueness rule the server applies. */
const maker = () => {
  const taken = new Set<string>();
  const made: DashboardSpec[] = [];
  return {
    made,
    createBoard: (title: string): DashboardSpec => {
      const base =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "board";
      let id = base;
      for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
      taken.add(id);
      const board = dashboardSchema.parse({ id, title, widgets: [] });
      made.push(board);
      return board;
    },
  };
};

const run = (input: {
  categories: readonly CategorySpec[];
  layout: "single" | "per-category";
  connection?: ConnectionSpec;
  entities?: readonly EntitySpec[];
}) =>
  materialise({
    source: {
      connection: input.connection ?? connection,
      entities: input.entities ?? ENTITIES,
    },
    categories: input.categories,
    layout: input.layout,
    createBoard: maker().createBoard,
  });

describe("materialise, per category", () => {
  it("makes one board per part, titled after it", () => {
    const result = run({ categories: [category(), LEASING], layout: "per-category" });
    expect(result.errors).toEqual([]);
    expect(result.boards.map((board) => board.board.title)).toEqual(["Maintenance", "Leasing"]);
    expect(result.boards[0]?.category).toBe("maintenance");
  });

  it("compiles every starter into a widget of the right kind", () => {
    const result = run({ categories: [category()], layout: "per-category" });
    const components = result.boards[0]?.widgets.map((widget) => widget.component);
    expect(components).toEqual(["stat", "bar", "table"]);
  });

  /* The board is laid out before any browser sees it. That is what makes a
   * starting dashboard look designed rather than stacked. */
  it("places every widget inside the grid, at the size it asked for", () => {
    const result = run({ categories: [category()], layout: "per-category" });
    const cells = result.boards[0]?.board.layout.cells ?? [];
    expect(cells).toHaveLength(3);
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x + cell.w).toBeLessThanOrEqual(12);
    }
    const stat = cells.find((cell) => cell.widgetId === "open_work");
    expect(stat?.sizeVariant).toBe("sm");
  });

  it("puts the most important widget first", () => {
    const result = run({ categories: [category()], layout: "per-category" });
    const cells = result.boards[0]?.board.layout.cells ?? [];
    const top = [...cells].sort((a, b) => a.y - b.y || a.x - b.x)[0];
    expect(top?.widgetId).toBe("open_work");
  });

  /* A shared artifact meets a connection that holds part of the API. A widget
   * over an endpoint this connection has not got is one nothing could fetch. */
  it("drops a part this connection cannot read, and says so", () => {
    const partial = connectionSchema.parse({
      ...connection,
      ops: [{ id: "tasks_list", title: "Tasks", path: "/v1/tasks" }],
      resources: [{ id: "task", title: "Tasks", listOp: "tasks_list" }],
    });
    const result = run({
      categories: [category(), LEASING],
      layout: "per-category",
      connection: partial,
    });
    expect(result.boards.map((board) => board.category)).toEqual(["maintenance"]);
    expect(result.notes.join(" ")).toMatch(/Leasing: no board was made/);
  });

  it("reports a starter the compiler refuses rather than dropping it silently", () => {
    const broken = category({
      starters: [
        starter({ brief: { entity: "task", intent: "records" } }),
        starter({ brief: { entity: "task", intent: "compare", groupBy: "Nonexistent" } }),
      ],
    });
    const result = run({ categories: [broken], layout: "per-category" });
    expect(result.boards[0]?.widgets).toHaveLength(1);
    expect(result.notes.join(" ")).toMatch(/Nonexistent/);
  });

  it("says nothing was chosen rather than making an empty board", () => {
    const result = run({ categories: [], layout: "per-category" });
    expect(result.boards).toEqual([]);
    expect(result.errors[0]).toMatch(/nothing was chosen/);
  });
});

describe("materialise, one board", () => {
  it("puts every part on one board named after the connection", () => {
    const result = run({ categories: [category(), LEASING], layout: "single" });
    expect(result.boards).toHaveLength(1);
    expect(result.boards[0]?.board.title).toBe("Acme");
    expect(result.boards[0]?.category).toBeUndefined();
    expect(result.boards[0]?.widgets).toHaveLength(5);
  });

  it("keeps widget ids unique across parts that share a board", () => {
    const twice = category({ id: "other", title: "Other", entities: ["task"] });
    const result = run({ categories: [category(), twice], layout: "single" });
    const ids = result.boards[0]?.widgets.map((widget) => widget.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("caps one board and says what it left off", () => {
    const many = Array.from({ length: 4 }, (_, index) =>
      category({
        id: `part${index}`,
        title: `Part ${index}`,
        entities: ["task"],
        starters: [
          starter({ brief: { entity: "task", intent: "measure" }, importance: 5 }),
          starter({ brief: { entity: "task", intent: "compare", groupBy: "Status" } }),
          starter({ brief: { entity: "task", intent: "compare", groupBy: "DueDate" } }),
          starter({ brief: { entity: "task", intent: "records" }, importance: 1 }),
        ],
      }),
    );
    const result = run({ categories: many, layout: "single" });
    expect(result.boards[0]?.widgets).toHaveLength(COMBINED_WIDGET_MAX);
    expect(result.notes.join(" ")).toMatch(/4 widget\(s\) were left off/);
  });
});

describe("interleave", () => {
  const built = (category: string, importance: number, id: string) =>
    ({
      widget: { id, component: "stat" },
      starter: { brief: { entity: "task", intent: "measure" }, importance },
      category,
    }) as never;

  /* Category by category would put the whole of the first above the fold and
   * none of the second. Somebody who asked for both wants to see both. */
  it("takes a turn from each part, best first", () => {
    const order = interleave(
      [
        built("a", 1, "a-low"),
        built("a", 5, "a-high"),
        built("b", 3, "b-mid"),
        built("b", 4, "b-high"),
      ],
      4,
    ).map((one) => (one as { widget: { id: string } }).widget.id);
    expect(order).toEqual(["a-high", "b-high", "a-low", "b-mid"]);
  });

  it("keeps taking from a part that still has widgets when another is empty", () => {
    const order = interleave([built("a", 5, "a1"), built("a", 4, "a2"), built("b", 3, "b1")], 3).map(
      (one) => (one as { widget: { id: string } }).widget.id,
    );
    expect(order).toEqual(["a1", "b1", "a2"]);
  });

  it("stops at the limit", () => {
    expect(interleave([built("a", 5, "a1"), built("a", 4, "a2")], 1)).toHaveLength(1);
  });
});
