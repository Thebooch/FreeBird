import type { ConnectionSpec, DashboardSpec, EntityLinkView } from "@freebirdai/dash-spec";
import { connectionSchema, dashboardSchema, getOp, resolveRange } from "@freebirdai/dash-spec";
import { AdapterError } from "@freebirdai/dash-adapters";
import { describe, expect, it } from "vitest";
import { QueryCache } from "../cache/queryCache.js";
import { buildQueryRequest } from "../query.js";
import { FAILURE_BACKOFF_MS, Keeper, LastSeen, retryAfterMs, type RefreshOutcome } from "./keeper.js";
import { WIDGET_EVERY_FLOOR_MS, boardParams, warmTargets, type WarmTarget } from "./targets.js";
import { ViewedRequests, paramShape, type ViewedRequest } from "./viewed.js";

/**
 * Warming the cache before anybody looks, and keeping it warm afterwards.
 *
 * The behaviour worth pinning is not the happy path — it is what the keeper
 * refuses to do: spend somebody's rate limit on a connection nobody has open,
 * retry an endpoint that answered 403, keep asking an API that said wait, or
 * warm a key no board will ever read.
 */

const connection: ConnectionSpec = connectionSchema.parse({
  id: "acme",
  title: "Acme",
  kind: "rest",
  baseUrl: "https://api.example.com",
  ops: [
    { id: "tasks", title: "Tasks", path: "/v1/tasks" },
    { id: "vendors", title: "Vendors", path: "/v1/vendors" },
    { id: "task", title: "Task", path: "/v1/tasks/{{param.taskId}}" },
    { id: "units", title: "Units", path: "/v1/properties/{{param.propertyId}}/units" },
    {
      id: "payments",
      title: "Payments",
      path: "/v1/payments",
      query: { since: "{{range.start | date}}" },
    },
  ],
  resources: [
    { id: "task", title: "Tasks", listOp: "tasks", detailOp: "task" },
    { id: "vendor", title: "Vendors", listOp: "vendors" },
  ],
});

const links: EntityLinkView[] = [
  {
    entity: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    identity: "Id",
    title: ["Title"],
    titleMode: "join",
    list: "tasks",
    ops: ["tasks", "task"],
    labels: {},
    references: [
      {
        field: "VendorId",
        target: "vendor",
        targetName: "Vendor",
        holds: "scalar",
        embedded: [],
        lookup: { op: "vendors", param: "vendorId" },
      },
    ],
  } as unknown as EntityLinkView,
  {
    entity: "vendor",
    resource: "vendor",
    name: { one: "Vendor", many: "Vendors" },
    identity: "Id",
    title: ["Name"],
    titleMode: "join",
    list: "vendors",
    ops: ["vendors"],
    labels: {},
    references: [],
  } as unknown as EntityLinkView,
];

const board = (widgets: unknown[], params?: unknown): DashboardSpec =>
  dashboardSchema.parse({
    id: "ops",
    title: "Ops",
    widgets,
    layout: { cells: [] },
    ...(params ? { params } : {}),
  });

const tableWidget = {
  id: "work",
  title: "Work",
  component: "table",
  entity: "task",
  source: { connection: "acme", op: "tasks", params: {} },
  roles: { columns: ["Title", "VendorId"] },
};

const NOW = Date.parse("2026-09-22T10:00:00Z");

const targetsFor = (
  widgets: unknown[],
  input: { viewed?: ViewedRequest[]; params?: unknown } = {},
): WarmTarget[] =>
  warmTargets({
    dashboards: [board(widgets, input.params)],
    connections: [connection],
    entityLinks: { acme: links },
    ...(input.viewed ? { viewed: input.viewed } : {}),
    now: () => NOW,
  });

/** What `/api/query` records for a request, built the way it builds it. */
const viewedRequest = (
  op: string,
  params: Record<string, string | number | boolean>,
  filters: Record<string, string | number | boolean> = {},
  range = resolveRange({ preset: "30d", now: NOW - 3 * 60 * 60_000 }),
): ViewedRequest => {
  const request = buildQueryRequest({
    connection: "acme",
    op: getOp(connection, op)!,
    params,
    resolved: { range, filters },
  });
  return { connection: "acme", op, ...request, shape: paramShape(params) };
};

