import { AdapterError, AdapterRegistry, InlineAdapter } from "@freebirdai/dash-adapters";
import type { LayoutCell, ResolvedParams } from "@freebirdai/dash-spec";
import { connectionSchema, parseWidget, resolveRange, widgetSchema } from "@freebirdai/dash-spec";
import { type TrailEntry, detailPanes, popTrail, truncateTrail } from "./detail.js";
import { describe, expect, it } from "vitest";
import { clampCell, completeLayout, solveLayout } from "./layout.js";
import { QueryClient, queryKey } from "./store.js";
import { labelColumns } from "./useWidgetData.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useDashboard, useOptionalDashboard } from "./context.jsx";
import { describeFailure } from "./WidgetShell.jsx";

describe("solveLayout", () => {
  it("packs widgets without overlapping", () => {
    const { cells } = solveLayout([
      { widgetId: "a", component: "stat" },
      { widgetId: "b", component: "stat" },
      { widgetId: "c", component: "timeseries" },
      { widgetId: "d", component: "table" },
    ]);

    expect(cells).toHaveLength(4);
    const occupied = new Set<string>();
    for (const cell of cells) {
      for (let y = cell.y; y < cell.y + cell.h; y++) {
        for (let x = cell.x; x < cell.x + cell.w; x++) {
          const slot = `${x},${y}`;
          expect(occupied.has(slot), `overlap at ${slot}`).toBe(false);
          occupied.add(slot);
        }
      }
    }
  });

  it("keeps every cell inside the grid", () => {
    const { cells } = solveLayout(
      Array.from({ length: 10 }, (_, i) => ({ widgetId: `w${i}`, component: "timeseries" as const })),
    );
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x + cell.w).toBeLessThanOrEqual(12);
    }
  });

  it("is deterministic", () => {
    const requests = [
      { widgetId: "a", component: "bar" as const },
      { widgetId: "b", component: "gauge" as const },
      { widgetId: "c", component: "list" as const },
    ];
    expect(solveLayout(requests).cells).toEqual(solveLayout(requests).cells);
  });

  it("gives a solo widget the largest variant that fits", () => {
    const [cell] = solveLayout([{ widgetId: "only", component: "timeseries" }]).cells;
    expect(cell?.w).toBe(12); // the "full" variant
  });

  it("uses the preferred variant once it has company", () => {
    const { cells } = solveLayout([
      { widgetId: "a", component: "timeseries" },
      { widgetId: "b", component: "timeseries" },
    ]);
    expect(cells.every((cell) => cell.w === 8)).toBe(true); // preferred "lg"
  });

  it("places higher importance first", () => {
    const { cells } = solveLayout([
      { widgetId: "low", component: "stat", importance: 1 },
      { widgetId: "high", component: "stat", importance: 5 },
    ]);
    const high = cells.find((cell) => cell.widgetId === "high")!;
    const low = cells.find((cell) => cell.widgetId === "low")!;
    expect(high.y < low.y || (high.y === low.y && high.x < low.x)).toBe(true);
  });

  it("treats saved cells as immovable and reports what it had to drop", () => {
    const locked: LayoutCell[] = [
      { widgetId: "pinned", x: 0, y: 0, w: 12, h: 6, locked: true },
    ];
    const { cells, dropped } = solveLayout([{ widgetId: "new", component: "stat" }], { locked });

    expect(cells.find((cell) => cell.widgetId === "pinned")).toMatchObject({ x: 0, y: 0, w: 12 });
    expect(cells.find((cell) => cell.widgetId === "new")?.y).toBeGreaterThanOrEqual(6);
    expect(dropped).toEqual([]);
  });

  it("drops a saved cell that no longer fits rather than silently moving it", () => {
    const { dropped } = solveLayout([], {
      locked: [{ widgetId: "wide", x: 8, y: 0, w: 8, h: 4, locked: true }],
    });
    expect(dropped[0]).toMatchObject({ widgetId: "wide", reason: expect.stringContaining("outside") });
  });
});

