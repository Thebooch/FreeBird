import type { WidgetSpec } from "@freebirdai/dash-spec";
import { parseWidget, resolveRange } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { compileWidget } from "./compile.js";
import { executeWidget } from "./execute.js";
import { runPipeline } from "./run.js";
import { chargesPayload, ctx, day, revenueWidget } from "./testFixtures.js";
import type { Row, RunContext } from "./types.js";

const compiled = (spec: WidgetSpec) => {
  const result = compileWidget(spec);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("; "));
  return result.widget;
};

const widget = (overrides: Record<string, unknown>): WidgetSpec => {
  const parsed = parseWidget({
    id: "w",
    title: "W",
    component: "table",
    source: { connection: "c", op: "o" },
    roles: {},
    ...overrides,
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value!;
};

const run = (spec: WidgetSpec, body: unknown, context: RunContext = ctx()) =>
  runPipeline(compiled(spec), body, context);

describe("golden: revenue by day from a payments payload", () => {
  it("produces exactly the expected rows", () => {
    const result = run(revenueWidget, chargesPayload);

    expect(result.rows).toEqual([
      { created: day(1), revenue: 58, orders: 2 },
      { created: day(4), revenue: 29, orders: 2 },
    ]);
  });

  it("traces every step for the inspector", () => {
    const result = run(revenueWidget, chargesPayload);

    expect(result.meta.steps.map((step) => [step.op, step.rowsIn, step.rowsOut])).toEqual([
      ["extract", 1, 5],
      ["coerce", 5, 5],
      ["filter", 5, 4],
      ["derive", 4, 4],
      ["group", 4, 2],
      ["sort", 2, 2],
    ]);
    expect(result.meta.steps[0]?.note).toBe("$.data[*]");
    expect(result.meta.coercionFailures).toBe(0);
    expect(result.meta.warnings).toEqual([]);
  });

  it("carries semantics through coercion and aggregation", () => {
    const byName = new Map(run(revenueWidget, chargesPayload).columns.map((c) => [c.name, c]));

    expect(byName.get("created")).toMatchObject({ valueType: "temporal", semantic: "timestamp" });
    expect(byName.get("revenue")).toMatchObject({ valueType: "numeric", semantic: "currency" });
    expect(byName.get("orders")).toMatchObject({ valueType: "numeric", semantic: "count" });
  });

  it("follows the dashboard grain", () => {
    const monthly = run(revenueWidget, chargesPayload, ctx("1mo"));
    expect(monthly.rows).toEqual([{ created: Date.UTC(2026, 7, 1), revenue: 87, orders: 4 }]);
  });

  it("is deterministic", () => {
    const a = run(revenueWidget, chargesPayload);
    const b = run(revenueWidget, chargesPayload);
    expect(a.rows).toEqual(b.rows);
    expect(a.columns).toEqual(b.columns);
    expect(a.meta).toEqual(b.meta);
  });
});

describe("extract", () => {
  it("wraps primitive rows so they stay addressable", () => {
    const spec = widget({ pipeline: [{ op: "extract", path: "$.values[*]" }] });
    expect(run(spec, { values: [1, 2, 3] }).rows).toEqual([
      { value: 1 },
      { value: 2 },
      { value: 3 },
    ]);
  });

  it("yields no rows when the path matches nothing", () => {
    const spec = widget({ pipeline: [{ op: "extract", path: "$.missing[*]" }] });
    const result = run(spec, { data: [1] });
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
  });

  it("treats a bare array payload as the row set with no extract step", () => {
    const spec = widget({ pipeline: [] });
    expect(run(spec, [{ a: 1 }, { a: 2 }]).rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("caps runaway row counts and says so", () => {
    const spec = widget({ pipeline: [{ op: "extract", path: "$[*]" }] });
    const big = Array.from({ length: 100 }, (_, i) => ({ i }));
    const result = runPipeline(compiled(spec), big, { ...ctx(), maxRows: 10 });
    expect(result.rows).toHaveLength(10);
    expect(result.meta.warnings[0]).toMatch(/kept the first 10/);
  });
});

describe("coerce", () => {
  it("counts values it could not coerce instead of hiding them", () => {
    const spec = widget({
      pipeline: [
        { op: "extract", path: "$[*]" },
        { op: "coerce", fields: { n: "->number" } },
      ],
    });
    const result = run(spec, [{ n: "12" }, { n: "junk" }, { n: null }]);

    expect(result.rows).toEqual([{ n: 12 }, { n: null }, { n: null }]);
    // null in, null out is not a failure; "junk" in, null out is.
    expect(result.meta.coercionFailures).toBe(1);
    expect(result.meta.warnings[0]).toMatch(/1 value\(s\) could not be coerced/);
  });
});

describe("filter and derive", () => {
  it("interpolates params into a filter expression", () => {
    const spec = widget({
      pipeline: [
        { op: "extract", path: "$[*]" },
        { op: "filter", where: "created >= {{range.start}}" },
      ],
    });
    const context: RunContext = {
      now: day(6),
      params: {
        range: resolveRange({ preset: "custom", now: day(6), custom: { start: day(3), end: day(6) } }),
        filters: {},
      },
    };
    const rows = [{ created: day(1) }, { created: day(4) }, { created: day(5) }];
    expect(run(spec, rows, context).rows).toEqual([{ created: day(4) }, { created: day(5) }]);
  });

  it("evaluates every derived field against the row as it was, not in key order", () => {
    const spec = widget({
      pipeline: [
        { op: "extract", path: "$[*]" },
        { op: "derive", fields: { b: "a * 2", a: "100" } },
      ],
    });
    // `b` sees the original a=5, never the a=100 written by the same step.
    expect(run(spec, [{ a: 5 }]).rows).toEqual([{ a: 100, b: 10 }]);
  });

  it("keeps a row whose expression cannot be evaluated out of the result rather than crashing", () => {
    const spec = widget({
      pipeline: [
        { op: "extract", path: "$[*]" },
        { op: "filter", where: "amount > 10" },
      ],
    });
    expect(run(spec, [{ amount: 20 }, { amount: null }, {}, { amount: "x" }]).rows).toEqual([
      { amount: 20 },
    ]);
  });
});

describe("group", () => {
  const rows = [
    { region: "emea", amount: 10, customer: "a" },
    { region: "emea", amount: 30, customer: "b" },
    { region: "emea", amount: null, customer: "a" },
    { region: "amer", amount: 5, customer: "c" },
  ];

  const grouped = (agg: Record<string, string>) =>
    run(
      widget({
        pipeline: [
          { op: "extract", path: "$[*]" },
          { op: "group", by: [{ field: "region" }], agg },
        ],
      }),
      rows,
    ).rows;

  it("computes every aggregation", () => {
    expect(grouped({ v: "sum(amount)" })).toEqual([
      { region: "amer", v: 5 },
      { region: "emea", v: 40 },
    ]);
    expect(grouped({ v: "avg(amount)" })).toEqual([
      { region: "amer", v: 5 },
      { region: "emea", v: 20 },
    ]);
    expect(grouped({ v: "min(amount)" })[1]).toEqual({ region: "emea", v: 10 });
    expect(grouped({ v: "max(amount)" })[1]).toEqual({ region: "emea", v: 30 });
    expect(grouped({ v: "first(customer)" })[1]).toEqual({ region: "emea", v: "a" });
    expect(grouped({ v: "last(customer)" })[1]).toEqual({ region: "emea", v: "a" });
  });

  it("counts rows, but counts only non-empty values for a named field", () => {
    expect(grouped({ v: "count()" })[1]).toEqual({ region: "emea", v: 3 });
    expect(grouped({ v: "count(amount)" })[1]).toEqual({ region: "emea", v: 2 });
    expect(grouped({ v: "countDistinct(customer)" })[1]).toEqual({ region: "emea", v: 2 });
  });

  it("orders output by its key so a series never comes back in hash order", () => {
    expect(grouped({ v: "count()" }).map((row) => row.region)).toEqual(["amer", "emea"]);
  });

  it("renames a key with `as`", () => {
    const result = run(
      widget({
        pipeline: [
          { op: "extract", path: "$[*]" },
          { op: "group", by: [{ field: "region", as: "market" }], agg: { n: "count()" } },
        ],
      }),
      rows,
    );
    expect(result.rows[0]).toEqual({ market: "amer", n: 1 });
  });

  it("fills empty buckets so a gap reads as a gap", () => {
    const spec = widget({
      pipeline: [
        { op: "extract", path: "$.data[*]" },
        { op: "coerce", fields: { created: "unix_s->datetime", amount: "money:cents->major" } },
        { op: "filter", where: "status == 'succeeded'" },
        {
          op: "group",
          by: [{ field: "created", bucket: "1d" }],
          agg: { revenue: "sum(amount)", orders: "count()" },
          fillGaps: true,
        },
      ],
    });
    expect(run(spec, chargesPayload).rows).toEqual([
      { created: day(1), revenue: 60, orders: 2 },
      { created: day(2), revenue: 0, orders: 0 },
      { created: day(3), revenue: 0, orders: 0 },
      { created: day(4), revenue: 30, orders: 2 },
    ]);
  });

  it("warns instead of guessing when fillGaps cannot apply", () => {
    const spec = widget({
      pipeline: [
        { op: "extract", path: "$[*]" },
        { op: "group", by: [{ field: "region" }], agg: { n: "count()" }, fillGaps: true },
      ],
    });
    expect(run(spec, rows).meta.warnings[0]).toMatch(/fillGaps needs exactly one bucketed/);
  });

  it("warns when a bucket grain cannot be resolved", () => {
    const spec = widget({
      pipeline: [
        { op: "extract", path: "$[*]" },
        { op: "group", by: [{ field: "created", bucket: "{{param.grain}}" }], agg: { n: "count()" } },
      ],
    });
    expect(run(spec, [{ created: day(1) }]).meta.warnings[0]).toMatch(/is not a grain/);
  });
});

describe("sort, limit, rename, select", () => {
  const rows = [{ n: 3 }, { n: null }, { n: 1 }, { n: 2 }];

  const sorted = (dir: "asc" | "desc") =>
    run(
      widget({
        pipeline: [
          { op: "extract", path: "$[*]" },
          { op: "sort", by: [{ field: "n", dir }] },
        ],
      }),
      rows,
    ).rows.map((row) => row.n);

  it("keeps empty values at the end in both directions", () => {
    expect(sorted("asc")).toEqual([1, 2, 3, null]);
    expect(sorted("desc")).toEqual([3, 2, 1, null]);
  });

  it("limits from either end", () => {
    const limited = (from: "start" | "end") =>
      run(
        widget({
          pipeline: [
            { op: "extract", path: "$[*]" },
            { op: "limit", count: 2, from },
          ],
        }),
        [{ n: 1 }, { n: 2 }, { n: 3 }],
      ).rows;
    expect(limited("start")).toEqual([{ n: 1 }, { n: 2 }]);
    expect(limited("end")).toEqual([{ n: 2 }, { n: 3 }]);
  });

  it("renames and carries the semantic with the name", () => {
    const result = run(
      widget({
        pipeline: [
          { op: "extract", path: "$[*]" },
          { op: "coerce", fields: { t: "unix_s->datetime" } },
          { op: "rename", fields: { t: "when" } },
        ],
      }),
      [{ t: 1_700_000_000 }],
    );
    expect(result.rows).toEqual([{ when: 1_700_000_000_000 }]);
    expect(result.columns[0]).toMatchObject({ name: "when", semantic: "timestamp" });
  });

  it("selects a subset, filling absent fields with null", () => {
    const result = run(
      widget({
        pipeline: [
          { op: "extract", path: "$[*]" },
          { op: "select", fields: ["a", "missing"] },
        ],
      }),
      [{ a: 1, b: 2 }],
    );
    expect(result.rows).toEqual([{ a: 1, missing: null }]);
  });

  it("annotate pins a semantic without touching the rows", () => {
    const result = run(
      widget({
        pipeline: [
          { op: "extract", path: "$[*]" },
          { op: "annotate", fields: { code: "status_enum" } },
        ],
      }),
      [{ code: "200" }],
    );
    expect(result.rows).toEqual([{ code: "200" }]);
    expect(result.columns[0]).toMatchObject({ semantic: "status_enum", valueType: "categorical" });
  });
});

describe("column inference", () => {
  const columnsFor = (rows: Row[]) =>
    run(widget({ pipeline: [{ op: "extract", path: "$[*]" }] }), rows).columns;

  it("counts nulls and distinct values", () => {
    const [column] = columnsFor([{ s: "a" }, { s: "b" }, { s: "a" }, { s: null }]);
    expect(column).toMatchObject({ name: "s", nullCount: 1, distinctCount: 2 });
  });

  it("separates a closed set of strings from free text", () => {
    const closed = columnsFor([{ s: "ok" }, { s: "fail" }, { s: "ok" }, { s: "ok" }])[0];
    expect(closed?.valueType).toBe("categorical");

    const free = columnsFor(
      Array.from({ length: 10 }, (_, i) => ({ s: `unique note number ${i}` })),
    )[0];
    expect(free?.valueType).toBe("text");
  });

  it("reports mixed types as unknown rather than picking one", () => {
    expect(columnsFor([{ v: 1 }, { v: "two" }])[0]?.valueType).toBe("unknown");
  });

  it("keeps first-seen column order", () => {
    expect(columnsFor([{ b: 1 }, { a: 2, c: 3 }]).map((c) => c.name)).toEqual(["b", "a", "c"]);
  });
});

describe("executeWidget", () => {
  it("returns rows and a valid binding for a good widget", () => {
    const result = executeWidget(revenueWidget, chargesPayload, ctx());
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.binding?.errors).toEqual([]);
  });

  it("rejects a binding the pipeline cannot satisfy", () => {
    const broken = { ...revenueWidget, roles: { time: "created", value: "nonexistent" } };
    const result = executeWidget(broken, chargesPayload, ctx());
    expect(result.ok).toBe(false);
    expect(result.binding?.errors[0]?.message).toMatch(/does not produce/);
  });

  it("rejects a numeric role bound to a categorical column", () => {
    const spec = widget({
      component: "stat",
      pipeline: [{ op: "extract", path: "$.data[*]" }],
      roles: { value: "status" },
    });
    const result = executeWidget(spec, chargesPayload, ctx());
    expect(result.ok).toBe(false);
    expect(result.binding?.errors[0]?.message).toMatch(/needs numeric/);
  });

  it("reports compile errors without throwing", () => {
    const result = executeWidget(
      { ...revenueWidget, pipeline: [{ op: "extract", path: "not a path" }] } as WidgetSpec,
      chargesPayload,
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/step 0:.*must start with "\$"/);
  });

  it("handles an empty payload without crashing", () => {
    const result = executeWidget(revenueWidget, { object: "list", data: [] }, ctx());
    expect(result.rows).toEqual([]);
    expect(result.meta?.rowsOut).toBe(0);
    // No columns means the binding cannot be satisfied — that is honest, and
    // the React layer shows the widget's empty state rather than an error.
    expect(result.ok).toBe(false);
  });
});

describe("highlights", () => {
  const rows = [
    { id: 1, status: "overdue", amount: 100 },
    { id: 2, status: "paid", amount: 50 },
    { id: 3, status: "overdue", amount: 20 },
  ];

  const withHighlights = (highlights: unknown[]) =>
    widget({
      pipeline: [{ op: "extract", path: "$" }],
      roles: { columns: ["id", "status"] },
      highlights,
    });

  it("marks the rows that match, index-parallel to the rows", () => {
    const result = run(
      withHighlights([
        { id: "late", when: 'status == "overdue"', tone: "serious", label: "Overdue" },
      ]),
      rows,
    );
    expect(result.highlights?.map((hits) => hits.length)).toEqual([1, 0, 1]);
    expect(result.highlights?.[0]?.[0]).toMatchObject({ tone: "serious", label: "Overdue" });
  });

  it("lets two rules land on the same row", () => {
    const result = run(
      withHighlights([
        { id: "late", when: 'status == "overdue"', tone: "serious", label: "Overdue" },
        { id: "big", when: "amount > 60", tone: "warning", label: "Large" },
      ]),
      rows,
    );
    expect(result.highlights?.[0]?.map((hit) => hit.id).sort()).toEqual(["big", "late"]);
  });

  /*
   * The silent-failure case. `evalPredicate` returns false for a column that
   * does not exist rather than throwing, so a typo just never lights up.
   */
  it("counts a rule that matched nothing rather than hiding it", () => {
    const result = run(
      withHighlights([{ id: "typo", when: "statuz == 1", tone: "good", label: "Nope" }]),
      rows,
    );
    expect(result.meta.highlightCounts).toEqual({ typo: 0 });
    expect(result.meta.steps.at(-1)?.note).toContain("0 of 3");
  });

  it("sees the columns as they are rendered, after a rename", () => {
    const result = run(
      widget({
        pipeline: [
          { op: "extract", path: "$" },
          { op: "rename", fields: { status: "state" } },
        ],
        roles: { columns: ["state"] },
        highlights: [{ id: "late", when: 'state == "overdue"', tone: "serious", label: "Late" }],
      }),
      rows,
    );
    // Evaluating inside the pipeline would have seen `status`, not `state`.
    expect(result.meta.highlightCounts).toEqual({ late: 2 });
  });

  it("adds nothing at all when a widget declares none", () => {
    const result = run(widget({ pipeline: [{ op: "extract", path: "$" }] }), rows);
    expect(result.highlights).toBeUndefined();
    expect(result.meta.highlightCounts).toBeUndefined();
    // No phantom step in the inspector for a feature nobody used.
    expect(result.meta.steps.some((step) => step.op === "highlight")).toBe(false);
  });

  it("survives a select that drops the column it looked at", () => {
    const result = run(
      widget({
        pipeline: [
          { op: "extract", path: "$" },
          { op: "select", fields: ["id"] },
        ],
        roles: { columns: ["id"] },
        highlights: [{ id: "late", when: 'status == "overdue"', tone: "serious", label: "Late" }],
      }),
      rows,
    );
    // Nothing matches, and it says so, rather than throwing.
    expect(result.meta.highlightCounts).toEqual({ late: 0 });
  });
});