describe("warmTargets", () => {
  it("warms a widget's own source", () => {
    const targets = targetsFor([tableWidget]);
    expect(targets.filter((one) => one.because === "widget").map((one) => one.op)).toEqual([
      "tasks",
    ]);
  });

  /* A row carries a vendor's id, not its name. Warming the list means the
   * names are there the first time somebody looks — one request rather than
   * one per distinct id. */
  it("warms the list behind a reference column the widget draws", () => {
    const targets = targetsFor([tableWidget]);
    expect(targets.filter((one) => one.because === "reference").map((one) => one.op)).toEqual([
      "vendors",
    ]);
  });

  it("leaves a reference column the widget does not draw alone", () => {
    const targets = targetsFor([{ ...tableWidget, roles: { columns: ["Title"] } }]);
    expect(targets.map((one) => one.op)).toEqual(["tasks"]);
  });

  it("asks for each query once however many widgets want it", () => {
    const targets = targetsFor([tableWidget, { ...tableWidget, id: "work2" }]);
    expect(targets).toHaveLength(2);
  });

  /* Its parameters come from another source's rows, so its key cannot be
   * known without fetching first. */
  it("skips a fan-out source", () => {
    const targets = targetsFor([
      {
        ...tableWidget,
        source: undefined,
        combine: { op: "join", left: "main", right: "child", on: { left: "Id", right: "TaskId" } },
        sources: [
          { as: "main", connection: "acme", op: "tasks", params: {} },
          {
            as: "child",
            connection: "acme",
            op: "task",
            params: { taskId: "{{row.Id}}" },
            fanOut: { from: "main", field: "Id" },
          },
        ],
      },
    ]);
    expect(targets.map((one) => one.op)).not.toContain("task");
  });

  /* A `{{row.…}}` belongs to a record somebody opened, not to the board. */
  it("skips a drill-down", () => {
    const targets = targetsFor([
      { ...tableWidget, source: { connection: "acme", op: "task", params: { taskId: "{{row.Id}}" } } },
    ]);
    expect(targets.map((one) => one.op)).not.toContain("task");
  });

  /*
   * The keeper used to put a path parameter on the query string, miss the
   * path, fetch a URL with an empty segment and warm a key nobody read.
   */
  it("puts a path parameter in the path, exactly as a board's query does", () => {
    const targets = targetsFor(
      [
        {
          ...tableWidget,
          id: "units",
          entity: undefined,
          source: { connection: "acme", op: "units", params: { propertyId: "{{param.property}}" } },
        },
      ],
      {
        params: {
          defaultRange: "30d",
          timeZone: "UTC",
          filters: [{ key: "property", label: "Property", type: "text", default: "7" }],
        },
      },
    );
    const units = targets.find((one) => one.op === "units");
    expect(units?.overrides).toEqual({});
    expect(units?.resolved.filters).toMatchObject({ property: "7", propertyId: "7" });
    /* And the key is the one `/api/query` writes for the same request. */
    expect(units?.key).toBe(
      viewedRequest("units", { propertyId: "7" }, { property: "7" }).key,
    );
  });

  /*
   * A window the reader's browser anchored when they opened the page cannot
   * be predicted here, so a guess would only ever warm a key nobody reads.
   */
  it("does not guess the window of an endpoint that reads the range", () => {
    const targets = targetsFor([
      { ...tableWidget, id: "pay", entity: undefined, source: { connection: "acme", op: "payments", params: {} } },
    ]);
    expect(targets.map((one) => one.op)).not.toContain("payments");
  });

  it("warms exactly what was viewed, window and all", () => {
    const seen = viewedRequest("payments", {});
    const targets = targetsFor(
      [{ ...tableWidget, id: "pay", entity: undefined, source: { connection: "acme", op: "payments", params: {} } }],
      { viewed: [seen] },
    );
    const payments = targets.find((one) => one.op === "payments");
    expect(payments).toMatchObject({ because: "viewed", key: seen.key });
  });

  /* A filter somebody changed is a key no board default produces. */
  it("warms a filter somebody changed as well as the default", () => {
    const changed = viewedRequest("tasks", {}, { status: "Closed" });
    const targets = targetsFor([tableWidget], { viewed: [changed] });
    expect(targets.filter((one) => one.op === "tasks")).toHaveLength(2);
    expect(targets.some((one) => one.key === changed.key && one.because === "viewed")).toBe(true);
  });

  /* A per-record name lookup asks the same endpoint with different
   * parameters. Warming those would be one request per vendor, forever. */
  it("does not warm a per-record lookup against a warmed endpoint", () => {
    const lookup = viewedRequest("vendors", { vendorId: "123" });
    const targets = targetsFor([tableWidget], { viewed: [lookup] });
    expect(targets.some((one) => one.key === lookup.key)).toBe(false);
  });

  it("does not warm a record somebody opened", () => {
    const opened = viewedRequest("task", { taskId: "5" });
    const targets = targetsFor([tableWidget], { viewed: [opened] });
    expect(targets.some((one) => one.key === opened.key)).toBe(false);
  });

  it("carries the shortest cadence a widget on the endpoint asked for, floored", () => {
    const targets = targetsFor([
      { ...tableWidget, refresh: { every: "5m" } },
      { ...tableWidget, id: "fast", refresh: { every: "10s" } },
    ]);
    expect(targets.find((one) => one.op === "tasks")?.everyMs).toBe(WIDGET_EVERY_FLOOR_MS);
  });

  it("reads a board's filters at their declared defaults", () => {
    const dashboard = dashboardSchema.parse({
      id: "ops",
      title: "Ops",
      widgets: [],
      params: {
        defaultRange: "30d",
        timeZone: "UTC",
        filters: [{ key: "status", label: "Status", type: "text", default: "open" }],
      },
    });
    expect(boardParams(dashboard, 0).filters).toEqual({ status: "open" });
  });
});