describe("completeLayout", () => {
  const widgets = [
    { widgetId: "kept", component: "stat" as const },
    { widgetId: "fresh", component: "bar" as const },
  ];

  it("leaves saved positions alone and places only what is new", () => {
    const saved: LayoutCell[] = [{ widgetId: "kept", x: 3, y: 2, w: 4, h: 3, locked: true }];
    const cells = completeLayout(widgets, saved);

    expect(cells.find((cell) => cell.widgetId === "kept")).toMatchObject({ x: 3, y: 2, w: 4, h: 3 });
    expect(cells.find((cell) => cell.widgetId === "fresh")).toBeDefined();
  });

  it("forgets cells for widgets that no longer exist", () => {
    const saved: LayoutCell[] = [
      { widgetId: "kept", x: 0, y: 0, w: 3, h: 3, locked: true },
      { widgetId: "deleted", x: 4, y: 0, w: 3, h: 3, locked: true },
    ];
    const cells = completeLayout(widgets, saved);
    expect(cells.some((cell) => cell.widgetId === "deleted")).toBe(false);
  });

  it("places every widget after the set changes — the stale-grid bug", () => {
    // DashboardGrid used to hold cells in useState initialised once at mount.
    // Swapping dashboards or adding a widget then left cells referencing ids
    // that no longer existed, and the grid rendered nothing at all. Cells are
    // derived now, so a completely different widget set must still lay out.
    const first = completeLayout(
      [
        { widgetId: "a", component: "stat" as const },
        { widgetId: "b", component: "timeseries" as const },
      ],
      [],
    );
    expect(first).toHaveLength(2);

    const second = completeLayout(
      [
        { widgetId: "x", component: "list" as const },
        { widgetId: "y", component: "bar" as const },
        { widgetId: "z", component: "gauge" as const },
      ],
      first, // the previous dashboard's cells, now entirely stale
    );

    expect(second.map((cell) => cell.widgetId).sort()).toEqual(["x", "y", "z"]);
    expect(second.some((cell) => cell.widgetId === "a")).toBe(false);
  });

  it("keeps existing widgets put when one is appended", () => {
    const before = completeLayout([{ widgetId: "a", component: "stat" as const }], []);
    const after = completeLayout(
      [
        { widgetId: "a", component: "stat" as const },
        { widgetId: "new", component: "bar" as const },
      ],
      before,
    );
    expect(after.find((cell) => cell.widgetId === "a")).toMatchObject({
      x: before[0]!.x,
      y: before[0]!.y,
    });
    expect(after.find((cell) => cell.widgetId === "new")).toBeDefined();
  });

  it("returns saved cells untouched when nothing is new", () => {
    const saved: LayoutCell[] = [
      { widgetId: "kept", x: 0, y: 0, w: 3, h: 3, locked: true },
      { widgetId: "fresh", x: 3, y: 0, w: 6, h: 5, locked: true },
    ];
    expect(completeLayout(widgets, saved)).toEqual(saved);
  });
});

describe("clampCell", () => {
  it("pulls a dragged cell back inside the grid", () => {
    expect(clampCell({ widgetId: "a", x: 10, y: 0, w: 6, h: 4, locked: true })).toMatchObject({
      x: 6,
      w: 6,
    });
    expect(clampCell({ widgetId: "a", x: -3, y: -2, w: 4, h: 3, locked: true })).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(clampCell({ widgetId: "a", x: 0, y: 0, w: 40, h: 99, locked: true })).toMatchObject({
      w: 12,
      h: 24,
    });
  });
});

describe("queryKey", () => {
  const scope = (preset: "7d" | "30d", filters = {}): ResolvedParams => ({
    range: resolveRange({ preset, now: 1_000_000_000 }),
    filters,
  });

  it("is stable regardless of param insertion order", () => {
    expect(queryKey("c", "o", { b: 2, a: 1 })).toBe(queryKey("c", "o", { a: 1, b: 2 }));
  });

  it("separates different params, ops and connections", () => {
    expect(queryKey("c", "o", { a: 1 })).not.toBe(queryKey("c", "o", { a: 2 }));
    expect(queryKey("c", "o1", {})).not.toBe(queryKey("c", "o2", {}));
    expect(queryKey("c1", "o", {})).not.toBe(queryKey("c2", "o", {}));
  });

  it("separates time ranges, so changing the range cannot serve the old window", () => {
    expect(queryKey("c", "o", {}, scope("7d"))).not.toBe(queryKey("c", "o", {}, scope("30d")));
  });

  it("separates filter sets", () => {
    expect(queryKey("c", "o", {}, scope("7d", { region: "emea" }))).not.toBe(
      queryKey("c", "o", {}, scope("7d", { region: "apac" })),
    );
  });

  it("is unchanged when nothing the request depends on changed", () => {
    expect(queryKey("c", "o", { a: 1 }, scope("7d"))).toBe(queryKey("c", "o", { a: 1 }, scope("7d")));
  });
});

