import { describe, expect, it } from "vitest";
import { parseAggregation } from "./aggregation.js";
import { connectionSchema, getOp } from "./connection.js";
import { COMPONENT_CONTRACTS, type ColumnMeta, validateBinding } from "./contracts.js";
import { parseDashboard, parseDuration, parseWidget } from "./dashboard.js";
import {
  type ResolvedParams,
  defaultGrainFor,
  interpolate,
  parseTokens,
  resolveRange,
} from "./params.js";
import { pipelineSchema } from "./pipeline.js";

describe("parseAggregation", () => {
  it("parses the supported forms", () => {
    expect(parseAggregation("sum(net)")).toEqual({ fn: "sum", field: "net" });
    expect(parseAggregation("count()")).toEqual({ fn: "count", field: null });
    expect(parseAggregation("countDistinct(customer_id)")).toEqual({
      fn: "countDistinct",
      field: "customer_id",
    });
    expect(parseAggregation("  avg( amount ) ")).toEqual({ fn: "avg", field: "amount" });
  });

  it("rejects anything else", () => {
    for (const source of ["sum", "sum(", "median(x)", "sum(x) + 1", "eval(x)", "sum(x,y)"]) {
      expect(parseAggregation(source), source).toBeNull();
    }
  });

  it("requires a field for everything but count", () => {
    expect(parseAggregation("sum()")).toBeNull();
  });
});

describe("parseDuration", () => {
  it("parses the supported units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  it("rejects unparseable durations", () => {
    for (const source of ["5", "5 minutes", "1w", ""]) {
      expect(parseDuration(source), source).toBeNull();
    }
  });
});

describe("params", () => {
  const NOW = Date.UTC(2026, 7, 4, 12, 0);

  it("resolves presets against an injected clock", () => {
    const range = resolveRange({ preset: "7d", now: NOW });
    expect(range.end).toBe(NOW);
    expect(range.start).toBe(NOW - 7 * 86_400_000);
    expect(range.grain).toBe("1d");
  });

  it("resolves ytd from the start of the calendar year", () => {
    expect(resolveRange({ preset: "ytd", now: NOW }).start).toBe(Date.UTC(2026, 0, 1));
  });

  it("requires explicit bounds for a custom range", () => {
    expect(() => resolveRange({ preset: "custom", now: NOW })).toThrow(/custom/);
  });

  it("picks a grain that yields a readable number of buckets", () => {
    expect(defaultGrainFor(NOW - 86_400_000, NOW)).toBe("1h");
    expect(defaultGrainFor(NOW - 30 * 86_400_000, NOW)).toBe("1d");
    expect(defaultGrainFor(NOW - 200 * 86_400_000, NOW)).toBe("1w");
    expect(defaultGrainFor(NOW - 1000 * 86_400_000, NOW)).toBe("1mo");
  });

  const params: ResolvedParams = {
    range: resolveRange({ preset: "30d", now: NOW }),
    filters: { region: "emea", minimum: 10 },
  };

  it("interpolates range and filter tokens", () => {
    expect(interpolate("{{range.grain}}", params)).toBe("1d");
    expect(interpolate("{{param.region}}", params)).toBe("emea");
    expect(interpolate("min={{param.minimum}}", params)).toBe("min=10");
  });

  it("applies token filters", () => {
    expect(interpolate("{{range.start | unix}}", params)).toBe(
      String(Math.floor(params.range.start / 1000)),
    );
    expect(interpolate("{{range.start | date}}", params)).toBe("2026-07-05");
    expect(interpolate("{{range.end | iso}}", params)).toBe(new Date(NOW).toISOString());
  });

  it("resolves an unknown token to an empty string, never a dangling brace", () => {
    expect(interpolate("x={{param.nope}}", params)).toBe("x=");
  });

  it("reports the tokens in a string", () => {
    expect(parseTokens("{{range.start | unix}}/{{param.region}}")).toEqual([
      { raw: "{{range.start | unix}}", key: "range.start", filter: "unix" },
      { raw: "{{param.region}}", key: "param.region", filter: null },
    ]);
  });
});