describe("ViewedRequests", () => {
  it("forgets the least recently viewed first", () => {
    const viewed = new ViewedRequests(2);
    viewed.record(viewedRequest("tasks", {}), 1);
    viewed.record(viewedRequest("vendors", {}), 2);
    viewed.record(viewedRequest("tasks", {}), 3);
    viewed.record(viewedRequest("units", { propertyId: "1" }), 4);
    expect(viewed.recent(5).map((one) => one.op)).toEqual(["tasks", "units"]);
  });

  it("stops warming what nobody has looked at in a day", () => {
    const viewed = new ViewedRequests(10, 1000);
    viewed.record(viewedRequest("tasks", {}), 0);
    expect(viewed.recent(500)).toHaveLength(1);
    expect(viewed.recent(2000)).toHaveLength(0);
  });
});

/* ── the rotation ──────────────────────────────────────────────────────── */

const target = (key: string, connection = "acme"): WarmTarget => ({
  connection,
  op: key,
  key,
  overrides: {},
  resolved: { range: { start: 0, end: 1, grain: "1d", preset: "30d" }, filters: {} },
  because: "widget",
  dashboard: "ops",
});

/**
 * A keeper over a pretend cache: a refresh stores the copy now unless told
 * otherwise, which is all the keeper reads about it.
 */
const build = (input: {
  targets: readonly WarmTarget[];
  seenAt?: number | null;
  refresh?: (target: WarmTarget) => Promise<RefreshOutcome | void>;
  everyMs?: number;
  everyMsFor?: (target: WarmTarget) => number;
  coolingUntil?: (connection: string) => number | null;
}) => {
  let at = 1_000_000;
  const asked: string[] = [];
  const stored = new Map<string, number>();
  const keeper = new Keeper({
    targets: () => input.targets,
    refresh:
      input.refresh ??
      (async (one) => {
        asked.push(one.key);
        stored.set(one.key, at);
        return { outcome: "miss" };
      }),
    lastReadAt: () => (input.seenAt === undefined ? at : input.seenAt),
    storedAt: (key) => stored.get(key) ?? null,
    ...(input.coolingUntil ? { coolingUntil: input.coolingUntil } : {}),
    ...(input.everyMsFor ? { everyMsFor: input.everyMsFor } : {}),
    now: () => at,
    everyMs: input.everyMs ?? 600_000,
  });
  return { keeper, asked, stored, advance: (ms: number) => (at += ms), now: () => at };
};

