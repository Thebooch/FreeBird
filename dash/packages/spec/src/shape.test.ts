import { describe, expect, it } from "vitest";
import {
  isEmptyShape,
  rolesForShape,
  shapeProblems,
  shapeSteps,
  widgetShapeSchema,
  type WidgetShape,
} from "./shape.js";
import { pipelineSchema } from "./pipeline.js";

/**
 * The shape, and the one thing it exists to make possible.
 *
 * Counting rows is what "how many" means. Every layer above the runtime used
 * to demand a column to aggregate, so a request to count was answered with the
 * sum of whichever number happened to be nearby — a confident, beautiful,
 * wrong answer. These tests pin the opposite.
 */

const shape = (partial: Partial<WidgetShape>): WidgetShape =>
  widgetShapeSchema.parse({ groupBy: [], measures: [], sort: [], ...partial });

describe("widgetShapeSchema", () => {
  it("takes a count with no field", () => {
    const parsed = widgetShapeSchema.safeParse({ measures: [{ as: "count", agg: "count" }] });
    expect(parsed.success).toBe(true);
  });

  it("refuses every other aggregation with no field", () => {
    const parsed = widgetShapeSchema.safeParse({ measures: [{ as: "total", agg: "sum" }] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("only count() may omit one");
  });
});

describe("shapeSteps", () => {
  it("emits nothing at all for an empty shape, so a plain list is untouched", () => {
    expect(shapeSteps(shape({}))).toEqual([]);
    expect(shapeSteps(undefined)).toEqual([]);
    expect(isEmptyShape(shape({}))).toBe(true);
  });

  it("counts rows per bucket — the case that could not be expressed", () => {
    const steps = shapeSteps(
      shape({
        groupBy: [{ field: "CreatedDate", bucket: "1mo", as: "bucket" }],
        measures: [{ as: "count", agg: "count" }],
      }),
    );
    expect(steps).toEqual([
      {
        op: "group",
        by: [{ field: "CreatedDate", bucket: "1mo", as: "bucket" }],
        agg: { count: "count()" },
      },
    ]);
  });

  it("carries the filter, so 'active listings' survives", () => {
    const steps = shapeSteps(shape({ filter: 'Status == "Active"' }));
    expect(steps).toEqual([{ op: "filter", where: 'Status == "Active"' }]);
  });

  it("groups on a constant to total every row, rather than special-casing it", () => {
    const steps = shapeSteps(shape({ measures: [{ as: "total", agg: "sum", field: "Rent" }] }));
    expect(steps).toEqual([
      { op: "derive", fields: { _all: "1" } },
      { op: "group", by: [{ field: "_all" }], agg: { total: "sum(Rent)" } },
    ]);
  });

  it("counts by default when asked to group with nothing to measure", () => {
    const steps = shapeSteps(shape({ groupBy: [{ field: "Status" }] }));
    expect(steps[0]).toMatchObject({ agg: { count: "count()" } });
  });

  it("produces a pipeline the spec accepts", () => {
    const steps = shapeSteps(
      shape({
        filter: "Rent > 0",
        groupBy: [{ field: "CreatedDate", bucket: "{{range.grain}}", as: "bucket" }],
        measures: [{ as: "count", agg: "count" }],
        sort: [{ field: "bucket", dir: "asc" }],
        limit: 100,
      }),
    );
    // The one guarantee that matters: whatever this emits must execute.
    expect(pipelineSchema.safeParse(steps).success).toBe(true);
    expect(steps.map((step) => step.op)).toEqual(["filter", "group", "sort", "limit"]);
  });
});

describe("rolesForShape", () => {
  it("makes a bucketed key the time axis and the measure the value", () => {
    expect(
      rolesForShape(
        shape({
          groupBy: [{ field: "CreatedDate", bucket: "1mo", as: "bucket" }],
          measures: [{ as: "count", agg: "count" }],
        }),
      ),
    ).toEqual({ time: "bucket", value: "count" });
  });

  it("makes an unbucketed key a category", () => {
    expect(
      rolesForShape(
        shape({ groupBy: [{ field: "Status" }], measures: [{ as: "count", agg: "count" }] }),
      ),
    ).toEqual({ category: "Status", value: "count" });
  });

  it("splits on a second key", () => {
    expect(
      rolesForShape(
        shape({
          groupBy: [{ field: "CreatedDate", bucket: "1mo", as: "bucket" }, { field: "Type" }],
          measures: [{ as: "count", agg: "count" }],
        }),
      ),
    ).toMatchObject({ series: "Type" });
  });

  /*
   * When rows have been stacked from several endpoints, which endpoint they
   * came from is the split that matters — that is the whole point of the
   * comparison, and it outranks any grouping inside one side.
   */
  it("prefers the source label over a second key when rows were stacked", () => {
    expect(
      rolesForShape(
        shape({
          groupBy: [{ field: "CreatedDate", bucket: "1mo", as: "bucket" }, { field: "Type" }],
          measures: [{ as: "count", agg: "count" }],
        }),
        "series",
      ),
    ).toMatchObject({ series: "series" });
  });

  it("determines nothing for an empty shape, so the old questions still get asked", () => {
    expect(rolesForShape(shape({}))).toEqual({});
  });
});

describe("shapeProblems", () => {
  const fields = ["CreatedDate", "Status", "Rent"];

  it("passes a shape naming only real fields", () => {
    expect(
      shapeProblems(
        shape({
          groupBy: [{ field: "CreatedDate", bucket: "1mo", as: "bucket" }],
          measures: [{ as: "count", agg: "count" }],
          sort: [{ field: "bucket", dir: "asc" }],
        }),
        fields,
      ),
    ).toEqual([]);
  });

  it("names an invented field rather than approximating it", () => {
    const problems = shapeProblems(shape({ groupBy: [{ field: "Invented" }] }), fields);
    expect(problems.join(" ")).toContain('"Invented" is not a field');
  });

  it("refuses a filter that does not parse", () => {
    expect(shapeProblems(shape({ filter: "Status ===" }), fields).join(" ")).toContain(
      "does not parse",
    );
  });

  /* Sorting by the bucket or the measure is the ordinary case, and neither
     exists on the raw rows — so the produced columns are in scope. */
  it("accepts a sort on something the shape itself produces", () => {
    expect(
      shapeProblems(
        shape({
          groupBy: [{ field: "Status" }],
          measures: [{ as: "count", agg: "count" }],
          sort: [{ field: "count", dir: "desc" }],
        }),
        fields,
      ),
    ).toEqual([]);
  });
});
