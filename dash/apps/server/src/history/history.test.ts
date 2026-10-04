import { connectionSchema, dashboardSchema, getOp, resolveRange, type DashboardSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { openDashDb } from "../platform/db.js";
import { buildQueryRequest } from "../query.js";
import { dayOf, numbersFrom } from "./record.js";
import { DbSnapshotStore, MemorySnapshotStore } from "./store.js";

/*
 * What a number on a board was, day by day: kept while the board is looked
 * after, because most APIs cannot be asked what a count was last month.
 */

const NOW = Date.UTC(2026, 8, 29, 12);
const connection = connectionSchema.parse({
  id: "shop",
  title: "Shop",
  kind: "rest",
  baseUrl: "https://api.shop.test",
  ops: [
    { id: "orders", title: "Orders", path: "/orders", rowsPath: "$.data" },
    { id: "refunds", title: "Refunds", path: "/refunds", rowsPath: "$.data" },
  ],
});

const total = (id: string, op: string, params: Record<string, string> = {}) => ({
  id,
  title: id,
  component: "stat",
  source: { connection: "shop", op, params },
  pipeline: [
    { op: "extract", path: "$.data[*]" },
    { op: "derive", fields: { _all: "1" } },
    { op: "group", by: [{ field: "_all" }], agg: { value: "sum(amount)" } },
  ],
  roles: { value: "value" },
});

const board: DashboardSpec = dashboardSchema.parse({
  id: "sales",
  title: "Sales",
  widgets: [
    total("revenue", "orders"),
    total("refunded", "refunds"),
    total("big-orders", "orders", { min: "100" }),
    { ...total("list", "orders"), component: "table", roles: {} },
  ],
  layout: { cells: [] },
});

const resolved = { range: resolveRange({ preset: "30d", now: NOW }), filters: {} };
const read = {
  connection: "shop",
  op: "orders",
  key: buildQueryRequest({ connection: "shop", op: getOp(connection, "orders")!, params: {}, resolved }).key,
  resolved,
};

describe("a number's history", () => {
  it("is each number tile the read feeds, worked out as the board would", () => {
    const numbers = numbersFrom({
      dashboards: [board],
      connections: new Map([["shop", connection]]),
      read,
      body: { data: [{ amount: 40 }, { amount: 2.5 }] },
      now: NOW,
    });
    /* Not the refunds (another endpoint), not the big orders (another request), not the list. */
    expect(numbers).toEqual([{ dashboard: "sales", widget: "revenue", value: 42.5 }]);
    expect(dayOf(NOW)).toBe("2026-09-29");
  });

  it("is kept a value a day, oldest first, pruned past the retention, and forgotten with the board", async () => {
    const db = await openDashDb({ inMemory: true });
    try {
      for (const store of [new MemorySnapshotStore(), new DbSnapshotStore(db)]) {
        await store.record("sales", "revenue", { day: "2026-09-28", value: 40 });
        await store.record("sales", "revenue", { day: "2026-09-29", value: 41 });
        await store.record("sales", "revenue", { day: "2026-09-29", value: 42.5 });
        await store.record("sales", "refunded", { day: "2026-01-01", value: 3 });
        expect(await store.list("sales", "revenue")).toEqual([
          { day: "2026-09-28", value: 40 },
          { day: "2026-09-29", value: 42.5 },
        ]);
        await store.prune("2026-02-01");
        expect(await store.list("sales", "refunded")).toEqual([]);
        await store.forget("sales");
        expect(await store.list("sales", "revenue")).toEqual([]);
      }
    } finally {
      await db.close();
    }
  });
});