describe("Keeper", () => {
  it("warms everything nobody has fetched yet, one after another", async () => {
    const { keeper, asked } = build({ targets: ["a", "b", "c"].map((key) => target(key)) });
    await keeper.tick();
    expect(asked).toEqual(["a", "b", "c"]);
  });

  it("comes round again once the copy is older than its cadence", async () => {
    const { keeper, asked, advance } = build({ targets: [target("a")], everyMs: 600_000 });
    await keeper.tick();
    advance(300_000);
    await keeper.tick();
    expect(asked).toEqual(["a"]);
    advance(400_000);
    await keeper.tick();
    expect(asked).toEqual(["a", "a"]);
  });

  /* A reader who fetched the copy themselves has made it fresh. */
  it("reads when something is due off the copy, whoever fetched it", async () => {
    const { keeper, asked, stored, now } = build({ targets: [target("a")] });
    stored.set("a", now());
    await keeper.tick();
    expect(asked).toEqual([]);
  });

  /* Moving an endpoint to a faster cadence used to wait out the old one — up
   * to a day. Nothing about the schedule is remembered now. */
  it("applies a changed cadence at the next tick", async () => {
    let every = 24 * 60 * 60_000;
    const { keeper, asked, advance } = build({
      targets: [target("a")],
      everyMsFor: () => every,
    });
    await keeper.tick();
    advance(15 * 60_000);
    await keeper.tick();
    expect(asked).toEqual(["a"]);
    every = 10 * 60_000;
    await keeper.tick();
    expect(asked).toEqual(["a", "a"]);
  });

  /* A board left open overnight spending somebody's whole rate limit is a bug
   * this codebase fixed once already. */
  it("spends nothing on a connection nobody is looking at", async () => {
    const { keeper, asked } = build({ targets: [target("a")], seenAt: null });
    const pass = await keeper.tick();
    expect(asked).toEqual([]);
    expect(pass.skipped).toEqual([{ key: "a", reason: "idle" }]);
  });

  it("picks it up the moment somebody comes back", async () => {
    let seen: number | null = null;
    const at = 1_000_000;
    const asked: string[] = [];
    const keeper = new Keeper({
      targets: () => [target("a")],
      refresh: async (one) => {
        asked.push(one.key);
        return { outcome: "miss" };
      },
      lastReadAt: () => seen,
      storedAt: () => null,
      now: () => at,
    });

    await keeper.tick();
    expect(asked).toEqual([]);
    seen = at;
    await keeper.tick();
    expect(asked).toEqual(["a"]);
  });

  it("drops a target the account is refused outright", async () => {
    const refusal = Object.assign(new Error("forbidden"), { status: 403 });
    let calls = 0;
    const { keeper, advance } = build({
      targets: [target("a")],
      refresh: async () => {
        calls++;
        throw refusal;
      },
    });

    const first = await keeper.tick();
    expect(calls).toBe(1);
    expect(first.failed[0]?.key).toBe("a");

    advance(700_000);
    const second = await keeper.tick();
    expect(calls).toBe(1);
    expect(second.skipped).toEqual([{ key: "a", reason: "denied" }]);
    expect(keeper.state()[0]?.denied).toBeTruthy();
  });

  /* The cache hands back its old copy instead of throwing whenever it has
   * one. Read as a success, a 403 was retried forever and a 429 pushed the
   * whole board a full cadence out while reporting "refreshed". */
  it("reads a refusal out of an old copy handed back in its place", async () => {
    let calls = 0;
    const { keeper, advance } = build({
      targets: [target("a")],
      refresh: async () => {
        calls++;
        return { outcome: "stale", error: { status: 403 } };
      },
    });
    const first = await keeper.tick();
    expect(first.refreshed).toEqual([]);
    advance(700_000);
    await keeper.tick();
    expect(calls).toBe(1);
  });

  it("stops asking a connection that said wait, for the rest of the pass", async () => {
    const asked: string[] = [];
    const { keeper } = build({
      targets: [target("a"), target("b"), target("c", "other")],
      refresh: async (one) => {
        asked.push(one.key);
        return one.key === "a"
          ? { outcome: "stale", error: { status: 429, retryAfter: "30" } }
          : { outcome: "miss" };
      },
    });
    const pass = await keeper.tick();
    /* b shares a's connection; c does not. */
    expect(asked).toEqual(["a", "c"]);
    expect(pass.skipped).toContainEqual({ key: "b", reason: "cooling" });
  });

  it("asks nothing of a connection still cooling down, and leaves it due", async () => {
    let until: number | null = 2_000_000;
    const { keeper, asked } = build({
      targets: [target("a")],
      coolingUntil: () => until,
    });
    const pass = await keeper.tick();
    expect(asked).toEqual([]);
    expect(pass.skipped).toEqual([{ key: "a", reason: "cooling" }]);
    until = null;
    await keeper.tick();
    expect(asked).toEqual(["a"]);
  });

  it("backs off a failure rather than retrying it every tick", async () => {
    let calls = 0;
    const { keeper, advance } = build({
      targets: [target("a")],
      refresh: async () => {
        calls++;
        return { outcome: "stale", error: {} };
      },
    });
    await keeper.tick();
    advance(30_000);
    await keeper.tick();
    expect(calls).toBe(1);
    advance(FAILURE_BACKOFF_MS);
    await keeper.tick();
    expect(calls).toBe(2);
  });

  it("lifts a refusal when the connection's data is invalidated", async () => {
    let refuse = true;
    let calls = 0;
    const { keeper, advance } = build({
      targets: [target("a")],
      refresh: async () => {
        calls++;
        if (refuse) throw Object.assign(new Error("unauthorised"), { status: 401 });
        return { outcome: "miss" };
      },
    });
    await keeper.tick();
    refuse = false;
    keeper.forget("acme");
    advance(1000);
    await keeper.tick();
    expect(calls).toBe(2);
    expect(keeper.state()[0]?.denied).toBeUndefined();
  });

  it("forgets a target whose board no longer wants it", async () => {
    let live = [target("a"), target("b")];
    let at = 1_000_000;
    const keeper = new Keeper({
      targets: () => live,
      refresh: async () => ({ outcome: "miss" }),
      lastReadAt: () => at,
      storedAt: () => null,
      now: () => at,
    });
    await keeper.tick();
    expect(keeper.state()).toHaveLength(2);

    live = [target("a")];
    at += 1000;
    await keeper.tick();
    expect(keeper.state().map((one) => one.target.key)).toEqual(["a"]);
  });
});