describe("QueryClient", () => {
  const connection = connectionSchema.parse({
    id: "demo",
    title: "Demo",
    kind: "inline",
    ops: [{ id: "rows", title: "Rows", path: "/rows" }],
  });

  const params: ResolvedParams = {
    range: resolveRange({ preset: "7d", now: 1_000_000 }),
    filters: {},
  };

  const makeClient = (onFetch?: () => void) => {
    const adapter = new InlineAdapter();
    adapter.register("demo", "rows", () => {
      onFetch?.();
      return { data: [1, 2, 3] };
    });
    const registry = new AdapterRegistry().register(adapter).addConnection(connection);
    return new QueryClient(registry);
  };

  const request = (client: QueryClient, key: string) =>
    client.ensure({
      key,
      connection: "demo",
      op: "rows",
      params: {},
      resolved: params,
      now: 1_000_000,
    });

  it("stores the body and marks the query ok", async () => {
    const client = makeClient();
    await request(client, "k");
    expect(client.get("k")).toMatchObject({ status: "ok", body: { data: [1, 2, 3] } });
  });

  it("fetches once for concurrent callers sharing a key", async () => {
    let calls = 0;
    const client = makeClient(() => calls++);
    await Promise.all([request(client, "k"), request(client, "k"), request(client, "k")]);
    expect(calls).toBe(1);
  });

  it("does not re-fetch a completed query", async () => {
    let calls = 0;
    const client = makeClient(() => calls++);
    await request(client, "k");
    await request(client, "k");
    expect(calls).toBe(1);
  });

  it("re-fetches when forced, and again after invalidation", async () => {
    let calls = 0;
    const client = makeClient(() => calls++);
    await request(client, "k");
    await client.ensure({
      key: "k",
      connection: "demo",
      op: "rows",
      params: {},
      resolved: params,
      now: 2_000_000,
      force: true,
    });
    expect(calls).toBe(2);

    client.invalidate();
    await request(client, "k");
    expect(calls).toBe(3);
  });

  it("keeps the previous body visible while refreshing", async () => {
    const client = makeClient();
    await request(client, "k");
    const pending = client.ensure({
      key: "k",
      connection: "demo",
      op: "rows",
      params: {},
      resolved: params,
      now: 2_000_000,
      force: true,
    });
    // Mid-refresh the widget still has data rather than blanking to a spinner.
    expect(client.get("k")).toMatchObject({ status: "loading", body: { data: [1, 2, 3] } });
    await pending;
  });

  it("turns an adapter failure into a message a user can act on", async () => {
    const registry = new AdapterRegistry().register(new InlineAdapter()).addConnection(connection);
    const client = new QueryClient(registry);
    await request(client, "k");

    const entry = client.get("k");
    expect(entry?.status).toBe("error");
    expect(entry?.error?.userMessage).toMatch(/sample data/);
  });

  it("keeps the HTTP status, so the tile can tell 401 from 403", async () => {
    const forbidding = {
      kind: "inline" as const,
      transport: "direct" as const,
      fetch: async () => {
        throw new AdapterError("auth forbidden (403)", {
          status: 403,
          userMessage: "Demo accepted the key but will not allow access to this endpoint.",
        });
      },
    };
    const registry = new AdapterRegistry()
      .register(forbidding as unknown as InlineAdapter)
      .addConnection(connection);
    const client = new QueryClient(registry);
    await request(client, "k");

    // Previously dropped here, which is what made every failure read as
    // "the key may have expired" — advice that is wrong for a 403.
    expect(client.get("k")?.error?.status).toBe(403);
  });

  it("notifies subscribers on every transition", async () => {
    const client = makeClient();
    let notifications = 0;
    const unsubscribe = client.subscribe(() => notifications++);
    await request(client, "k");
    unsubscribe();
    expect(notifications).toBeGreaterThanOrEqual(2); // loading, then ok
  });
});

