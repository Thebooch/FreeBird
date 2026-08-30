import { describe, expect, it } from "vitest";
import { type DashboardSpec, dashboardSchema } from "@freebirdai/dash-spec";
import {
  PAGE_SIZE,
  coverageOf,
  orderedByOf,
  pipelineCut,
  readWidget,
  readableDates,
} from "./read.js";
import type { Candidate } from "./types.js";

/**
 * What a read claims about itself.
 *
 * The rows are the easy part. What has to be right is the coverage: every way
 * a read can be less than complete has to end up saying so, because the reply
 * states the number and the limit in one breath and a wrong limit makes a
 * sample read as a total.
 */

const widgetSpec = (over: Record<string, unknown> = {}) => ({
  id: "leases",
  title: "Leases",
  component: "table",
  source: { connection: "acme", op: "list_leases" },
  pipeline: [{ op: "extract", path: "$" }],
  roles: { columns: ["Name"] },
  ...over,
});

const board = (widgets: unknown[]): DashboardSpec =>
  dashboardSchema.parse({ id: "ops", title: "Ops", widgets, layout: { cells: [] } });

const candidate: Candidate = {
  kind: "widget",
  id: "leases",
  title: "Leases",
  describes: "",
  connection: "acme",
  op: "list_leases",
  fields: [],
  cached: false,
};

const resolved = {
  range: { start: 0, end: 1_000, grain: "1d" as const, preset: "30d" as const },
  filters: {},
};

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ Name: `row ${i}` }));

const readOf = (body: unknown, truncated = false) => async () => ({
  ok: true as const,
  body,
  requests: 1,
  truncated,
});

const run = (spec: unknown, body: unknown, opts: { truncated?: boolean } = {}) =>
  readWidget({
    candidate,
    widget: board([spec]).widgets[0]!,
    resolved,
    read: readOf(body, opts.truncated ?? false),
    cacheOnly: false,
    now: 0,
    timeZone: "UTC",
  });

describe("readWidget", () => {
  it("runs the widget's own pipeline, so the rows are the tile's rows", async () => {
    const evidence = await run(widgetSpec(), rows(3));
    expect(evidence?.rows).toHaveLength(3);
    expect(evidence?.columns).toContain("Name");
    expect(evidence?.requests).toBe(1);
  });

  it("reports a complete read as complete", async () => {
    const evidence = await run(widgetSpec(), rows(3));
    expect(evidence?.coverage).toMatchObject({ scanned: 3, of: 3, partial: false });
  });

  it("caps the dump and says the rest was not handed over", async () => {
    const evidence = await run(widgetSpec(), rows(PAGE_SIZE + 20));
    expect(evidence?.rows).toHaveLength(PAGE_SIZE);
    expect(evidence?.coverage.partial).toBe(true);
  });

  /*
   * The quiet one. The page cap stops the fetch before the API runs out, so
   * every row that came back is handed over and the read looks whole — while
   * the account holds more.
   */
  it("is partial when the page cap stopped the fetch, even though nothing was dropped", async () => {
    const evidence = await run(widgetSpec(), rows(10), { truncated: true });
    expect(evidence?.rows).toHaveLength(10);
    expect(evidence?.coverage.partial).toBe(true);
    // A total nobody can know is null, never the number that came back.
    expect(evidence?.coverage.of).toBeNull();
  });

  it("is partial when the widget's own limit threw rows away", async () => {
    const limited = widgetSpec({
      pipeline: [{ op: "extract", path: "$" }, { op: "limit", count: 5 }],
    });
    const evidence = await run(limited, rows(40));
    expect(evidence?.rows).toHaveLength(5);
    expect(evidence?.coverage.partial).toBe(true);
    expect(evidence?.coverage.of).toBeNull();
  });

  it("returns nothing at all when no source could be read", async () => {
    const evidence = await readWidget({
      candidate,
      widget: board([widgetSpec()]).widgets[0]!,
      resolved,
      read: async () => null,
      cacheOnly: true,
      now: 0,
      timeZone: "UTC",
    });
    expect(evidence).toBeNull();
  });

  /*
   * A widget drawing on two endpoints where one refuses still has rows, and
   * they still look like a whole answer. The caveat is the only thing that
   * says otherwise.
   */
  it("says so when only some of a widget's sources could be read", async () => {
    const twoSource = widgetSpec({
      source: undefined,
      sources: [
        { as: "leases", label: "Leases", connection: "acme", op: "list_leases" },
        { as: "rentals", label: "Rentals", connection: "acme", op: "list_rentals" },
      ],
      combine: { op: "union", as: "series" },
    });
    let calls = 0;
    const evidence = await readWidget({
      candidate,
      widget: board([twoSource]).widgets[0]!,
      resolved,
      read: async () =>
        calls++ === 0
          ? { ok: true as const, body: rows(3), requests: 1, truncated: false }
          : null,
      cacheOnly: false,
      now: 0,
      timeZone: "UTC",
    });
    expect(evidence?.warnings.join(" ")).toContain("returned nothing");
  });

  /*
   * A refusal is not the same as a blank. "Your key works and is not allowed
   * to read this" is actionable; "returned nothing" is not, and folding one
   * into the other loses the only useful half.
   */
  it("carries the API's own reason when a source is refused", async () => {
    const evidence = await readWidget({
      candidate,
      widget: board([widgetSpec()]).widgets[0]!,
      resolved,
      read: async () => ({
        ok: false as const,
        reason: "accepted the key but will not allow access to this endpoint",
      }),
      cacheOnly: false,
      now: 0,
      timeZone: "UTC",
    });
    expect(evidence).not.toBeNull();
    expect(evidence?.refused).toBe(true);
    expect(evidence?.rows).toEqual([]);
    expect(evidence?.warnings.join(" ")).toContain("will not allow access");
  });

  /*
   * The other half of the same line, and the reason `refused` is a flag rather
   * than "no rows and a warning": a cache-only read that missed is a blank,
   * carries no blame, and must stay null so nothing reports it as a refusal.
   */
  it("stays null when every source simply had nothing cached", async () => {
    const evidence = await readWidget({
      candidate,
      widget: board([widgetSpec()]).widgets[0]!,
      resolved,
      read: async () => null,
      cacheOnly: true,
      now: 0,
      timeZone: "UTC",
    });
    expect(evidence).toBeNull();
  });

  it("marks a fan-out it deliberately did not drive", async () => {
    const fanned = widgetSpec({
      source: undefined,
      sources: [
        { as: "leases", label: "Leases", connection: "acme", op: "list_leases" },
        {
          as: "notes",
          label: "Notes",
          connection: "acme",
          op: "list_notes",
          fanOut: { from: "leases", field: "Id", maxRows: 25 },
        },
      ],
      combine: { op: "union", as: "series" },
    });
    const evidence = await run(fanned, rows(3));
    expect(evidence?.warnings.join(" ")).toContain("per-record lookup");
  });
});