/*
 * The keeper against the real cache, because the mock above is exactly where
 * the old bug hid: a refusal the cache turned into an old copy never reached
 * the keeper, and the tests that threw from `refresh` could not see it.
 */
describe("Keeper over a real QueryCache", () => {
  const setup = () => {
    let at = 1_000_000;
    const cache = new QueryCache({ now: () => at });
    let respond: () => Promise<{ body: unknown; meta: never }> = async () => ({
      body: [{ Id: 1 }],
      meta: {} as never,
    });
    let calls = 0;
    const keeper = new Keeper({
      targets: () => [target("acme.tasks|[]")],
      refresh: (one) =>
        cache.read({
          key: one.key,
          connection: one.connection,
          maxAgeMs: 0,
          mode: "refresh",
          fetcher: () => {
            calls++;
            return respond();
          },
        }),
      lastReadAt: () => at,
      storedAt: (key) => cache.storedAt(key),
      coolingUntil: (connection) => cache.coolingUntil(connection),
      now: () => at,
      everyMs: 600_000,
    });
    cache.onInvalidate((connection) => keeper.forget(connection));
    return {
      cache,
      keeper,
      calls: () => calls,
      advance: (ms: number) => (at += ms),
      respondWith: (next: typeof respond) => (respond = next),
    };
  };

  it("sees a 403 behind a cached copy and stops asking", async () => {
    const run = setup();
    await run.keeper.tick();
    expect(run.calls()).toBe(1);

    run.respondWith(async () => {
      throw new AdapterError("forbidden", { status: 403 });
    });
    run.advance(700_000);
    const refused = await run.keeper.tick();
    expect(refused.refreshed).toEqual([]);
    expect(run.keeper.state()[0]?.denied).toBeTruthy();

    run.advance(700_000);
    await run.keeper.tick();
    expect(run.calls()).toBe(2);
  });

  /* A key pasted wrong and then fixed: the first refusal must not outlive the
   * fix, or the widgets it covers load once and never again. */
  it("asks again once the key changes", async () => {
    const run = setup();
    run.respondWith(async () => {
      throw new AdapterError("unauthorised", { status: 401 });
    });
    await run.keeper.tick();
    expect(run.keeper.state()[0]?.denied).toBeTruthy();

    run.respondWith(async () => ({ body: [{ Id: 2 }], meta: {} as never }));
    run.cache.invalidate("acme");
    run.advance(1000);
    const pass = await run.keeper.tick();
    expect(pass.refreshed).toEqual(["acme.tasks|[]"]);
  });

  it("waits out a 429 instead of pushing the board a full cadence out", async () => {
    const run = setup();
    await run.keeper.tick();
    run.respondWith(async () => {
      throw new AdapterError("slow down", { status: 429, retryAfter: "60" });
    });
    run.advance(700_000);
    await run.keeper.tick();
    expect(run.calls()).toBe(2);

    /* Still cooling: nothing asked. */
    run.advance(30_000);
    await run.keeper.tick();
    expect(run.calls()).toBe(2);

    /* The wait is over: asked straight away, not ten minutes later. */
    run.respondWith(async () => ({ body: [{ Id: 3 }], meta: {} as never }));
    run.advance(31_000);
    const pass = await run.keeper.tick();
    expect(pass.refreshed).toEqual(["acme.tasks|[]"]);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and dates", () => {
    expect(retryAfterMs("30", 0)).toBe(30_000);
    expect(retryAfterMs("Thu, 01 Jan 1970 00:01:00 GMT", 0)).toBe(60_000);
    expect(retryAfterMs("soon", 0)).toBeUndefined();
  });
});

describe("LastSeen", () => {
  it("knows nothing about a connection nobody has read", () => {
    expect(new LastSeen().seenAt("acme")).toBeNull();
  });

  it("records being asked, which is what a view does and a fetch does not", () => {
    const seen = new LastSeen();
    seen.touch("acme", 42);
    expect(seen.seenAt("acme")).toBe(42);
  });
});