describe("validateBinding", () => {
  const columns: ColumnMeta[] = [
    { name: "created", valueType: "temporal", semantic: "timestamp" },
    { name: "revenue", valueType: "numeric", semantic: "currency" },
    { name: "status", valueType: "categorical", semantic: "status_enum", distinctCount: 3 },
    { name: "note", valueType: "text" },
  ];

  it("accepts a well-formed binding", () => {
    const result = validateBinding(
      COMPONENT_CONTRACTS.timeseries,
      { time: "created", value: "revenue" },
      columns,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a missing required role", () => {
    const result = validateBinding(COMPONENT_CONTRACTS.timeseries, { time: "created" }, columns);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toMatch(/"value" is required/);
  });

  it("rejects a role pointing at a column the pipeline does not produce", () => {
    const result = validateBinding(
      COMPONENT_CONTRACTS.stat,
      { value: "nonexistent" },
      columns,
    );
    expect(result.errors[0]?.message).toMatch(/does not produce/);
  });

  it("rejects a type mismatch", () => {
    const result = validateBinding(COMPONENT_CONTRACTS.stat, { value: "note" }, columns);
    expect(result.errors[0]?.message).toMatch(/needs numeric, but "note" is text/);
  });

  it("rejects an unknown role name", () => {
    const result = validateBinding(
      COMPONENT_CONTRACTS.stat,
      { value: "revenue", nonsense: "note" },
      columns,
    );
    expect(result.errors[0]?.message).toMatch(/has no role "nonsense"/);
  });

  it("warns rather than errors on excessive cardinality", () => {
    const wide: ColumnMeta[] = [
      ...columns,
      { name: "country", valueType: "categorical", distinctCount: 180 },
    ];
    const result = validateBinding(
      COMPONENT_CONTRACTS.timeseries,
      { time: "created", value: "revenue", series: "country" },
      wide,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings[0]?.message).toMatch(/180 distinct values/);
  });

  it("warns about columns that are empty in some rows", () => {
    const ragged: ColumnMeta[] = [
      { name: "created", valueType: "temporal" },
      { name: "revenue", valueType: "numeric", nullCount: 4 },
    ];
    const result = validateBinding(
      COMPONENT_CONTRACTS.timeseries,
      { time: "created", value: "revenue" },
      ragged,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /empty in 4 row/.test(w.message))).toBe(true);
  });

  it("accepts a list of columns only for a multi role", () => {
    expect(
      validateBinding(COMPONENT_CONTRACTS.table, { columns: ["created", "revenue"] }, columns).ok,
    ).toBe(true);
    expect(
      validateBinding(COMPONENT_CONTRACTS.stat, { value: ["revenue", "created"] }, columns)
        .errors[0]?.message,
    ).toMatch(/takes a single column/);
  });

  it("checks every shipped contract has a required role and grid variants", () => {
    for (const contract of Object.values(COMPONENT_CONTRACTS)) {
      expect(contract.roles.some((role) => role.required), contract.id).toBe(true);
      expect(contract.grid.sizes.length, contract.id).toBeGreaterThan(0);
      const names = contract.grid.sizes.map((size) => size.name);
      if (contract.grid.preferredSize) expect(names).toContain(contract.grid.preferredSize);
      if (contract.grid.minSize) expect(names).toContain(contract.grid.minSize);
    }
  });
});