describe("readableDates", () => {
  const columns = [
    { name: "Title", semantic: "text" },
    { name: "DueDate", semantic: "timestamp" },
    { name: "Seen", semantic: "relative_time" },
    { name: "Rent", semantic: "currency" },
  ];

  /*
   * The failure: a task due 2026-08-17 reached the model as 1786924800000 and
   * came back as "July 16, 2025". Thirteen-digit arithmetic is not something
   * to ask of a language model when the runtime already knows what the column
   * means.
   */
  it("turns an epoch column into something readable", () => {
    const [row] = readableDates([{ Title: "Dishwasher", DueDate: 1786924800000 }], columns);
    expect(row!.DueDate).toBe("2026-08-17T00:00:00.000Z");
    expect(row!.Title).toBe("Dishwasher");
  });

  it("converts relative_time as well as timestamp", () => {
    const [row] = readableDates([{ Seen: 1786064552000 }], columns);
    expect(row!.Seen).toBe("2026-08-07T01:02:32.000Z");
  });

  it("leaves a number that is not a date alone", () => {
    const [row] = readableDates([{ Rent: 1786924800000 }], columns);
    expect(row!.Rent).toBe(1786924800000);
  });

  it("leaves a date that is already readable alone", () => {
    const [row] = readableDates([{ DueDate: "2026-08-17" }], columns);
    expect(row!.DueDate).toBe("2026-08-17");
  });

  it("leaves nulls and missing fields alone", () => {
    const [row] = readableDates([{ DueDate: null, Title: "x" }], columns);
    expect(row!.DueDate).toBeNull();
  });

  it("does nothing at all when no column is a date", () => {
    const rows = [{ Title: "x" }];
    expect(readableDates(rows, [{ name: "Title", semantic: "text" }])).toEqual(rows);
  });
});

describe("orderedByOf", () => {
  it("names the field a sort really imposed", () => {
    const spec = board([
      widgetSpec({
        pipeline: [
          { op: "extract", path: "$" },
          { op: "sort", by: [{ field: "EndDate", dir: "desc" }] },
        ],
      }),
    ]).widgets[0]!;
    expect(orderedByOf(spec)).toBe("EndDate");
  });

  /*
   * Without this, "the 50 most recent" is a claim about an order nobody
   * imposed — and a date column existing is not the same as rows being in
   * date order.
   */
  it("is null when nothing sorted them", () => {
    expect(orderedByOf(board([widgetSpec()]).widgets[0]!)).toBeNull();
  });

  it("takes the last sort, the way the pipeline does", () => {
    const spec = board([
      widgetSpec({
        pipeline: [
          { op: "extract", path: "$" },
          { op: "sort", by: [{ field: "A", dir: "asc" }] },
          { op: "sort", by: [{ field: "B", dir: "asc" }] },
        ],
      }),
    ]).widgets[0]!;
    expect(orderedByOf(spec)).toBe("B");
  });
});

describe("pipelineCut", () => {
  it("sees a limit that actually cut", () => {
    expect(pipelineCut({ steps: [{ op: "limit", rowsIn: 40, rowsOut: 5 }] })).toBe(true);
  });

  it("ignores a limit that had nothing to cut", () => {
    expect(pipelineCut({ steps: [{ op: "limit", rowsIn: 3, rowsOut: 3 }] })).toBe(false);
  });

  /*
   * A group turning twenty rows into four buckets has hidden nothing, and a
   * filter is the question being asked. Counting either as partial would put a
   * caveat on every chart in the product.
   */
  it("ignores steps that legitimately reduce the row count", () => {
    expect(
      pipelineCut({
        steps: [
          { op: "filter", rowsIn: 40, rowsOut: 12 },
          { op: "group", rowsIn: 12, rowsOut: 4 },
        ],
      }),
    ).toBe(false);
  });

  it("sees a limit inside a named source of a multi-source plan", () => {
    expect(pipelineCut({ steps: [{ op: "leases.limit", rowsIn: 40, rowsOut: 5 }] })).toBe(true);
  });

  it("is false with no meta at all", () => {
    expect(pipelineCut(null)).toBe(false);
  });
});

describe("coverageOf", () => {
  it("counts what was scanned against the cap", () => {
    expect(coverageOf({ total: 120, orderedBy: null })).toMatchObject({
      scanned: PAGE_SIZE,
      of: 120,
      partial: true,
    });
  });
});