describe("drill-down cache separation", () => {
  const params = {
    range: { start: 0, end: 1, grain: "1d" as const, preset: "30d" as const },
    filters: {},
  };

  /**
   * The failure this guards against is the same class as the range bug: a key
   * that omits part of the request serves one record's data under another's
   * heading, and it looks entirely plausible.
   */
  it("gives two rows two different cache keys", () => {
    const a = queryKey("buildium", "lease_detail", { leaseId: "4127" }, params);
    const b = queryKey("buildium", "lease_detail", { leaseId: "5230" }, params);
    expect(a).not.toBe(b);
  });

  it("reuses one entry when two rows resolve to the same request", () => {
    const a = queryKey("buildium", "lease_detail", { leaseId: "4127" }, params);
    const b = queryKey("buildium", "lease_detail", { leaseId: "4127" }, params);
    expect(a).toBe(b);
  });
});

describe("detail panes", () => {
  const parent = parseWidget({
    id: "crates",
    title: "Crates",
    component: "table",
    source: { connection: "api", op: "crates", params: {} },
    pipeline: [{ op: "extract", path: "$" }],
    roles: { columns: ["Id", "Name"] },
    drilldown: {
      op: "crate",
      params: { crateId: "{{row.Id}}" },
      title: "Crate",
      roles: { fields: ["Id", "Name"] },
      related: [
        {
          id: "items",
          title: "Items in this crate",
          op: "crateItems",
          params: { crateId: "{{row.Id}}" },
          roles: { columns: ["Id", "Sku"] },
          opensRecord: { op: "crateItem", params: { itemId: "{{row.Id}}" } },
        },
      ],
    },
  }).value!;

  it("builds the record and everything belonging to it", () => {
    const panes = detailPanes(parent);
    expect(panes.map((pane) => pane.id)).toEqual(["record", "items"]);
    // A record view, because one thing is being opened rather than many.
    expect(panes[0]?.spec.component).toBe("record");
  });

  it("inherits the parent's connection so a pane cannot drift to another API", () => {
    for (const pane of detailPanes(parent)) {
      expect(pane.spec.source?.connection).toBe("api");
    }
  });

  it("clears the drill-down so a pane cannot re-open itself", () => {
    for (const pane of detailPanes(parent)) {
      expect(pane.spec.drilldown).toBeUndefined();
      expect(pane.spec.sources).toEqual([]);
    }
  });

  it("namespaces pane ids under the parent", () => {
    const panes = detailPanes(parent);
    expect(panes[0]?.spec.id).toBe("crates__detail");
    expect(panes[1]?.spec.id).toBe("crates__rel__items");
  });

  it("offers a child record only where one is declared", () => {
    const panes = detailPanes(parent);
    expect(panes[0]?.opens).toBeUndefined();
    expect(panes[1]?.opens?.source?.op).toBe("crateItem");
  });

  it("has nothing to show for a widget with no drill-down", () => {
    expect(detailPanes({ ...parent, drilldown: undefined })).toEqual([]);
  });
});

describe("detail trail", () => {
  const entry = (title: string): TrailEntry => ({ title, panes: [], row: {} });
  const trail = [entry("Crate"), entry("Item"), entry("Part")];

  it("steps back one level", () => {
    expect(popTrail(trail)?.map((step) => step.title)).toEqual(["Crate", "Item"]);
  });

  it("reports nowhere to go at the root, which the caller reads as close", () => {
    // One sheet, one Escape handler: at depth 1 there is nothing to pop, so
    // the sheet closes rather than a second dialog swallowing the key.
    expect(popTrail([entry("Crate")])).toBeNull();
  });

  it("jumps straight back to a clicked breadcrumb", () => {
    expect(truncateTrail(trail, 0).map((step) => step.title)).toEqual(["Crate"]);
    expect(truncateTrail(trail, 1).map((step) => step.title)).toEqual(["Crate", "Item"]);
  });

  it("never truncates below the root", () => {
    expect(truncateTrail(trail, -5)).toHaveLength(1);
    expect(truncateTrail(trail, 99)).toHaveLength(3);
  });
});

/**
 * Chrome that outlives the board.
 *
 * The assistant panel mounts on an empty workspace, where there is no
 * `DashboardProvider` above it. `useDashboard` throwing there took the entire
 * app down the moment the panel was opened — a blank page from one click.
 */