describe("pipeline validation", () => {
  it("accepts a realistic pipeline", () => {
    const result = pipelineSchema.safeParse([
      { op: "extract", path: "$.data[*]" },
      { op: "coerce", fields: { created: "unix_s->datetime", amount: "money:cents->major" } },
      { op: "filter", where: "status == 'succeeded'" },
      { op: "derive", fields: { net: "amount - coalesce(fee, 0)" } },
      {
        op: "group",
        by: [{ field: "created", bucket: "{{range.grain}}" }],
        agg: { revenue: "sum(net)", orders: "count()" },
      },
      { op: "sort", by: [{ field: "created", dir: "asc" }] },
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects a malformed path at spec-validation time", () => {
    const result = pipelineSchema.safeParse([{ op: "extract", path: "data[*]" }]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/must start with "\$"/);
  });

  it("rejects an unparseable filter expression", () => {
    const result = pipelineSchema.safeParse([{ op: "filter", where: "status ==" }]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/ended unexpectedly/);
  });

  it("rejects an expression that reaches for a prototype", () => {
    const result = pipelineSchema.safeParse([
      { op: "derive", fields: { x: "row.constructor" } },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/not a readable property/);
  });

  it("accepts params inside expressions", () => {
    const result = pipelineSchema.safeParse([
      { op: "filter", where: "created >= {{range.start}}" },
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects a bad aggregation with the offending text", () => {
    const result = pipelineSchema.safeParse([
      { op: "group", by: [{ field: "day" }], agg: { x: "median(v)" } },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/"median\(v\)" is not an aggregation/);
  });

  it("requires extract to come first and only once", () => {
    expect(
      pipelineSchema.safeParse([
        { op: "filter", where: "a == 1" },
        { op: "extract", path: "$.data" },
      ]).success,
    ).toBe(false);
    expect(
      pipelineSchema.safeParse([
        { op: "extract", path: "$.a" },
        { op: "extract", path: "$.b" },
      ]).success,
    ).toBe(false);
  });
});

describe("connection spec", () => {
  it("defaults to a safe, read-only, unpaginated op", () => {
    const result = connectionSchema.safeParse({
      id: "github",
      title: "GitHub",
      kind: "rest",
      baseUrl: "https://api.github.com",
      ops: [{ id: "issues", title: "Issues", path: "/repos/{{param.repo}}/issues" }],
    });
    expect(result.success).toBe(true);
    // The stored definition is lean; defaults appear once it is resolved.
    const op = getOp(result.data!, "issues");
    expect(op?.method).toBe("GET");
    expect(op?.pagination).toEqual({ kind: "none" });
    expect(op?.maxPages).toBe(5);
  });

  it("refuses a non-GET method — v1 is read-only by construction", () => {
    const result = connectionSchema.safeParse({
      id: "x",
      title: "X",
      kind: "rest",
      baseUrl: "https://api.example.com",
      ops: [{ id: "o", title: "O", path: "/p", method: "POST" }],
    });
    expect(result.success).toBe(false);
  });

  it("never carries a secret — only a vault reference", () => {
    const result = connectionSchema.safeParse({
      id: "stripe",
      title: "Stripe",
      kind: "rest",
      baseUrl: "https://api.stripe.com",
      auth: { type: "bearer", keyRef: "stripe-key" },
    });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).not.toMatch(/sk_live|secret/);
  });
});

describe("parseWidget / parseDashboard", () => {
  const widget = {
    id: "revenue_trend",
    title: "Revenue",
    component: "timeseries",
    source: { connection: "stripe", op: "charges" },
    pipeline: [
      { op: "extract", path: "$.data[*]" },
      { op: "coerce", fields: { created: "unix_s->datetime", amount: "money:cents->major" } },
      {
        op: "group",
        by: [{ field: "created", bucket: "{{range.grain}}" }],
        agg: { revenue: "sum(amount)" },
      },
    ],
    roles: { time: "created", value: "revenue" },
    format: { revenue: { semantic: "currency", currency: "USD" } },
  };

  it("applies defaults for the optional half of a widget", () => {
    const result = parseWidget(widget);
    expect(result.ok).toBe(true);
    expect(result.value?.refresh.staleAfter).toBe("15m");
    expect(result.value?.confirmed).toEqual([]);
    expect(result.value?.states).toEqual({});
  });

  it("returns flat, readable errors for the agent repair loop", () => {
    const result = parseWidget({ ...widget, component: "9 not an id" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/^component:/);
  });

  it("accepts a component id it has never heard of", () => {
    /*
     * Component ids are open names. Rejecting an unknown one at parse time
     * would make the eight shipped components the only ones that could ever
     * exist, no matter what a registry offered later. Whether the name
     * resolves to something renderable is a separate question, answered at
     * execution with a message naming the id.
     */
    expect(parseWidget({ ...widget, component: "piechart" }).ok).toBe(true);
  });

  it("still rejects an id that is not a usable name", () => {
    expect(parseWidget({ ...widget, component: "" }).ok).toBe(false);
    expect(parseWidget({ ...widget, component: "has spaces" }).ok).toBe(false);
  });

  it("rejects a layout cell that references an unknown widget", () => {
    const result = parseDashboard({
      id: "d",
      title: "D",
      widgets: [widget],
      layout: { cells: [{ widgetId: "ghost", x: 0, y: 0, w: 6, h: 5 }] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/references unknown widget "ghost"/);
  });

  it("rejects a cell that runs past the grid", () => {
    const result = parseDashboard({
      id: "d",
      title: "D",
      widgets: [widget],
      layout: { cells: [{ widgetId: "revenue_trend", x: 8, y: 0, w: 6, h: 5 }] },
    });
    expect(result.errors.join()).toMatch(/runs past the grid/);
  });

  it("rejects duplicate widget ids", () => {
    const result = parseDashboard({ id: "d", title: "D", widgets: [widget, widget] });
    expect(result.errors.join()).toMatch(/duplicate widget id/);
  });

  it("catches a param token with no matching filter declaration", () => {
    const result = parseDashboard({
      id: "d",
      title: "D",
      widgets: [
        {
          ...widget,
          source: { connection: "stripe", op: "charges", params: { region: "{{param.region}}" } },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/\{\{param\.region\}\} is used but no filter declares/);
  });

  it("accepts that token once the filter is declared", () => {
    const result = parseDashboard({
      id: "d",
      title: "D",
      params: { filters: [{ key: "region", label: "Region", type: "text" }] },
      widgets: [
        {
          ...widget,
          source: { connection: "stripe", op: "charges", params: { region: "{{param.region}}" } },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("row scope for drill-down", () => {
  const base = {
    range: { start: 0, end: 1, grain: "1d" as const, preset: "30d" as const },
    filters: {},
  };

  it("resolves {{row.field}} from the row a drill-down was opened on", () => {
    expect(interpolate("/v1/leases/{{row.Id}}", { ...base, row: { Id: 4127 } })).toBe(
      "/v1/leases/4127",
    );
  });

  it("resolves to nothing when no row is in scope", () => {
    // An ordinary widget writing {{row.x}} must not borrow a value from
    // somewhere else — it gets an empty string, same as any unknown token.
    expect(interpolate("/v1/leases/{{row.Id}}", base)).toBe("/v1/leases/");
  });

  it("keeps the row scope separate from dashboard filters", () => {
    const params = { ...base, filters: { Id: "from-filter" }, row: { Id: "from-row" } };
    expect(interpolate("{{param.Id}}|{{row.Id}}", params)).toBe("from-filter|from-row");
  });
});

describe("dashboard validation of drill-down tokens", () => {
  const dashboard = (drilldown: unknown) => ({
    id: "d",
    title: "D",
    params: { filters: [] },
    widgets: [
      {
        id: "w",
        title: "W",
        component: "table",
        source: { connection: "c", op: "list" },
        roles: { columns: ["a"] },
        drilldown,
      },
    ],
    layout: { cells: [{ widgetId: "w", x: 0, y: 0, w: 6, h: 4 }] },
  });

  it("accepts {{row.*}}, which is row-scoped rather than dashboard-declared", () => {
    const result = parseDashboard(
      dashboard({ op: "detail", params: { leaseId: "{{row.Id}}" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("still rejects a {{param.*}} no filter declares, even inside a drill-down", () => {
    const result = parseDashboard(
      dashboard({ op: "detail", params: { leaseId: "{{param.nosuch}}" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/no filter declares "nosuch"/);
  });
});

describe("highlights", () => {
  const widget = (highlights: unknown[]) =>
    parseWidget({
      id: "w",
      title: "W",
      component: "table",
      source: { connection: "c", op: "o" },
      pipeline: [{ op: "extract", path: "$" }],
      roles: { columns: ["a"] },
      highlights,
    });

  it("accepts a predicate in the same language as a filter", () => {
    const parsed = widget([
      { id: "listed", when: "isListed == true", tone: "good", label: "Listed" },
    ]);
    expect(parsed.ok).toBe(true);
    // Row scope by default: the common case is "this record needs a look".
    expect(parsed.value?.highlights[0]?.scope).toBe("row");
  });

  it("rejects a predicate that does not parse, with the parser's own words", () => {
    const parsed = widget([{ id: "bad", when: "status ==", tone: "good", label: "X" }]);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(" ")).toMatch(/highlights/);
  });

  it("refuses colour as the only channel", () => {
    // A label is not decoration: a reader who cannot tell the colours apart,
    // or is printing, gets nothing else.
    const parsed = widget([{ id: "x", when: "a == 1", tone: "critical", label: "" }]);
    expect(parsed.ok).toBe(false);
  });

  it("refuses a field-scoped highlight with no field to mark", () => {
    const parsed = widget([
      { id: "x", when: "a == 1", tone: "warning", label: "Late", scope: "field" },
    ]);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(" ")).toMatch(/needs a field/);
  });

  it("holds a param inside a condition to the declared-filter rule", () => {
    const dashboard = parseDashboard({
      id: "d",
      title: "D",
      params: { defaultRange: "30d", timeZone: "UTC", filters: [] },
      widgets: [
        {
          id: "w",
          title: "W",
          component: "table",
          source: { connection: "c", op: "o" },
          pipeline: [{ op: "extract", path: "$" }],
          roles: { columns: ["a"] },
          highlights: [
            { id: "x", when: "region == {{param.region}}", tone: "good", label: "Mine" },
          ],
        },
      ],
    });
    // `region` was never declared as a dashboard filter.
    expect(dashboard.ok).toBe(false);
  });

  it("defaults to none, so every stored widget still parses", () => {
    const parsed = parseWidget({
      id: "w",
      title: "W",
      component: "table",
      source: { connection: "c", op: "o" },
      pipeline: [{ op: "extract", path: "$" }],
      roles: { columns: ["a"] },
    });
    expect(parsed.value?.highlights).toEqual([]);
  });
});