describe("useOptionalDashboard", () => {
  it("returns null outside a provider instead of throwing", () => {
    let seen: unknown = "unset";
    const Probe = (): null => {
      seen = useOptionalDashboard();
      return null;
    };
    // No provider anywhere above it.
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBeNull();
  });

  it("still throws for useDashboard, which widgets rely on", () => {
    const Probe = (): null => {
      useDashboard();
      return null;
    };
    expect(() => renderToStaticMarkup(createElement(Probe))).toThrow(/DashboardProvider/);
  });
});

/* ── what a failed tile says ───────────────────────────────────────────── */

describe("describeFailure", () => {
  it("does not blame the key for a 403, because a 403 proves the key works", () => {
    const failure = describeFailure(403, "Acme accepted the key but will not allow access.");
    // You cannot be forbidden without first being identified.
    expect(failure.message).toContain("accepted the key");
    expect(failure.detail).toContain("Nothing is wrong with the connection");
    expect(failure.detail).not.toMatch(/expired|re-enter/i);
    // Retrying cannot change a permission, so it is not offered.
    expect(failure.retryable).toBe(false);
  });

  it("does blame the key for a 401, and says where to fix it", () => {
    const failure = describeFailure(401, "Acme rejected the key.");
    expect(failure.detail).toMatch(/expired|revoked/);
    expect(failure.detail).toContain("Connections");
    expect(failure.retryable).toBe(false);
  });

  it("calls a 429 temporary and offers the retry", () => {
    const failure = describeFailure(429, "Too many requests.");
    expect(failure.detail).toContain("temporary");
    expect(failure.retryable).toBe(true);
  });

  it("retries anything it cannot identify", () => {
    expect(describeFailure(502, null).retryable).toBe(true);
    expect(describeFailure(null, null).retryable).toBe(true);
    expect(describeFailure(null, null).message).toBe("That request did not come back.");
  });

  it("prefers the adapter's own words, which name the connection", () => {
    expect(describeFailure(403, "Buildium says no").message).toBe("Buildium says no");
    // And still says something useful when there are none.
    expect(describeFailure(403, null).message).toContain("not allowed to read this");
  });
});

describe("labelColumns", () => {
  const widget = (extra: Record<string, unknown> = {}) =>
    widgetSchema.parse({
      id: "w",
      title: "W",
      component: "record",
      source: { connection: "api", op: "detail" },
      ...extra,
    });

  const columns = (...names: string[]) =>
    names.map((name) => ({ name, valueType: "text" as const }));

  const lexicon = {
    api: {
      "Address.AddressLine1": "Address line 1",
      IsActive: "Active",
      Total: "Amount charged",
    },
  };

  it("labels a plain column from the lexicon", () => {
    const [active] = labelColumns(columns("IsActive"), widget(), lexicon);
    expect(active?.label).toBe("Active");
  });

  it("leaves a column the lexicon does not cover alone, for humanLabel to handle", () => {
    const [other] = labelColumns(columns("UnitNumber"), widget(), lexicon);
    expect(other?.label).toBeUndefined();
  });

  /*
   * The case the whole second lookup exists for. A nested field only becomes a
   * column because a derive step renames it, and the lexicon is keyed by the
   * name the API uses — so without this every nested field misses, which is
   * exactly the set most in need of a readable name.
   */
  it("follows a derive step back to the API's own field name", () => {
    const derived = widget({
      pipeline: [
        { op: "extract", path: "$" },
        { op: "derive", fields: { Address_AddressLine1: "Address.AddressLine1" } },
      ],
    });
    const [line] = labelColumns(columns("Address_AddressLine1"), derived, lexicon);
    expect(line?.label).toBe("Address line 1");
  });

  it("does not follow a computed derive, which names no single field", () => {
    const computed = widget({
      pipeline: [
        { op: "extract", path: "$" },
        { op: "derive", fields: { Total: "Rent + Fees" } },
      ],
    });
    // The column is called `Total` and the lexicon has an entry for that name,
    // so it is labelled — but on its own name, not on the expression's.
    const [total] = labelColumns(columns("Total"), computed, lexicon);
    expect(total?.label).toBe("Amount charged");
  });

  it("does nothing at all with no lexicon", () => {
    const plain = labelColumns(columns("IsActive"), widget(), undefined);
    expect(plain[0]?.label).toBeUndefined();
  });
});
